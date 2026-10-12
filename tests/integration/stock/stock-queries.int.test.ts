// T-332a: stok sorguları (stockByItem / stockByLocation): stock.view, depo kapsamı, tenant yalıtımı, keyset. GERÇEK wms_app bağlantısı + RLS;
// fikstür yalnızca DATABASE_URL_DIRECT ile (sentetik, G-09). Akış testi gerçek komutlarla (kabul → kalite onayı → yerleştirme → rezervasyon) kurulur;
// boyut/sayfalama/kapsam testleri bakiye satırını doğrudan yazar (yalnızca OKUMA sorgusu sınanır). Bağımsız kanıt: AC-04 satırı (tenant yalıtımı).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/domain/node_modules/drizzle-orm/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { runTenantQuery } from "../../../packages/domain/src/identity/access.ts";
import { resolveWarehouseScope } from "../../../packages/domain/src/warehouse/scope.ts";
import { createWarehouse, setMembershipWarehouseScopes } from "../../../packages/domain/src/warehouse/index.ts";
import { approveCount, approveQuality, cancelCount, createInboundReceipt, openInboundReceipt, postCountAdjustment, putaway, receiveGoods, recordCount, startCount, submitCount } from "../../../packages/domain/src/operations/index.ts";
import {
  STOCK_QUERY_LIMIT_MAX,
  approveDocument,
  createStockDocument,
  postDocument,
  reserve,
  stockByItem,
  stockByLocation,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let otherWh: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const hex = (n: number): string => randomUUID().replaceAll("-", "").slice(0, n);
const owner = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });
const cmd = (w: TenantWorld): StockDocCallParams => ({ ...owner(w), clientKey: randomUUID(), retry: NO_WAIT });

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
const shape = (e: AppError) => ({ code: e.code, detail: e.detail, message: e.message, retryable: e.retryable });

