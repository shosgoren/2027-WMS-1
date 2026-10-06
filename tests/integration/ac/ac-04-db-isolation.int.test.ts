// AC-04 — bağımsız kabul testi (T-104, qa-verifier). Uygulayıcının testlerinden bağımsız yazıldı.
// katman: DB — API/dosya/cache/export katmanları T-128, oturum katmanı T-120.
//
// AC-04: "Tenant A, B'nin ID'sini kullanır → API, DB, dosya, cache, export reddeder". Bu dosya YALNIZCA DB katmanını
// kanıtlar (kısmi kapı; değerlendirme T-132).
//
// Uygulama rolü bağlantısı yalnızca DATABASE_URL (wms_app, PgBouncer transaction mode). Migration rolü
// (DATABASE_URL_DIRECT) yalnızca fikstür kurulumu/temizliği ve katalog okuması içindir. Her tenant tablosu
// `information_schema`'dan DİNAMİK bulunur (tenant_id sütunu olan her tablo + `tenants`, anahtarı `id`): yeni tablo eklenince
// test kendiliğinden kapsar; tablonun fikstürde satırı yoksa veya RLS `FORCE` değilse test KIRMIZI olur.
//
// Genel sorgular tablo adından bağımsızdır: B satırı `x::text` eşitliğiyle aranır, INSERT, A satırının kopyasını B anahtarıyla
// yazar (wms_app'in INSERT yetkili sütunlarıyla; RLS WITH CHECK hatası 42501 + "row-level security" beklenir; A anahtarlı
// kontrol kopyası RLS'i geçer: 23505 ya da başarı). Mutasyon denemeleri daima ROLLBACK edilir.
//
// Ek (T-102 security-reviewer @77317fe MINOR, Supervisor): security_events sunucu alanı zorlaması,
// session_replication_role=replica altında tetikleyici/TRUNCATE reddi, tetikleyicilerin tgenabled='A' denetimi.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createDbClient, type DbClient } from "../../../packages/db/src/client.ts";
import { withUser } from "../../../packages/db/src/index.ts";
import { APP_ROLE, AUTH_ROLE, PROBE_ROLE, readIntEnv, redactErrorChain } from "../harness/env.ts";
import { cleanupDocuments, cleanupStock, mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";

const env = readIntEnv(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect];
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const RLS_MESSAGE = /row-level security/i;

const reg = newRegistry();
const open: pg.Client[] = [];

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  open.push(c);
  return c;
}

type Attempt =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { ok: false; code: string | undefined; message: string };

type Pre = readonly [text: string, params: unknown[]];
const setTenant = (id: string): Pre => ["SELECT set_config('app.current_tenant_id', $1, true)", [id]];
const setUser = (id: string): Pre => ["SELECT set_config('app.current_user_id', $1, true)", [id]];

