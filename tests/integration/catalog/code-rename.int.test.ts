// T-251: ürün/depo/lokasyon kodu değişimi + kod geçmişi (migration 0018). Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Kanıtlar: UUID bağlantıları (defter/rezervasyon/barkod/belge satırı) kod değişiminde aynı kalır; eski kodla arama yeni karta yönlenir;
// eşzamanlı aynı koda iki değişimden biri CODE_TAKEN; ARCHIVED değiştirilemez; tenant izolasyonu; code_history ekle-yalnız.
// Audit append-only: audit yazan tenant'lar kısa ömürlü test veritabanında kalır (cleanupRegistry çağrılmaz).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { archiveItem, createItem, getItem, updateItem } from "../../../packages/domain/src/catalog/items.ts";
import { searchItems } from "../../../packages/domain/src/catalog/reads.ts";
import { archiveWarehouse, createWarehouse, renameWarehouse } from "../../../packages/domain/src/warehouse/warehouses.ts";
import { archiveLocation, createLocation, findLocationByCode, renameLocation } from "../../../packages/domain/src/warehouse/locations.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex").toUpperCase();

let app: DbClient;
let adm: pg.Client;
let appPg: pg.Client; // wms_app (DATABASE_URL): doğrudan SQL denemeleri
let A: TenantWorld;
let B: TenantWorld;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  appPg = new pg.Client({ connectionString: env.databaseUrl });
  appPg.on("error", () => undefined);
  try {
    await adm.connect();
    await appPg.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  A = await seedWorld(adm, reg, "A");
  B = await seedWorld(adm, reg, "B");
}, 120_000);

afterAll(async () => {
  await appPg.end();
  await adm.end();
  await app.close();
}, 120_000);

const admin = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });

async function fail(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}
const expectFail = async (p: Promise<unknown>, code: string, detail?: string): Promise<void> => {
  const e = await fail(p);
  expect(e.code).toBe(code);
  expect(e.detail).toBe(detail);
};
async function auditCount(tenant: string, action: string, entityId?: string): Promise<number> {
  const r = await adm.query(
    "SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = $2 AND ($3::text IS NULL OR entity_id = $3::text)",
    [tenant, action, entityId ?? null],
  );
  return (r.rows[0] as { n: number }).n;
}
async function history(tenant: string, entityId: string): Promise<{ old_code: string; new_code: string; changed_by: string; entity_type: string }[]> {
  const r = await adm.query("SELECT entity_type, old_code, new_code, changed_by FROM public.code_history WHERE tenant_id = $1 AND entity_id = $2 ORDER BY changed_at, id", [tenant, entityId]);
  return r.rows as { old_code: string; new_code: string; changed_by: string; entity_type: string }[];
}
/** wms_app olarak tek transaction (tenant bağlamı transaction-local); daima ROLLBACK. */
async function asApp<T>(tenant: string | null, fn: (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; code?: string; message: string }> {
  await appPg.query("BEGIN");
  try {
    if (tenant !== null) await appPg.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
    return { ok: true, v: await fn((t, p) => appPg.query(t, p)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await appPg.query("ROLLBACK");
  }
}

async function stockLinks(w: TenantWorld, itemId: string): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [w.tenantId, itemId])).rows;
  return {
    dims: await q("SELECT id, item_id FROM public.stock_dimensions WHERE tenant_id = $1 AND item_id = $2 ORDER BY id"),
    ledger: await q("SELECT l.id, l.quantity::text AS q FROM public.stock_ledger l JOIN public.stock_dimensions d ON d.tenant_id = l.tenant_id AND d.id = l.stock_dimension_id WHERE l.tenant_id = $1 AND d.item_id = $2 ORDER BY l.id"),
    balances: await q("SELECT b.stock_dimension_id, b.quantity::text AS q, b.reserved_quantity::text AS r FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id WHERE b.tenant_id = $1 AND d.item_id = $2 ORDER BY 1"),
    reservations: await q("SELECT id, item_id, status, quantity::text AS q FROM public.reservations WHERE tenant_id = $1 AND item_id = $2 ORDER BY id"),
    lines: await q("SELECT id, item_id FROM public.document_lines WHERE tenant_id = $1 AND item_id = $2 ORDER BY id"),
    barcodes: await q("SELECT id, item_id, barcode FROM public.item_barcodes WHERE tenant_id = $1 AND item_id = $2 ORDER BY id"),
  };
}

