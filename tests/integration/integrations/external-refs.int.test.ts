// T-252: dış referans eşlemesi + senkron imleçleri (migration 0019). Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Kanıtlar: iki yönlü tekillik (EXTERNAL_REF_CONFLICT), idempotent bağlama, kod değişiminde (T-251) eşleme sabit, tenant izolasyonu,
// imleç ilerlemesi idempotent ve geri gitmez, en az yetki (UPDATE/DELETE sınırları), listUnsynced (dış kimlik taşır, xmin kapısı).
// Audit append-only: audit yazan tenant'lar kısa ömürlü test veritabanında kalır (cleanupRegistry çağrılmaz).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { updateItem } from "../../../packages/domain/src/catalog/items.ts";
import { renameWarehouse } from "../../../packages/domain/src/warehouse/warehouses.ts";
import {
  ExternalRefConflictError,
  SYNC_START,
  advanceSyncCursor,
  getSyncCursor,
  linkExternalRef,
  listUnsynced,
  resolveByEntity,
  resolveByExternalId,
} from "../../../packages/domain/src/integrations/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex").toUpperCase();

let app: DbClient;
let adm: pg.Client;
let appPg: pg.Client;
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
/** Her test kendi `system` değerini kullanır (fikstürün LOGO satırı ve testler birbirine karışmaz). */
const sys = (): string => `T252X${rnd()}`;
const ext = (): string => `EXT-${rnd()}`;

async function fail(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}
async function auditCount(tenant: string, entityId?: string): Promise<number> {
  const r = await adm.query(
    "SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'external_ref.linked' AND ($2::text IS NULL OR entity_id = $2::text)",
    [tenant, entityId ?? null],
  );
  return (r.rows[0] as { n: number }).n;
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
/** Tenant'ın defter satırı konumları (created_xid, id) sırasıyla (fikstür satırları; migration rolüyle okunur). */
async function positions(w: TenantWorld): Promise<{ xid: string; id: string }[]> {
  const r = await adm.query<{ xid: string; id: string }>("SELECT created_xid::text AS xid, id FROM public.stock_ledger WHERE tenant_id = $1", [w.tenantId]);
  return r.rows.sort((a, b) => (BigInt(a.xid) === BigInt(b.xid) ? (a.id < b.id ? -1 : 1) : BigInt(a.xid) < BigInt(b.xid) ? -1 : 1));
}
/** İlerletilebilir (sonuçlanmış) konumlar hazır olana dek bekler. */
async function finalPositions(w: TenantWorld): Promise<{ xid: string; id: string }[]> {
  const ps = await positions(w);
  const s0 = `T252X${rnd()}`;
  await eventually(() => listUnsynced(admin(w), { system: s0, stream: "LEDGER", after: SYNC_START }), (v) => v.entries.length === ps.length);
  return ps;
}
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last = await fn();
  for (let i = 0; i < 50 && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 200));
    last = await fn();
  }
  return last;
}