async function mkItem(w: TenantWorld, tracking: "NONE" | "LOT" = "NONE"): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T332 urun',$4,$5,0)", [
    w.tenantId, id, `I-${hex(10)}`, w.unitId, tracking,
  ]);
  return id;
}
async function mkLoc(w: TenantWorld, warehouseId: string, kind: "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT", code = `L-${hex(10)}`, pickBlocked = false): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T332 lok',0,$5,$6)", [
    w.tenantId, id, warehouseId, code, kind, pickBlocked,
  ]);
  return id;
}
interface Dim { status?: "AVAILABLE" | "QUARANTINE" | "DAMAGED" | "BLOCKED"; lotId?: string; ownerId?: string; huId?: string }
const line = (w: TenantWorld, item: string, quantity: string, extra: Record<string, unknown>) => ({
  itemId: item, unitId: w.unitId, quantity, conversionFactor: "1", baseQuantity: quantity, ...extra,
});
async function postDoc(w: TenantWorld, kind: "STOCK_IN" | "STOCK_OUT", lines: ReturnType<typeof line>[], warehouseId: string): Promise<string[]> {
  const c = await createStockDocument(cmd(w), { kind, warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(cmd(w), { documentId: id, expectedVersion: 1 });
  return [id, ...(await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id=$1 ORDER BY line_no", [id])).map((r) => r.id)];
}
/**
 * Gerçek komutlarla stok: STOCK_IN işlenir (+ isteğe bağlı rezervasyon). Bakiyeye doğrudan yazılmaz (G-01; defter-bakiye tetikleyicisi de reddeder).
 * `quantity = "0"`: 1 girilip 1 çıkarılır (sıfır bakiyeli boyut kalır). Boyut kimliği döner.
 */
async function putStock(w: TenantWorld, item: string, loc: string, quantity: string, reserved = "0", d: Dim = {}): Promise<void> {
  const wh = (await q<{ warehouse_id: string }>("SELECT warehouse_id FROM public.locations WHERE id=$1", [loc]))[0]?.warehouse_id as string;
  const dim = { lotId: d.lotId ?? null, stockStatus: d.status ?? "AVAILABLE", inventoryOwnerId: d.ownerId ?? null, handlingUnitId: d.huId ?? null };
  const inQty = quantity === "0" ? "1" : quantity;
  const [inDoc] = await postDoc(w, "STOCK_IN", [line(w, item, inQty, { targetLocationId: loc, ...dim })], wh);
  const post = await postDocument(cmd(w), { documentId: inDoc as string, expectedVersion: (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [inDoc]))[0]?.version as number });
  expect(post.status).toBe("POSTED");
  if (quantity === "0" || reserved !== "0") {
    const [outDoc, outLine] = await postDoc(w, "STOCK_OUT", [line(w, item, quantity === "0" ? "1" : reserved, { sourceLocationId: loc, ...dim })], wh);
    if (quantity === "0") {
      await postDocument(cmd(w), { documentId: outDoc as string, expectedVersion: (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [outDoc]))[0]?.version as number });
    } else {
      await reserve(cmd(w), {
        documentLineId: outLine as string,
        allocations: [{ dimension: { locationId: loc, lotId: d.lotId ?? null, stockStatus: d.status ?? "AVAILABLE", inventoryOwnerId: d.ownerId ?? null, handlingUnitId: d.huId ?? null }, quantity: reserved }],
      });
    }
  }
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A332");
  B = await seedWorld(adm, reg, "B332");
  otherWh = (await createWarehouse(owner(A), { code: `s${hex(8)}`, name: "T332 ikinci depo" })).warehouseId;
}, 120_000);

afterEach(() => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
});
afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("kabul + kalite + yerleştirme + rezervasyon sonrası değerler (gerçek komutlar)", () => {
  it("her adımda fiziksel/rezerve/kullanılabilir ve durum ayrımı birebir; byLocation aynı değerleri verir", async () => {
    await q("UPDATE public.tenant_settings SET receiving_qc_enabled = true WHERE tenant_id = $1", [A.tenantId]);
    const item = await mkItem(A);
    const kabul = await mkLoc(A, A.warehouseId, "RECEIVING", `KB-${hex(6)}`);
    const raf = await mkLoc(A, A.warehouseId, "STORAGE", `RF-${hex(6)}`);
    const c = await createInboundReceipt(cmd(A), { warehouseId: A.warehouseId, supplierRef: "T332", lines: [{ itemId: item, unitId: A.unitId, expectedQuantity: "10" }] });
    const receiptId = c.documentId as string;
    await openInboundReceipt(cmd(A), { receiptId, expectedVersion: 1 });
    const lineId = (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id=$1", [receiptId]))[0]?.id as string;

    // Kabul öncesi: hiç satır yok, toplamlar sıfır.
    const empty = await stockByItem(picker(A), { itemId: item });
    expect(empty.rows).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    expect(empty.totals).toMatchObject({ physical: "0.000000", reserved: "0.000000", available: "0.000000" });
    expect(empty.item).toMatchObject({ id: item, name: "T332 urun", baseUnit: { id: A.unitId } });

    // 1) Kabul 10 (2 hasarlı): KABUL·QUARANTINE 8 + KABUL·DAMAGED 2; hiçbiri kullanılabilir değil.
    await receiveGoods(cmd(A), { receiptId, lines: [{ lineId, received: "10", damaged: "2", locationId: kabul }] });
    const s1 = await stockByItem(picker(A), { itemId: item });
    expect(s1.rows.map((r) => [r.locationId, r.stockStatus, r.physical, r.reserved, r.available])).toEqual(
      expect.arrayContaining([
        [kabul, "QUARANTINE", "8.000000", "0.000000", "0.000000"],
        [kabul, "DAMAGED", "2.000000", "0.000000", "0.000000"],
      ]),
    );
    expect(s1.rows).toHaveLength(2);
    expect(s1.rows[0]).toMatchObject({ warehouseId: A.warehouseId, locationCode: expect.stringMatching(/^KB-/), locationKind: "RECEIVING", pickBlocked: false, lot: null, serial: null, owner: null, handlingUnit: null });
    expect(s1.totals).toEqual({
      physical: "10.000000", reserved: "0.000000", available: "0.000000",
      physicalByStatus: { AVAILABLE: "0.000000", QUARANTINE: "8.000000", DAMAGED: "2.000000", BLOCKED: "0.000000" }, countLockedExcluded: false,
    });

    // 2) Kalite onayı: 8 → AVAILABLE (KABUL türü RECEIVING olduğundan hâlâ kullanılabilir değil).
    await approveQuality(cmd(A), { receiptId });
    const s2 = await stockByItem(picker(A), { itemId: item });
    expect(s2.rows.map((r) => [r.stockStatus, r.physical, r.available]).sort()).toEqual([
      ["AVAILABLE", "8.000000", "0.000000"],
      ["DAMAGED", "2.000000", "0.000000"],
    ]);

    // 3) Yerleştirme 5 → RAF: RAF·AVAILABLE 5 (kullanılabilir 5), KABUL·AVAILABLE 3.
    await putaway(cmd(A), { sourceLocationId: kabul, targetLocationId: raf, itemId: item, quantity: "5" });
    const s3 = await stockByItem(picker(A), { itemId: item });
    const at = (rows: typeof s3.rows, loc: string, st: string) => rows.find((r) => r.locationId === loc && r.stockStatus === st);
    expect(at(s3.rows, raf, "AVAILABLE")).toMatchObject({ physical: "5.000000", reserved: "0.000000", available: "5.000000", locationKind: "STORAGE" });
    expect(at(s3.rows, kabul, "AVAILABLE")).toMatchObject({ physical: "3.000000", available: "0.000000" });
    expect(s3.totals).toMatchObject({ physical: "10.000000", reserved: "0.000000", available: "5.000000" });

    // 4) Rezervasyon 2 (RAF): fiziksel 5, rezerve 2, kullanılabilir 3.
    const out = await createStockDocument(cmd(A), {
      kind: "STOCK_OUT",
      warehouseId: A.warehouseId,
      lines: [{ itemId: item, unitId: A.unitId, quantity: "2", conversionFactor: "1", baseQuantity: "2", sourceLocationId: raf }],
    });
    await approveDocument(cmd(A), { documentId: out.documentId as string, expectedVersion: 1 });
    const outLine = (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id=$1", [out.documentId]))[0]?.id as string;
    await reserve(cmd(A), { documentLineId: outLine, allocations: [{ dimension: { locationId: raf }, quantity: "2" }] });
    const s4 = await stockByItem(picker(A), { itemId: item });
    expect(at(s4.rows, raf, "AVAILABLE")).toMatchObject({ physical: "5.000000", reserved: "2.000000", available: "3.000000" });
    expect(s4.totals).toEqual({
      physical: "10.000000", reserved: "2.000000", available: "3.000000",
      physicalByStatus: { AVAILABLE: "8.000000", QUARANTINE: "0.000000", DAMAGED: "2.000000", BLOCKED: "0.000000" }, countLockedExcluded: false,
    });
    // Sıra: depo kodu, lokasyon kodu (KB- < RF-), boyut kimliği.
    expect(s4.rows.map((r) => r.locationCode.slice(0, 3))).toEqual(["KB-", "KB-", "RF-"]);

    // byLocation aynı değerleri ürün başına verir.
    const l = await stockByLocation(picker(A), { locationId: raf });
    expect(l.location).toMatchObject({ id: raf, warehouseId: A.warehouseId, locationKind: "STORAGE" });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0]).toMatchObject({ itemId: item, itemName: "T332 urun", baseUnit: { id: A.unitId, code: expect.any(String), name: expect.any(String) }, physical: "5.000000", reserved: "2.000000", available: "3.000000" });
  });
});