describe("ürün kodu değişimi", () => {
  it("stoklu üründe kod değişir; defter/bakiye/rezervasyon/belge satırı/barkod bağlantıları aynı UUID; geçmiş + audit aynı işlemde", async () => {
    const itemId = A.itemNoneId;
    await adm.query("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [A.tenantId, itemId, `BC-${rnd()}`]);
    const before = await stockLinks(A, itemId);
    expect((before as { ledger: unknown[] }).ledger.length).toBeGreaterThan(0);
    expect((before as { reservations: unknown[] }).reservations.length).toBeGreaterThan(0);
    expect((before as { lines: unknown[] }).lines.length).toBeGreaterThan(0);
    expect((before as { barcodes: unknown[] }).barcodes.length).toBeGreaterThan(0);
    const oldCode = (await getItem(picker(A), { itemId })).code;
    const newCode = `YENI-${rnd()}`;
    expect(await updateItem(admin(A), { itemId, code: newCode })).toEqual({ itemId, changed: true });
    expect((await getItem(picker(A), { itemId })).code).toBe(newCode);
    expect(await stockLinks(A, itemId)).toEqual(before);
    const h = await history(A.tenantId, itemId);
    expect(h.filter((x) => x.old_code === oldCode)).toEqual([{ entity_type: "item", old_code: oldCode, new_code: newCode, changed_by: A.ownerUserId }]);
    expect(await auditCount(A.tenantId, "item.code_changed", itemId)).toBe(1);
    // aynı kod yeniden verilirse no-op: geçmiş/audit artmaz
    expect(await updateItem(admin(A), { itemId, code: newCode })).toEqual({ itemId, changed: false });
    expect(await auditCount(A.tenantId, "item.code_changed", itemId)).toBe(1);
  });

  it("eski kodla arama yeni karta yönlenir ('bu kod X olarak değişti'); yeni kodla aramada renamedFrom yok; B tenant'ı görmez", async () => {
    const unitId = A.unitId;
    const { itemId } = await createItem(admin(A), { code: `S-${rnd()}`, name: "Aranan", baseUnitId: unitId });
    const first = (await getItem(picker(A), { itemId })).code;
    const mid = `S-${rnd()}`;
    const last = `S-${rnd()}`;
    await updateItem(admin(A), { itemId, code: mid });
    await updateItem(admin(A), { itemId, code: last });
    for (const old of [first, mid]) {
      const r = await searchItems(picker(A), { q: old.toLowerCase() }); // büyük-küçük harf duyarsız tam eşleşme
      expect(r.items.map((i) => i.id)).toContain(itemId);
      expect(r.renamedFrom).toEqual([{ oldCode: old, itemId, currentCode: last }]);
    }
    const cur = await searchItems(picker(A), { q: last });
    expect(cur.items.map((i) => i.id)).toEqual([itemId]);
    expect(cur.renamedFrom).toBeUndefined();
    const other = await searchItems(picker(B), { q: first });
    expect(other.items).toEqual([]);
    expect(other.renamedFrom).toBeUndefined();
    expect((await history(A.tenantId, itemId)).map((x) => [x.old_code, x.new_code])).toEqual([[first, mid], [mid, last]]);
  });

  it("kod tenant içinde benzersiz: mevcut koda değişim CODE_TAKEN, hiçbir iz bırakmaz; biçim hatası VALIDATION_FAILED", async () => {
    const a = await createItem(admin(A), { code: `T-${rnd()}`, name: "A", baseUnitId: A.unitId });
    const bCode = `T-${rnd()}`;
    await createItem(admin(A), { code: bCode, name: "B", baseUnitId: A.unitId });
    const auditBefore = await auditCount(A.tenantId, "item.code_changed");
    await expectFail(updateItem(admin(A), { itemId: a.itemId, code: bCode }), "VALIDATION_FAILED", "CODE_TAKEN");
    expect(await history(A.tenantId, a.itemId)).toEqual([]);
    expect(await auditCount(A.tenantId, "item.code_changed")).toBe(auditBefore);
    await expectFail(updateItem(admin(A), { itemId: a.itemId, code: "   " }), "VALIDATION_FAILED");
    await expectFail(updateItem(admin(A), { itemId: a.itemId, code: "x".repeat(200) }), "VALIDATION_FAILED");
    // B tenant'ında aynı kod serbest (benzersizlik tenant içi)
    const bItem = await createItem(admin(B), { code: bCode, name: "B tenant", baseUnitId: B.unitId });
    expect(bItem.itemId).not.toBe(a.itemId);
  });

  it("eşzamanlı aynı koda iki değişim: biri başarılı, biri CODE_TAKEN; geçmiş ve audit yalnızca kazanan için", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await createItem(admin(A), { code: `R-${rnd()}`, name: "X", baseUnitId: A.unitId });
      const y = await createItem(admin(A), { code: `R-${rnd()}`, name: "Y", baseUnitId: A.unitId });
      const target = `R-${rnd()}`;
      const res = await Promise.allSettled([updateItem(admin(A), { itemId: x.itemId, code: target }), updateItem(admin(A), { itemId: y.itemId, code: target })]);
      const ok = res.filter((r) => r.status === "fulfilled");
      const bad = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0]?.reason).toBeInstanceOf(AppError);
      expect((bad[0]?.reason as AppError).code).toBe("VALIDATION_FAILED");
      expect((bad[0]?.reason as AppError).detail).toBe("CODE_TAKEN");
      const hx = await history(A.tenantId, x.itemId);
      const hy = await history(A.tenantId, y.itemId);
      expect(hx.length + hy.length).toBe(1);
      expect((await auditCount(A.tenantId, "item.code_changed", x.itemId)) + (await auditCount(A.tenantId, "item.code_changed", y.itemId))).toBe(1);
    }
  });

  it("ARCHIVED ürünün kodu değiştirilemez; kilitli alanlar (takip modu) stoklu üründe IN_USE olarak kalır; yetkisiz rol reddedilir", async () => {
    const { itemId } = await createItem(admin(A), { code: `AR-${rnd()}`, name: "Arşivlenecek", baseUnitId: A.unitId });
    await archiveItem(admin(A), { itemId });
    const code = (await getItem(picker(A), { itemId })).code;
    await expectFail(updateItem(admin(A), { itemId, code: `AR-${rnd()}` }), "VALIDATION_FAILED");
    expect((await getItem(picker(A), { itemId })).code).toBe(code);
    expect(await history(A.tenantId, itemId)).toEqual([]);
    await expectFail(updateItem(admin(A), { itemId: A.itemNoneId, trackingMode: "SERIAL" }), "VALIDATION_FAILED", "IN_USE");
    const e = await fail(updateItem(picker(A), { itemId: A.itemNoneId, code: `X-${rnd()}` }));
    expect(e.code).not.toBe("INTERNAL");
    expect((await getItem(picker(A), { itemId: A.itemNoneId })).code).not.toMatch(/^X-/);
  });

  it("başka tenant'ın ürünü: NOT_FOUND, değişiklik yok", async () => {
    const before = (await getItem(picker(B), { itemId: B.itemNoneId })).code;
    await expectFail(updateItem(admin(A), { itemId: B.itemNoneId, code: `Z-${rnd()}` }), "NOT_FOUND");
    expect((await getItem(picker(B), { itemId: B.itemNoneId })).code).toBe(before);
    expect(await history(B.tenantId, B.itemNoneId).then((h) => h.filter((x) => x.new_code.startsWith("Z-")))).toEqual([]);
  });
});