describe("T-252 external_refs — bağlama ve iki yönlü tekillik", () => {
  it("linkExternalRef idempotent: aynı çağrı tekrarında created=false, version/synced_at sabit, ikinci audit yok", async () => {
    const s = sys();
    const x = ext();
    const first = await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x, externalCode: "K1" });
    expect(first).toMatchObject({ created: true, updated: false, ref: { externalId: x, externalCode: "K1", version: 1, entityId: A.itemId } });
    const again = await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x, externalCode: "K1" });
    expect(again.created).toBe(false);
    expect(again.updated).toBe(false);
    expect(again.ref.id).toBe(first.ref.id);
    expect(again.ref.version).toBe(1);
    expect(again.ref.syncedAt).toEqual(first.ref.syncedAt);
    const omitted = await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x });
    expect(omitted.ref.externalCode).toBe("K1");
    expect(await auditCount(A.tenantId, first.ref.id)).toBe(1);
    // G-09: dış kimlik/dış kod audit değişiklik özetine yazılmaz.
    const sum = await adm.query<{ s: string }>("SELECT change_summary::text AS s FROM public.audit_logs WHERE tenant_id = $1 AND entity_id = $2", [A.tenantId, first.ref.id]);
    expect(sum.rows).toHaveLength(1);
    expect(sum.rows[0]?.s).not.toContain(x);
    expect(sum.rows[0]?.s).not.toContain("K1");
    expect(JSON.parse(sum.rows[0]?.s ?? "{}")).toMatchObject({ system: s, linkedEntityType: "ITEM", linkedEntityId: A.itemId });
  });

  it("dış kod farkı: aynı eşleme güncellenir (version+1, synced_at ilerler), audit yazılır", async () => {
    const s = sys();
    const x = ext();
    const first = await linkExternalRef(admin(A), { system: s, entityType: "UNIT", entityId: A.unitId, externalId: x, externalCode: "K1" });
    const upd = await linkExternalRef(admin(A), { system: s, entityType: "UNIT", entityId: A.unitId, externalId: x, externalCode: "K2" });
    expect(upd).toMatchObject({ created: false, updated: true, ref: { id: first.ref.id, externalCode: "K2", version: 2 } });
    expect(upd.ref.syncedAt.getTime()).toBeGreaterThanOrEqual(first.ref.syncedAt.getTime());
    expect(await auditCount(A.tenantId, first.ref.id)).toBe(2);
  });

  it("EXTERNAL_REF_CONFLICT: aynı dış kimlik başka varlığa bağlıysa; mevcut eşleme bozulmaz", async () => {
    const s = sys();
    const x = ext();
    await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x });
    const e = await fail(linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemTwoId, externalId: x }));
    expect(e).toBeInstanceOf(ExternalRefConflictError);
    expect((e as ExternalRefConflictError).reason).toBe("EXTERNAL_REF_CONFLICT");
    expect(await resolveByExternalId(admin(A), { system: s, entityType: "ITEM", externalId: x })).toMatchObject({ entityId: A.itemId });
    expect(await resolveByEntity(admin(A), { system: s, entityType: "ITEM", entityId: A.itemTwoId })).toBeNull();
  });

  it("EXTERNAL_REF_CONFLICT (ters yön): varlık başka bir dış kimliğe bağlıysa yeniden bağlanmaz", async () => {
    const s = sys();
    const x = ext();
    await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x });
    await expect(linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: ext() })).rejects.toBeInstanceOf(ExternalRefConflictError);
    expect(await resolveByEntity(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId })).toMatchObject({ externalId: x });
  });

  it("farklı system veya entity_type aynı dış kimliği/varlığı kullanabilir (tekillik kapsamı)", async () => {
    const x = ext();
    const s1 = sys();
    const s2 = sys();
    await linkExternalRef(admin(A), { system: s1, entityType: "ITEM", entityId: A.itemId, externalId: x });
    await linkExternalRef(admin(A), { system: s2, entityType: "ITEM", entityId: A.itemId, externalId: x });
    await linkExternalRef(admin(A), { system: s1, entityType: "UNIT", entityId: A.unitId, externalId: x });
  });

  it("eşzamanlı iki bağlama (aynı dış kimlik, iki varlık): tam biri kazanır, diğeri EXTERNAL_REF_CONFLICT", async () => {
    const s = sys();
    const x = ext();
    const r = await Promise.allSettled([
      linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x }),
      linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemTwoId, externalId: x }),
    ]);
    expect(r.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    const rej = r.filter((v): v is PromiseRejectedResult => v.status === "rejected");
    expect(rej).toHaveLength(1);
    expect(rej[0]?.reason).toBeInstanceOf(ExternalRefConflictError);
  });

  it("DB iki yönlü tekilliği kendisi de zorlar (komut katmanı atlansa bile 23505)", async () => {
    const s = sys();
    const x = ext();
    await adm.query("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, $2, 'ITEM', $3, $4)", [A.tenantId, s, A.itemId, x]);
    await expect(adm.query("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, $2, 'ITEM', $3, $4)", [A.tenantId, s, A.itemTwoId, x])).rejects.toMatchObject({ code: "23505", constraint: "external_refs_external_key" });
    await expect(adm.query("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, $2, 'ITEM', $3, $4)", [A.tenantId, s, A.itemId, ext()])).rejects.toMatchObject({ code: "23505", constraint: "external_refs_entity_key" });
  });

  it("doğrulama: entity_type beyaz liste (komut + DB CHECK), varlık yoksa NOT_FOUND, PARTY komutta reddedilir (cari tablosu yok, A-252-4)", async () => {
    const s = sys();
    expect((await fail(linkExternalRef(admin(A), { system: s, entityType: "SUPPLIER" as never, entityId: A.itemId, externalId: ext() }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(linkExternalRef(admin(A), { system: "logo", entityType: "ITEM", entityId: A.itemId, externalId: ext() }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: "   " }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: randomUUID(), externalId: ext() }))).code).toBe("NOT_FOUND");
    // PARTY: cari tablosu gelene dek komut reddeder (kapalı bayrak); DB CHECK listesinde kalır (migration değişmez).
    expect((await fail(linkExternalRef(admin(A), { system: s, entityType: "PARTY" as never, entityId: randomUUID(), externalId: ext() }))).code).toBe("VALIDATION_FAILED");
    await adm.query("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, $2, 'PARTY', $3, 'p-1')", [A.tenantId, s, randomUUID()]);
    await expect(adm.query("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, $2, 'SUPPLIER', $3, 'x')", [A.tenantId, s, randomUUID()])).rejects.toMatchObject({ code: "23514" });
  });

  it("LEDGER_ENTRY / DOCUMENT / WAREHOUSE / LOCATION türleri bağlanır", async () => {
    const s = sys();
    for (const [entityType, entityId] of [
      ["LEDGER_ENTRY", A.ledgerId],
      ["DOCUMENT", A.documentId],
      ["WAREHOUSE", A.warehouseId],
      ["LOCATION", A.rootLocationId],
    ] as const) {
      expect((await linkExternalRef(admin(A), { system: s, entityType, entityId, externalId: ext() })).created).toBe(true);
    }
  });

  it("yetki: yalnız TENANT_ADMIN (settings.manage); PICKER hem yazma hem okumada FORBIDDEN", async () => {
    const s = sys();
    expect((await fail(linkExternalRef(picker(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: ext() }))).code).toBe("FORBIDDEN");
    expect((await fail(resolveByExternalId(picker(A), { system: s, entityType: "ITEM", externalId: ext() }))).code).toBe("FORBIDDEN");
    expect((await fail(advanceSyncCursor(picker(A), { system: s, stream: "LEDGER", to: SYNC_START }))).code).toBe("FORBIDDEN");
    expect((await fail(listUnsynced(picker(A), { system: s, stream: "LEDGER", after: SYNC_START }))).code).toBe("FORBIDDEN");
    expect((await fail(getSyncCursor(picker(A), { system: s, stream: "LEDGER" }))).code).toBe("FORBIDDEN");
    expect((await fail(resolveByEntity(picker(A), { system: s, entityType: "ITEM", entityId: A.itemId }))).code).toBe("FORBIDDEN");
  });
});

