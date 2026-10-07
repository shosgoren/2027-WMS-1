// T-250: kolay kurulum — kod önerisi, toplu raf oluşturucu, rehber ilerlemesi, lokasyon araması. Gerçek wms_app bağlantısı + RLS.
// Fikstürler sentetik (G-09). audit_logs değişmez olduğundan test tenant'ları geçici Testcontainers ortamında kalır.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { PgDialect } from "../../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import type { SQL } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { archiveItem, createItem, createItemWithDefaultUnit, createUnit, createWithSuggestedCode, suggestCode, suggestedCodePrefix } from "../../../packages/domain/src/catalog/index.ts";
import {
  BULK_LOCATIONS_MAX,
  archiveWarehouse,
  createBulkLocations,
  createLocation,
  createWarehouse,
  getLocationTree,
  getSetupProgress,
  planBulkLocations,
  previewBulkLocations,
  searchLocations,
} from "../../../packages/domain/src/warehouse/index.ts";
import { IDEMPOTENCY_WINDOW_DAYS, WAREHOUSE_LOCATIONS_MAX, bulkRefLegacyLookupSql, bulkRefLookupSql } from "../../../packages/domain/src/warehouse/bulk-locations.ts";
import { locationSearchSql } from "../../../packages/domain/src/warehouse/setup-queries.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
/** Hiç depo/ürün/lokasyonu olmayan tenant (rehber başlangıç durumu). */
let E: { tenantId: string; slug: string; ownerUserId: string };

