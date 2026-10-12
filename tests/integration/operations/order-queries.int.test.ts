// T-314a: sipariş okuma sorguları (stock.view, keyset, depo kapsamı, tenant yalıtımı, satır başına miktar dökümü). Gerçek wms_app bağlantısı + RLS;
// fikstür yalnızca DATABASE_URL_DIRECT ile (sentetik, G-09). Senaryo mevcut komutlarla kurulur (tahsis, görevlendirme, toplama, sevk, iade, iptal).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/domain/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { runTenantQuery } from "../../../packages/domain/src/identity/access.ts";
import { resolveWarehouseScope } from "../../../packages/domain/src/warehouse/scope.ts";
import { createWarehouse, setMembershipWarehouseScopes } from "../../../packages/domain/src/warehouse/index.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import {
  ORDER_LIST_LIMIT_MAX,
  cancelOrderLine,
  confirmPick,
  createCustomerReturn,
  createPickAssignment,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
  reserveOrder,
  shipOrder,
} from "../../../packages/domain/src/operations/index.ts";
import { approveDocument, createStockDocument, postDocument, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let C: TenantWorld;
let otherWh: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const hex = (n: number): string => randomUUID().replaceAll("-", "").slice(0, n);
const owner = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });
const cmd = (w: TenantWorld): StockDocCallParams => ({ ...owner(w), clientKey: randomUUID(), retry: NO_WAIT });
const pcmd = (w: TenantWorld): StockDocCallParams => ({ ...picker(w), clientKey: randomUUID(), retry: NO_WAIT });

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
async function mkItem(w: TenantWorld): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T314a urun',$4,'NONE',0)", [
    w.tenantId, id, `I-${hex(10)}`, w.unitId,
  ]);
  return id;
}
async function mkLoc(w: TenantWorld, warehouseId: string, kind: "RECEIVING" | "STORAGE" | "STAGING", code = `L-${hex(10)}`): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T314a lok',0,$5)", [
    w.tenantId, id, warehouseId, code, kind,
  ]);
  return id;
}
async function stockIn(w: TenantWorld, warehouseId: string, item: string, loc: string, qty: string): Promise<void> {
  const c = await createStockDocument(cmd(w), {
    kind: "STOCK_IN",
    warehouseId,
    lines: [{ itemId: item, unitId: w.unitId, quantity: qty, conversionFactor: "1", baseQuantity: qty, targetLocationId: loc, stockStatus: "AVAILABLE" }],
  });
  const id = c.documentId as string;
  await approveDocument(cmd(w), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [id]))[0] as { version: number };
  await postDocument(cmd(w), { documentId: id, expectedVersion: v.version });
}
interface Order {
  id: string;
  lineIds: string[];
  number: string;
}
async function mkOrder(w: TenantWorld, lines: { item: string; qty: string }[], customerRef: string | null = "T314a-MUS"): Promise<Order> {
  const r = await createSalesOrder(cmd(w), { customerRef, lines: lines.map((l) => ({ itemId: l.item, unitId: w.unitId, quantity: l.qty })) });
  const rows = await q<{ id: string }>("SELECT id FROM public.sales_order_lines WHERE order_id = $1 ORDER BY line_no", [r.documentId]);
  return { id: r.documentId as string, lineIds: rows.map((x) => x.id), number: r.documentNumber as string };
}
const barcodes = new Map<string, string>();
async function bcOf(w: TenantWorld, item: string): Promise<string> {
  const have = barcodes.get(item);
  if (have !== undefined) return have;
  const code = `BC${hex(12)}`;
  await q("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode, quantity) VALUES ($1,$2,$3,$4,NULL)", [w.tenantId, item, w.unitId, code]);
  barcodes.set(item, code);
  return code;
}
async function pick(w: TenantWorld, taskId: string, found: string, loc: string, item: string): Promise<void> {
  const code = (await q<{ code: string }>("SELECT code FROM public.locations WHERE id = $1", [loc]))[0]?.code as string;
  await confirmPick(pcmd(w), { taskId, foundQuantity: found, scannedLocationCode: code, scannedItemBarcode: await bcOf(w, item) });
}
/** Aynı iç düzenin kendi "kimlik" karşılaştırması: kod, ayrıntı, ileti. */
const shape = (e: AppError) => ({ code: e.code, detail: e.detail, message: e.message });

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A314a");
  B = await seedWorld(adm, reg, "B314a");
  C = await seedWorld(adm, reg, "C314a");
  otherWh = (await createWarehouse(owner(A), { code: `s${hex(8)}`, name: "T314a ikinci depo" })).warehouseId;
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("listSalesOrders/getSalesOrder açık; SQL parçaları ve iç yardımcılar açılmaz", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["listSalesOrders", "getSalesOrder", "SALES_ORDER_STATUSES"]));
    for (const hidden of ["visibleSql", "toListItem", "cursorOf", "limitOf"]) expect(Object.keys(ops)).not.toContain(hidden);
  });
});

