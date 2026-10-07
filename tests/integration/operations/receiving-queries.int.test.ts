// T-313: mal kabul okuma sorguları (stock.view, keyset, depo kapsamı, tenant yalıtımı). Gerçek wms_app bağlantısı + RLS; fikstür yalnızca
// DATABASE_URL_DIRECT ile (sentetik, G-09). Bağımsız kanıt: AC-04 satırı ac-04-coverage.int.test.ts'te.
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
import {
  RECEIPT_LIST_LIMIT_MAX,
  getAvailableAtLocation,
  getInboundReceipt,
  listInboundReceipts,
  openInboundReceipt,
  receiveGoods,
  createInboundReceipt,
} from "../../../packages/domain/src/operations/index.ts";
import type { StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
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
async function mkItem(w: TenantWorld): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T313 urun',$4,'NONE',0)", [
    w.tenantId, id, `I-${hex(10)}`, w.unitId,
  ]);
  return id;
}
async function mkLoc(w: TenantWorld, warehouseId: string, kind: "RECEIVING" | "STORAGE", code = `L-${hex(10)}`): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T313 lok',0,$5)", [
    w.tenantId, id, warehouseId, code, kind,
  ]);
  return id;
}
async function mkReceipt(w: TenantWorld, warehouseId: string, itemId: string, expected: string, open = true): Promise<string> {
  const c = await createInboundReceipt(cmd(w), {
    warehouseId,
    supplierRef: "T313-TED",
    lines: [{ itemId, unitId: w.unitId, expectedQuantity: expected }],
  });
  const id = c.documentId as string;
  if (open) await openInboundReceipt(cmd(w), { receiptId: id, expectedVersion: 1 });
  return id;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A313");
  B = await seedWorld(adm, reg, "B313");
  otherWh = (await createWarehouse(owner(A), { code: `s${hex(8)}`, name: "T313 ikinci depo" })).warehouseId;
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("listInboundReceipts / getInboundReceipt", () => {
  it("satırlar, kalan miktar ve KABUL lokasyonları döner; miktarlar dizgidir", async () => {
    const item = await mkItem(A);
    const kabul = await mkLoc(A, A.warehouseId, "RECEIVING", `KB-${hex(6)}`);
    const id = await mkReceipt(A, A.warehouseId, item, "10");
    await receiveGoods(cmd(A), { receiptId: id, lines: [{ lineId: (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id=$1", [id]))[0]?.id as string, received: "4", damaged: "1", locationId: kabul }] });
    const d = await getInboundReceipt(picker(A), { receiptId: id });
    expect(d.status).toBe("OPEN");
    expect(d.supplierRef).toBe("T313-TED");
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ itemId: item, itemName: "T313 urun", expected: "10.000000", received: "4.000000", damaged: "1.000000", open: "6.000000" });
    expect(d.receivingLocations.map((l) => l.id)).toContain(kabul);
    const listed = await listInboundReceipts(picker(A), { status: "OPEN", warehouseId: A.warehouseId });
    expect(listed.items.some((r) => r.id === id && r.lines.length === 1)).toBe(true);
  });

  it("DRAFT filtresi ve durum doğrulaması", async () => {
    const item = await mkItem(A);
    const draft = await mkReceipt(A, A.warehouseId, item, "3", false);
    const r = await listInboundReceipts(owner(A), { status: "DRAFT", limit: 100 });
    expect(r.items.some((x) => x.id === draft)).toBe(true);
    expect(r.items.every((x) => x.status === "DRAFT")).toBe(true);
    expect((await failure(listInboundReceipts(owner(A), { status: "BOGUS" as never }))).code).toBe("VALIDATION_FAILED");
  });

  it("keyset: sayfalar çakışmaz ve eksiksizdir; limit/imleç doğrulanır", async () => {
    const item = await mkItem(A);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await mkReceipt(A, A.warehouseId, item, "1"));
    const seen: string[] = [];
    let after: { createdKey: string; id: string } | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const p = await listInboundReceipts(owner(A), { limit: 2, ...(after === undefined ? {} : { after }) });
      expect(p.items.length).toBeLessThanOrEqual(2);
      seen.push(...p.items.map((x) => x.id));
      if (p.next === null) break;
      after = p.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    for (const bad of [0, -1, 1.5, RECEIPT_LIST_LIMIT_MAX + 1]) {
      expect((await failure(listInboundReceipts(owner(A), { limit: bad }))).code).toBe("VALIDATION_FAILED");
    }
    for (const bad of [
      { createdKey: "x", id: randomUUID() },
      { createdKey: "2026-02-31T00:00:00.000000Z", id: randomUUID() },
      { createdKey: "2026-01-01T25:00:00.000000Z", id: randomUUID() },
      { createdKey: "2026-01-01T00:00:00.000000Z", id: "not-a-uuid" },
    ]) {
      expect((await failure(listInboundReceipts(owner(A), { after: bad }))).code).toBe("VALIDATION_FAILED");
    }
  });

  it("izin: stock.view olmayan üyelik reddedilir (üye olmayan kullanıcı)", async () => {
    // B tenant'ının üyesi A'nın verisine erişemez: üyelik yok → NOT_FOUND/FORBIDDEN (tenant varlığı sızmaz).
    const e = await failure(listInboundReceipts({ db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(e.code);
  });
});

describe("tenant yalıtımı (AC-04 okuma katmanı)", () => {
  it("başka tenant'ın teslim kimliği NOT_FOUND; liste yalnızca kendi tenant'ını gösterir", async () => {
    const bItem = await mkItem(B);
    const bReceipt = await mkReceipt(B, B.warehouseId, bItem, "7");
    expect((await failure(getInboundReceipt(owner(A), { receiptId: bReceipt }))).code).toBe("NOT_FOUND");
    expect((await failure(getInboundReceipt(owner(A), { receiptId: randomUUID() }))).code).toBe("NOT_FOUND");
    const a = await listInboundReceipts(owner(A), { limit: 100 });
    expect(a.items.some((r) => r.id === bReceipt)).toBe(false);
    const b = await listInboundReceipts(owner(B), { limit: 100 });
    expect(b.items.map((r) => r.id)).toContain(bReceipt);
    // B'nin depo kimliğiyle süzmek A için boş döner (sızıntı yok).
    expect((await listInboundReceipts(owner(A), { warehouseId: B.warehouseId })).items).toEqual([]);
  });

  it("getAvailableAtLocation: başka tenant'ın lokasyonu NOT_FOUND", async () => {
    const bLoc = await mkLoc(B, B.warehouseId, "RECEIVING");
    const aItem = await mkItem(A);
    expect((await failure(getAvailableAtLocation(owner(A), { locationId: bLoc, itemId: aItem }))).code).toBe("NOT_FOUND");
  });
});

describe("depo kapsamı (A-46)", () => {
  it("kapsam dışı depo: liste süzer, tekil okuma NOT_FOUND; bayrak kapalıyken görünür; mutasyon testi kapsam süzgecinin gerekli olduğunu gösterir", async () => {
    const item = await mkItem(A);
    const inScope = await mkReceipt(A, A.warehouseId, item, "2");
    const outScope = await mkReceipt(A, otherWh, item, "2");
    await setMembershipWarehouseScopes(owner(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });
    const prev = process.env.WAREHOUSE_SCOPE_ENABLED;
    try {
      delete process.env.WAREHOUSE_SCOPE_ENABLED;
      expect((await getInboundReceipt(picker(A), { receiptId: outScope })).id).toBe(outScope);
      process.env.WAREHOUSE_SCOPE_ENABLED = "true";
      const listed = (await listInboundReceipts(picker(A), { limit: 100 })).items.map((r) => r.id);
      expect(listed).toContain(inScope);
      expect(listed).not.toContain(outScope);
      expect((await failure(getInboundReceipt(picker(A), { receiptId: outScope }))).code).toBe("NOT_FOUND");
      expect((await getInboundReceipt(picker(A), { receiptId: inScope })).id).toBe(inScope);
      // Yönetici kapsamdan muaf.
      expect((await listInboundReceipts(owner(A), { limit: 100 })).items.map((r) => r.id)).toContain(outScope);
      // Kapsam dışı depodaki lokasyon miktarı da NOT_FOUND.
      const outLoc = await mkLoc(A, otherWh, "RECEIVING");
      expect((await failure(getAvailableAtLocation(picker(A), { locationId: outLoc, itemId: item }))).code).toBe("NOT_FOUND");

      // MUTASYON: kapsam süzgeci olmayan eşdeğer sorgu kapsam dışı satırı döndürür → yukarıdaki `not.toContain` iddiası ayırt edicidir.
      const mutated = await runTenantQuery({ ...picker(A), permission: "stock.view" }, async (tx, m) => {
        expect(await resolveWarehouseScope(tx, m)).toEqual([A.warehouseId]);
        return tx.execute<{ id: string }>(sql`SELECT r.id FROM public.inbound_receipts r WHERE r.tenant_id = ${m.tenantId}::uuid`);
      });
      expect(mutated.map((r) => r.id)).toContain(outScope);
    } finally {
      if (prev === undefined) delete process.env.WAREHOUSE_SCOPE_ENABLED;
      else process.env.WAREHOUSE_SCOPE_ENABLED = prev;
    }
  });
});

describe("getAvailableAtLocation", () => {
  it("yalnızca AVAILABLE miktar; kabul sonrası karantina/kalite kapalıyken AVAILABLE", async () => {
    await q("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1", [A.tenantId]);
    const item = await mkItem(A);
    const kabul = await mkLoc(A, A.warehouseId, "RECEIVING");
    expect((await getAvailableAtLocation(picker(A), { locationId: kabul, itemId: item })).quantity).toBe("0");
    const id = await mkReceipt(A, A.warehouseId, item, "8");
    const lineId = (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id=$1", [id]))[0]?.id as string;
    await receiveGoods(cmd(A), { receiptId: id, lines: [{ lineId, received: "8", damaged: "2", locationId: kabul }] });
    expect((await getAvailableAtLocation(picker(A), { locationId: kabul, itemId: item })).quantity).toBe("6.000000");
    expect((await failure(getAvailableAtLocation(picker(A), { locationId: "x", itemId: item }))).code).toBe("VALIDATION_FAILED");
  });
});