const admin = (w: { slug: string; ownerUserId: string }) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const pfx = (): string => `Z${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
const key = (): string => randomUUID();
async function countLocations(tenantId: string, warehouseId: string, like: string): Promise<number> {
  const r = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.locations WHERE tenant_id = $1 AND warehouse_id = $2 AND code LIKE $3", [tenantId, warehouseId, like]);
  return Number(r.rows[0]?.n);
}
async function newWarehouse(w: { slug: string; ownerUserId: string }): Promise<string> {
  return (await createWarehouse(admin(w), { code: pfx(), name: "Test depo" })).warehouseId;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A250");
  B = await seedWorld(adm, reg, "B250");
  const tenantId = randomUUID();
  const slug = `t250-empty-${randomUUID().slice(0, 8)}`;
  const ownerUserId = await mkUser(adm, reg, "E250 owner");
  await adm.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [tenantId, slug, "T250 bos tenant"]);
  await mkMembership(adm, tenantId, ownerUserId, { isOwner: true, roles: ["TENANT_ADMIN"] });
  E = { tenantId, slug, ownerUserId };
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("kod önerisi (görev 1)", () => {
  it("boş tenant'ta ilk kod, sonra en büyük sıra + 1; arşivli ürünün kodu da ayrılmıştır", async () => {
    expect(await suggestCode(admin(E), { kind: "item" })).toEqual({ code: "URN-0001", prefix: "URN" });
    const { warehouseId } = await createWarehouse(admin(E), { code: "DEPO-01", name: "Ana depo" });
    expect(await suggestCode(admin(E), { kind: "warehouse" })).toMatchObject({ code: "DEPO-02" });
    expect(await suggestCode(admin(E), { kind: "location", warehouseId })).toMatchObject({ code: "LOK-0001" });
    await createLocation(admin(E), { warehouseId, code: "LOK-0007", name: "Yedi", kind: "STORAGE" });
    await createLocation(admin(E), { warehouseId, code: "LOK-ABC", name: "Rakam değil", kind: "STORAGE" });
    expect((await suggestCode(admin(E), { kind: "location", warehouseId })).code).toBe("LOK-0008");

    const p = pfx();
    const { itemId } = await createItem(admin(A), { code: `${p}-0041`, name: "Kırk bir", baseUnitId: A.unitId });
    expect((await suggestCode(admin(A), { kind: "item", prefix: p.toLowerCase() })).code).toBe(`${p}-0042`);
    await archiveItem(admin(A), { itemId });
    expect((await suggestCode(admin(A), { kind: "item", prefix: p })).code).toBe(`${p}-0042`);
  });

  it("öneri tenant'a özeldir ve lokasyon önerisi depoya özeldir; geçersiz önek/kimlik reddedilir", async () => {
    const p = pfx();
    await createItem(admin(A), { code: `${p}-0005`, name: "A ürünü", baseUnitId: A.unitId });
    expect((await suggestCode(admin(B), { kind: "item", prefix: p })).code).toBe(`${p}-0001`);
    const w1 = await newWarehouse(A);
    const w2 = await newWarehouse(A);
    await createLocation(admin(A), { warehouseId: w1, code: "LOK-0003", name: "x", kind: "STORAGE" });
    expect((await suggestCode(admin(A), { kind: "location", warehouseId: w1 })).code).toBe("LOK-0004");
    expect((await suggestCode(admin(A), { kind: "location", warehouseId: w2 })).code).toBe("LOK-0001");
    expect((await failure(suggestCode(admin(A), { kind: "item", prefix: "A-B" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(suggestCode(admin(A), { kind: "location" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(suggestCode(admin(A), { kind: "location", warehouseId: B.warehouseId }))).code).toBe("NOT_FOUND");
  });

  it("yetkisiz üye öneri alamaz (settings.manage)", async () => {
    expect((await failure(suggestCode(picker(A), { kind: "item" }))).code).toBe("FORBIDDEN");
  });

  it("eşzamanlı iki (ve altı) otomatik kodlu oluşturma çakışmasız: her biri ayrı kod alır", async () => {
    const p = pfx();
    const make = (name: string) =>
      createWithSuggestedCode({
        kind: "item",
        code: `${p}-0001`, // ikisi de aynı öneriyi görmüş gibi başlar
        auto: true,
        suggest: (prefix) => suggestCode(admin(A), { kind: "item", prefix }),
        create: async (code) => {
          await createItem(admin(A), { code, name, baseUnitId: A.unitId });
          return code;
        },
      });
    const two = await Promise.all([make("Eş 1"), make("Eş 2")]);
    expect(new Set(two).size).toBe(2);
    expect(two.sort()).toEqual([`${p}-0001`, `${p}-0002`]);
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => make(`Eş ${n + 2}`)));
    expect(new Set(six).size).toBe(6);
    const total = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.items WHERE tenant_id = $1 AND code LIKE $2", [A.tenantId, `${p}-%`]);
    expect(Number(total.rows[0]?.n)).toBe(8);
  });

  it("kullanıcının yazdığı kod sessizce değişmez: çakışma CODE_TAKEN olarak görünür", async () => {
    const p = pfx();
    await createItem(admin(A), { code: `${p}-0001`, name: "Var", baseUnitId: A.unitId });
    const e = await failure(
      createWithSuggestedCode({
        kind: "item",
        code: `${p}-0001`,
        auto: false,
        suggest: (prefix) => suggestCode(admin(A), { kind: "item", prefix }),
        create: (code) => createItem(admin(A), { code, name: "Yeni", baseUnitId: A.unitId }),
      }),
    );
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
  });
});

describe("toplu raf oluşturucu (görev 2)", () => {
  it("planBulkLocations: kod biçimi, sayı, sınır ve geçersiz aralıklar (saf)", () => {
    const plan = planBulkLocations({ zone: "a", rackFrom: 1, rackTo: 10, levelFrom: 1, levelTo: 5 });
    expect(plan.codes).toHaveLength(50);
    expect(plan.codes[0]).toBe("A-01-01");
    expect(plan.codes[49]).toBe("A-10-05");
    expect(planBulkLocations({ zone: "B", rackFrom: 1, rackTo: 100, levelFrom: 1, levelTo: 3 }).codes[0]).toBe("B-001-01");
    expect(planBulkLocations({ zone: "A", rackFrom: 1, rackTo: 40, levelFrom: 1, levelTo: 50 }).codes).toHaveLength(BULK_LOCATIONS_MAX);
  });

  it("planBulkLocations: sınır aşımı, ters aralık, geçersiz bölge ve TRANSIT reddedilir", () => {
    const bad = (s: Parameters<typeof planBulkLocations>[0]) => {
      try {
        planBulkLocations(s);
      } catch (e) {
        return e as AppError;
      }
      throw new Error("expected rejection");
    };
    expect(bad({ zone: "A", rackFrom: 1, rackTo: 41, levelFrom: 1, levelTo: 50 })).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    expect(bad({ zone: "A", rackFrom: 5, rackTo: 4, levelFrom: 1, levelTo: 1 }).code).toBe("VALIDATION_FAILED");
    expect(bad({ zone: "A", rackFrom: 0, rackTo: 4, levelFrom: 1, levelTo: 1 }).code).toBe("VALIDATION_FAILED");
    expect(bad({ zone: "A-1", rackFrom: 1, rackTo: 4, levelFrom: 1, levelTo: 1 }).code).toBe("VALIDATION_FAILED");
    expect(bad({ zone: "", rackFrom: 1, rackTo: 4, levelFrom: 1, levelTo: 1 }).code).toBe("VALIDATION_FAILED");
    expect(bad({ zone: "A", rackFrom: 1, rackTo: 4, levelFrom: 1, levelTo: 1, kind: "TRANSIT" }).code).toBe("VALIDATION_FAILED");
    expect(bad({ zone: "A", rackFrom: 1.5, rackTo: 4, levelFrom: 1, levelTo: 1 }).code).toBe("VALIDATION_FAILED");
  });

  it("önizleme 50 lokasyonu söyler, yazmaz; oluşturma tek komutla 50 satır + 1 audit + sayım kilitleri üretir", async () => {
    const warehouseId = await newWarehouse(A);
    const spec = { warehouseId, zone: "A", rackFrom: 1, rackTo: 10, levelFrom: 1, levelTo: 5 };
    const pre = await previewBulkLocations(admin(A), spec);
    expect(pre).toMatchObject({ count: 50, first: "A-01-01", last: "A-10-05", conflictCount: 0, conflicts: [], max: BULK_LOCATIONS_MAX });
    expect(pre.sample[0]).toBe("A-01-01");
    expect(await countLocations(A.tenantId, warehouseId, "A-%")).toBe(0);

    const k = key();
    const res = await createBulkLocations(admin(A), { ...spec, idempotencyKey: k });
    expect(res).toEqual({ created: 50, first: "A-01-01", last: "A-10-05", replayed: false });
    expect(await countLocations(A.tenantId, warehouseId, "A-%")).toBe(50);
    const rows = await adm.query<{ depth: number; kind: string; name: string; parent_id: string | null }>(
      "SELECT depth, kind, name, parent_id FROM public.locations WHERE tenant_id = $1 AND warehouse_id = $2 AND code = 'A-03-04'",
      [A.tenantId, warehouseId],
    );
    expect(rows.rows[0]).toMatchObject({ depth: 0, kind: "STORAGE", name: "A-03-04", parent_id: null });
    const locks = await adm.query<{ n: string }>(
      "SELECT count(*) AS n FROM public.location_count_locks k JOIN public.locations l ON l.tenant_id = k.tenant_id AND l.id = k.location_id WHERE l.tenant_id = $1 AND l.warehouse_id = $2",
      [A.tenantId, warehouseId],
    );
    expect(Number(locks.rows[0]?.n)).toBe(50);
    const audit = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'location.created' AND change_summary->>'bulk_ref' = $2", [A.tenantId, k]);
    expect(Number(audit.rows[0]?.n)).toBe(1);
    const tree = await getLocationTree(admin(A), { warehouseId, limit: 100 });
    expect(tree.items).toHaveLength(50);
  });

  it("üst lokasyon altında oluşturur (depth = ebeveyn + 1); geçersiz ebeveyn PARENT_INVALID", async () => {
    const warehouseId = await newWarehouse(A);
    const parent = await createLocation(admin(A), { warehouseId, code: "BOLGE-A", name: "Bölge A", kind: "STORAGE" });
    await createBulkLocations(admin(A), { warehouseId, parentId: parent.locationId, zone: "R", rackFrom: 1, rackTo: 2, levelFrom: 1, levelTo: 2, idempotencyKey: key() });
    const r = await adm.query<{ depth: number; parent_id: string }>("SELECT depth, parent_id FROM public.locations WHERE tenant_id = $1 AND warehouse_id = $2 AND code = 'R-02-02'", [A.tenantId, warehouseId]);
    expect(r.rows[0]).toMatchObject({ depth: 1, parent_id: parent.locationId });
    const e = await failure(createBulkLocations(admin(A), { warehouseId, parentId: randomUUID(), zone: "Q", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1, idempotencyKey: key() }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "PARENT_INVALID" });
  });

  it("çakışma: önizleme mevcut kodları listeler, oluşturma CODE_TAKEN ile reddedilir ve HİÇBİR satır yazılmaz", async () => {
    const warehouseId = await newWarehouse(A);
    await createLocation(admin(A), { warehouseId, code: "C-01-02", name: "Var", kind: "STORAGE" });
    await createLocation(admin(A), { warehouseId, code: "C-02-01", name: "Var", kind: "STORAGE" });
    const spec = { warehouseId, zone: "C", rackFrom: 1, rackTo: 3, levelFrom: 1, levelTo: 3 };
    const pre = await previewBulkLocations(admin(A), spec);
    expect(pre.count).toBe(9);
    expect(pre.conflicts).toEqual(["C-01-02", "C-02-01"]);
    expect(pre.conflictCount).toBe(2);
    const e = await failure(createBulkLocations(admin(A), { ...spec, idempotencyKey: key() }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    expect(await countLocations(A.tenantId, warehouseId, "C-%")).toBe(2);
  });

  it("üst sınır: 2.000 oluşur, 2.001 hiçbir şey yazmadan reddedilir", async () => {
    const warehouseId = await newWarehouse(A);
    const over = await failure(createBulkLocations(admin(A), { warehouseId, zone: "M", rackFrom: 1, rackTo: 667, levelFrom: 1, levelTo: 3, idempotencyKey: key() }));
    expect(over).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    expect(await countLocations(A.tenantId, warehouseId, "M-%")).toBe(0);
    const ok = await createBulkLocations(admin(A), { warehouseId, zone: "M", rackFrom: 1, rackTo: 40, levelFrom: 1, levelTo: 50, idempotencyKey: key() });
    expect(ok.created).toBe(2000);
    expect(await countLocations(A.tenantId, warehouseId, "M-%")).toBe(2000);
  });

  it("idempotency: aynı anahtar + aynı girdi yeni satır üretmez; farklı girdi IDEMPOTENCY_MISMATCH; anahtar zorunlu", async () => {
    const warehouseId = await newWarehouse(A);
    const spec = { warehouseId, zone: "I", rackFrom: 1, rackTo: 2, levelFrom: 1, levelTo: 3 };
    const k = key();
    expect((await createBulkLocations(admin(A), { ...spec, idempotencyKey: k })).replayed).toBe(false);
    const again = await createBulkLocations(admin(A), { ...spec, idempotencyKey: k });
    expect(again).toEqual({ created: 6, first: "I-01-01", last: "I-02-03", replayed: true });
    expect(await countLocations(A.tenantId, warehouseId, "I-%")).toBe(6);
    expect((await failure(createBulkLocations(admin(A), { ...spec, rackTo: 3, idempotencyKey: k }))).code).toBe("IDEMPOTENCY_MISMATCH");
    const missing = await failure(createBulkLocations(admin(A), { ...spec, zone: "J", idempotencyKey: "" }));
    expect(missing).toMatchObject({ code: "VALIDATION_FAILED", detail: "IDEMPOTENCY_KEY_REQUIRED" });
    expect((await failure(createBulkLocations(admin(A), { ...spec, zone: "J", idempotencyKey: "degil-uuid" }))).code).toBe("VALIDATION_FAILED");
  });

  it("eşzamanlı aynı anahtar: biri yazar, diğeri aynı sonucu tekrarlar (50 satır, 1 audit)", async () => {
    const warehouseId = await newWarehouse(A);
    const spec = { warehouseId, zone: "P", rackFrom: 1, rackTo: 10, levelFrom: 1, levelTo: 5 };
    const k = key();
    const [r1, r2] = await Promise.all([createBulkLocations(admin(A), { ...spec, idempotencyKey: k }), createBulkLocations(admin(A), { ...spec, idempotencyKey: k })]);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect(await countLocations(A.tenantId, warehouseId, "P-%")).toBe(50);
    const audit = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND change_summary->>'bulk_ref' = $2", [A.tenantId, k]);
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it("eşzamanlı farklı anahtar, aynı kodlar: biri başarır, diğeri CODE_TAKEN (kısmi yazım yok)", async () => {
    const warehouseId = await newWarehouse(A);
    const spec = { warehouseId, zone: "S", rackFrom: 1, rackTo: 10, levelFrom: 1, levelTo: 5 };
    const results = await Promise.allSettled([createBulkLocations(admin(A), { ...spec, idempotencyKey: key() }), createBulkLocations(admin(A), { ...spec, idempotencyKey: key() })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    expect(await countLocations(A.tenantId, warehouseId, "S-%")).toBe(50);
  });

  it("yetki: settings.manage olmayan üye önizleyemez ve oluşturamaz", async () => {
    const warehouseId = await newWarehouse(A);
    const spec = { warehouseId, zone: "Y", rackFrom: 1, rackTo: 2, levelFrom: 1, levelTo: 2 };
    expect((await failure(previewBulkLocations(picker(A), spec))).code).toBe("FORBIDDEN");
    expect((await failure(createBulkLocations(picker(A), { ...spec, idempotencyKey: key() }))).code).toBe("FORBIDDEN");
    expect(await countLocations(A.tenantId, warehouseId, "Y-%")).toBe(0);
  });

  it("tenant izolasyonu: başka tenant'ın deposu NOT_FOUND; aynı anahtar başka tenant'ta ayrı kayıttır", async () => {
    const spec = { zone: "T", rackFrom: 1, rackTo: 2, levelFrom: 1, levelTo: 2 };
    const k = key();
    expect((await failure(previewBulkLocations(admin(A), { ...spec, warehouseId: B.warehouseId }))).code).toBe("NOT_FOUND");
    expect((await failure(createBulkLocations(admin(A), { ...spec, warehouseId: B.warehouseId, idempotencyKey: k }))).code).toBe("NOT_FOUND");
    const wa = await newWarehouse(A);
    const wb = await newWarehouse(B);
    expect((await createBulkLocations(admin(A), { ...spec, warehouseId: wa, idempotencyKey: k })).replayed).toBe(false);
    expect((await createBulkLocations(admin(B), { ...spec, warehouseId: wb, idempotencyKey: k })).replayed).toBe(false);
    expect(await countLocations(B.tenantId, wb, "T-%")).toBe(4);
    expect(await countLocations(B.tenantId, B.warehouseId, "T-%")).toBe(0);
  });

  it("arşivli depoda oluşturulamaz", async () => {
    const warehouseId = await newWarehouse(A);
    await archiveWarehouse(admin(A), { warehouseId });
    const e = await failure(createBulkLocations(admin(A), { warehouseId, zone: "X", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1, idempotencyKey: key() }));
    expect(e.code).toBe("VALIDATION_FAILED");
  });
});

describe("rehber ilerlemesi ve lokasyon araması (görev 4, 5)", () => {
  it("boş tenant: hiçbir adım tamam değil; depo → raf → ürün sırasıyla tamamlanır", async () => {
    const w = await (async () => {
      const t = randomUUID();
      const slug = `t250-prog-${randomUUID().slice(0, 8)}`;
      const owner = await mkUser(adm, reg, "P250 owner");
      await adm.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [t, slug, "T250 ilerleme"]);
      await mkMembership(adm, t, owner, { isOwner: true, roles: ["TENANT_ADMIN"] });
      return { slug, ownerUserId: owner };
    })();
    expect(await getSetupProgress(admin(w))).toEqual({ hasWarehouse: false, hasLocation: false, hasItem: false, nextWarehouseId: null });
    const { warehouseId } = await createWarehouse(admin(w), { code: "DEPO-01", name: "Ana" });
    expect(await getSetupProgress(admin(w))).toEqual({ hasWarehouse: true, hasLocation: false, hasItem: false, nextWarehouseId: warehouseId });
    await createBulkLocations(admin(w), { warehouseId, zone: "A", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 2, idempotencyKey: key() });
    expect(await getSetupProgress(admin(w))).toEqual({ hasWarehouse: true, hasLocation: true, hasItem: false, nextWarehouseId: warehouseId });
    const { unitId } = await createUnit(admin(w), { code: "ADET", name: "Adet" });
    const { itemId } = await createItem(admin(w), { code: "URN-0001", name: "İlk ürün", baseUnitId: unitId });
    expect(await getSetupProgress(admin(w))).toMatchObject({ hasWarehouse: true, hasLocation: true, hasItem: true });
    await archiveItem(admin(w), { itemId });
    expect((await getSetupProgress(admin(w))).hasItem).toBe(false); // yalnızca aktif ürün sayılır
  });

  it("searchLocations: önek eşleşmesi (büyük/küçük harf duyarsız), sınırlı sonuç, başka tenant'ın deposu NOT_FOUND", async () => {
    const warehouseId = await newWarehouse(A);
    await createBulkLocations(admin(A), { warehouseId, zone: "A", rackFrom: 1, rackTo: 3, levelFrom: 1, levelTo: 3, idempotencyKey: key() });
    const hit = await searchLocations(admin(A), { warehouseId, q: "a-02" });
    expect(hit.map((l) => l.code)).toEqual(["A-02-01", "A-02-02", "A-02-03"]);
    expect(await searchLocations(admin(A), { warehouseId, q: "", limit: 4 })).toHaveLength(4);
    expect(await searchLocations(admin(A), { warehouseId, q: "A-02-02" })).toHaveLength(1);
    expect(await searchLocations(admin(A), { warehouseId, q: "A_" })).toHaveLength(0); // joker yok
    expect((await failure(searchLocations(admin(A), { warehouseId: B.warehouseId, q: "A" }))).code).toBe("NOT_FOUND");
    expect((await failure(searchLocations(admin(A), { warehouseId, q: "A", limit: 500 }))).code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// T-259 (T-250 inceleme MINOR-1…7). Madde → test eşlemesi raporda; her madde için mutasyon kanıtı raporda.
// ---------------------------------------------------------------------------------------------------------------------------
async function newTenant(tag: string): Promise<{ tenantId: string; slug: string; ownerUserId: string }> {
  const tenantId = randomUUID();
  const slug = `t259-${tag}-${randomUUID().slice(0, 8)}`;
  const ownerUserId = await mkUser(adm, reg, `${tag} 259 owner`);
  await adm.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [tenantId, slug, `T259 ${tag}`]);
  await mkMembership(adm, tenantId, ownerUserId, { isOwner: true, roles: ["TENANT_ADMIN"] });
  return { tenantId, slug, ownerUserId };
}
async function unitCodes(tenantId: string): Promise<string[]> {
  return (await adm.query<{ code: string }>("SELECT code FROM public.units WHERE tenant_id = $1 ORDER BY code", [tenantId])).rows.map((r) => r.code);
}
async function itemCount(tenantId: string, code?: string): Promise<number> {
  const r = code === undefined
    ? await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.items WHERE tenant_id = $1", [tenantId])
    : await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.items WHERE tenant_id = $1 AND code = $2", [tenantId, code]);
  return Number(r.rows[0]?.n);
}
/** Üretim SQL'ini wms_app + tenant bağlamıyla (RLS açık) EXPLAIN eder; plan metni döner. */
async function explain(tenantId: string, query: SQL): Promise<string> {
  const q = new PgDialect().sqlToQuery(query);
  await adm.query("BEGIN");
  try {
    await adm.query("SET LOCAL ROLE wms_app");
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await adm.query<Record<string, string>>(`EXPLAIN ${q.sql}`, q.params as unknown[]);
    return r.rows.map((x) => Object.values(x)[0]).join("\n");
  } finally {
    await adm.query("ROLLBACK");
  }
}

describe("T-259 MINOR-1: sunucu autoCode bayrağına güvenmez", () => {
  it("suggestedCodePrefix: yalnızca sunucunun üreteceği biçim (kanonik dolgu, büyük harf) eşleşir", () => {
    expect(suggestedCodePrefix("item", "URN-0042")).toBe("URN");
    expect(suggestedCodePrefix("item", "MYPFX-0001")).toBe("MYPFX");
    expect(suggestedCodePrefix("warehouse", "DEPO-02")).toBe("DEPO");
    expect(suggestedCodePrefix("item", "urn-0042")).toBeNull(); // küçük harf: kullanıcı yazmış
    expect(suggestedCodePrefix("item", "URN-42")).toBeNull(); // dolgusuz
    expect(suggestedCodePrefix("item", "URN-0042-X")).toBeNull();
    expect(suggestedCodePrefix("item", "VIDA")).toBeNull();
    expect(suggestedCodePrefix("warehouse", "DEPO-0002")).toBeNull(); // depo için genişlik 2: 4 basamaklı dolgu kanonik değil
  });

  it("autoCode:true ama kod önerilen biçimde DEĞİL (elle yazılmış): çakışma CODE_TAKEN, öneri sorgulanmaz, ek kayıt yok", async () => {
    const p = pfx();
    await createItem(admin(A), { code: `${p}-1`, name: "Elle yazılmış", baseUnitId: A.unitId });
    let suggestCalls = 0;
    const e = await failure(
      createWithSuggestedCode({
        kind: "item",
        code: `${p}-1`, // kullanıcı "-1" yazdı (kanonik "-0001" değil); istemci yine de autoCode:true gönderdi
        auto: true,
        suggest: (prefix) => {
          suggestCalls++;
          return suggestCode(admin(A), { kind: "item", prefix });
        },
        create: (code) => createItem(admin(A), { code, name: "Yeni", baseUnitId: A.unitId }),
      }),
    );
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    expect(suggestCalls).toBe(0);
    expect(await itemCount(A.tenantId, `${p}-2`)).toBe(0);
    expect(await itemCount(A.tenantId, `${p}-0002`)).toBe(0);
  });

  it("önerilen biçimde ve çakışırsa: yeniden deneme GÖNDERİLEN önekle yapılır (varsayılan URN ile değil)", async () => {
    const p = pfx();
    await createItem(admin(A), { code: `${p}-0001`, name: "Var", baseUnitId: A.unitId });
    const seen: string[] = [];
    const code = await createWithSuggestedCode({
      kind: "item",
      code: `${p}-0001`,
      auto: true,
      suggest: (prefix) => {
        seen.push(prefix);
        return suggestCode(admin(A), { kind: "item", prefix });
      },
      create: async (c) => {
        await createItem(admin(A), { code: c, name: "Yeni", baseUnitId: A.unitId });
        return c;
      },
    });
    expect(seen).toEqual([p]);
    expect(code).toBe(`${p}-0002`);
  });
});

describe("T-259 MINOR-3/4: varsayılan birim + ürün tek transaction; sessiz birim seçimi yok", () => {
  it("birimi olmayan tenant: ADET + ürün birlikte oluşur; eşzamanlı iki oluşturma tek ADET üretir; sonraki mevcut ADET'i kullanır", async () => {
    const w = await newTenant("unit");
    const [a, b] = await Promise.all([
      createItemWithDefaultUnit(admin(w), { code: "K-1", name: "Bir" }),
      createItemWithDefaultUnit(admin(w), { code: "K-2", name: "İki" }),
    ]);
    expect(a.unitId).toBe(b.unitId);
    expect([a.unitCreated, b.unitCreated].filter(Boolean)).toHaveLength(1);
    expect(await unitCodes(w.tenantId)).toEqual(["ADET"]);
    expect(await itemCount(w.tenantId)).toBe(2);
    const c = await createItemWithDefaultUnit(admin(w), { code: "K-3", name: "Üç" });
    expect(c).toMatchObject({ unitId: a.unitId, unitCreated: false });
    const audits = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'unit.created'", [w.tenantId]);
    expect(Number(audits.rows[0]?.n)).toBe(1);
  });

  it("ürün reddedilirse (CODE_TAKEN) yeni açılan ADET de geri alınır: yetim birim kalmaz", async () => {
    const w = await newTenant("atomic");
    const { unitId } = await createUnit(admin(w), { code: "ESKI", name: "Eski birim" });
    await createItem(admin(w), { code: "VAR-1", name: "Var", baseUnitId: unitId });
    await adm.query("UPDATE public.units SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [w.tenantId, unitId]); // aktif birim kalmadı
    const e = await failure(createItemWithDefaultUnit(admin(w), { code: "VAR-1", name: "Aynı kod" }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    expect(await unitCodes(w.tenantId)).toEqual(["ESKI"]); // ADET yok
    const audits = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'unit.created' AND change_summary->>'code' = 'ADET'", [w.tenantId]);
    expect(Number(audits.rows[0]?.n)).toBe(0);
    expect(await itemCount(w.tenantId)).toBe(1);
  });

  it("aktif birim var ama ADET yok: sessiz seçim yok → VALIDATION_FAILED, ne ürün ne birim yazılır", async () => {
    const w = await newTenant("nosilent");
    await createUnit(admin(w), { code: "KG", name: "Kilogram" });
    await createUnit(admin(w), { code: "LT", name: "Litre" });
    const e = await failure(createItemWithDefaultUnit(admin(w), { code: "X-1", name: "Birim seçilmedi" }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toBeUndefined();
    expect(await itemCount(w.tenantId)).toBe(0);
    expect(await unitCodes(w.tenantId)).toEqual(["KG", "LT"]);
  });

  it("ADET arşivliyse ve aktif birim yoksa VALIDATION_FAILED (arşivli birim sessizce açılmaz); açık birim verilince çalışır", async () => {
    const w = await newTenant("archived");
    const { unitId } = await createUnit(admin(w), { code: "ADET", name: "Adet" });
    await adm.query("UPDATE public.units SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [w.tenantId, unitId]);
    expect((await failure(createItemWithDefaultUnit(admin(w), { code: "Y-1", name: "Arşivli ADET" }))).code).toBe("VALIDATION_FAILED");
    expect(await itemCount(w.tenantId)).toBe(0);
    const k = await createUnit(admin(w), { code: "KOLI", name: "Koli" });
    expect(await createItemWithDefaultUnit(admin(w), { code: "Y-2", name: "Açık birim", baseUnitId: k.unitId })).toMatchObject({ unitId: k.unitId, unitCreated: false });
  });

  it("aktif ADET varsa o kullanılır; yetkisiz üye oluşturamaz", async () => {
    const r = await createItemWithDefaultUnit(admin(A), { code: `Z-${pfx()}`, name: "ADET'li tenant" });
    const u = await adm.query<{ code: string }>("SELECT code FROM public.units WHERE tenant_id = $1 AND id = $2", [A.tenantId, r.unitId]);
    expect(r.unitCreated).toBe(false);
    expect(u.rows[0]).toBeDefined();
    expect((await failure(createItemWithDefaultUnit(picker(A), { code: `Z-${pfx()}`, name: "Yetkisiz" }))).code).toBe("FORBIDDEN");
  });
});

describe("T-259 MINOR-5/6/7: indeksler ve depo başına lokasyon sınırı", () => {
  let big: { tenantId: string; slug: string; ownerUserId: string };
  let bigWh: string;
  const BASE = WAREHOUSE_LOCATIONS_MAX - 10;

  beforeAll(async () => {
    big = await newTenant("big");
    bigWh = (await createWarehouse(admin(big), { code: "BUYUK", name: "Büyük depo" })).warehouseId;
    await adm.query(
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       SELECT $1::uuid, gen_random_uuid(), $2::uuid, NULL, 'R-' || lpad(n::text, 6, '0'), 'R-' || lpad(n::text, 6, '0'), 0, 'STORAGE'
         FROM generate_series(1, $3::int) AS n`,
      [big.tenantId, bigWh, BASE],
    );
    // audit_logs: indeks ölçeği için aynı tenant'a bulk_ref'siz çok satır + az sayıda bulk_ref'li satır (satırlar değişmez; geçici ortamda kalır).
    await adm.query(
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, change_summary)
       SELECT $1::uuid, 'location.created', 'location', jsonb_build_object('n', n) FROM generate_series(1, 30000) AS n`,
      [big.tenantId],
    );
    await adm.query(
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, change_summary)
       SELECT $1::uuid, 'location.created', 'location_batch', jsonb_build_object('bulk_ref', md5(n::text), 'spec_fp', 'x', 'created', 1) FROM generate_series(1, 5) AS n`,
      [big.tenantId],
    );
    await adm.query("ANALYZE public.locations");
    await adm.query("ANALYZE public.audit_logs");
  }, 300_000);

  it("MINOR-5: idempotency araması kısmi indeksi wms_app+RLS altında kullanır (EXPLAIN) ve replay doğru çalışır", async () => {
    const plan = await explain(big.tenantId, bulkRefLookupSql(big.tenantId, "00000000-0000-0000-0000-000000000000"));
    expect(plan).toMatch(/Index Scan|Bitmap (Heap|Index) Scan/);
    expect(plan).toContain("audit_logs_tenant_bulk_ref_idx");
    const def = await adm.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'audit_logs_tenant_bulk_ref_idx'");
    expect(def.rows[0]?.indexdef).toMatch(/\(tenant_id, entity_id\) WHERE \(entity_type = 'location_batch'::text\)/);
    // Gerçek anahtar: indeksli sorgu hâlâ doğru satırı döner (replay yolu).
    const k = key();
    const idxWh = (await createWarehouse(admin(big), { code: "IDXDEPO", name: "Idx depo" })).warehouseId;
    const spec = { warehouseId: idxWh, zone: "IDX", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1 };
    await createBulkLocations(admin(big), { ...spec, idempotencyKey: k });
    expect((await createBulkLocations(admin(big), { ...spec, idempotencyKey: k })).replayed).toBe(true);
  });

  it("MINOR-7: lokasyon typeahead kod kolu `locations_search_code_idx` indeksini wms_app+RLS altında kullanır (EXPLAIN); joker yok; ad kolu korunur", async () => {
    const plan = await explain(big.tenantId, locationSearchSql(big.tenantId, bigWh, "r-0499", 8));
    expect(plan).toMatch(/(Index Scan|Bitmap Index Scan) using locations_search_code_idx on locations/); // kod kolu: indeksli
    // Ad kolu (lower(name)) RLS altında indekslenemez (leakproof değil; 0021 başlığı): bilinen, depo başına sınırla (A-259-1) sınırlı bacak.
    const hit = await searchLocations(admin(big), { warehouseId: bigWh, q: "R-0499", limit: 20 });
    expect(hit.length).toBe(20);
    expect(hit.every((l) => l.code.startsWith("R-0499"))).toBe(true);
    expect(await searchLocations(admin(big), { warehouseId: bigWh, q: "r-%", limit: 5 })).toHaveLength(0); // % joker değil
    expect(await searchLocations(admin(big), { warehouseId: bigWh, q: "R_", limit: 5 })).toHaveLength(0);
    expect(await searchLocations(admin(big), { warehouseId: bigWh, q: "R\\", limit: 5 })).toHaveLength(0);
    expect(await searchLocations(admin(big), { warehouseId: bigWh, q: "R-000001" })).toHaveLength(1);
    // Ad kolu (indekssiz bacak) ve ASCII dışı kod girdisi eski büyük/küçük harf duyarsız anlamını korur.
    const wh = await newWarehouse(A);
    await createLocation(admin(A), { warehouseId: wh, code: "XYZ-1", name: "Soğuk Oda", kind: "STORAGE" });
    await createLocation(admin(A), { warehouseId: wh, code: "ÇELIK-1", name: "Çelik raf", kind: "STORAGE" });
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "soğ" })).map((l) => l.code)).toEqual(["XYZ-1"]);
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "SOĞUK" })).map((l) => l.code)).toEqual(["XYZ-1"]);
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "xyz" })).map((l) => l.code)).toEqual(["XYZ-1"]);
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "çelik" })).map((l) => l.code)).toEqual(["ÇELIK-1"]);
    expect((await failure(searchLocations(admin(A), { warehouseId: wh, q: "a\u0000b" }))).code).toBe("VALIDATION_FAILED");
  });

  it("MINOR-6: depo başına toplam sınır: eşzamanlı iki komut sınırı birlikte aşamaz; sınırda 50.000 oluşur, +1 DOCUMENT_TOO_LARGE ve yazım yok", async () => {
    const tooBig = { warehouseId: bigWh, zone: "ZA", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 11 }; // 49.990 + 11 > 50.000
    const e = await failure(createBulkLocations(admin(big), { ...tooBig, idempotencyKey: key() }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    expect(await countLocations(big.tenantId, bigWh, "ZA-%")).toBe(0);
    expect(await previewBulkLocations(admin(big), { ...tooBig, levelTo: 10 })).toMatchObject({ count: 10 }); // tam sığıyor
    expect((await failure(previewBulkLocations(admin(big), tooBig))).detail).toBe("DOCUMENT_TOO_LARGE"); // önizleme de reddeder

    // Eşzamanlı: her biri 6 (toplam 12 > 10 boş yer): tam biri yazar (kilit yoksa ikisi de sayımı 49.990 görüp geçerdi).
    const six = (zone: string) => createBulkLocations(admin(big), { warehouseId: bigWh, zone, rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 6, idempotencyKey: key() });
    const results = await Promise.allSettled([six("ZB"), six("ZC")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    const total = async () => Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.locations WHERE tenant_id = $1 AND warehouse_id = $2", [big.tenantId, bigWh])).rows[0]?.n);
    expect(await total()).toBe(BASE + 6);

    const rest = await createBulkLocations(admin(big), { warehouseId: bigWh, zone: "ZD", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 4, idempotencyKey: key() });
    expect(rest.created).toBe(4);
    expect(await total()).toBe(WAREHOUSE_LOCATIONS_MAX);
    const over = await failure(createBulkLocations(admin(big), { warehouseId: bigWh, zone: "ZE", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1, idempotencyKey: key() }));
    expect(over).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    expect(await total()).toBe(WAREHOUSE_LOCATIONS_MAX);
    // Başka depo etkilenmez (sınır depo başınadır).
    const other = await createWarehouse(admin(big), { code: "DIGER", name: "Diğer" });
    expect((await createBulkLocations(admin(big), { warehouseId: other.warehouseId, zone: "ZF", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 2, idempotencyKey: key() })).created).toBe(2);
  }, 120_000);

  it("MINOR-6: sınır denetimi depo başına advisory kilitle serileşir (kilit tutulurken komut bekler, bırakılınca tamamlanır)", async () => {
    const wh = await newWarehouse(A);
    const lockKey = `${A.tenantId}:warehouse-locations-cap:${wh}`;
    await adm.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    let released = false;
    try {
      const p = createBulkLocations(admin(A), { warehouseId: wh, zone: "LK", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1, idempotencyKey: key() });
      const state = await Promise.race([p.then(() => "done"), new Promise<string>((r) => setTimeout(() => r("blocked"), 1000))]);
      expect(state).toBe("blocked");
      expect(await countLocations(A.tenantId, wh, "LK-%")).toBe(0);
      await adm.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      released = true;
      expect((await p).created).toBe(1);
    } finally {
      if (!released) await adm.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    }
  });

  it("MINOR-6 (güvenlik incelemesi): tekli createLocation da sınırı denetler: dolu depoda VALIDATION_FAILED, yazım yok", async () => {
    const e = await failure(createLocation(admin(big), { warehouseId: bigWh, code: "TEKLI-1", name: "Sınır üstü", kind: "STORAGE" }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
    expect(await countLocations(big.tenantId, bigWh, "TEKLI-%")).toBe(0);
  });

  it("MINOR-6 (güvenlik incelemesi): sınırda 49.999 iken tekli + toplu yarışı: kilit bariyeriyle ikisi birlikte aşamaz (toplam ≤ 50.000)", async () => {
    const wh = await newWarehouse(A);
    await adm.query(
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       SELECT $1::uuid, gen_random_uuid(), $2::uuid, NULL, 'Q-' || lpad(n::text, 6, '0'), 'Q-' || lpad(n::text, 6, '0'), 0, 'STORAGE'
         FROM generate_series(1, $3::int) AS n`,
      [A.tenantId, wh, WAREHOUSE_LOCATIONS_MAX - 1],
    );
    const total = async () => Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.locations WHERE tenant_id = $1 AND warehouse_id = $2", [A.tenantId, wh])).rows[0]?.n);
    const lockKey = `${A.tenantId}:warehouse-locations-cap:${wh}`;
    // Bariyer: kilit adm oturumunda tutulur; iki komut da sayımdan ÖNCE aynı kilitte bekler (kilitsiz tekli komut burada geçip yazardı).
    await adm.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    let released = false;
    try {
      const single = createLocation(admin(A), { warehouseId: wh, code: "RACE-S", name: "tekli", kind: "STORAGE" });
      const bulk = createBulkLocations(admin(A), { warehouseId: wh, zone: "RB", rackFrom: 1, rackTo: 1, levelFrom: 1, levelTo: 1, idempotencyKey: key() });
      const settled = Promise.allSettled([single, bulk]);
      const state = await Promise.race([settled.then(() => "done"), new Promise<string>((r) => setTimeout(() => r("blocked"), 1500))]);
      expect(state).toBe("blocked");
      expect(await total()).toBe(WAREHOUSE_LOCATIONS_MAX - 1);
      await adm.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      released = true;
      const [rs, rb] = await settled;
      expect([rs, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rej = [rs, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rej.reason).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" });
      expect(await total()).toBe(WAREHOUSE_LOCATIONS_MAX);
    } finally {
      if (!released) await adm.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    }
  }, 120_000);
});

describe("T-273: T-259 MINOR takipleri", () => {
  const spec = (warehouseId: string) => ({ warehouseId, zone: "LG", rackFrom: 1, rackTo: 2, levelFrom: 1, levelTo: 2 });

  async function legacyAudit(tenantId: string, bulkRef: string, from: Record<string, unknown>): Promise<void> {
    // T-250 biçimi: entity_id anahtar DEĞİL (ilk lokasyonun kimliği gibi rastgele UUID), anahtar yalnızca change_summary.bulk_ref'te.
    await adm.query(
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, entity_id, change_summary)
       VALUES ($1::uuid, 'location.created', 'location_batch', $2, $3::jsonb)`,
      [tenantId, randomUUID(), JSON.stringify({ ...from, bulk_ref: bulkRef })],
    );
  }
  async function fpOf(tenantId: string, k: string): Promise<{ spec_fp: string; created: number }> {
    const r = await adm.query<{ s: Record<string, unknown> }>("SELECT change_summary AS s FROM public.audit_logs WHERE tenant_id = $1 AND entity_id = $2", [tenantId, k]);
    return { spec_fp: r.rows[0]?.s.spec_fp as string, created: r.rows[0]?.s.created as number };
  }

  it("eski biçim (entity_id ≠ anahtar, yalnızca bulk_ref) 7 günlük pencerede replay; farklı girdi IDEMPOTENCY_MISMATCH; pencere dışı ve başka tenant görünmez", async () => {
    const warehouseId = await newWarehouse(A);
    const k1 = key();
    await createBulkLocations(admin(A), { ...spec(warehouseId), idempotencyKey: k1 }); // 4 lokasyon yazar (yeni biçim)
    const { spec_fp, created } = await fpOf(A.tenantId, k1);
    const before = await countLocations(A.tenantId, warehouseId, "LG-%");
    expect(before).toBe(4);

    const k2 = key();
    await legacyAudit(A.tenantId, k2, { spec_fp, created, first_loc: "LG-01-01", last_loc: "LG-02-02" });
    expect(await createBulkLocations(admin(A), { ...spec(warehouseId), idempotencyKey: k2 })).toMatchObject({ replayed: true, created: 4 });
    expect(await countLocations(A.tenantId, warehouseId, "LG-%")).toBe(before); // yeni yazım yok
    const e = await failure(createBulkLocations(admin(A), { ...spec(warehouseId), rackTo: 3, idempotencyKey: k2 }));
    expect(e.code).toBe("IDEMPOTENCY_MISMATCH");

    // Pencere: audit `occurred_at` tetikleyiciyle now()'a zorlanır (ENABLE ALWAYS; geriye tarihlenemez) → sınır SQL düzeyinde sınanır: 7 gün içinde bulunur,
    // pencere 0 gündeyken (satır artık "eski") bulunmaz; tenant süzgeci açıktır.
    expect(IDEMPOTENCY_WINDOW_DAYS).toBe(7);
    const run = async (tenantId: string, k: string, days?: number): Promise<number> => {
      const q = new PgDialect().sqlToQuery(bulkRefLegacyLookupSql(tenantId, k, days));
      return (await adm.query(q.sql, q.params as unknown[])).rows.length;
    };
    expect(await run(A.tenantId, k2)).toBe(1);
    expect(await run(A.tenantId, k2, 0)).toBe(0);
    expect(await run(B.tenantId, k2)).toBe(0);
    // Başka tenant'ın eski satırı görünmez
    const k4 = key();
    await legacyAudit(B.tenantId, k4, { spec_fp, created });
    expect((await failure(createBulkLocations(admin(A), { ...spec(warehouseId), idempotencyKey: k4 }))).detail).toBe("CODE_TAKEN");
  });

  it("typeahead: Kelvin işareti (U+212A) ve I+U+0307 girdisi yazımdaki NFC dönüşümüyle (A-98) eşleşir; ASCII yol indeksli kalır", async () => {
    const wh = await newWarehouse(A);
    await createLocation(admin(A), { warehouseId: wh, code: "kelvin-1", name: "Kelvin deneme", kind: "STORAGE" }); // saklanan: KELVIN-1
    await createLocation(admin(A), { warehouseId: wh, code: "İZMIR-1", name: "Izmir raf", kind: "STORAGE" });
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "\u212Aelv" })).map((l) => l.code)).toEqual(["KELVIN-1"]); // NFC: K → ASCII yol
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "I\u0307ZM" })).map((l) => l.code)).toEqual(["İZMIR-1"]); // NFC: İ
    expect((await searchLocations(admin(A), { warehouseId: wh, q: "İZM" })).map((l) => l.code)).toEqual(["İZMIR-1"]);
  });

  it("createItemWithDefaultUnit: ADET satırı FOR SHARE — arşivleyen işlem commit olunca ürün arşivli birimle OLUŞMAZ (VALIDATION_FAILED)", async () => {
    const w = await newTenant("adetrace");
    const { unitId } = await createUnit(admin(w), { code: "ADET", name: "Adet" });
    const blocker = new pg.Client({ connectionString: env.databaseUrlDirect });
    blocker.on("error", () => undefined);
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE public.units SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [w.tenantId, unitId]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as number;
      // Komut düz okumada birimi ACTIVE görür (arşiv commit olmadı), sonra FOR SHARE'de blocker'ı BEKLER (zamanlamaya dayanmaz: yoklama).
      const racing = createItemWithDefaultUnit(admin(w), { code: "R-1", name: "Yarış" }).then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, err: e as AppError }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const r = await adm.query<{ c: string }>("SELECT count(*)::text AS c FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid]);
        if (Number(r.rows[0]?.c) >= 1) break;
        if (Date.now() > deadline) throw new Error("bariyer zaman aşımı: bekleyen yok");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query("COMMIT");
      const out = await racing;
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.err.code).toBe("VALIDATION_FAILED");
      expect(await itemCount(w.tenantId)).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  }, 120_000);
});
