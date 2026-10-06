// T-250: kolay kurulum — kod önerisi, toplu raf oluşturucu, rehber ilerlemesi, lokasyon araması. Gerçek wms_app bağlantısı + RLS.
// Fikstürler sentetik (G-09). audit_logs değişmez olduğundan test tenant'ları geçici Testcontainers ortamında kalır.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { archiveItem, createItem, createUnit, createWithSuggestedCode, ensureDefaultUnit, suggestCode } from "../../../packages/domain/src/catalog/index.ts";
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
        code: `${p}-0001`, // ikisi de aynı öneriyi görmüş gibi başlar
        auto: true,
        suggest: () => suggestCode(admin(A), { kind: "item", prefix: p }),
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
        code: `${p}-0001`,
        auto: false,
        suggest: () => suggestCode(admin(A), { kind: "item", prefix: p }),
        create: (code) => createItem(admin(A), { code, name: "Yeni", baseUnitId: A.unitId }),
      }),
    );
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
  });
});

describe("akıllı varsayılan birim (görev 3)", () => {
  it("birimi olmayan tenant'ta ADET oluşturulur; eşzamanlı iki çağrı tek birim üretir; sonraki çağrı mevcut olanı kullanır", async () => {
    const tenantId = randomUUID();
    const slug = `t250-unit-${randomUUID().slice(0, 8)}`;
    const owner = await mkUser(adm, reg, "U250 owner");
    await adm.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, 'ACTIVE')", [tenantId, slug, "T250 birim"]);
    await mkMembership(adm, tenantId, owner, { isOwner: true, roles: ["TENANT_ADMIN"] });
    const w = { slug, ownerUserId: owner };
    const [a, b] = await Promise.all([ensureDefaultUnit(admin(w)), ensureDefaultUnit(admin(w))]);
    expect(a.unitId).toBe(b.unitId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const rows = await adm.query<{ code: string }>("SELECT code FROM public.units WHERE tenant_id = $1", [tenantId]);
    expect(rows.rows.map((r) => r.code)).toEqual(["ADET"]);
    expect(await ensureDefaultUnit(admin(w))).toEqual({ unitId: a.unitId, created: false });
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