describe("depo kodu değişimi", () => {
  it("depo kodu değişir (normalize edilir); geçmiş + audit; tekrar CODE_TAKEN; eşzamanlı iki değişimden biri CODE_TAKEN; ARCHIVED değişmez", async () => {
    const w1 = await createWarehouse(admin(A), { code: `W-${rnd()}`, name: "W1" });
    const w2 = await createWarehouse(admin(A), { code: `W-${rnd()}`, name: "W2" });
    const loc = await createLocation(admin(A), { warehouseId: w1.warehouseId, code: "RAF-1", name: "Raf", kind: "STORAGE" });
    const old = (await adm.query("SELECT code FROM public.warehouses WHERE id = $1", [w1.warehouseId])).rows[0].code as string;
    const next = `wn-${rnd().toLowerCase()}`;
    expect(await renameWarehouse(admin(A), { warehouseId: w1.warehouseId, code: next })).toEqual({ changed: true });
    const stored = (await adm.query("SELECT code FROM public.warehouses WHERE id = $1", [w1.warehouseId])).rows[0].code as string;
    expect(stored).toBe(next.toUpperCase());
    expect(await history(A.tenantId, w1.warehouseId)).toEqual([{ entity_type: "warehouse", old_code: old, new_code: stored, changed_by: A.ownerUserId }]);
    expect(await auditCount(A.tenantId, "warehouse.code_changed", w1.warehouseId)).toBe(1);
    // lokasyon bağlantısı UUID ile aynı
    const l = (await adm.query("SELECT warehouse_id FROM public.locations WHERE id = $1", [loc.locationId])).rows[0] as { warehouse_id: string };
    expect(l.warehouse_id).toBe(w1.warehouseId);
    await expectFail(renameWarehouse(admin(A), { warehouseId: w2.warehouseId, code: stored }), "VALIDATION_FAILED", "CODE_TAKEN");
    expect(await history(A.tenantId, w2.warehouseId)).toEqual([]);
    // ad değişimi eski davranışı korur (kod yok → code_changed yok)
    expect(await renameWarehouse(admin(A), { warehouseId: w1.warehouseId, name: "Yeni ad" })).toEqual({ changed: true });
    expect(await auditCount(A.tenantId, "warehouse.code_changed", w1.warehouseId)).toBe(1);
    await expectFail(renameWarehouse(admin(A), { warehouseId: w1.warehouseId }), "VALIDATION_FAILED");
    // eşzamanlı
    const p = await createWarehouse(admin(A), { code: `W-${rnd()}`, name: "P" });
    const q = await createWarehouse(admin(A), { code: `W-${rnd()}`, name: "Q" });
    const target = `W-${rnd()}`;
    const res = await Promise.allSettled([renameWarehouse(admin(A), { warehouseId: p.warehouseId, code: target }), renameWarehouse(admin(A), { warehouseId: q.warehouseId, code: target })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(bad).toHaveLength(1);
    expect((bad[0]?.reason as AppError).detail).toBe("CODE_TAKEN");
    expect((await history(A.tenantId, p.warehouseId)).length + (await history(A.tenantId, q.warehouseId)).length).toBe(1);
    // ARCHIVED
    const arch = await createWarehouse(admin(A), { code: `W-${rnd()}`, name: "Arşiv" });
    await archiveWarehouse(admin(A), { warehouseId: arch.warehouseId });
    await expectFail(renameWarehouse(admin(A), { warehouseId: arch.warehouseId, code: `W-${rnd()}` }), "VALIDATION_FAILED");
    expect(await history(A.tenantId, arch.warehouseId)).toEqual([]);
    // başka tenant
    await expectFail(renameWarehouse(admin(A), { warehouseId: B.warehouseId, code: `W-${rnd()}` }), "NOT_FOUND");
  });
});

describe("lokasyon kodu değişimi", () => {
  it("kod değişir; depo içi benzersiz (başka depoda aynı kod serbest); eski kodla arama yeni karta yönlenir; geçmiş + audit; ARCHIVED değişmez", async () => {
    const w1 = await createWarehouse(admin(A), { code: `L-${rnd()}`, name: "LW1" });
    const w2 = await createWarehouse(admin(A), { code: `L-${rnd()}`, name: "LW2" });
    const a = await createLocation(admin(A), { warehouseId: w1.warehouseId, code: "A-01", name: "A", kind: "STORAGE" });
    const b = await createLocation(admin(A), { warehouseId: w1.warehouseId, code: "A-02", name: "B", kind: "STORAGE" });
    const other = await createLocation(admin(A), { warehouseId: w2.warehouseId, code: "A-03", name: "C", kind: "STORAGE" });
    expect(await renameLocation(admin(A), { locationId: a.locationId, code: "a-10" })).toEqual({ changed: true });
    expect(await history(A.tenantId, a.locationId)).toEqual([{ entity_type: "location", old_code: "A-01", new_code: "A-10", changed_by: A.ownerUserId }]);
    expect(await auditCount(A.tenantId, "location.code_changed", a.locationId)).toBe(1);
    await expectFail(renameLocation(admin(A), { locationId: b.locationId, code: "A-10" }), "VALIDATION_FAILED", "CODE_TAKEN");
    expect(await history(A.tenantId, b.locationId)).toEqual([]);
    // başka depoda aynı koda geçiş serbest
    expect(await renameLocation(admin(A), { locationId: other.locationId, code: "A-10" })).toEqual({ changed: true });
    // eski kod → yeni kart
    const viaOld = await findLocationByCode(picker(A), { warehouseId: w1.warehouseId, code: "a-01" });
    expect(viaOld).toMatchObject({ id: a.locationId, code: "A-10", renamedFrom: "A-01" });
    const viaNew = await findLocationByCode(picker(A), { warehouseId: w1.warehouseId, code: "A-10" });
    expect(viaNew?.id).toBe(a.locationId);
    expect(viaNew?.renamedFrom).toBeUndefined();
    // eski kod başka depoda aranınca o depodaki karta gitmez
    expect(await findLocationByCode(picker(A), { warehouseId: w2.warehouseId, code: "A-01" })).toBeNull();
    // eski kod sonradan yeniden kullanılırsa güncel eşleşme önceliklidir
    expect(await renameLocation(admin(A), { locationId: b.locationId, code: "A-01" })).toEqual({ changed: true });
    expect((await findLocationByCode(picker(A), { warehouseId: w1.warehouseId, code: "A-01" }))?.id).toBe(b.locationId);
    // eşzamanlı
    const p = await createLocation(admin(A), { warehouseId: w1.warehouseId, code: "P-1", name: "P", kind: "STORAGE" });
    const q = await createLocation(admin(A), { warehouseId: w1.warehouseId, code: "Q-1", name: "Q", kind: "STORAGE" });
    const res = await Promise.allSettled([renameLocation(admin(A), { locationId: p.locationId, code: "Z-9" }), renameLocation(admin(A), { locationId: q.locationId, code: "Z-9" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(bad).toHaveLength(1);
    expect((bad[0]?.reason as AppError).detail).toBe("CODE_TAKEN");
    expect((await history(A.tenantId, p.locationId)).length + (await history(A.tenantId, q.locationId)).length).toBe(1);
    // ARCHIVED
    const arch = await createLocation(admin(A), { warehouseId: w2.warehouseId, code: "ARC-1", name: "Arşiv", kind: "STORAGE" });
    await archiveLocation(admin(A), { locationId: arch.locationId });
    await expectFail(renameLocation(admin(A), { locationId: arch.locationId, code: "ARC-2" }), "VALIDATION_FAILED");
    expect(await history(A.tenantId, arch.locationId)).toEqual([]);
    // başka tenant
    await expectFail(renameLocation(admin(A), { locationId: B.rootLocationId, code: "HX-1" }), "NOT_FOUND");
  });
});

describe("T-257: eski kod belirsizliği (A-69, MINOR-1)", () => {
  it("aynı eski kod aynı depoda iki lokasyonun geçmişindeyse findLocationByCode sessizce seçmez: VALIDATION_FAILED/CODE_AMBIGUOUS; güncel kod ve tek adaylı eski kod çalışır", async () => {
    const w = await createWarehouse(admin(A), { code: `AM-${rnd()}`, name: "Belirsiz" });
    const x = await createLocation(admin(A), { warehouseId: w.warehouseId, code: "R-01", name: "X", kind: "STORAGE" });
    // X eski kodu R-01'i bırakır; Y aynı kodu alır ve o da bırakır → "R-01" iki kartın geçmişinde.
    await renameLocation(admin(A), { locationId: x.locationId, code: "R-11" });
    const y = await createLocation(admin(A), { warehouseId: w.warehouseId, code: "R-01", name: "Y", kind: "STORAGE" });
    // Y henüz R-01 iken güncel eşleşme önceliklidir (belirsizlik yok).
    expect((await findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "R-01" }))?.id).toBe(y.locationId);
    await renameLocation(admin(A), { locationId: y.locationId, code: "R-12" });
    await expectFail(findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "R-01" }), "VALIDATION_FAILED", "CODE_AMBIGUOUS");
    await expectFail(findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "r-01" }), "VALIDATION_FAILED", "CODE_AMBIGUOUS");
    // Güncel kodlar belirsiz değil; yalnızca tek karta ait eski kod yönlenir.
    expect((await findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "R-11" }))?.id).toBe(x.locationId);
    await renameLocation(admin(A), { locationId: x.locationId, code: "R-21" });
    expect(await findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "R-11" })).toMatchObject({ id: x.locationId, code: "R-21", renamedFrom: "R-11" });
    // Aynı karta ait tekrarlı geçmiş satırları belirsizlik sayılmaz: X "R-21"i iki kez bırakır (R-21 → R-31 → R-21 → R-32), ama kart tektir.
    await renameLocation(admin(A), { locationId: x.locationId, code: "R-31" });
    await renameLocation(admin(A), { locationId: x.locationId, code: "R-21" });
    await renameLocation(admin(A), { locationId: x.locationId, code: "R-32" });
    expect(await findLocationByCode(picker(A), { warehouseId: w.warehouseId, code: "R-21" })).toMatchObject({ id: x.locationId, renamedFrom: "R-21" });
    // Arama yolu: eski kod iki kartın geçmişindeyse her ikisi de aday döner (sessiz seçim yok).
    const i1 = await createItem(admin(A), { code: `AI-${rnd()}`, name: "A1", baseUnitId: A.unitId });
    const i2 = await createItem(admin(A), { code: `AI-${rnd()}`, name: "A2", baseUnitId: A.unitId });
    const shared = `SH-${rnd()}`;
    await updateItem(admin(A), { itemId: i1.itemId, code: shared });
    await updateItem(admin(A), { itemId: i1.itemId, code: `AJ-${rnd()}` });
    await updateItem(admin(A), { itemId: i2.itemId, code: shared });
    await updateItem(admin(A), { itemId: i2.itemId, code: `AK-${rnd()}` });
    const r = await searchItems(picker(A), { q: shared });
    expect(r.items.map((i) => i.id).sort()).toEqual([i1.itemId, i2.itemId].sort());
    expect(r.renamedFrom?.map((h) => h.itemId).sort()).toEqual([i1.itemId, i2.itemId].sort());
  });
});