describe("T-252 kod değişimi eşlemeyi etkilemez (T-251)", () => {
  it("ürün ve depo kodu değişince dış kimlik aynı UUID'ye çözülür", async () => {
    const s = sys();
    const xi = ext();
    const xw = ext();
    await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemTwoId, externalId: xi });
    await linkExternalRef(admin(A), { system: s, entityType: "WAREHOUSE", entityId: A.warehouseId, externalId: xw });
    const itemCode = `RN-${rnd()}`;
    const whCode = `W-${rnd()}`;
    expect(await updateItem(admin(A), { itemId: A.itemTwoId, code: itemCode })).toMatchObject({ changed: true });
    expect(await renameWarehouse(admin(A), { warehouseId: A.warehouseId, code: whCode })).toEqual({ changed: true });
    const codes = await adm.query("SELECT (SELECT code FROM public.items WHERE id = $1) AS i, (SELECT code FROM public.warehouses WHERE id = $2) AS w", [A.itemTwoId, A.warehouseId]);
    expect(codes.rows[0]).toEqual({ i: itemCode, w: whCode });
    expect(await resolveByExternalId(admin(A), { system: s, entityType: "ITEM", externalId: xi })).toMatchObject({ entityId: A.itemTwoId, version: 1 });
    expect(await resolveByEntity(admin(A), { system: s, entityType: "WAREHOUSE", entityId: A.warehouseId })).toMatchObject({ externalId: xw, version: 1 });
    // Eşleme satırı kod sütunu taşımaz: yeniden bağlama aynı kayıttır.
    expect((await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemTwoId, externalId: xi })).created).toBe(false);
  });
});