describe("boyutlar, sıfır bakiye, bloke lokasyon", () => {
  it("lot/sahip/taşıma birimi ayrı satır; sıfır bakiye gizli; pick_blocked ve KARANTINA kullanılabilir değil; BLOCKED durumu ayrı", async () => {
    const item = await mkItem(A, "LOT");
    const lotA = randomUUID();
    const lotB = randomUUID();
    await q("INSERT INTO public.lots (tenant_id, id, item_id, lot_code, expiry_date) VALUES ($1,$2,$3,'LOT-A','2030-01-31'), ($1,$4,$3,'LOT-B',NULL)", [A.tenantId, lotA, item, lotB]);
    const raf = await mkLoc(A, A.warehouseId, "STORAGE", `D-${hex(6)}`);
    const blocked = await mkLoc(A, A.warehouseId, "STORAGE", `E-${hex(6)}`, true);
    await putStock(A, item, raf, "6", "1", { lotId: lotA });
    await putStock(A, item, raf, "4", "0", { lotId: lotB, ownerId: A.ownerId, huId: A.handlingUnitId });
    await putStock(A, item, raf, "0", "0", { lotId: lotA, status: "DAMAGED" }); // sıfır: gösterilmez
    await putStock(A, item, raf, "3", "0", { lotId: lotB, status: "QUARANTINE" });
    await putStock(A, item, raf, "2", "0", { lotId: lotB, status: "BLOCKED" });
    await putStock(A, item, blocked, "7", "0", { lotId: lotA });

    const r = await stockByItem(owner(A), { itemId: item });
    expect(r.rows).toHaveLength(5);
    const lotRow = r.rows.find((x) => x.lot?.code === "LOT-A" && x.locationId === raf);
    expect(lotRow).toMatchObject({ lot: { id: lotA, code: "LOT-A", expiryDate: "2030-01-31" }, physical: "6.000000", reserved: "1.000000", available: "5.000000", owner: null, handlingUnit: null });
    const full = r.rows.find((x) => x.owner !== null);
    expect(full).toMatchObject({ lot: { id: lotB, expiryDate: null }, owner: { id: A.ownerId }, handlingUnit: { id: A.handlingUnitId, kind: expect.stringMatching(/KOLI|PALET/) }, physical: "4.000000", available: "4.000000" });
    expect(r.rows.find((x) => x.stockStatus === "QUARANTINE")).toMatchObject({ physical: "3.000000", available: "0.000000" });
    expect(r.rows.find((x) => x.stockStatus === "BLOCKED")).toMatchObject({ physical: "2.000000", available: "0.000000" });
    expect(r.rows.find((x) => x.locationId === blocked)).toMatchObject({ pickBlocked: true, physical: "7.000000", available: "0.000000" });
    expect(r.rows.some((x) => x.stockStatus === "DAMAGED")).toBe(false);
    expect(r.totals).toEqual({
      physical: "22.000000", reserved: "1.000000", available: "9.000000",
      physicalByStatus: { AVAILABLE: "17.000000", QUARANTINE: "3.000000", DAMAGED: "0.000000", BLOCKED: "2.000000" }, countLockedExcluded: false,
    });
    const byLoc = await stockByLocation(owner(A), { locationId: blocked });
    expect(byLoc.location.pickBlocked).toBe(true);
    expect(byLoc.rows.map((x) => x.available)).toEqual(["0.000000"]);
  });
});