describe("code_history: RLS, izolasyon ve ekle-yalnız yetki (wms_app)", () => {
  it("A bağlamı yalnızca A satırlarını görür; B anahtarlı INSERT RLS ile reddedilir; bağlamsız 0 satır", async () => {
    const own = await asApp(A.tenantId, async (q) => (await q("SELECT DISTINCT tenant_id FROM public.code_history")).rows);
    expect(own).toEqual({ ok: true, v: [{ tenant_id: A.tenantId }] });
    const none = await asApp(null, async (q) => (await q("SELECT count(*)::int AS n FROM public.code_history")).rows[0]);
    expect(none).toEqual({ ok: true, v: { n: 0 } });
    const ins = (tenant: string) => (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>) =>
      q("INSERT INTO public.code_history (tenant_id, entity_type, entity_id, old_code, new_code, changed_by) VALUES ($1, 'item', $2, 'O1', 'N1', $3)", [tenant, A.itemId, A.ownerUserId]);
    const cross = await asApp(A.tenantId, ins(B.tenantId));
    expect(cross).toMatchObject({ ok: false, code: "42501" });
    expect((cross as { message: string }).message).toMatch(/row-level security/i);
    expect((await asApp(A.tenantId, ins(A.tenantId))).ok).toBe(true);
  });

  it("wms_app UPDATE/DELETE yapamaz; changed_at ve id sütununa değer veremez; polimorfik tür CHECK'i", async () => {
    expect(await asApp(A.tenantId, (q) => q("UPDATE public.code_history SET new_code = 'X' WHERE tenant_id = $1", [A.tenantId]))).toMatchObject({ ok: false, code: "42501" });
    expect(await asApp(A.tenantId, (q) => q("DELETE FROM public.code_history WHERE tenant_id = $1", [A.tenantId]))).toMatchObject({ ok: false, code: "42501" });
    expect(await asApp(A.tenantId, (q) => q("INSERT INTO public.code_history (tenant_id, entity_type, entity_id, old_code, new_code, changed_by, changed_at) VALUES ($1, 'item', $2, 'O', 'N', $3, '2000-01-01')", [A.tenantId, A.itemId, A.ownerUserId]))).toMatchObject({ ok: false, code: "42501" });
    expect(await asApp(A.tenantId, (q) => q("INSERT INTO public.code_history (tenant_id, entity_type, entity_id, old_code, new_code, changed_by) VALUES ($1, 'unit', $2, 'O', 'N', $3)", [A.tenantId, A.itemId, A.ownerUserId]))).toMatchObject({ ok: false, code: "23514" });
    expect(await asApp(A.tenantId, (q) => q("INSERT INTO public.code_history (tenant_id, entity_type, entity_id, old_code, new_code, changed_by) VALUES ($1, 'item', $2, 'SAME', 'SAME', $3)", [A.tenantId, A.itemId, A.ownerUserId]))).toMatchObject({ ok: false, code: "23514" });
  });

  it("kod UPDATE yetkisi yalnızca code sütunu: items/warehouses/locations.code güncellenebilir; kilitli sütunlar (base_unit_id, tracking_mode, quantity_scale, parent_id, warehouse_id) hâlâ 42501", async () => {
    const ok1 = await asApp(A.tenantId, (q) => q("UPDATE public.items SET code = code WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.itemId]));
    expect(ok1.ok).toBe(true);
    expect((await asApp(A.tenantId, (q) => q("UPDATE public.warehouses SET code = code WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.warehouseId]))).ok).toBe(true);
    expect((await asApp(A.tenantId, (q) => q("UPDATE public.locations SET code = code WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.rootLocationId]))).ok).toBe(true);
    for (const stmt of [
      "UPDATE public.items SET base_unit_id = base_unit_id WHERE tenant_id = $1",
      "UPDATE public.items SET tracking_mode = tracking_mode WHERE tenant_id = $1",
      "UPDATE public.items SET quantity_scale = quantity_scale WHERE tenant_id = $1",
      "UPDATE public.locations SET warehouse_id = warehouse_id WHERE tenant_id = $1",
      "UPDATE public.locations SET parent_id = parent_id WHERE tenant_id = $1",
    ]) {
      expect(await asApp(A.tenantId, (q) => q(stmt, [A.tenantId])), stmt).toMatchObject({ ok: false, code: "42501" });
    }
    // tenant bağlamı olmadan veya B bağlamında A satırının kodu değişmez (RLS: 0 satır)
    const cross = await asApp(B.tenantId, (q) => q("UPDATE public.items SET code = 'HACK' WHERE tenant_id = $1", [A.tenantId]));
    expect(cross).toMatchObject({ ok: true });
    expect((cross as { v: pg.QueryResult }).v.rowCount).toBe(0);
  });
});