describe("T-252 tenant izolasyonu", () => {
  it("B, A'nın eşlemesini çözemez; A'nın varlığını bağlayamaz (NOT_FOUND); aynı dış kimlik B'de bağımsızdır", async () => {
    const s = sys();
    const x = ext();
    await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: x });
    expect(await resolveByExternalId(admin(B), { system: s, entityType: "ITEM", externalId: x })).toBeNull();
    expect(await resolveByEntity(admin(B), { system: s, entityType: "ITEM", entityId: A.itemId })).toBeNull();
    expect((await fail(linkExternalRef(admin(B), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: ext() }))).code).toBe("NOT_FOUND");
    const own = await linkExternalRef(admin(B), { system: s, entityType: "ITEM", entityId: B.itemId, externalId: x });
    expect(own.created).toBe(true);
    expect(await resolveByExternalId(admin(A), { system: s, entityType: "ITEM", externalId: x })).toMatchObject({ entityId: A.itemId });
  });

  it("B, A'nın hiçbir türdeki varlığını bağlayamaz (tüm entity_type'lar için NOT_FOUND) ve satır oluşmaz", async () => {
    const s = sys();
    const aEntities = [
      ["ITEM", A.itemId],
      ["UNIT", A.unitId],
      ["WAREHOUSE", A.warehouseId],
      ["LOCATION", A.rootLocationId],
      ["DOCUMENT", A.documentId],
      ["LEDGER_ENTRY", A.ledgerId],
    ] as const;
    for (const [entityType, entityId] of aEntities) {
      expect((await fail(linkExternalRef(admin(B), { system: s, entityType, entityId, externalId: ext() }))).code, entityType).toBe("NOT_FOUND");
    }
    const n = await adm.query("SELECT count(*)::int AS n FROM public.external_refs WHERE tenant_id = $1 AND system = $2", [B.tenantId, s]);
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it("wms_app doğrudan SQL: A bağlamında B satırı görünmez/yazılamaz; bağlamsız 0 satır; B anahtarlı INSERT RLS hatası", async () => {
    const s = sys();
    await linkExternalRef(admin(B), { system: s, entityType: "ITEM", entityId: B.itemId, externalId: ext() });
    const seen = await asApp(A.tenantId, (q) => q("SELECT count(*)::int AS n FROM public.external_refs WHERE tenant_id = $1", [B.tenantId]));
    expect(seen).toMatchObject({ ok: true, v: { rows: [{ n: 0 }] } });
    const none = await asApp(null, (q) => q("SELECT count(*)::int AS n FROM public.external_refs"));
    expect(none).toMatchObject({ ok: true, v: { rows: [{ n: 0 }] } });
    const ins = await asApp(A.tenantId, (q) => q("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id) VALUES ($1, 'X', 'ITEM', $2, 'x')", [B.tenantId, randomUUID()]));
    expect(ins).toMatchObject({ ok: false, code: "42501" });
    const cur = await asApp(A.tenantId, (q) => q("SELECT count(*)::int AS n FROM public.sync_cursors WHERE tenant_id = $1", [B.tenantId]));
    expect(cur).toMatchObject({ ok: true, v: { rows: [{ n: 0 }] } });
  });

  it("imleçler tenant'a özeldir", async () => {
    const s = sys();
    const ps = await finalPositions(A);
    const pos = ps[ps.length - 1];
    if (pos === undefined) throw new Error("defter satırı yok");
    await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: pos });
    expect(await getSyncCursor(admin(B), { system: s, stream: "LEDGER" })).toEqual(SYNC_START);
    expect(await getSyncCursor(admin(A), { system: s, stream: "LEDGER" })).toEqual(pos);
  });
});