/** `pre` ifadeleri + `stmt` tek transaction'da; daima ROLLBACK (kalıcı değişiklik yok). */
async function attempt(c: pg.Client, pre: readonly Pre[], stmt: string, params: unknown[] = []): Promise<Attempt> {
  await c.query("BEGIN");
  try {
    for (const [t, p] of pre) await c.query(t, p);
    const r = await c.query(stmt, params);
    return { ok: true, rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await c.query("ROLLBACK");
  }
}

function fmt(r: Attempt): string {
  return r.ok ? `ok rows=${r.rowCount}` : `error ${r.code ?? "?"}: ${r.message}`;
}

const q = (ident: string): string => `"${ident.replaceAll('"', '""')}"`;

// ---------------------------------------------------------------------------------------------
// Katalogdan dinamik tablo keşfi
// ---------------------------------------------------------------------------------------------
interface TenantTable {
  name: string;
  /** Tenant anahtarı sütunu: `tenant_id`; `tenants` için `id`. */
  key: string;
  forced: boolean;
  rlsEnabled: boolean;
  policyCount: number;
  ownerIsApp: boolean;
  insertCols: string[];
  updateCols: string[];
  canDelete: boolean;
}

let A: TenantWorld;
let B: TenantWorld;
let multi: { userId: string };
let appClient: pg.Client;
let admin: pg.Client;
let tables: TenantTable[] = [];

async function discoverTables(): Promise<TenantTable[]> {
  const found = await admin.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      ORDER BY c.table_name`,
  );
  // T-206: document_type_versions KÜRESEL sistem tablosudur (tenant_id NULL = sistem satırı, A-79; wms_app yalnızca SELECT, yazma
  // politikası yok): "her tenant için satır" ve "yabancı satır görünmez" varsayımları ona uygulanamaz. Yalnızca bu tablo, adıyla
  // dışarıda; görünürlük/yazma yasağı documents-schema.int.test.ts'te sınanır. Başka tablo bu listeye eklenemez (gevşetme değil).
  const GLOBAL_SYSTEM_TABLES = new Set(["document_type_versions"]);
  const names = new Set(found.rows.map((r) => r.table_name).filter((n) => !GLOBAL_SYSTEM_TABLES.has(n)));
  names.add("tenants"); // tenant_id sütunu yok; id tenant kimliğidir (ADR-016 §2)
  const out: TenantTable[] = [];
  for (const name of [...names].sort()) {
    const meta = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
      policies: string;
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)::text AS owner,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c WHERE c.oid = ('public.' || quote_ident($1))::regclass`,
      [name],
    );
    const m = meta.rows[0];
    if (m === undefined) throw new Error(`pg_class satırı yok: ${name}`);
    const cols = await admin.query<{ column_name: string; ins: boolean; upd: boolean }>(
      `SELECT column_name,
              has_column_privilege($2, ('public.' || quote_ident($1))::regclass, column_name, 'INSERT') AS ins,
              has_column_privilege($2, ('public.' || quote_ident($1))::regclass, column_name, 'UPDATE') AS upd
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [name, APP_ROLE],
    );
    const del = await admin.query<{ d: boolean }>(`SELECT has_table_privilege($2, ('public.' || quote_ident($1))::regclass, 'DELETE') AS d`, [
      name,
      APP_ROLE,
    ]);
    out.push({
      name,
      key: name === "tenants" ? "id" : "tenant_id",
      forced: m.relforcerowsecurity,
      rlsEnabled: m.relrowsecurity,
      policyCount: Number(m.policies),
      ownerIsApp: m.owner === APP_ROLE,
      insertCols: cols.rows.filter((c) => c.ins).map((c) => c.column_name),
      updateCols: cols.rows.filter((c) => c.upd).map((c) => c.column_name),
      canDelete: del.rows[0]?.d === true,
    });
  }
  return out;
}

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  appClient = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
  multi = { userId: await mkUser(admin, reg, "multi") };
  await mkMembership(admin, A.tenantId, multi.userId, { roles: ["READ_ONLY"] });
  await mkMembership(admin, B.tenantId, multi.userId, { roles: ["READ_ONLY"] });
  // T-108: audit_logs append-only'dir ve wms_app tenant_id'ye INSERT edemez; fikstür (T-104) onu tohumlamaz. Satırlar wms_app ile
  // (gerçek yol: tenant_id DEFAULT'u bağlamdan) A ve B bağlamında yazılır ve COMMIT edilir.
  for (const w of [A, B]) {
    await appClient.query("BEGIN");
    try {
      await appClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [w.tenantId]);
      await appClient.query("INSERT INTO public.audit_logs (action, entity_type, entity_id) VALUES ('tenant.created', 'tenant', $1)", [w.tenantId]);
      await appClient.query("COMMIT");
    } catch (e) {
      await appClient.query("ROLLBACK");
      throw e;
    }
  }
  tables = await discoverTables();
}, 60_000);

/**
 * audit_logs satırı SİLİNEMEZ (I-12) ve tenants'a FK ile bağlıdır: tenant satırları bilerek silinmez (tek kullanımlık
 * Testcontainers örneği; Neon'da `t104-*` slug'lı sentetik artık kalır — audit.int.test.ts ile aynı). Diğer fikstür satırları
 * (FK sırasıyla) silinir; hatalar yutulmaz.
 */
async function cleanupExceptTenants(c: pg.Client, r: typeof reg): Promise<void> {
  const tenantIds = r.worlds.map((w) => w.tenantId);
  const userIds = [...r.worlds.flatMap((w) => [w.ownerUserId, w.memberUserId]), ...r.extraUsers];
  if (tenantIds.length > 0) {
    await cleanupStock(c, tenantIds); // T-232 stok tabloları (defter append-only tetikleyicisi fikstürde geçici kapatılır)
    await cleanupDocuments(c, tenantIds); // T-206 tabloları (append-only tetikleyici replica ile atlanır)
    // T-204 + T-202 tabloları FK sırasıyla önce (taşıma birimi → seri → lot → barkod/dönüşüm → sahip → ürün → birim; kapsam → kilit → lokasyon → depo).
    for (const t of [
      "handling_units",
      "serials",
      "lots",
      "item_barcodes",
      "unit_conversions",
      "inventory_owners",
      "items",
      "units",
      "membership_warehouse_scopes",
      "location_count_locks",
      "locations",
      "warehouses",
      "invitations",
      "membership_roles",
      "tenant_memberships",
      "tenant_settings",
    ]) {
      await c.query(`DELETE FROM public.${t} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
    }
  }
  if (userIds.length > 0) await c.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [userIds]);
  r.worlds.length = 0;
  r.extraUsers.length = 0;
}

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupExceptTenants(admin, reg);
  } finally {
    await Promise.all(open.map((c) => c.end().catch(() => undefined)));
  }
});