describe("listSalesOrders", () => {
  it("boş liste: eşleşen siparişi olmayan sorgu { items: [], next: null } (fikstür tenant'ı tek OPEN sipariş içerir)", async () => {
    expect(await listSalesOrders(owner(C), { status: "CLOSED" })).toEqual({ items: [], next: null });
    expect(await listSalesOrders(owner(C), { status: "CANCELLED", limit: 1 })).toEqual({ items: [], next: null });
  });

  it("satırlar: numara, müşteri referansı, durum, oluşturma zamanı, satır sayısı, açık satır sayısı", async () => {
    const item = await mkItem(A);
    const o = await mkOrder(A, [{ item, qty: "3" }, { item, qty: "2" }], "MUS-77");
    const none = await mkOrder(A, [{ item, qty: "1" }], null);
    const page = await listSalesOrders(picker(A), { limit: 100 });
    const row = page.items.find((x) => x.id === o.id);
    expect(row).toMatchObject({ number: o.number, customerRef: "MUS-77", status: "OPEN", version: 1, lineCount: 2, openLineCount: 2 });
    expect(row?.createdKey).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(page.items.find((x) => x.id === none.id)?.customerRef).toBeNull();
    // Bir satır tamamen iptal → açık satır sayısı 1'e düşer, sipariş OPEN kalır.
    await cancelOrderLine(cmd(A), { lineId: o.lineIds[0] as string, quantity: "3", reason: "test" });
    const after = (await listSalesOrders(owner(A), { limit: 100 })).items.find((x) => x.id === o.id);
    expect(after).toMatchObject({ status: "OPEN", lineCount: 2, openLineCount: 1 });
  });

  it("durum süzgeci: CANCELLED yalnız iptal edilmiş siparişi, OPEN açık olanı getirir; bilinmeyen durum VALIDATION_FAILED", async () => {
    const item = await mkItem(A);
    const open = await mkOrder(A, [{ item, qty: "2" }]);
    const cancelled = await mkOrder(A, [{ item, qty: "2" }]);
    await cancelOrderLine(cmd(A), { lineId: cancelled.lineIds[0] as string, quantity: "2", reason: "test" });
    const c = await listSalesOrders(owner(A), { status: "CANCELLED", limit: 100 });
    expect(c.items.every((x) => x.status === "CANCELLED")).toBe(true);
    expect(c.items.map((x) => x.id)).toContain(cancelled.id);
    expect(c.items.map((x) => x.id)).not.toContain(open.id);
    expect(c.items.find((x) => x.id === cancelled.id)).toMatchObject({ lineCount: 1, openLineCount: 0 });
    const o = await listSalesOrders(owner(A), { status: "OPEN", limit: 100 });
    expect(o.items.every((x) => x.status === "OPEN")).toBe(true);
    expect(o.items.map((x) => x.id)).toContain(open.id);
    expect((await failure(listSalesOrders(owner(A), { status: "BOGUS" as never }))).code).toBe("VALIDATION_FAILED");
  });

  it("keyset sayfalama: tam sınır (limit = kalan) next null; sayfalar çakışmaz ve eksiksizdir; limit/imleç doğrulanır", async () => {
    const item = await mkItem(C);
    const ids = (await listSalesOrders(owner(C), { limit: 100 })).items.map((x) => x.id); // fikstürün kendi siparişi dahil
    for (let i = 0; i < 5; i++) ids.push((await mkOrder(C, [{ item, qty: "1" }])).id);
    const total = ids.length;
    // Sınır: limit = toplam → tek sayfa, next null; limit = toplam − 1 → next dolu.
    const full = await listSalesOrders(owner(C), { limit: total });
    expect(full.items).toHaveLength(total);
    expect(full.next).toBeNull();
    expect((await listSalesOrders(owner(C), { limit: total - 1 })).next).not.toBeNull();
    const seen: string[] = [];
    let afterKey: { createdKey: string; id: string } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const p = await listSalesOrders(owner(C), { limit: 2, ...(afterKey === undefined ? {} : { afterKey }) });
      expect(p.items.length).toBeLessThanOrEqual(2);
      seen.push(...p.items.map((x) => x.id));
      if (p.next === null) break;
      afterKey = p.next;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual([...ids].sort());
    for (const bad of [0, -1, 1.5, ORDER_LIST_LIMIT_MAX + 1]) {
      expect((await failure(listSalesOrders(owner(C), { limit: bad }))).code).toBe("VALIDATION_FAILED");
    }
    for (const bad of [
      { createdKey: "x", id: randomUUID() },
      { createdKey: "2026-02-31T00:00:00.000000Z", id: randomUUID() },
      { createdKey: "2026-01-01T25:00:00.000000Z", id: randomUUID() },
      { createdKey: "2026-01-01T00:00:00.000000Z", id: "not-a-uuid" },
    ]) {
      expect((await failure(listSalesOrders(owner(C), { afterKey: bad }))).code).toBe("VALIDATION_FAILED");
    }
  });

  it("üyelik: başka tenant'ın üyesi (A'da üyeliği yok) reddedilir", async () => {
    const e = await failure(listSalesOrders({ db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(e.code);
    const d = await failure(getSalesOrder({ db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, { orderId: randomUUID() }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(d.code);
  });
});

describe("getSalesOrder: satır başına miktar dökümü (mevcut komutlarla kurulan senaryo)", () => {
  it("tahsis → kısmi tahsis → toplama → kısmi sevk → iade → iptal sonrası her adımda döküm birebir; miktarlar dizgi", async () => {
    const X = await mkItem(A);
    const Y = await mkItem(A);
    const R01 = await mkLoc(A, A.warehouseId, "STORAGE");
    const RCV = await mkLoc(A, A.warehouseId, "RECEIVING");
    const SEVK = await mkLoc(A, A.warehouseId, "STAGING", `0S${hex(8)}`);
    await stockIn(A, A.warehouseId, X, R01, "10");
    await stockIn(A, A.warehouseId, Y, R01, "2"); // Y: 5 istenir, yalnız 2 tahsis edilebilir
    const o = await mkOrder(A, [{ item: X, qty: "6" }, { item: Y, qty: "5" }]);
    const [LX, LY] = o.lineIds as [string, string];
    const get = () => getSalesOrder(picker(A), { orderId: o.id });
    const dump = (d: Awaited<ReturnType<typeof get>>) =>
      d.lines.map((l) => [l.requested, l.allocated, l.picked, l.shipped, l.open, l.returned, l.cancelled].map((v) => v));
    const z = "0.000000";

    // Kurulum sonrası: hiçbiri tahsisli değil.
    let d = await get();
    expect(d).toMatchObject({ id: o.id, number: o.number, status: "OPEN", customerRef: "T314a-MUS", lineCount: 2, openLineCount: 2 });
    expect(d.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(d.lines[0]).toMatchObject({ id: LX, itemId: X, itemName: "T314a urun", unitId: A.unitId });
    expect(d.lines[0]?.unitCode).toEqual(expect.any(String));
    expect(d.lines[0]?.unitName).toEqual(expect.any(String));
    expect(dump(d)).toEqual([
      ["6.000000", z, z, z, "6.000000", z, z],
      ["5.000000", z, z, z, "5.000000", z, z],
    ]);

    // Kısmi tahsis: X tam (6), Y kısmi (2 / 5).
    await reserveOrder(cmd(A), { orderId: o.id });
    expect(dump(await get())).toEqual([
      ["6.000000", "6.000000", z, z, "6.000000", z, z],
      ["5.000000", "2.000000", z, z, "5.000000", z, z],
    ]);

    // Toplama: X'in 6'sı toplanır, Y'nin 2'sinden 1'i.
    const a = await createPickAssignment(cmd(A), { orderIds: [o.id] });
    const tasks = await q<{ id: string; item_id: string; quantity: string }>("SELECT id, item_id, quantity::text AS quantity FROM public.warehouse_tasks WHERE tenant_id=$1 AND group_id=$2", [
      A.tenantId, a.groupId,
    ]);
    const tx = tasks.find((t) => t.item_id === X) as { id: string };
    const ty = tasks.find((t) => t.item_id === Y) as { id: string };
    await pick(A, tx.id, "6", R01, X);
    await pick(A, ty.id, "2", R01, Y);
    expect(dump(await get())).toEqual([
      ["6.000000", "6.000000", "6.000000", z, "6.000000", z, z],
      ["5.000000", "2.000000", "2.000000", z, "5.000000", z, z],
    ]);
    expect(SEVK).toBeTruthy();

    // Kısmi sevk: X'ten 4 → sevk 4, açık 2, tahsisli/toplanan 2.
    await shipOrder(cmd(A), { orderId: o.id, lines: [{ orderLineId: LX, quantity: "4" }] });
    expect(dump(await get())).toEqual([
      ["6.000000", "2.000000", "2.000000", "4.000000", "2.000000", z, z],
      ["5.000000", "2.000000", "2.000000", z, "5.000000", z, z],
    ]);

    // İade 1: açık miktar değişmez, yalnız iade artar.
    await createCustomerReturn(cmd(A), { orderLineId: LX, quantity: "1", locationId: RCV, reason: "test iade" });
    expect(dump(await get())).toEqual([
      ["6.000000", "2.000000", "2.000000", "4.000000", "2.000000", "1.000000", z],
      ["5.000000", "2.000000", "2.000000", z, "5.000000", z, z],
    ]);

    // Y satırının kalan 3'ü iptal: iptal 3, açık 2 (iptal edilen satır listeden gizlenmez).
    await cancelOrderLine(cmd(A), { lineId: LY, quantity: "3", reason: "test iptal" });
    d = await get();
    expect(dump(d)).toEqual([
      ["6.000000", "2.000000", "2.000000", "4.000000", "2.000000", "1.000000", z],
      ["5.000000", "2.000000", "2.000000", z, "2.000000", z, "3.000000"],
    ]);
    expect(d.lines).toHaveLength(2);
    // Her alan metindir (float yok).
    for (const l of d.lines) for (const v of [l.requested, l.allocated, l.picked, l.shipped, l.open, l.returned, l.cancelled]) expect(typeof v).toBe("string");

    // Döküm DB'deki satırla birebir (bağımsız okuma).
    const raw = await q<{ req: string; shp: string; ret: string; can: string }>(
      "SELECT requested_quantity::text AS req, shipped_quantity::text AS shp, returned_quantity::text AS ret, cancelled_quantity::text AS can FROM public.sales_order_lines WHERE order_id=$1 ORDER BY line_no", [o.id],
    );
    expect(d.lines.map((l) => [l.requested, l.shipped, l.returned, l.cancelled])).toEqual(raw.map((r) => [r.req, r.shp, r.ret, r.can]));
  }, 240_000);
});

describe("tenant yalıtımı", () => {
  it("başka tenant'ın sipariş kimliği, olmayan kimlik ile AYNI NOT_FOUND; liste yalnızca kendi tenant'ını gösterir", async () => {
    const bItem = await mkItem(B);
    const bOrder = await mkOrder(B, [{ item: bItem, qty: "7" }]);
    const missing = await failure(getSalesOrder(owner(A), { orderId: randomUUID() }));
    const cross = await failure(getSalesOrder(owner(A), { orderId: bOrder.id }));
    expect(cross.code).toBe("NOT_FOUND");
    expect(shape(cross)).toEqual(shape(missing));
    expect((await listSalesOrders(owner(A), { limit: 100 })).items.map((x) => x.id)).not.toContain(bOrder.id);
    expect((await listSalesOrders(owner(B), { limit: 100 })).items.map((x) => x.id)).toContain(bOrder.id);
    // Doğrulama: kimlik biçimi bozuksa VALIDATION_FAILED (varlık bilgisi vermez).
    expect((await failure(getSalesOrder(owner(A), { orderId: "x" }))).code).toBe("VALIDATION_FAILED");
    // B kendi siparişini görür.
    expect((await getSalesOrder(owner(B), { orderId: bOrder.id })).id).toBe(bOrder.id);
  });
});

describe("depo kapsamı (A-46, A-314a-2)", () => {
  it("kapsam dışı depodaki sipariş: liste süzer, tekil okuma olmayanla AYNI NOT_FOUND; bayrak kapalıyken görünür; tahsissiz sipariş kapsamlıya görünmez; mutasyon testi", async () => {
    const inItem = await mkItem(A);
    const outItem = await mkItem(A);
    const inLoc = await mkLoc(A, A.warehouseId, "STORAGE");
    const outLoc = await mkLoc(A, otherWh, "STORAGE");
    await stockIn(A, A.warehouseId, inItem, inLoc, "5");
    await stockIn(A, otherWh, outItem, outLoc, "5");
    const inOrder = await mkOrder(A, [{ item: inItem, qty: "2" }]);
    const outOrder = await mkOrder(A, [{ item: outItem, qty: "2" }]);
    const unlinked = await mkOrder(A, [{ item: inItem, qty: "1" }]);
    await reserveOrder(cmd(A), { orderId: inOrder.id });
    await reserveOrder(cmd(A), { orderId: outOrder.id });
    expect(Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.reservations r JOIN public.stock_dimensions d ON d.tenant_id=r.tenant_id AND d.id=r.stock_dimension_id JOIN public.locations l ON l.tenant_id=d.tenant_id AND l.id=d.location_id WHERE r.tenant_id=$1 AND l.warehouse_id=$2", [A.tenantId, otherWh]))[0]?.c)).toBeGreaterThan(0);
    await setMembershipWarehouseScopes(owner(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });
    const prev = process.env.WAREHOUSE_SCOPE_ENABLED;
    try {
      delete process.env.WAREHOUSE_SCOPE_ENABLED;
      expect((await getSalesOrder(picker(A), { orderId: outOrder.id })).id).toBe(outOrder.id);
      expect((await listSalesOrders(picker(A), { limit: 100 })).items.map((x) => x.id)).toContain(unlinked.id);
      process.env.WAREHOUSE_SCOPE_ENABLED = "true";
      const listed = (await listSalesOrders(picker(A), { limit: 100 })).items.map((x) => x.id);
      expect(listed).toContain(inOrder.id);
      expect(listed).not.toContain(outOrder.id);
      expect(listed).not.toContain(unlinked.id); // A-314a-2: bağsız sipariş kapsamlıya görünmez
      const missing = await failure(getSalesOrder(picker(A), { orderId: randomUUID() }));
      const out = await failure(getSalesOrder(picker(A), { orderId: outOrder.id }));
      const hidden = await failure(getSalesOrder(picker(A), { orderId: unlinked.id }));
      expect(out.code).toBe("NOT_FOUND");
      expect(shape(out)).toEqual(shape(missing));
      expect(shape(hidden)).toEqual(shape(missing));
      expect((await getSalesOrder(picker(A), { orderId: inOrder.id })).id).toBe(inOrder.id);
      // Yönetici kapsamdan muaf.
      const adm2 = (await listSalesOrders(owner(A), { limit: 100 })).items.map((x) => x.id);
      expect(adm2).toEqual(expect.arrayContaining([inOrder.id, outOrder.id, unlinked.id]));
      expect((await getSalesOrder(owner(A), { orderId: outOrder.id })).id).toBe(outOrder.id);

      // MUTASYON: kapsam koşulu olmayan eşdeğer sorgu kapsam dışı siparişi döndürür → yukarıdaki `not.toContain` iddiası ayırt edicidir.
      const mutated = await runTenantQuery({ ...picker(A), permission: "stock.view" }, async (tx, m) => {
        expect(await resolveWarehouseScope(tx, m)).toEqual([A.warehouseId]);
        return tx.execute<{ id: string }>(sql`SELECT o.id FROM public.sales_orders o WHERE o.tenant_id = ${m.tenantId}::uuid`);
      });
      expect(mutated.map((r) => r.id)).toEqual(expect.arrayContaining([outOrder.id, unlinked.id]));
    } finally {
      if (prev === undefined) delete process.env.WAREHOUSE_SCOPE_ENABLED;
      else process.env.WAREHOUSE_SCOPE_ENABLED = prev;
    }
  }, 180_000);
});