describe("keyset sayfalama", () => {
  it("sayfalar çakışmaz, eksiksiz ve sıralıdır (ürün ve lokasyon); toplamlar sayfadan bağımsızdır; limit/imleç doğrulanır", async () => {
    const item = await mkItem(A);
    const locs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const loc = await mkLoc(A, A.warehouseId, "STORAGE", `P-${i}-${hex(4)}`);
      locs.push(loc);
      await putStock(A, item, loc, "2");
    }
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (let guard = 0; guard < 20; guard++) {
      const p = await stockByItem(owner(A), { itemId: item, limit: 2, ...(after === undefined ? {} : { afterKey: after }) });
      expect(p.rows.length).toBeLessThanOrEqual(2);
      expect(p.totals.physical).toBe("10.000000");
      seen.push(...p.rows.map((x) => x.locationId));
      pages++;
      if (p.nextCursor === null) break;
      after = p.nextCursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(locs); // kod sırası P-0…P-4
    expect(new Set(seen).size).toBe(5);

    // byLocation: bir rafta 5 ürün.
    const shelf = await mkLoc(A, A.warehouseId, "STORAGE", `Q-${hex(6)}`);
    const items: string[] = [];
    for (let i = 0; i < 5; i++) {
      const it = await mkItem(A);
      items.push(it);
      await putStock(A, it, shelf, "1");
    }
    const codes = new Map((await q<{ id: string; code: string }>("SELECT id, code FROM public.items WHERE id = ANY($1::uuid[])", [items])).map((x) => [x.id, x.code]));
    const expected = [...items].sort((a, b) => ((codes.get(a) as string) < (codes.get(b) as string) ? -1 : 1));
    const got: string[] = [];
    let a2: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const p = await stockByLocation(owner(A), { locationId: shelf, limit: 2, ...(a2 === undefined ? {} : { afterKey: a2 }) });
      got.push(...p.rows.map((x) => x.itemId));
      if (p.nextCursor === null) break;
      a2 = p.nextCursor;
    }
    expect(got).toEqual(expected);

    for (const bad of [0, -1, 1.5, STOCK_QUERY_LIMIT_MAX + 1]) {
      expect((await failure(stockByItem(owner(A), { itemId: item, limit: bad }))).code).toBe("VALIDATION_FAILED");
      expect((await failure(stockByLocation(owner(A), { locationId: shelf, limit: bad }))).code).toBe("VALIDATION_FAILED");
    }
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of ["x!", "", b64("a"), b64(["a", "b"]), b64(["a", "b", "not-a-uuid"]), b64([1, "b", randomUUID()]), b64(["", "b", randomUUID()])]) {
      expect((await failure(stockByItem(owner(A), { itemId: item, afterKey: bad }))).code).toBe("VALIDATION_FAILED");
    }
    expect((await failure(stockByLocation(owner(A), { locationId: shelf, afterKey: b64(["a", "b", randomUUID()]) }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(stockByItem(owner(A), { itemId: "x" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(stockByLocation(owner(A), { locationId: "x" }))).code).toBe("VALIDATION_FAILED");
  });
});

describe("tenant yalıtımı (AC-04 okuma katmanı)", () => {
  it("başka tenant'ın ürünü/lokasyonu ile olmayan kimlik aynı NOT_FOUND; kendi tenant'ında B stoğu görünmez; yan etki yok", async () => {
    const bItem = await mkItem(B);
    const bLoc = await mkLoc(B, B.warehouseId, "STORAGE");
    await putStock(B, bItem, bLoc, "9");
    const ledgerBefore = (await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.n;
    const auditBefore = (await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.n;
    const balBefore = (await q<{ s: string }>("SELECT COALESCE(sum(quantity + reserved_quantity),0)::text AS s FROM public.stock_balances WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.s;

    const foreignItem = shape(await failure(stockByItem(owner(A), { itemId: bItem })));
    const missingItem = shape(await failure(stockByItem(owner(A), { itemId: randomUUID() })));
    expect(foreignItem).toEqual(missingItem);
    expect(foreignItem.code).toBe("NOT_FOUND");
    const foreignLoc = shape(await failure(stockByLocation(owner(A), { locationId: bLoc })));
    const missingLoc = shape(await failure(stockByLocation(owner(A), { locationId: randomUUID() })));
    expect(foreignLoc).toEqual(missingLoc);
    expect(foreignLoc.code).toBe("NOT_FOUND");
    expect(foreignLoc).toEqual({ ...foreignItem });

    // B kendi verisini görür.
    expect((await stockByItem(owner(B), { itemId: bItem })).totals.physical).toBe("9.000000");
    expect((await stockByLocation(owner(B), { locationId: bLoc })).rows).toHaveLength(1);

    const same = (await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.n;
    expect(same).toBe(ledgerBefore);
    expect((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.n).toBe(auditBefore);
    expect((await q<{ s: string }>("SELECT COALESCE(sum(quantity + reserved_quantity),0)::text AS s FROM public.stock_balances WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]))[0]?.s).toBe(balBefore);
  });

  it("üyeliği olmayan kullanıcı (B üyesi, A slug'ı) reddedilir", async () => {
    // NOT: `stock.view` tüm rollerde vardır; izin reddi yalnızca üyeliksiz kullanıcı için sınanabilir (tenant varlığı sızmaz).
    const e = await failure(stockByItem({ db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, { itemId: A.itemId }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(e.code);
    const e2 = await failure(stockByLocation({ db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, { locationId: A.rootLocationId }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(e2.code);
  });
});

describe("depo kapsamı (A-46)", () => {
  it("kapsam dışı depo stoğu satırda ve toplamda görünmez; kapsam dışı lokasyon başka tenant/yok ile aynı NOT_FOUND; bayrak kapalıyken görünür; mutasyon süzgecin gerekli olduğunu gösterir", async () => {
    const item = await mkItem(A);
    const inLoc = await mkLoc(A, A.warehouseId, "STORAGE", `S-${hex(6)}`);
    const outLoc = await mkLoc(A, otherWh, "STORAGE", `T-${hex(6)}`);
    await putStock(A, item, inLoc, "4");
    await putStock(A, item, outLoc, "6");
    await setMembershipWarehouseScopes(owner(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });

    // Bayrak kapalı: kapsam uygulanmaz.
    const off = await stockByItem(picker(A), { itemId: item });
    expect(off.rows.map((r) => r.locationId).sort()).toEqual([inLoc, outLoc].sort());
    expect(off.totals.physical).toBe("10.000000");

    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const scoped = await stockByItem(picker(A), { itemId: item });
    expect(scoped.rows.map((r) => r.locationId)).toEqual([inLoc]);
    expect(scoped.totals).toMatchObject({ physical: "4.000000", available: "4.000000" });
    expect((await stockByLocation(picker(A), { locationId: inLoc })).rows).toHaveLength(1);

    const outShape = shape(await failure(stockByLocation(picker(A), { locationId: outLoc })));
    const missingShape = shape(await failure(stockByLocation(picker(A), { locationId: randomUUID() })));
    const bLoc = await mkLoc(B, B.warehouseId, "STORAGE");
    const foreignShape = shape(await failure(stockByLocation(picker(A), { locationId: bLoc })));
    expect(outShape.code).toBe("NOT_FOUND");
    expect(outShape).toEqual(missingShape);
    expect(outShape).toEqual(foreignShape);

    // Yönetici kapsamdan muaf.
    expect((await stockByItem(owner(A), { itemId: item })).totals.physical).toBe("10.000000");
    expect((await stockByLocation(owner(A), { locationId: outLoc })).rows).toHaveLength(1);

    // MUTASYON: kapsam süzgeci olmayan eşdeğer sorgu kapsam dışı satırı döndürür → yukarıdaki iddialar ayırt edicidir.
    const mutated = await runTenantQuery({ ...picker(A), permission: "stock.view" }, async (tx, m) => {
      expect(await resolveWarehouseScope(tx, m)).toEqual([A.warehouseId]);
      return tx.execute<{ location_id: string }>(
        sql`SELECT d.location_id FROM public.stock_dimensions d WHERE d.tenant_id = ${m.tenantId}::uuid AND d.item_id = ${item}::uuid`,
      );
    });
    expect(mutated.map((r) => r.location_id)).toContain(outLoc);
  });
});

// T-334 (A-334-1): COUNTING kilidindeki lokasyonun miktarı count_diff.approve sahibi olmayana hiçbir stok okumasında görünmez.
describe("kör sayım stok okumalarında (T-334)", () => {
  // A-335-4: yalnız-COUNTER stock.view taşımaz (aşağıda FORBIDDEN); maske ikinci katmandır, çoklu rollü sayımcıyı (COUNTER+PICKER) korur.
  const ROLES = { COUNTER: ["COUNTER", "PICKER"], PICKER: ["PICKER"] } as const;
  async function who(w: TenantWorld, roles: readonly string[]) {
    const u = await mkUser(adm, reg, `T334 ${roles.join("+")}`);
    await mkMembership(adm, w.tenantId, u, { roles: [...roles] });
    return { db: app, principal: { userId: u, mfaVerified: true }, tenantSlug: w.slug };
  }
  async function setup() {
    const item = await mkItem(A);
    const locked = await mkLoc(A, A.warehouseId, "STORAGE", `KL-${hex(6)}`);
    const free = await mkLoc(A, A.warehouseId, "STORAGE", `SB-${hex(6)}`);
    await putStock(A, item, locked, "7", "2");
    await putStock(A, item, free, "3");
    const sid = (await startCount(cmd(A), { warehouseId: A.warehouseId, locationIds: [locked] })).sessionId;
    return { item, locked, free, sid };
  }
  const NULLS = { physical: null, reserved: null, available: null, countLocked: true };

  it("yalnız-COUNTER stok okumalarında FORBIDDEN (T-335a: stock.view yok)", async () => {
    const { item, locked } = await setup();
    const p = await who(A, ["COUNTER"]);
    await expect(stockByLocation(p, { locationId: locked })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stockByItem(p, { itemId: item })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aktif sayımda çoklu rollü sayımcı (COUNTER+PICKER)/PICKER: kilitli lokasyon miktarı null + countLocked; kilitsiz lokasyon ve yönetici etkilenmez", async () => {
    const { item, locked, free } = await setup();
    const mgr = await who(A, ["WAREHOUSE_MANAGER"]);
    for (const r of [ROLES.COUNTER, ROLES.PICKER]) {
      const p = await who(A, r);
      const byLoc = await stockByLocation(p, { locationId: locked });
      expect(byLoc.rows).toHaveLength(1);
      expect(byLoc.rows[0]).toMatchObject(NULLS);
      const free1 = await stockByLocation(p, { locationId: free });
      expect(free1.rows[0]).toMatchObject({ physical: "3.000000", reserved: "0.000000", available: "3.000000", countLocked: false });
      const byItem = await stockByItem(p, { itemId: item });
      expect(byItem.rows).toHaveLength(2);
      expect(byItem.rows.find((x) => x.locationId === locked)).toMatchObject(NULLS);
      expect(byItem.rows.find((x) => x.locationId === free)).toMatchObject({ physical: "3.000000", countLocked: false });
      // Toplamlar kilitli lokasyonu dışlar (aksi halde toplam − görünen satırlar = gizli miktar olurdu).
      expect(byItem.totals).toMatchObject({ physical: "3.000000", reserved: "0.000000", available: "3.000000", countLockedExcluded: true });
      expect(byItem.totals.physicalByStatus.AVAILABLE).toBe("3.000000");
      expect(JSON.stringify([byLoc, byItem])).not.toMatch(/7\.000000|10\.000000|"2\.000000"/);
    }
    for (const p of [mgr, owner(A)]) {
      const byLoc = await stockByLocation(p, { locationId: locked });
      expect(byLoc.rows[0]).toMatchObject({ physical: "7.000000", reserved: "2.000000", available: "5.000000", countLocked: true });
      const byItem = await stockByItem(p, { itemId: item });
      expect(byItem.rows.find((x) => x.locationId === locked)).toMatchObject({ physical: "7.000000", countLocked: true });
      expect(byItem.totals).toMatchObject({ physical: "10.000000", reserved: "2.000000", available: "8.000000", countLockedExcluded: false });
    }
  });

  it("sayım iptalinde ve fark fişi işlenince çoklu rollü sayımcı (COUNTER+PICKER) miktarı yeniden görür", async () => {
    const a = await setup();
    const counter = await who(A, ["COUNTER", "PICKER"]);
    expect((await stockByLocation(counter, { locationId: a.locked })).rows[0]).toMatchObject(NULLS);
    await cancelCount(cmd(A), { sessionId: a.sid, reason: "T334 iptal" });
    expect((await stockByLocation(counter, { locationId: a.locked })).rows[0]).toMatchObject({ physical: "7.000000", countLocked: false });
    const itemTotals = (await stockByItem(counter, { itemId: a.item })).totals;
    expect(itemTotals).toMatchObject({ physical: "10.000000", countLockedExcluded: false });

    const b = await setup();
    expect((await stockByItem(counter, { itemId: b.item })).rows.find((x) => x.locationId === b.locked)).toMatchObject(NULLS);
    await recordCount(cmd(A), { sessionId: b.sid, lines: [{ locationId: b.locked, itemId: b.item, countedQuantity: "7" }] });
    await submitCount(cmd(A), { sessionId: b.sid });
    await approveCount(cmd(A), { sessionId: b.sid });
    // Onaylı ama fark fişi işlenmemiş: kilit sürer, hâlâ gizli.
    expect((await stockByLocation(counter, { locationId: b.locked })).rows[0]).toMatchObject(NULLS);
    await postCountAdjustment(cmd(A), { sessionId: b.sid });
    expect((await stockByItem(counter, { itemId: b.item })).rows.find((x) => x.locationId === b.locked)).toMatchObject({ physical: "7.000000", countLocked: false });
  });
});