describe("T-252 en az yetki (wms_app)", () => {
  it("UPDATE yalnız external_code; external_id/entity_id/version/synced_at 42501; DELETE 42501; version tetikleyiciden", async () => {
    const s = sys();
    const { ref } = await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: A.itemId, externalId: ext(), externalCode: "K" });
    for (const set of ["external_id = 'z'", "entity_id = gen_random_uuid()", "version = 9", "synced_at = now()", "tenant_id = tenant_id", "system = 'ZZ'"]) {
      const r = await asApp(A.tenantId, (q) => q(`UPDATE public.external_refs SET ${set} WHERE id = $1`, [ref.id]));
      expect(r, set).toMatchObject({ ok: false, code: "42501" });
    }
    const del = await asApp(A.tenantId, (q) => q("DELETE FROM public.external_refs WHERE id = $1", [ref.id]));
    expect(del).toMatchObject({ ok: false, code: "42501" });
    const okUpd = await asApp(A.tenantId, async (q) => (await q("UPDATE public.external_refs SET external_code = 'K9' WHERE id = $1 RETURNING version", [ref.id])).rows[0]);
    expect(okUpd).toMatchObject({ ok: true, v: { version: 2 } });
    const spoof = await asApp(A.tenantId, (q) => q("INSERT INTO public.external_refs (tenant_id, system, entity_type, entity_id, external_id, version) VALUES ($1, 'X', 'ITEM', $2, 'x', 7)", [A.tenantId, randomUUID()]));
    expect(spoof).toMatchObject({ ok: false, code: "42501" });
  });
});

describe("T-252 sync_cursors", () => {
  it("ilerleme idempotent: aynı konum tekrarında advanced=false ve imleç/updated_at sabit; geri konum imleci değiştirmez", async () => {
    const s = sys();
    const ps = await finalPositions(A);
    const [p1, p2] = [ps[0], ps[1]];
    if (p1 === undefined || p2 === undefined) throw new Error("en az 2 defter satırı gerekir");
    expect(await getSyncCursor(admin(A), { system: s, stream: "LEDGER" })).toEqual(SYNC_START);
    expect(await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: p2 })).toEqual({ advanced: true, cursor: p2 });
    const t0 = (await adm.query("SELECT updated_at FROM public.sync_cursors WHERE tenant_id = $1 AND system = $2", [A.tenantId, s])).rows[0] as { updated_at: Date };
    expect(await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: p2 })).toEqual({ advanced: false, cursor: p2 });
    expect(await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: p1 })).toEqual({ advanced: false, cursor: p2 });
    const t1 = (await adm.query("SELECT updated_at FROM public.sync_cursors WHERE tenant_id = $1 AND system = $2", [A.tenantId, s])).rows[0] as { updated_at: Date };
    expect(t1.updated_at).toEqual(t0.updated_at);
    expect(await getSyncCursor(admin(A), { system: s, stream: "LEDGER" })).toEqual(p2);
    // Başlangıç konumu gerçek bir defter satırı değildir: reddedilir.
    expect((await fail(advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: SYNC_START }))).code).toBe("VALIDATION_FAILED");
  });

  it("MAJOR-1: hedef konum var olan, aynı tenant'ın sonuçlanmış defter satırı olmalı (yok / gelecekteki xid / başka tenant / xid uyuşmaz / sonuçlanmamış)", async () => {
    const s = sys();
    const ps = await finalPositions(A);
    const real = ps[0];
    const bReal = (await finalPositions(B))[0];
    if (real === undefined || bReal === undefined) throw new Error("defter satırı yok");
    const bad = async (to: { xid: string; id: string }, why: string): Promise<void> => {
      expect((await fail(advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to }))).code, why).toBe("VALIDATION_FAILED");
      expect(await getSyncCursor(admin(A), { system: s, stream: "LEDGER" }), `${why}: imleç değişmemeli`).toEqual(SYNC_START);
    };
    await bad({ xid: real.xid, id: randomUUID() }, "var olmayan satır");
    await bad({ xid: String(BigInt(real.xid) + 1_000_000n), id: real.id }, "gelecekteki xid (gerçek satır kimliğiyle)");
    await bad({ xid: "999999999999999999", id: randomUUID() }, "uydurma 18 haneli xid");
    await bad(bReal, "başka tenant'ın defter satırı");
    const n = await adm.query("SELECT count(*)::int AS n FROM public.sync_cursors WHERE tenant_id = $1 AND system = $2", [A.tenantId, s]);
    expect(n.rows[0]).toEqual({ n: 0 });
    // Geçerli konum kabul edilir (kontrol).
    expect((await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: real })).advanced).toBe(true);
  });

  it("MAJOR-1: sonuçlanmamış (xmin altında olmayan) defter satırına ilerletme reddedilir; işlem bitince kabul edilir", async () => {
    const s = sys();
    const old = new pg.Client({ connectionString: env.databaseUrlDirect });
    old.on("error", () => undefined);
    await old.connect();
    let D: TenantWorld;
    try {
      await old.query("BEGIN");
      await old.query("SELECT pg_current_xact_id()");
      D = await seedWorld(adm, reg, "D");
      const p = (await positions(D))[0];
      if (p === undefined) throw new Error("defter satırı yok");
      expect((await fail(advanceSyncCursor(admin(D), { system: s, stream: "LEDGER", to: p }))).code).toBe("VALIDATION_FAILED");
    } finally {
      await old.query("ROLLBACK").catch(() => undefined);
      await old.end();
    }
    const p = (await positions(D))[0];
    if (p === undefined) throw new Error("defter satırı yok");
    const ok = await eventually(
      () => advanceSyncCursor(admin(D), { system: s, stream: "LEDGER", to: p }).then(() => true, () => false),
      (v) => v,
    );
    expect(ok).toBe(true);
  });

  it("eşzamanlı ilerletmede sonuç en büyük konumdur (satır başına tek imleç)", async () => {
    const s = sys();
    const ps = await finalPositions(A);
    const last = ps[ps.length - 1];
    if (last === undefined) throw new Error("defter satırı yok");
    await Promise.all([...ps, ...ps].map((to) => advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to })));
    expect(await getSyncCursor(admin(A), { system: s, stream: "LEDGER" })).toEqual(last);
    const n = await adm.query("SELECT count(*)::int AS n FROM public.sync_cursors WHERE tenant_id = $1 AND system = $2", [A.tenantId, s]);
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it("DB geriye gitmeyi reddeder (23514); updated_at/yabancı sütun yazılamaz (42501); DELETE yok", async () => {
    const s = sys();
    const last = (await finalPositions(A)).pop();
    if (last === undefined) throw new Error("defter satırı yok");
    await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: last });
    const back = await asApp(A.tenantId, (q) => q("UPDATE public.sync_cursors SET cursor_xid = cursor_xid - 1 WHERE system = $1", [s]));
    expect(back).toMatchObject({ ok: false, code: "23514" });
    const same = await asApp(A.tenantId, (q) => q("UPDATE public.sync_cursors SET cursor_xid = cursor_xid WHERE system = $1", [s]));
    expect(same).toMatchObject({ ok: true });
    for (const set of ["updated_at = now()", "stream = 'X'", "system = 'ZZ'"]) {
      expect(await asApp(A.tenantId, (q) => q(`UPDATE public.sync_cursors SET ${set} WHERE system = $1`, [s])), set).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await asApp(A.tenantId, (q) => q("DELETE FROM public.sync_cursors WHERE system = $1", [s]))).toMatchObject({ ok: false, code: "42501" });
  });

  it("doğrulama: bilinmeyen akış, bozuk konum", async () => {
    const s = sys();
    expect((await fail(getSyncCursor(admin(A), { system: s, stream: "OUTBOX" as never }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: { xid: "-1", id: randomUUID() } }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: { xid: "1", id: "x" } }))).code).toBe("VALIDATION_FAILED");
  });
});