// ---------------------------------------------------------------------------------------------
// 1. Katalog: kapsam + FORCE RLS
// ---------------------------------------------------------------------------------------------
describe("AC-04 DB — tenant tablosu keşfi ve RLS durumu", () => {
  it("@AC-04 keşif en az Faz 1 tenant tablolarını içerir (tarama sessizce boşalamaz)", () => {
    const names = tables.map((t) => t.name);
    for (const expected of ["invitations", "membership_roles", "tenant_memberships", "tenant_settings", "tenants"]) {
      expect(names, `keşfedilen tablolar: ${names.join(",")}`).toContain(expected);
    }
  });

  it("@AC-04 her tenant tablosunda RLS ENABLE + FORCE, en az bir politika, sahibi wms_app değil", () => {
    const bad = tables.filter((t) => !t.rlsEnabled || !t.forced || t.policyCount === 0 || t.ownerIsApp);
    expect(
      bad.map((t) => `${t.name}: enable=${t.rlsEnabled} force=${t.forced} policies=${t.policyCount} ownerIsApp=${t.ownerIsApp}`),
    ).toEqual([]);
  });

  it("@AC-04 fikstür her keşfedilen tabloda A ve B için en az bir satır tohumlamış (yeni tablo → kırmızı)", async () => {
    const missing: string[] = [];
    for (const t of tables) {
      for (const w of [A, B]) {
        const r = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${q(t.name)} WHERE ${q(t.key)} = $1`, [w.tenantId]);
        if (Number(r.rows[0]?.n) < 1) missing.push(`${t.name}/${w.label}`);
      }
    }
    expect(missing, "fikstürde (tests/integration/fixtures/tenants.ts) tohumlanmamış tablo/tenant").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. A bağlamında B'ye erişim denemeleri (her tablo, wms_app, pooler)
// ---------------------------------------------------------------------------------------------
describe("AC-04 DB — A bağlamında B kimliğiyle erişim (tablo başına)", () => {
  it("@AC-04 SELECT: B satırı (x::text ile) 0 satır; toplam görünür satır yalnızca A'nın; A satırı görünür (kontrol)", async () => {
    const failures: string[] = [];
    for (const t of tables) {
      const bRows = await admin.query<{ r: string }>(`SELECT x::text AS r FROM public.${q(t.name)} x WHERE x.${q(t.key)} = $1`, [B.tenantId]);
      const aRows = await admin.query<{ r: string }>(`SELECT x::text AS r FROM public.${q(t.name)} x WHERE x.${q(t.key)} = $1`, [A.tenantId]);
      for (const b of bRows.rows) {
        const r = await attempt(appClient, [setTenant(A.tenantId)], `SELECT count(*)::int AS n FROM public.${q(t.name)} x WHERE x::text = $1`, [b.r]);
        if (!r.ok || (r.rows[0] as { n: number }).n !== 0) failures.push(`${t.name}: B satırı A bağlamında görünür/hata: ${fmt(r)}`);
      }
      const byKey = await attempt(appClient, [setTenant(A.tenantId)], `SELECT count(*)::int AS n FROM public.${q(t.name)} WHERE ${q(t.key)} = $1`, [B.tenantId]);
      if (!byKey.ok || (byKey.rows[0] as { n: number }).n !== 0) failures.push(`${t.name}: ${t.key}=B sorgusu 0 değil: ${fmt(byKey)}`);
      const total = await attempt(
        appClient,
        [setTenant(A.tenantId)],
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${q(t.key)} = $1)::int AS own FROM public.${q(t.name)}`,
        [A.tenantId],
      );
      if (!total.ok) failures.push(`${t.name}: A bağlamı SELECT hata: ${fmt(total)}`);
      else {
        const { total: tot, own } = total.rows[0] as { total: number; own: number };
        if (tot !== own) failures.push(`${t.name}: A bağlamında yabancı satır var (toplam=${tot}, A=${own})`);
        if (own !== aRows.rows.length) failures.push(`${t.name}: A kendi satırlarını göremiyor (görünen=${own}, beklenen=${aRows.rows.length})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 UPDATE: B satırına 0 satır etkilenir (ya da yetki yok 42501); A'ya yazabilen tabloda kontrol ≥1", async () => {
    const failures: string[] = [];
    for (const t of tables) {
      const col = t.updateCols[0];
      if (col === undefined) {
        const r = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.${q(t.name)} SET ${q(t.key)} = ${q(t.key)} WHERE ${q(t.key)} = $1`, [B.tenantId]);
        if (r.ok || r.code !== INSUFFICIENT_PRIVILEGE) failures.push(`${t.name}: UPDATE yetkisi yokken beklenen 42501, gelen ${fmt(r)}`);
        continue;
      }
      const foreign = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.${q(t.name)} SET ${q(col)} = ${q(col)} WHERE ${q(t.key)} = $1`, [B.tenantId]);
      if (!foreign.ok || foreign.rowCount !== 0) failures.push(`${t.name}: B satırına UPDATE 0 değil: ${fmt(foreign)}`);
      const own = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.${q(t.name)} SET ${q(col)} = ${q(col)} WHERE ${q(t.key)} = $1`, [A.tenantId]);
      if (!own.ok || own.rowCount < 1) failures.push(`${t.name}: kontrol (A kendi satırı) UPDATE ≥1 değil: ${fmt(own)}`);
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 DELETE kontrol kaydı yalnızca gerçekten DELETE yetkisi olan tabloları içerir (kayıt yetkisiz tabloyu gizleyemez)", () => {
    for (const name of Object.keys(A.deletableControl)) {
      const t = tables.find((x) => x.name === name);
      expect(t, `kayıttaki tablo katalogda yok: ${name}`).toBeDefined();
      expect(t?.canDelete, `${name}: kayıtta ama wms_app DELETE yetkisi yok`).toBe(true);
    }
  });

  it("@AC-04 DELETE: B satırına 0 satır etkilenir (ya da yetki yok 42501); A'da silebilen tabloda kontrol ≥1", async () => {
    const failures: string[] = [];
    for (const t of tables) {
      const foreign = await attempt(appClient, [setTenant(A.tenantId)], `DELETE FROM public.${q(t.name)} WHERE ${q(t.key)} = $1`, [B.tenantId]);
      if (t.canDelete) {
        if (!foreign.ok || foreign.rowCount !== 0) failures.push(`${t.name}: B satırına DELETE 0 değil: ${fmt(foreign)}`);
        // T-232: FK ile korunan satırı (ör. defter/rezervasyonun bağlandığı document_lines) silmek 23503 verir. Kontrol silmesi, fikstürün
        // verdiği FK ile korunmayan kayıtlı satıra daraltılır (assertion gücü aynı: ≥1 satır silinmeli); kayıtta olmayan tablo eski genel
        // `WHERE key = A` kontrolünü korur.
        const controlId = A.deletableControl[t.name];
        const own =
          controlId === undefined
            ? await attempt(appClient, [setTenant(A.tenantId)], `DELETE FROM public.${q(t.name)} WHERE ${q(t.key)} = $1`, [A.tenantId])
            : await attempt(appClient, [setTenant(A.tenantId)], `DELETE FROM public.${q(t.name)} WHERE ${q(t.key)} = $1 AND id = $2`, [A.tenantId, controlId]);
        if (!own.ok || own.rowCount < 1) failures.push(`${t.name}: kontrol (A kendi satırı) DELETE ≥1 değil: ${fmt(own)}`);
      } else if (foreign.ok || foreign.code !== INSUFFICIENT_PRIVILEGE) {
        failures.push(`${t.name}: DELETE yetkisi yokken beklenen 42501, gelen ${fmt(foreign)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 INSERT: B tenant anahtarıyla satır RLS hatası verir; A anahtarlı kontrol RLS'i geçer", async () => {
    const failures: string[] = [];
    for (const t of tables) {
      if (t.insertCols.length === 0) {
        const r = await attempt(appClient, [setTenant(A.tenantId)], `INSERT INTO public.${q(t.name)} DEFAULT VALUES`);
        if (r.ok || r.code !== INSUFFICIENT_PRIVILEGE) failures.push(`${t.name}: INSERT yetkisi yokken beklenen 42501, gelen ${fmt(r)}`);
        continue;
      }
      if (!t.insertCols.includes(t.key)) {
        // Tenant anahtarı sütununa INSERT yetkisi yok (ör. audit_logs): B anahtarını açıkça vermek yetki hatasıdır; anahtarsız
        // kopya yalnızca bağlam tenant'ına (A) yazılabilir, asla B'ye.
        const explicit = await attempt(appClient, [setTenant(A.tenantId)], `INSERT INTO public.${q(t.name)} (${q(t.key)}) VALUES ($1)`, [B.tenantId]);
        if (explicit.ok || explicit.code !== INSUFFICIENT_PRIVILEGE) failures.push(`${t.name}: ${t.key}=B açık INSERT için 42501 beklenir, gelen ${fmt(explicit)}`);
        const cols2 = t.insertCols.map(q).join(", ");
        const sel2 = t.insertCols.map((c) => `r.${q(c)}`).join(", ");
        const viaDefault = await attempt(
          appClient,
          [setTenant(A.tenantId)],
          `INSERT INTO public.${q(t.name)} (${cols2})
           SELECT ${sel2} FROM (SELECT (jsonb_populate_record(NULL::public.${q(t.name)}, to_jsonb(a))).* FROM public.${q(t.name)} a WHERE a.${q(t.key)} = $1 LIMIT 1) r
           RETURNING ${q(t.key)}::text AS k`,
          [A.tenantId],
        );
        if (!viaDefault.ok || viaDefault.rowCount !== 1 || (viaDefault.rows[0] as { k: string }).k !== A.tenantId) {
          failures.push(`${t.name}: anahtarsız kopya yalnızca bağlam tenant'ına (A) 1 satır yazmalı, gelen ${fmt(viaDefault)}`);
        }
        continue;
      }
      const cols = t.insertCols.map(q).join(", ");
      const sel = t.insertCols.map((c) => `r.${q(c)}`).join(", ");
      const copy = (): string =>
        `INSERT INTO public.${q(t.name)} (${cols})
         SELECT ${sel} FROM (
           SELECT (jsonb_populate_record(NULL::public.${q(t.name)}, to_jsonb(a) || jsonb_build_object('${t.key}', $2::text))).*
             FROM public.${q(t.name)} a WHERE a.${q(t.key)} = $1 LIMIT 1
         ) r`;
      const foreign = await attempt(appClient, [setTenant(A.tenantId)], copy(), [A.tenantId, B.tenantId]);
      if (foreign.ok || foreign.code !== INSUFFICIENT_PRIVILEGE || !RLS_MESSAGE.test(foreign.message)) {
        failures.push(`${t.name}: B anahtarlı INSERT için RLS hatası beklenir, gelen ${fmt(foreign)}`);
      }
      const control = await attempt(appClient, [setTenant(A.tenantId)], copy(), [A.tenantId, A.tenantId]);
      if (!control.ok && control.code !== UNIQUE_VIOLATION) {
        failures.push(`${t.name}: kontrol (A anahtarlı kopya) RLS'i geçmeli (başarı ya da 23505), gelen ${fmt(control)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("@AC-04 bağlamsız (tenant ayarı yok / boş / var olmayan tenant): her tabloda 0 satır; yazma reddi", async () => {
    const failures: string[] = [];
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    const contexts: [string, readonly Pre[]][] = [
      ["ayar yok", []],
      ["boş ayar", [setTenant("")]],
      ["var olmayan tenant", [setTenant(ghost)]],
    ];
    for (const t of tables) {
      for (const [label, pre] of contexts) {
        const r = await attempt(appClient, pre, `SELECT count(*)::int AS n FROM public.${q(t.name)}`);
        if (!r.ok || (r.rows[0] as { n: number }).n !== 0) failures.push(`${t.name} [${label}]: 0 satır beklenir, gelen ${fmt(r)}`);
      }
    }
    // Havuzlu bağlantı bağlam sızdırmaz: aynı istemcide koşu sonrası ayar boş.
    const leak = await appClient.query<{ t: string | null }>("SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS t");
    expect(leak.rows[0]?.t ?? null).toBeNull();
    // Bağlamsız yazma: RLS WITH CHECK reddi.
    const ins = await attempt(
      appClient,
      [],
      `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr-TR', 'UTC', 'PENDING')`,
      [A.tenantId],
    );
    if (ins.ok || ins.code !== INSUFFICIENT_PRIVILEGE || !RLS_MESSAGE.test(ins.message)) failures.push(`bağlamsız INSERT RLS hatası vermedi: ${fmt(ins)}`);
    const upd = await attempt(appClient, [], `UPDATE public.tenant_settings SET locale = locale WHERE tenant_id = $1`, [A.tenantId]);
    if (!upd.ok || upd.rowCount !== 0) failures.push(`bağlamsız UPDATE 0 satır değil: ${fmt(upd)}`);
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. withUser: yalnızca kendi üyelikleri ve o tenant'ların tenants satırı
// ---------------------------------------------------------------------------------------------
describe("AC-04 DB — withUser kapsamı", () => {
  let client: DbClient;
  beforeAll(() => {
    client = createDbClient({ url: env.databaseUrl, poolMax: 2, prepare: false });
  });
  afterAll(async () => {
    await client.close();
  });

  async function snapshot(userId: string): Promise<{ memberships: { tenant_id: string; user_id: string }[]; tenants: string[]; others: Record<string, number> }> {
    return withUser(client, userId, async (tx) => {
      const memberships = await tx.execute<{ tenant_id: string; user_id: string }>(sql`SELECT tenant_id::text AS tenant_id, user_id::text AS user_id FROM public.tenant_memberships`);
      const tenants = await tx.execute<{ id: string }>(sql`SELECT id::text AS id FROM public.tenants`);
      const others: Record<string, number> = {};
      for (const t of tables) {
        if (t.name === "tenants" || t.name === "tenant_memberships") continue;
        const r = await tx.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM public.${q(t.name)}`));
        others[t.name] = Number(r[0]?.n);
      }
      return { memberships: [...memberships], tenants: tenants.map((r) => r.id), others };
    });
  }

  it("@AC-04 tek tenantlı kullanıcı: yalnızca kendi üyeliği + yalnızca kendi tenant satırı; diğer tenant tablolarında 0 satır", async () => {
    const s = await snapshot(A.ownerUserId);
    expect(s.memberships).toEqual([{ tenant_id: A.tenantId, user_id: A.ownerUserId }]);
    expect(s.tenants).toEqual([A.tenantId]);
    expect(Object.values(s.others).every((n) => n === 0), JSON.stringify(s.others)).toBe(true);
    expect(Object.keys(s.others).length).toBeGreaterThanOrEqual(3);
  });

  it("@AC-04 B sahibi A'yı hiçbir yoldan görmez", async () => {
    const s = await snapshot(B.ownerUserId);
    expect(s.memberships.map((m) => m.tenant_id)).toEqual([B.tenantId]);
    expect(s.tenants).toEqual([B.tenantId]);
  });

  it("@AC-04 çok tenantlı kullanıcı: yalnızca kendi iki üyeliği ve o iki tenant; başka kullanıcıların üyeliği yok", async () => {
    const s = await snapshot(multi.userId);
    expect(s.memberships.map((m) => m.user_id)).toEqual([multi.userId, multi.userId]);
    expect(s.memberships.map((m) => m.tenant_id).sort()).toEqual([A.tenantId, B.tenantId].sort());
    expect(s.tenants.sort()).toEqual([A.tenantId, B.tenantId].sort());
    expect(Object.values(s.others).every((n) => n === 0)).toBe(true);
  });

  it("@AC-04 üyeliği REMOVED olan kullanıcı: tenants satırı görünmez (yalnızca ACTIVE üyelik)", async () => {
    await admin.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [A.memberMembershipId]);
    try {
      const s = await snapshot(A.memberUserId);
      expect(s.tenants).toEqual([]);
      expect(s.memberships.every((m) => m.user_id === A.memberUserId)).toBe(true);
    } finally {
      await admin.query("UPDATE public.tenant_memberships SET status = 'ACTIVE', removed_at = NULL WHERE id = $1", [A.memberMembershipId]);
    }
  });

  it("@AC-04 withUser bağlamında yazma politikası yok: UPDATE 0 satır, INSERT RLS hatası", async () => {
    const sentinel = new Error("rollback-sentinel");
    let updated = -1;
    let insertCode: string | undefined;
    let insertMessage = "";
    await withUser(client, A.ownerUserId, async (tx) => {
      const u = await tx.execute(sql`UPDATE public.tenant_memberships SET roles_version = roles_version + 1 WHERE user_id = ${A.ownerUserId}::uuid RETURNING id`);
      updated = u.length;
      await tx.execute(sql`SAVEPOINT s1`);
      try {
        await tx.execute(sql`INSERT INTO public.tenant_memberships (tenant_id, user_id) VALUES (${A.tenantId}::uuid, ${B.ownerUserId}::uuid)`);
      } catch (e) {
        let cur: unknown = e;
        for (let i = 0; i < 5 && cur !== null && typeof cur === "object"; i++) {
          const o = cur as { code?: string; message?: string; cause?: unknown };
          if (typeof o.code === "string") insertCode = o.code;
          if (typeof o.message === "string") insertMessage += o.message + " | ";
          cur = o.cause;
        }
      }
      throw sentinel;
    }).catch((e: unknown) => {
      if (e !== sentinel) throw e;
    });
    expect(updated).toBe(0);
    expect(insertCode, insertMessage).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. İnceleme ekleri M8 / m4 / m1
// ---------------------------------------------------------------------------------------------
describe("AC-04 DB — tenants sütun yetkileri (M8, m4) ve kullanıcı bağlamı sızıntısı (m1)", () => {
  it("@AC-04 M8: wms_app A bağlamında tenants.status / is_demo / slug güncelleyemez (42501)", async () => {
    for (const set of ["status = 'ACTIVE'", "is_demo = false", "slug = 't104-hijack'"]) {
      const r = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.tenants SET ${set} WHERE id = $1`, [A.tenantId]);
      expect(r.ok, `UPDATE ... SET ${set}: ${fmt(r)}`).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("@AC-04 M8: tenants.name yalnızca kendi tenant'ında güncellenir (A: 1 satır, B: 0 satır)", async () => {
    const own = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.tenants SET name = 'T104 renamed' WHERE id = $1`, [A.tenantId]);
    expect(own.ok && own.rowCount, fmt(own)).toBe(1);
    const foreign = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.tenants SET name = 'T104 hijack' WHERE id = $1`, [B.tenantId]);
    expect(foreign.ok && foreign.rowCount, fmt(foreign)).toBe(0);
    const check = await admin.query<{ name: string }>("SELECT name FROM public.tenants WHERE id = $1", [B.tenantId]);
    expect(check.rows[0]?.name).toBe("T104 Tenant B");
  });

  it("@AC-04 T-103 son tur: wms_app kendi tenant'ındaki membership_roles.id'yi değiştiremez (42501, tetikleyici); id=id kilit amaçlı UPDATE geçer", async () => {
    const same = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.membership_roles SET id = id WHERE tenant_id = $1`, [A.tenantId]);
    expect(same.ok && same.rowCount, fmt(same)).toBeGreaterThanOrEqual(1);
    const change = await attempt(appClient, [setTenant(A.tenantId)], `UPDATE public.membership_roles SET id = gen_random_uuid() WHERE tenant_id = $1`, [A.tenantId]);
    expect(change.ok, fmt(change)).toBe(false);
    if (!change.ok) {
      expect(change.code, change.message).toBe(INSUFFICIENT_PRIVILEGE);
      expect(change.message).toMatch(/id_immutable/);
    }
  });

  it("@AC-04 m4: wms_app is_demo / status sütunlu tenants INSERT'i yetki hatası verir (42501)", async () => {
    const fresh = "c0000000-0000-4000-8000-0000000000c1";
    for (const stmt of [
      `INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, 't104-demo-try', 'x', true)`,
      `INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, 't104-status-try', 'x', 'ACTIVE')`,
    ]) {
      const r = await attempt(appClient, [setTenant(fresh)], stmt, [fresh]);
      expect(r.ok, `${stmt}: ${fmt(r)}`).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("@AC-04 m1: A tenant bağlamı + elle B üyesinin app.current_user_id'si → B üyelik/tenant satırları görünmez", async () => {
    const pre = [setTenant(A.tenantId), setUser(B.ownerUserId)];
    const probes: [string, string, unknown[]][] = [
      ["B üyelikleri (tenant_id)", `SELECT count(*)::int AS n FROM public.tenant_memberships WHERE tenant_id = $1`, [B.tenantId]],
      ["B kullanıcısının üyelikleri", `SELECT count(*)::int AS n FROM public.tenant_memberships WHERE user_id = $1`, [B.ownerUserId]],
      ["B tenants satırı", `SELECT count(*)::int AS n FROM public.tenants WHERE id = $1`, [B.tenantId]],
    ];
    for (const [label, stmt, params] of probes) {
      const r = await attempt(appClient, pre, stmt, params);
      expect(r.ok && (r.rows[0] as { n: number }).n, `${label}: ${fmt(r)}`).toBe(0);
    }
    const all = await attempt(appClient, pre, `SELECT count(*) FILTER (WHERE tenant_id <> $1)::int AS foreign_rows FROM public.tenant_memberships`, [A.tenantId]);
    expect(all.ok && (all.rows[0] as { foreign_rows: number }).foreign_rows, fmt(all)).toBe(0);
    const tn = await attempt(appClient, pre, `SELECT count(*) FILTER (WHERE id <> $1)::int AS foreign_rows FROM public.tenants`, [A.tenantId]);
    expect(tn.ok && (tn.rows[0] as { foreign_rows: number }).foreign_rows, fmt(tn)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Katalog taraması: SECURITY DEFINER işlevleri (ADR-016 risk, M-B, m3, MINOR-1/2/6)
// ---------------------------------------------------------------------------------------------
describe("AC-04 DB — SECURITY DEFINER katalog taraması", () => {
  interface Fn {
    schema: string;
    name: string;
    owner: string;
    secdef: boolean;
    config: string[] | null;
    aclNull: boolean;
    grantees: string[];
  }
  let fns: Fn[] = [];
  let migrator = "";
  const key = (f: Fn): string => `${f.schema}.${f.name}`;

  beforeAll(async () => {
    migrator = ((await admin.query<{ u: string }>("SELECT current_user AS u")).rows[0] as { u: string }).u;
    const r = await admin.query<{
      schema: string;
      name: string;
      owner: string;
      secdef: boolean;
      config: string[] | null;
      acl_null: boolean;
      grantees: string[] | null;
    }>(
      `SELECT n.nspname AS schema, p.proname AS name, pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS secdef,
              p.proconfig AS config, (p.proacl IS NULL) AS acl_null,
              (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') AS grantees
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    );
    fns = r.rows.map((x) => ({
      schema: x.schema,
      name: x.name,
      owner: x.owner,
      secdef: x.secdef,
      config: x.config,
      aclNull: x.acl_null,
      grantees: x.grantees ?? [],
    }));
  });

  const ALLOWED_SECDEF = [
    "wms_probe.admin_reset_cleanup_on_membership", // T-103 üyelik tetikleyici işlevi (ADR-016 Sonuçlar)
    "wms_probe.consume_admin_reset_grant",
    "wms_probe.identity_exclusive_to_tenant",
    "wms_probe.invitation_for_account_creation",
    "wms_probe.invitation_preview_for_token", // T-117d migration 0008: salt okunur (ad+rol+süre), yalnızca wms_app EXECUTE
    "wms_probe.invitation_tenant_for_token", // T-117 migration 0006: salt okunur, yalnızca wms_app EXECUTE
    "wms_probe.ops_session_audited", // T-105c migration 0009: salt okunur denetim kanıtı (özyineleme önlemi), yalnızca wms_ops EXECUTE
  ];

  it("@AC-04 prosecdef=true işlevler tam olarak izinli liste; wms_meta'da hiç yok", () => {
    const secdef = fns.filter((f) => f.secdef).map(key).sort();
    expect(secdef).toEqual(ALLOWED_SECDEF);
    expect(fns.filter((f) => f.schema === "wms_meta" && f.secdef).map(key)).toEqual([]);
  });

  it("@AC-04 probe işlevleri yalnızca wms_probe şemasında; admin_reset_still_valid yok", () => {
    for (const name of ["identity_exclusive_to_tenant", "consume_admin_reset_grant", "invitation_for_account_creation", "admin_reset_cleanup_on_membership", "invitation_tenant_for_token"]) {
      expect(fns.filter((f) => f.name === name).map(key), name).toEqual([`wms_probe.${name}`]);
    }
    expect(fns.filter((f) => f.name === "admin_reset_still_valid").map(key)).toEqual([]);
  });

  it("@AC-04 her SECURITY DEFINER işlev: sahibi wms_identity_probe, search_path=pg_catalog, pg_temp, proacl NULL değil, PUBLIC'te EXECUTE yok", () => {
    for (const f of fns.filter((x) => x.secdef)) {
      expect(f.owner, `${key(f)} sahibi`).toBe(PROBE_ROLE);
      expect(f.config ?? [], `${key(f)} proconfig`).toContain("search_path=pg_catalog, pg_temp");
      expect(f.aclNull, `${key(f)} proacl NULL (varsayılan PUBLIC EXECUTE)`).toBe(false);
      expect(f.grantees, `${key(f)} EXECUTE alıcıları`).not.toContain("PUBLIC");
    }
    // wms_probe şemasındaki (sahibi probe) tüm işlevler için aynı PUBLIC/proacl kuralı.
    for (const f of fns.filter((x) => x.schema === "wms_probe")) {
      expect(f.aclNull, `${key(f)} proacl NULL`).toBe(false);
      expect(f.grantees, `${key(f)} PUBLIC`).not.toContain("PUBLIC");
    }
  });

  it("@AC-04 EXECUTE alıcıları (sahip hariç): yoklama işlevleri yalnızca beklenen uygulama rolü; migration rolü girdisi yok; tetikleyici işlevi yalnızca migration rolü", () => {
    const expected: Record<string, string[]> = {
      "wms_probe.identity_exclusive_to_tenant": [APP_ROLE],
      "wms_probe.consume_admin_reset_grant": [AUTH_ROLE],
      "wms_probe.invitation_for_account_creation": [AUTH_ROLE],
      "wms_probe.invitation_preview_for_token": [APP_ROLE],
      "wms_probe.invitation_tenant_for_token": [APP_ROLE],
      "wms_probe.ops_session_audited": ["wms_ops"],
      "wms_probe.admin_reset_cleanup_on_membership": [migrator],
    };
    for (const [k, grantees] of Object.entries(expected)) {
      const f = fns.find((x) => key(x) === k);
      expect(f, `${k} bulunamadı`).toBeDefined();
      const others = (f as Fn).grantees.filter((g) => g !== PROBE_ROLE).sort();
      expect(others, `${k} EXECUTE alıcıları`).toEqual([...grantees].sort());
    }
    for (const k of ["wms_probe.identity_exclusive_to_tenant", "wms_probe.consume_admin_reset_grant", "wms_probe.invitation_for_account_creation", "wms_probe.invitation_tenant_for_token"]) {
      expect((fns.find((x) => key(x) === k) as Fn).grantees, `${k} proacl'inde migration rolü`).not.toContain(migrator);
    }
    const trig = fns.find((x) => key(x) === "wms_probe.admin_reset_cleanup_on_membership") as Fn;
    expect(trig.grantees).not.toContain(APP_ROLE);
    expect(trig.grantees).not.toContain(AUTH_ROLE);
  });

  it("@AC-04 MINOR-6: demo bekçi tetikleyici işlevi SECURITY DEFINER değil", () => {
    const g = fns.find((f) => key(f) === "public.tenancy_guard_system_reason");
    expect(g, "public.tenancy_guard_system_reason bulunamadı").toBeDefined();
    expect((g as Fn).secdef).toBe(false);
  });

  it("@AC-04 wms_identity_probe'u kapsayan her politika yalnızca TO wms_identity_probe", async () => {
    const r = await admin.query<{ tablename: string; policyname: string; roles: string[] }>(
      `SELECT tablename, policyname, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public'`,
    );
    const probePolicies = r.rows.filter((p) => p.roles.includes(PROBE_ROLE));
    expect(probePolicies.length).toBeGreaterThan(0);
    for (const p of probePolicies) expect(p.roles, `${p.tablename}.${p.policyname}`).toEqual([PROBE_ROLE]);
    // PUBLIC'e açık politika (TO'suz) probe için de geçerli olur: probe'a ait olduğu varsayılan politikalar yalnızca SELECT.
    const cmds = await admin.query<{ polname: string; polcmd: string }>(
      `SELECT polname, polcmd FROM pg_policy p WHERE p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = $1)]`,
      [PROBE_ROLE],
    );
    for (const p of cmds.rows) expect(p.polcmd, p.polname).toBe("r");
  });
});

// ---------------------------------------------------------------------------------------------
// 6. T-102 ek (security-reviewer @77317fe MINOR): security_events
// ---------------------------------------------------------------------------------------------
describe("T-102 ek — security_events append-only + sunucu alanları (AC etiketsiz)", () => {
  const INSERT_APP = `INSERT INTO public.security_events (event_type, detail) VALUES ('t104.probe', '{}'::jsonb)
                      RETURNING created_xid::text AS created_xid, pg_current_xact_id()::text AS xid, occurred_at, now() AS now`;

  it("security_events: wms_app açık created_xid / occurred_at / id yazamaz (42501)", async () => {
    for (const col of ["created_xid", "occurred_at", "id"]) {
      const val = col === "created_xid" ? "'1'::xid8" : col === "occurred_at" ? "'2000-01-01'::timestamptz" : "gen_random_uuid()";
      const r = await attempt(appClient, [], `INSERT INTO public.security_events (event_type, ${col}) VALUES ('t104.forge', ${val})`);
      expect(r.ok, `${col}: ${fmt(r)}`).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("security_events: wms_app normal INSERT'te created_xid = geçerli transaction, occurred_at = now()", async () => {
    const r = await attempt(appClient, [], INSERT_APP);
    expect(r.ok, fmt(r)).toBe(true);
    if (r.ok) {
      const row = r.rows[0] as { created_xid: string; xid: string; occurred_at: Date; now: Date };
      expect(row.created_xid).toBe(row.xid);
      expect(row.occurred_at.getTime()).toBe(row.now.getTime());
    }
  });

  it("security_events: yetkili rol (migration) sahte created_xid / occurred_at verse bile tetikleyici sunucu değerine zorlar", async () => {
    const r = await attempt(
      admin,
      [],
      `INSERT INTO public.security_events (event_type, created_xid, occurred_at) VALUES ('t104.forge', '1'::xid8, '2000-01-01'::timestamptz)
       RETURNING created_xid::text AS created_xid, pg_current_xact_id()::text AS xid, occurred_at, now() AS now`,
    );
    expect(r.ok, fmt(r)).toBe(true);
    if (r.ok) {
      const row = r.rows[0] as { created_xid: string; xid: string; occurred_at: Date; now: Date };
      expect(row.created_xid, "created_xid sunucu değerine zorlanmadı").toBe(row.xid);
      expect(row.occurred_at.getTime(), "occurred_at sunucu değerine zorlanmadı").toBe(row.now.getTime());
    }
  });

  /** Süper kullanıcı gibi davranan migration rolüyle replica moduna geçilebiliyorsa onu döndürür; geçilemiyorsa null. */
  async function replicaPre(): Promise<Pre[] | null> {
    const probe = await attempt(admin, [], "SET LOCAL session_replication_role = replica");
    if (probe.ok) return [["SET LOCAL session_replication_role = replica", []]];
    expect(probe.code, probe.message).toBe(INSUFFICIENT_PRIVILEGE); // yetkisiz rol replica'ya geçemez: atlatma yolu zaten kapalı
    return null;
  }

  it("security_events: session_replication_role=replica iken INSERT tetikleyicisi (ENABLE ALWAYS) hâlâ sunucu alanlarını zorlar", async () => {
    const pre = await replicaPre();
    if (pre === null) return;
    const r = await attempt(
      admin,
      pre,
      `INSERT INTO public.security_events (event_type, created_xid, occurred_at) VALUES ('t104.forge', '1'::xid8, '2000-01-01'::timestamptz)
       RETURNING created_xid::text AS created_xid, pg_current_xact_id()::text AS xid, occurred_at, now() AS now`,
    );
    expect(r.ok, fmt(r)).toBe(true);
    if (r.ok) {
      const row = r.rows[0] as { created_xid: string; xid: string; occurred_at: Date; now: Date };
      expect(row.created_xid, "replica modunda created_xid zorlanmadı").toBe(row.xid);
      expect(row.occurred_at.getTime(), "replica modunda occurred_at zorlanmadı").toBe(row.now.getTime());
    }
  });

  it("security_events: replica modunda ve normal modda UPDATE / DELETE / TRUNCATE reddedilir (42501); veri değişmez", async () => {
    await admin.query("BEGIN");
    let seeded: string;
    try {
      // Satır kalıcı olmasın diye tohum da ROLLBACK edilir; sayımlar aynı transaction içinde kıyaslanır.
      const ins = await admin.query<{ id: string }>("INSERT INTO public.security_events (event_type) VALUES ('t104.seed') RETURNING id");
      seeded = (ins.rows[0] as { id: string }).id;
      const before = (await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.security_events")).rows[0]?.n;
      const modes: [string, string | null][] = [["normal", null], ["replica", "SET LOCAL session_replication_role = replica"]];
      for (const [mode, setup] of modes) {
        if (setup !== null) {
          try {
            await admin.query("SAVEPOINT rep");
            await admin.query(setup);
          } catch (e) {
            await admin.query("ROLLBACK TO SAVEPOINT rep");
            expect((e as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
            continue;
          }
        }
        for (const stmt of [
          `UPDATE public.security_events SET event_type = 'tampered' WHERE id = '${seeded}'`,
          `DELETE FROM public.security_events WHERE id = '${seeded}'`,
          "TRUNCATE public.security_events",
        ]) {
          await admin.query("SAVEPOINT s");
          let code: string | undefined;
          let message = "";
          try {
            await admin.query(stmt);
          } catch (e) {
            code = (e as { code?: string }).code;
            message = String((e as { message?: string }).message);
          }
          await admin.query("ROLLBACK TO SAVEPOINT s");
          expect(code, `[${mode}] ${stmt} reddedilmedi`).toBe(INSUFFICIENT_PRIVILEGE);
          expect(message, `[${mode}] ${stmt}`).toMatch(/append-only/);
        }
        const after = (await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM public.security_events")).rows[0]?.n;
        expect(after, `[${mode}] satır sayısı değişti`).toBe(before);
        const type = (await admin.query<{ event_type: string }>("SELECT event_type FROM public.security_events WHERE id = $1", [seeded])).rows[0]?.event_type;
        expect(type).toBe("t104.seed");
        if (setup !== null) await admin.query("RESET session_replication_role");
      }
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("security_events: wms_app session_replication_role'ü değiştiremez (42501) ve UPDATE/DELETE/TRUNCATE yetkisi yok", async () => {
    const set = await attempt(appClient, [], "SET LOCAL session_replication_role = replica");
    expect(set.ok, fmt(set)).toBe(false);
    if (!set.ok) expect(set.code, set.message).toBe(INSUFFICIENT_PRIVILEGE);
    for (const stmt of ["UPDATE public.security_events SET event_type = 'x'", "DELETE FROM public.security_events", "TRUNCATE public.security_events"]) {
      const r = await attempt(appClient, [], stmt);
      expect(r.ok, `${stmt}: ${fmt(r)}`).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("katalog: güvenlik tetikleyicileri tgenabled='A' (ENABLE ALWAYS); hiçbir public tetikleyici devre dışı değil", async () => {
    const expected: Record<string, string[]> = {
      security_events: ["security_events_no_truncate", "security_events_no_update_delete", "security_events_server_fields"],
      tenant_memberships: ["tenant_memberships_admin_reset_cleanup", "tenant_memberships_system_reason_guard"],
      membership_roles: ["membership_roles_id_immutable", "membership_roles_system_reason_guard"],
      admin_reset_grants: ["admin_reset_grants_guard_issuer"],
    };
    const r = await admin.query<{ tbl: string; trg: string; enabled: string }>(
      `SELECT c.relname AS tbl, t.tgname AS trg, t.tgenabled::text AS enabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
    );
    for (const [tbl, names] of Object.entries(expected)) {
      const have = r.rows.filter((x) => x.tbl === tbl);
      for (const name of names) {
        const t = have.find((x) => x.trg === name);
        expect(t, `${tbl}.${name} yok`).toBeDefined();
        expect(t?.enabled, `${tbl}.${name} tgenabled`).toBe("A");
      }
    }
    expect(r.rows.filter((x) => x.enabled === "D").map((x) => `${x.tbl}.${x.trg}`)).toEqual([]);
  });
});