describe("T-252 listUnsynced (salt okuma)", () => {
  const ledgerOf = async (w: TenantWorld): Promise<{ id: string; xid: string; item_id: string; document_id: string; quantity: string }[]> =>
    (await adm.query("SELECT id, created_xid::text AS xid, item_id, document_id, quantity::text AS quantity FROM public.stock_ledger WHERE tenant_id = $1", [w.tenantId])).rows;

  it("iç UUID + dış kimlik taşır; LEDGER_ENTRY bağlanan satır listeden düşer; sıra (xid,id); sayfalama after/next", async () => {
    const s = sys();
    const rows = await ledgerOf(A);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ordered = [...rows].sort((a, b) => (BigInt(a.xid) === BigInt(b.xid) ? (a.id < b.id ? -1 : 1) : BigInt(a.xid) < BigInt(b.xid) ? -1 : 1));
    const first = ordered[0];
    if (first === undefined) throw new Error("defter satırı yok");
    const xItem = ext();
    const xDoc = ext();
    await linkExternalRef(admin(A), { system: s, entityType: "ITEM", entityId: first.item_id, externalId: xItem });
    await linkExternalRef(admin(A), { system: s, entityType: "DOCUMENT", entityId: first.document_id, externalId: xDoc });
    const all = await eventually(() => listUnsynced(admin(A), { system: s, stream: "LEDGER", after: SYNC_START }), (v) => v.entries.length === rows.length);
    expect(all.entries.map((e) => e.ledgerId)).toEqual(ordered.map((r) => r.id));
    expect(all.entries[0]).toMatchObject({ itemId: first.item_id, documentId: first.document_id, quantity: first.quantity, itemExternalId: xItem, documentExternalId: xDoc });
    expect(all.next).toEqual(all.entries[all.entries.length - 1]?.position);
    // sayfalama
    const page1 = await listUnsynced(admin(A), { system: s, stream: "LEDGER", after: SYNC_START, limit: 1 });
    expect(page1.entries).toHaveLength(1);
    const page2 = await listUnsynced(admin(A), { system: s, stream: "LEDGER", after: page1.next ?? SYNC_START, limit: 500 });
    expect(page2.entries.map((e) => e.ledgerId)).toEqual(ordered.slice(1).map((r) => r.id));
    // dışa aktarılan satır (LEDGER_ENTRY dış referansı) düşer
    await linkExternalRef(admin(A), { system: s, entityType: "LEDGER_ENTRY", entityId: first.id, externalId: ext() });
    const after = await listUnsynced(admin(A), { system: s, stream: "LEDGER", after: SYNC_START });
    expect(after.entries.map((e) => e.ledgerId)).toEqual(ordered.slice(1).map((r) => r.id));
    expect(after.entries.every((e) => e.itemExternalId === null || e.itemId === first.item_id)).toBe(true);
  });

  it("varsayılan after kayıtlı imleçtir: imleç ilerleyince önceki satırlar gelmez; ikinci ilerletme etkisiz", async () => {
    const s = sys();
    const rows = await eventually(() => listUnsynced(admin(A), { system: s, stream: "LEDGER" }), (v) => v.entries.length >= 2);
    const [e0, ...rest] = rows.entries;
    if (e0 === undefined) throw new Error("defter satırı yok");
    expect((await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: e0.position })).advanced).toBe(true);
    expect((await advanceSyncCursor(admin(A), { system: s, stream: "LEDGER", to: e0.position })).advanced).toBe(false);
    const next = await listUnsynced(admin(A), { system: s, stream: "LEDGER" });
    expect(next.entries.map((e) => e.ledgerId)).toEqual(rest.map((e) => e.ledgerId));
  });

  it("tenant izolasyonu: B listesi yalnız B'nin defter satırlarıdır; sınır doğrulaması", async () => {
    const s = sys();
    const bRows = await ledgerOf(B);
    const res = await eventually(() => listUnsynced(admin(B), { system: s, stream: "LEDGER", after: SYNC_START }), (v) => v.entries.length === bRows.length);
    expect(new Set(res.entries.map((e) => e.ledgerId))).toEqual(new Set(bRows.map((r) => r.id)));
    expect((await fail(listUnsynced(admin(B), { system: s, stream: "LEDGER", limit: 0 }))).code).toBe("VALIDATION_FAILED");
    expect((await fail(listUnsynced(admin(B), { system: s, stream: "LEDGER", limit: 501 }))).code).toBe("VALIDATION_FAILED");
  });

  it("xmin kapısı: eski açık bir işlem varken sonradan yazılan defter satırları listelenmez; işlem bitince görünür", async () => {
    const s = sys();
    const old = new pg.Client({ connectionString: env.databaseUrlDirect });
    old.on("error", () => undefined);
    await old.connect();
    let C: TenantWorld;
    try {
      await old.query("BEGIN");
      await old.query("SELECT pg_current_xact_id()"); // eski xid ata: snapshot xmin bunun altına iner
      C = await seedWorld(adm, reg, "C"); // yeni defter satırları, eski xid'den büyük created_xid
      const cRows = await ledgerOf(C);
      expect(cRows.length).toBeGreaterThan(0);
      const hidden = await listUnsynced(admin(C), { system: s, stream: "LEDGER", after: SYNC_START });
      expect(hidden.entries).toEqual([]);
    } finally {
      await old.query("ROLLBACK").catch(() => undefined);
      await old.end();
    }
    const cRows = await ledgerOf(C);
    const visible = await eventually(() => listUnsynced(admin(C), { system: s, stream: "LEDGER", after: SYNC_START }), (v) => v.entries.length === cRows.length);
    expect(visible.entries).toHaveLength(cRows.length);
  });
});
