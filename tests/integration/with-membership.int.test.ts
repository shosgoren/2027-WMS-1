// withMembership ailesi + tenancy şeması entegrasyon testi (T-103; ADR-016 §2-3, §5-9 ve 2.-5. tur ekleri).
//
// Roller GERÇEK bağlantılarla sınanır: uygulama tarafı YALNIZCA DATABASE_URL (wms_app, pooler) ve
// AUTH_DATABASE_URL (wms_auth, pooler); superuser ile değil. Migration rolü (DATABASE_URL_DIRECT) yalnızca fikstür
// kurulumu/temizliği, "başka bağlantıdan eşzamanlı yazma" taraf (B) ve katalog okuması içindir.
//
// Yarış testleri: A, withMembership içinde bekler; B (migration rolü) çıkarma / rol değişimi / askıya alma yazar.
// B'nin A'yı beklediği `pg_blocking_pids` ile KANITLANIR (zamanlamaya güvenilmez). Tersi: B açık transaction'da
// yazar, A bloklanır (kanıtlanır), B commit eder, A reddedilir.
//
// Fikstür verisi rastgele UUID/e-posta (`@example.test`) ile sentetiktir (G-09) ve afterAll'da silinir.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MembershipError,
  createDbClient,
  lockOwners,
  withMembership,
  withNewTenant,
  withSystemTenant,
  withUser,
} from "../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient, type TenantTx } from "../../packages/db/src/client.ts";
import { PROBE_ROLE, readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "./harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];

const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

// ---------------------------------------------------------------------------------------------
// Bağlantı yardımcıları
// ---------------------------------------------------------------------------------------------
async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  return client;
}

const open: pg.Client[] = [];
async function openClient(url: string): Promise<pg.Client> {
  const c = await connect(url);
  open.push(c);
  return c;
}

/** Migration rolüyle tek seferlik (otomatik commit) çalıştırma. */
async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(env.databaseUrlDirect);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string | undefined; message: string };

/** İfadeyi kendi transaction'ında çalıştırır; sonucu/hatayı döndürür ve daima ROLLBACK yapar. */
async function attempt(client: pg.Client, sqlText: string, params: unknown[] = [], pre: string[] = []): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    for (const p of pre) await client.query(p);
    const r = await client.query(sqlText, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectDenied(client: pg.Client, sqlText: string, params: unknown[] = [], pre: string[] = []): Promise<void> {
  const r = await attempt(client, sqlText, params, pre);
  expect(r.ok, `beklenen yetki hatasi: ${sqlText}`).toBe(false);
  if (!r.ok) expect(r.code, r.message).toBe(INSUFFICIENT_PRIVILEGE);
}

async function expectOk(client: pg.Client, sqlText: string, params: unknown[] = [], pre: string[] = []): Promise<Record<string, unknown>[]> {
  const r = await attempt(client, sqlText, params, pre);
  expect(r.ok, `beklenen basari: ${sqlText} -> ${r.ok ? "" : r.message}`).toBe(true);
  return r.ok ? r.rows : [];
}

/** Drizzle hatasını (DrizzleQueryError.cause = PostgresError) ve zincirini düzleştirir. */
function errInfo(e: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const texts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof o.code === "string") codes.push(o.code);
    if (typeof o.message === "string") texts.push(o.message);
    cur = o.cause;
  }
  return { codes, text: redactErrorChain(e, urls) + " | " + texts.join(" | ") };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function poll(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`zaman asimi: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** `blockerPid` backend'inin en az bir başka backend'i beklettiği ana kadar bekler. */
async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
  const watcher = await openClient(env.databaseUrlDirect);
  await poll(`backend ${blockerPid} bir sorguyu bekletmiyor`, async () => {
    const r = await watcher.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [blockerPid],
    );
    return Number(r.rows[0]?.n) > 0;
  });
}

function gate(): { wait: Promise<void>; open: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, open: release };
}

async function myPid(tx: TenantTx): Promise<number> {
  const rows = await tx.execute<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(rows[0]?.pid);
}

// ---------------------------------------------------------------------------------------------
// Fikstürler (migration rolü; süper kullanıcı RLS'i aşar — Neon'da sahip rol BYPASSRLS gerektirir)
// ---------------------------------------------------------------------------------------------
const createdUsers: string[] = [];
const createdTenants: string[] = [];
const createdVerifications: string[] = [];

async function mkUser(c: pg.Client): Promise<string> {
  const r = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T103 fixture', $1) RETURNING id", [
    `t103-${randomBytes(6).toString("hex")}@example.test`,
  ]);
  const id = (r.rows[0] as { id: string }).id;
  createdUsers.push(id);
  return id;
}

interface TenantOpts {
  status?: "ACTIVE" | "SUSPENDED" | "CLOSING";
  isDemo?: boolean;
}
async function mkTenant(c: pg.Client, o: TenantOpts = {}): Promise<string> {
  const id = randomUUID();
  await c.query("INSERT INTO public.tenants (id, slug, name, status, is_demo) VALUES ($1, $2, 'T103 Tenant', $3, $4)", [
    id,
    `t103-${randomBytes(6).toString("hex")}`,
    o.status ?? "ACTIVE",
    o.isDemo ?? false,
  ]);
  createdTenants.push(id);
  return id;
}

interface MemberOpts {
  status?: "ACTIVE" | "REMOVED";
  isOwner?: boolean;
  roles?: string[];
}
async function mkMember(c: pg.Client, tenantId: string, userId: string, o: MemberOpts = {}): Promise<string> {
  const status = o.status ?? "ACTIVE";
  const r = await c.query<{ id: string }>(
    `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner, removed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'REMOVED' THEN now() END) RETURNING id`,
    [tenantId, userId, status, o.isOwner ?? false],
  );
  const id = (r.rows[0] as { id: string }).id;
  for (const role of o.roles ?? ["PICKER"]) {
    await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenantId, id, role]);
  }
  return id;
}

/** Better Auth 1.7.7 sıfırlama kaydı biçimi: identifier `reset-password:<token>`, value = kullanıcı kimliği (MAJOR-1). */
async function mkVerification(c: pg.Client, userId: string, identifier?: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO public.verifications (identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id",
    [identifier ?? `reset-password:t103-${randomBytes(12).toString("hex")}`, userId],
  );
  const id = (r.rows[0] as { id: string }).id;
  createdVerifications.push(id);
  return id;
}

async function mkInvitation(
  c: pg.Client,
  tenantId: string,
  invitedBy: string,
  o: { claimId?: string | null; claimExpiresInSec?: number; expiresInSec?: number; revoked?: boolean; accepted?: boolean; via?: string; email?: string } = {},
): Promise<{ id: string; tokenHash: string; email: string }> {
  const tokenHash = randomBytes(32).toString("hex");
  const email = o.email ?? `inv-${randomBytes(5).toString("hex")}@example.test`;
  const r = await c.query<{ id: string }>(
    `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at,
                                     accepted_at, revoked_at, invited_by_membership_id, claim_id, claim_expires_at)
     VALUES ($1, $2, 'PICKER', $3, $4, now() + make_interval(secs => $5),
             CASE WHEN $6::boolean THEN now() END, CASE WHEN $7::boolean THEN now() END, $8, $9,
             CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() + make_interval(secs => $10) END) RETURNING id`,
    [tenantId, email, tokenHash, o.via ?? "EMAIL", o.expiresInSec ?? 3600, o.accepted ?? false, o.revoked ?? false, invitedBy, o.claimId ?? null, o.claimExpiresInSec ?? 3600],
  );
  return { id: (r.rows[0] as { id: string }).id, tokenHash, email };
}

async function cleanup(): Promise<void> {
  const c = await connect(env.databaseUrlDirect);
  try {
    const t = createdTenants;
    await c.query("DELETE FROM public.admin_reset_grants WHERE user_id = ANY($1::uuid[]) OR issuing_tenant_id = ANY($2::uuid[])", [createdUsers, t]);
    await c.query("DELETE FROM public.verifications WHERE id = ANY($1::uuid[])", [createdVerifications]);
    // withNewTenant ile oluşturulan tenant'lar da kullanıcıya bağlı satırlarla birlikte silinir.
    const owned = await c.query<{ id: string }>("SELECT id FROM public.tenants WHERE created_by_user_id = ANY($1::uuid[])", [createdUsers]);
    const all = [...new Set([...t, ...owned.rows.map((r) => r.id)])];
    await c.query("DELETE FROM public.invitations WHERE tenant_id = ANY($1::uuid[])", [all]);
    await c.query("DELETE FROM public.membership_roles WHERE tenant_id = ANY($1::uuid[])", [all]);
    await c.query("DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])", [all, createdUsers]);
    await c.query("DELETE FROM public.tenant_settings WHERE tenant_id = ANY($1::uuid[])", [all]);
    await c.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [all]);
    await c.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [createdUsers]);
  } finally {
    await c.end();
  }
}

let app: DbClient;
let appRaw: pg.Client;
let authRaw: pg.Client;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  appRaw = await openClient(env.databaseUrl);
  authRaw = await openClient(authUrl);
});

afterAll(async () => {
  await app.close();
  for (const c of open) await c.end().catch(() => undefined);
  await cleanup();
}, 60_000);

/** withMembership içinde gözlenen GUC'ler. */
async function guc(tx: TenantTx): Promise<{ tenant: string; user: string; reason: string }> {
  const rows = await tx.execute<{ tenant: string | null; usr: string | null; reason: string | null }>(
    `SELECT current_setting('app.current_tenant_id', true) AS tenant,
            current_setting('app.current_user_id', true) AS usr,
            current_setting('app.system_reason', true) AS reason`,
  );
  const r = rows[0];
  return { tenant: r?.tenant ?? "", user: r?.usr ?? "", reason: r?.reason ?? "" };
}

// ---------------------------------------------------------------------------------------------
// withMembership: kabul ve ret yolları
// ---------------------------------------------------------------------------------------------
describe(`withMembership — kabul ve ret yolları (target=${env.target})`, () => {
  it("aktif üyelik: fn çalışır; yalnızca app.current_tenant_id kurulur; roller ve sürüm döner", async () => {
    const { tenant, user, membership } = await admin(async (c) => {
      const tenant = await mkTenant(c);
      const user = await mkUser(c);
      const membership = await mkMember(c, tenant, user, { roles: ["PICKER", "COUNTER"], isOwner: true });
      return { tenant, user, membership };
    });
    const out = await withMembership({ client: app, userId: user, tenantId: tenant }, async (tx, m) => ({ m, g: await guc(tx) }));
    expect(out.m).toEqual({ membershipId: membership, userId: user, tenantId: tenant, isOwner: true, roles: ["COUNTER", "PICKER"], rolesVersion: 0 });
    expect(out.g).toEqual({ tenant, user: "", reason: "" });
  });

  it("REMOVED → FORBIDDEN; üye olmayan → FORBIDDEN; başka tenant'ın id'si → FORBIDDEN; var olmayan tenant → FORBIDDEN", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const removed = await mkUser(c);
      const member2 = await mkUser(c);
      const stranger = await mkUser(c);
      await mkMember(c, t1, removed, { status: "REMOVED" });
      await mkMember(c, t2, member2);
      return { t1, t2, removed, member2, stranger };
    });
    const run = (userId: string, tenantId: string) => caught(withMembership({ client: app, userId, tenantId }, async () => "unreachable"));
    for (const [userId, tenantId] of [
      [f.removed, f.t1],
      [f.stranger, f.t1],
      [f.member2, f.t1], // t2 üyesi t1'in id'siyle
      [f.member2, randomUUID()],
    ] as const) {
      const e = await run(userId, tenantId);
      expect(e).toBeInstanceOf(MembershipError);
      expect((e as MembershipError).code).toBe("FORBIDDEN");
    }
  });

  it("slug (UUID olmayan) → sorgusuz FORBIDDEN", async () => {
    const e = await caught(withMembership({ client: app, userId: randomUUID(), tenantId: "t103-some-slug" }, async () => "x"));
    expect((e as MembershipError).code).toBe("FORBIDDEN");
  });

  it("SUSPENDED → TENANT_SUSPENDED; CLOSING → TENANT_CLOSING; üye olmayana durum sızdırılmaz (FORBIDDEN)", async () => {
    const f = await admin(async (c) => {
      const s = await mkTenant(c, { status: "SUSPENDED" });
      const cl = await mkTenant(c, { status: "CLOSING" });
      const u = await mkUser(c);
      const stranger = await mkUser(c);
      await mkMember(c, s, u);
      await mkMember(c, cl, u);
      return { s, cl, u, stranger };
    });
    const code = async (userId: string, tenantId: string) =>
      ((await caught(withMembership({ client: app, userId, tenantId }, async () => "x"))) as MembershipError).code;
    expect(await code(f.u, f.s)).toBe("TENANT_SUSPENDED");
    expect(await code(f.u, f.cl)).toBe("TENANT_CLOSING");
    expect(await code(f.stranger, f.s)).toBe("FORBIDDEN");
  });

  it("permission: allowedRoles ve fonksiyon biçimi (izin matrisi parametre)", async () => {
    const { tenant, user } = await admin(async (c) => {
      const tenant = await mkTenant(c);
      const user = await mkUser(c);
      await mkMember(c, tenant, user, { roles: ["PICKER"] });
      return { tenant, user };
    });
    const base = { client: app, userId: user, tenantId: tenant };
    await expect(withMembership({ ...base, permission: { allowedRoles: ["PICKER"] } }, async () => "ok")).resolves.toBe("ok");
    await expect(withMembership({ ...base, permission: (roles) => roles.includes("PICKER") }, async () => "ok")).resolves.toBe("ok");
    const denied = await caught(withMembership({ ...base, permission: { allowedRoles: ["TENANT_ADMIN"] } }, async () => "x"));
    expect((denied as MembershipError).code).toBe("FORBIDDEN");
  });

  it("fn hatası → geri alma ve aynen yeniden fırlatma", async () => {
    const { tenant, user } = await admin(async (c) => {
      const tenant = await mkTenant(c);
      const user = await mkUser(c);
      await mkMember(c, tenant, user, { roles: ["TENANT_ADMIN"] });
      return { tenant, user };
    });
    const boom = new Error("boom after insert");
    const e = await caught(
      withMembership({ client: app, userId: user, tenantId: tenant }, async (tx, m) => {
        await tx.execute(
          `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status)
           VALUES ('${m.tenantId}', 'tr-TR', 'Europe/Istanbul', 'IN_PROGRESS')`,
        );
        throw boom;
      }),
    );
    expect(e).toBe(boom);
    const rows = await admin((c) => c.query("SELECT 1 FROM public.tenant_settings WHERE tenant_id = $1", [tenant]));
    expect(rows.rowCount).toBe(0);
  });

  it("withMembership içinde üyelik ekleme tetikleyiciden etkilenmez; tenant_settings yazılır", async () => {
    const f = await admin(async (c) => {
      const tenant = await mkTenant(c);
      const adminUser = await mkUser(c);
      const newUser = await mkUser(c);
      await mkMember(c, tenant, adminUser, { roles: ["TENANT_ADMIN"], isOwner: true });
      return { tenant, adminUser, newUser };
    });
    const newMembership = await withMembership({ client: app, userId: f.adminUser, tenantId: f.tenant }, async (tx, m) => {
      const rows = await tx.execute<{ id: string }>(
        `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner)
         VALUES ('${m.tenantId}', '${f.newUser}', 'ACTIVE', false) RETURNING id`,
      );
      const id = (rows[0] as { id: string }).id;
      await tx.execute(`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ('${m.tenantId}', '${id}', 'COUNTER')`);
      await tx.execute(
        `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status)
         VALUES ('${m.tenantId}', 'tr-TR', 'Europe/Istanbul', 'IN_PROGRESS')`,
      );
      await tx.execute(`UPDATE public.tenant_settings SET onboarding_status = 'COMPLETED' WHERE tenant_id = '${m.tenantId}'`);
      return id;
    });
    expect(newMembership).toMatch(/^[0-9a-f-]{36}$/);
    const r = await withMembership({ client: app, userId: f.newUser, tenantId: f.tenant }, async (_tx, m) => m.roles);
    expect(r).toEqual(["COUNTER"]);
  });
});

// ---------------------------------------------------------------------------------------------
// withMembership: FOR SHARE yarış testleri (M4)
// ---------------------------------------------------------------------------------------------
describe(`withMembership — eşzamanlı yazma yarışı (FOR SHARE; target=${env.target})`, () => {
  type Writer = { name: string; sql: (ids: { tenant: string; membership: string }) => string; expect: "FORBIDDEN" | "TENANT_SUSPENDED" | "ok" };
  const writers: Writer[] = [
    { name: "çıkarma (üyelik REMOVED)", sql: (i) => `UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = '${i.membership}'`, expect: "FORBIDDEN" },
    // Rol değişimi: üyelik satırı UPDATE + roles_version artar → bekler; sonrasında güncel durum görünür (ok, sürüm 1).
    { name: "rol değişimi (roles_version + 1)", sql: (i) => `UPDATE public.tenant_memberships SET roles_version = roles_version + 1 WHERE id = '${i.membership}'`, expect: "ok" },
    { name: "askıya alma (tenants.status)", sql: (i) => `UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = '${i.tenant}'`, expect: "TENANT_SUSPENDED" },
  ];

  async function fixture(): Promise<{ tenant: string; user: string; membership: string }> {
    return admin(async (c) => {
      const tenant = await mkTenant(c);
      const user = await mkUser(c);
      const membership = await mkMember(c, tenant, user, { roles: ["TENANT_ADMIN"] });
      return { tenant, user, membership };
    });
  }

  for (const w of writers) {
    it(`A withMembership içinde beklerken B ${w.name} commit etmeye çalışır → B BEKLER; A bitince B tamamlanır`, async () => {
      const f = await fixture();
      const inside = gate();
      const hold = gate();
      let pid = 0;
      const a = withMembership({ client: app, userId: f.user, tenantId: f.tenant }, async (tx, m) => {
        pid = await myPid(tx);
        inside.open();
        await hold.wait;
        return m.rolesVersion;
      });
      await inside.wait;
      const b = await openClient(env.databaseUrlDirect);
      const write = b.query(w.sql({ tenant: f.tenant, membership: f.membership }));
      let writeDone = false;
      void write.then(() => (writeDone = true), () => (writeDone = true));
      await waitUntilBlockedBy(pid);
      expect(writeDone, "B, A bitmeden tamamlanmamalı").toBe(false);
      hold.open();
      // A, B'den ÖNCE kilidi almıştı: eski (güncellenmemiş) durumu görür.
      expect(await a).toBe(0);
      await write;
      expect(writeDone).toBe(true);
    });

    it(`tersi: B ${w.name} açık transaction'da yazarken A bloklanır; B commit edince A ${w.expect === "ok" ? "güncel durumu görür" : "reddedilir"}`, async () => {
      const f = await fixture();
      const b = await openClient(env.databaseUrlDirect);
      await b.query("BEGIN");
      const pidRow = await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await b.query(w.sql({ tenant: f.tenant, membership: f.membership }));
      let fnRan = false;
      const a = withMembership({ client: app, userId: f.user, tenantId: f.tenant }, async (_tx, m) => {
        fnRan = true;
        return m.rolesVersion;
      }).then(
        (version) => ({ version }) as { version?: number; error?: unknown },
        (error: unknown) => ({ error }) as { version?: number; error?: unknown },
      );
      await waitUntilBlockedBy(Number(pidRow.rows[0]?.pid));
      expect(fnRan, "A, B commit etmeden fn'e girmemeli").toBe(false);
      await b.query("COMMIT");
      const res = await a;
      if (w.expect === "ok") {
        expect(res.error).toBeUndefined();
        expect(res.version).toBe(1);
      } else {
        expect(res.error).toBeInstanceOf(MembershipError);
        expect((res.error as MembershipError).code).toBe(w.expect);
        expect(fnRan).toBe(false);
      }
    });
  }
});

describe(`withMembership — rol satırları FOR SHARE (MINOR-6; target=${env.target})`, () => {
  async function fixture(): Promise<{ tenant: string; user: string; membership: string }> {
    return admin(async (c) => {
      const tenant = await mkTenant(c);
      const user = await mkUser(c);
      const membership = await mkMember(c, tenant, user, { roles: ["TENANT_ADMIN"] });
      return { tenant, user, membership };
    });
  }
  const deleteRoles = (membership: string) => `DELETE FROM public.membership_roles WHERE membership_id = '${membership}'`;

  it("A withMembership içinde beklerken B rol satırını siler → B BEKLER; A eski rolleri görür, B sonra tamamlanır", async () => {
    const f = await fixture();
    const inside = gate();
    const hold = gate();
    let pid = 0;
    const a = withMembership({ client: app, userId: f.user, tenantId: f.tenant }, async (tx, m) => {
      pid = await myPid(tx);
      inside.open();
      await hold.wait;
      return m.roles;
    });
    await inside.wait;
    const b = await openClient(env.databaseUrlDirect);
    const del = b.query(deleteRoles(f.membership));
    let done = false;
    void del.then(() => (done = true), () => (done = true));
    await waitUntilBlockedBy(pid);
    expect(done, "rol silme, A bitmeden tamamlanmamalı").toBe(false);
    hold.open();
    expect(await a).toEqual(["TENANT_ADMIN"]);
    await del;
    expect(done).toBe(true);
  });

  it("tersi: B rol silmesini açık transaction'da tutarken A bloklanır; B commit edince A güncel (boş) rolleri görür", async () => {
    const f = await fixture();
    const b = await openClient(env.databaseUrlDirect);
    await b.query("BEGIN");
    const pidRow = await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await b.query(deleteRoles(f.membership));
    let fnRan = false;
    const a = withMembership({ client: app, userId: f.user, tenantId: f.tenant }, async (_tx, m) => {
      fnRan = true;
      return m.roles;
    });
    await waitUntilBlockedBy(Number(pidRow.rows[0]?.pid));
    expect(fnRan, "A, B commit etmeden fn'e girmemeli").toBe(false);
    await b.query("COMMIT");
    expect(await a).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// withUser / withNewTenant / withSystemTenant / lockOwners
// ---------------------------------------------------------------------------------------------
describe(`withUser ve kullanıcı kimliğine dayalı SELECT politikaları (target=${env.target})`, () => {
  it("withUser yalnızca kendi üyeliklerini ve ACTIVE üyeliği olan tenant'ları görür; tenant bağlamı boş", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const t3 = await mkTenant(c);
      const me = await mkUser(c);
      const other = await mkUser(c);
      const m1 = await mkMember(c, t1, me, { roles: ["PICKER"] });
      const m2 = await mkMember(c, t2, me, { status: "REMOVED" });
      await mkMember(c, t1, other);
      await mkMember(c, t3, other);
      return { t1, t2, t3, me, other, m1, m2 };
    });
    const out = await withUser(app, f.me, async (tx) => {
      const mem = await tx.execute<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM public.tenant_memberships ORDER BY id");
      const ten = await tx.execute<{ id: string }>("SELECT id FROM public.tenants ORDER BY id");
      const roles = await tx.execute("SELECT 1 FROM public.membership_roles");
      const inv = await tx.execute("SELECT 1 FROM public.invitations");
      return { mem: mem.map((r) => r.id).sort(), ten: ten.map((r) => r.id), roles: roles.length, inv: inv.length, g: await guc(tx) };
    });
    expect(out.mem).toEqual([f.m1, f.m2].sort());
    expect(out.ten).toEqual([f.t1]); // t2: REMOVED, t3: üye değil
    expect(out.roles).toBe(0);
    expect(out.inv).toBe(0);
    expect(out.g).toEqual({ tenant: "", user: f.me, reason: "" });
  });

  it("m1: tenant bağlamı doluyken kullanıcı kimliği politikaları devre dışı (iki GUC birden → yalnızca o tenant)", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const me = await mkUser(c);
      const m1 = await mkMember(c, t1, me);
      await mkMember(c, t2, me);
      return { t1, t2, me, m1 };
    });
    const rows = await expectOk(
      appRaw,
      "SELECT id, tenant_id FROM public.tenant_memberships",
      [],
      [`SELECT set_config('app.current_user_id', '${f.me}', true)`, `SELECT set_config('app.current_tenant_id', '${f.t1}', true)`],
    );
    expect(rows.map((r) => r.id)).toEqual([f.m1]);
    const tenants = await expectOk(
      appRaw,
      "SELECT id FROM public.tenants",
      [],
      [`SELECT set_config('app.current_user_id', '${f.me}', true)`, `SELECT set_config('app.current_tenant_id', '${f.t1}', true)`],
    );
    expect(tenants.map((r) => r.id)).toEqual([f.t1]);
  });

  it("withMembership içinde yalnızca o tenant'ın üyelik/tenant satırları görünür", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const a = await mkUser(c);
      const b = await mkUser(c);
      await mkMember(c, t1, a);
      await mkMember(c, t1, b);
      await mkMember(c, t2, a);
      return { t1, t2, a };
    });
    const out = await withMembership({ client: app, userId: f.a, tenantId: f.t1 }, async (tx) => ({
      mem: (await tx.execute<{ tenant_id: string }>("SELECT tenant_id FROM public.tenant_memberships")).map((r) => r.tenant_id),
      ten: (await tx.execute<{ id: string }>("SELECT id FROM public.tenants")).map((r) => r.id),
    }));
    expect(out.mem).toHaveLength(2);
    expect(new Set(out.mem)).toEqual(new Set([f.t1]));
    expect(out.ten).toEqual([f.t1]);
  });
});

describe(`withNewTenant (target=${env.target})`, () => {
  const newTenant = (user: string, slug: string, req: string, name = "Yeni") =>
    withNewTenant(app, { userId: user, slug, name, creationRequestId: req }, async (tx, m) => ({ m, g: await guc(tx), tenants: (await tx.execute<{ id: string }>("SELECT id FROM public.tenants")).map((r) => r.id) }));

  it("tenant + sahip üyeliği + TENANT_ADMIN rolü tek transaction'da; kimlik içeride üretilir; RLS atlanmadan; withMembership ile doğrulanır", async () => {
    const user = await admin((c) => mkUser(c));
    const slug = `t103-new-${randomBytes(4).toString("hex")}`;
    const inFn = await withNewTenant(app, { userId: user, slug, name: "Yeni", creationRequestId: randomUUID() }, async (tx, m) => {
      const t = await tx.execute<{ id: string }>("SELECT id FROM public.tenants");
      await tx.execute(
        `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status)
         VALUES ('${m.tenantId}', 'tr-TR', 'Europe/Istanbul', 'IN_PROGRESS')`,
      );
      return { m, tenants: t.map((r) => r.id), g: await guc(tx) };
    });
    const tenantId = inFn.m.tenantId;
    createdTenants.push(tenantId);
    expect(inFn.m.created).toBe(true);
    expect(inFn.tenants).toEqual([tenantId]);
    expect(inFn.g).toEqual({ tenant: tenantId, user: "", reason: "" });
    const verified = await withMembership({ client: app, userId: user, tenantId }, async (_tx, m) => m);
    expect(verified).toMatchObject({ membershipId: inFn.m.membershipId, isOwner: true, roles: ["TENANT_ADMIN"] });
    const row = await admin((c) => c.query("SELECT status, is_demo, created_by_user_id FROM public.tenants WHERE id = $1", [tenantId]));
    expect(row.rows[0]).toEqual({ status: "ACTIVE", is_demo: false, created_by_user_id: user });
  });

  it("fn hatasında tenant, üyelik ve rol dahil hiçbir şey kalmaz", async () => {
    const user = await admin((c) => mkUser(c));
    const slug = `t103-rb-${randomBytes(4).toString("hex")}`;
    const boom = new Error("boom");
    let seen = "";
    const e = await caught(withNewTenant(app, { userId: user, slug, name: "X", creationRequestId: randomUUID() }, async (_tx, m) => { seen = m.tenantId; throw boom; }));
    expect(e).toBe(boom);
    const left = await admin((c) => c.query("SELECT (SELECT count(*) FROM public.tenants WHERE id = $1) AS t, (SELECT count(*) FROM public.tenant_memberships WHERE tenant_id = $1) AS m", [seen]));
    expect(left.rows[0]).toEqual({ t: "0", m: "0" });
  });

  it("MINOR-7: slug çakışması → SLUG_TAKEN (nötr; PostgreSQL ayrıntısı sızmaz) ve hiçbir şey kalmaz", async () => {
    const user = await admin((c) => mkUser(c));
    const slug = `t103-dup-${randomBytes(4).toString("hex")}`;
    const first = await newTenant(user, slug, randomUUID());
    createdTenants.push(first.m.tenantId);
    const user2 = await admin((c) => mkUser(c));
    const err = await caught(newTenant(user2, slug, randomUUID(), "B"));
    expect(err).toBeInstanceOf(MembershipError);
    expect((err as MembershipError).code).toBe("SLUG_TAKEN");
    expect((err as MembershipError).message).not.toMatch(/tenants_slug_key|duplicate|unique|INSERT|public\./i);
    expect((err as MembershipError).cause).toBeUndefined();
    const n = await admin((c) => c.query("SELECT count(*)::int AS n FROM public.tenants WHERE created_by_user_id = $1", [user2]));
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it("MINOR-7: aynı (kullanıcı, creationRequestId) tekrarı mevcut tenant'ı döndürür (created=false); ikinci tenant/üyelik yok; farklı kullanıcının aynı kimliği çakışmaz", async () => {
    const user = await admin((c) => mkUser(c));
    const other = await admin((c) => mkUser(c));
    const req = randomUUID();
    const slug = `t103-idem-${randomBytes(4).toString("hex")}`;
    const first = await newTenant(user, slug, req);
    createdTenants.push(first.m.tenantId);
    const again = await newTenant(user, slug, req);
    expect(again.m).toEqual({ tenantId: first.m.tenantId, membershipId: first.m.membershipId, userId: user, created: false });
    expect(again.g).toEqual({ tenant: first.m.tenantId, user: "", reason: "" });
    expect(again.tenants).toEqual([first.m.tenantId]);
    const counts = await admin((c) => c.query("SELECT (SELECT count(*) FROM public.tenants WHERE created_by_user_id = $1) AS t, (SELECT count(*) FROM public.tenant_memberships WHERE user_id = $1) AS m", [user]));
    expect(counts.rows[0]).toEqual({ t: "1", m: "1" });
    const sameReqOtherUser = await newTenant(other, `${slug}-diger`, req);
    createdTenants.push(sameReqOtherUser.m.tenantId);
    expect(sameReqOtherUser.m.created).toBe(true);
    expect(sameReqOtherUser.m.tenantId).not.toBe(first.m.tenantId);
  });

  it("D: aynı istek kimliği başka slug veya ad ile tekrarlanırsa IDEMPOTENCY_MISMATCH; fn çalışmaz", async () => {
    const user = await admin((c) => mkUser(c));
    const req = randomUUID();
    const slug = `t103-mm-${randomBytes(4).toString("hex")}`;
    const first = await newTenant(user, slug, req);
    createdTenants.push(first.m.tenantId);
    for (const [s2, n2] of [[`${slug}-x`, "Yeni"], [slug, "Başka ad"]] as const) {
      let ran = false;
      const err = await caught(withNewTenant(app, { userId: user, slug: s2, name: n2, creationRequestId: req }, async () => { ran = true; }));
      expect((err as MembershipError).code, `${s2}/${n2}`).toBe("IDEMPOTENCY_MISMATCH");
      expect(ran).toBe(false);
    }
  });

  it("C: tekrar yolunda tenant SUSPENDED/CLOSING → TENANT_SUSPENDED/TENANT_CLOSING; fn çalışmaz", async () => {
    const user = await admin((c) => mkUser(c));
    const req = randomUUID();
    const slug = `t103-st-${randomBytes(4).toString("hex")}`;
    const first = await newTenant(user, slug, req);
    createdTenants.push(first.m.tenantId);
    for (const [status, code] of [["SUSPENDED", "TENANT_SUSPENDED"], ["CLOSING", "TENANT_CLOSING"]] as const) {
      await admin((c) => c.query("UPDATE public.tenants SET status = $2 WHERE id = $1", [first.m.tenantId, status]));
      let ran = false;
      const err = await caught(withNewTenant(app, { userId: user, slug, name: "Yeni", creationRequestId: req }, async () => { ran = true; }));
      expect((err as MembershipError).code).toBe(code);
      expect(ran).toBe(false);
    }
  });

  it("MINOR-7: aynı isteğin iki eşzamanlı çağrısı tek tenant üretir (biri created=true, diğeri false)", async () => {
    const user = await admin((c) => mkUser(c));
    const req = randomUUID();
    const slug = `t103-race-${randomBytes(4).toString("hex")}`;
    const [a, b] = await Promise.all([newTenant(user, slug, req), newTenant(user, slug, req)]);
    createdTenants.push(a.m.tenantId);
    expect(b.m.tenantId).toBe(a.m.tenantId);
    expect([a.m.created, b.m.created].sort()).toEqual([false, true]);
    const n = await admin((c) => c.query("SELECT count(*)::int AS n FROM public.tenants WHERE created_by_user_id = $1", [user]));
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it("MINOR-8: demo / hatalı biçimli slug → sorgusuz ret (FORBIDDEN); tenant satırı oluşmaz", async () => {
    const user = await admin((c) => mkUser(c));
    for (const slug of ["demo", "Demo", "-x1", "x1-", "a_b"]) {
      const err = await caught(newTenant(user, slug, randomUUID()));
      expect((err as MembershipError).code, slug).toBe("FORBIDDEN");
    }
    const n = await admin((c) => c.query("SELECT count(*)::int AS n FROM public.tenants WHERE created_by_user_id = $1", [user]));
    expect(n.rows[0]).toEqual({ n: 0 });
  });
});

describe(`tenants_slug_chk (MINOR-8; target=${env.target})`, () => {
  // attempt() daima ROLLBACK eder: 'demo' / tek karakterli slug gibi paylaşılan adlar kalıcı satır bırakmaz.
  let adm: pg.Client;
  beforeAll(async () => {
    adm = await openClient(env.databaseUrlDirect);
  });
  const ins = (slug: string, isDemo: boolean) =>
    attempt(adm, "INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'x', $3)", [randomUUID(), slug, isDemo]);

  it("geçersiz biçimler CHECK ihlali: büyük harf, uç tire, alt çizgi, boşluk, 64 karakter, boş", async () => {
    for (const slug of ["Abc", "-abc", "abc-", "a_b", "a b", "a".repeat(64), "", "ünal"]) {
      const r = await ins(slug, false);
      expect(r.ok, `slug ${JSON.stringify(slug)} reddedilmeli`).toBe(false);
      if (!r.ok) expect(r.code, r.message).toBe(CHECK_VIOLATION);
    }
  });

  it("geçerli biçimler kabul: 1, 2, 3 ve 63 karakter, içeride tire", async () => {
    for (const slug of ["a", "ab", "abc", "a-b", "a1-b2-c3", `a${"b".repeat(61)}c`]) {
      const r = await ins(slug, false);
      expect(r.ok, `slug ${slug}: ${r.ok ? "" : r.message}`).toBe(true);
    }
  });

  it("'demo' yalnızca is_demo=true iken izinli", async () => {
    const bad = await ins("demo", false);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(CHECK_VIOLATION);
    expect((await ins("demo", true)).ok).toBe(true);
  });
});

describe(`tenants / üyelik tabloları: wms_app yetkileri ve RLS (target=${env.target})`, () => {
  let t1 = "";
  let t2 = "";
  let u1 = "";
  let m1 = "";
  let m2 = "";
  const ctx = (t: string): string[] => [`SELECT set_config('app.current_tenant_id', '${t}', true)`];

  beforeAll(async () => {
    const f = await admin(async (c) => {
      const a = await mkTenant(c);
      const b = await mkTenant(c);
      const u = await mkUser(c);
      const ma = await mkMember(c, a, u, { roles: ["TENANT_ADMIN"] });
      const mb = await mkMember(c, b, u, { roles: ["TENANT_ADMIN"] });
      return { a, b, u, ma, mb };
    });
    t1 = f.a;
    t2 = f.b;
    u1 = f.u;
    m1 = f.ma;
    m2 = f.mb;
  });

  it("tenants: INSERT'te is_demo/status → yetki hatası; UPDATE status/slug/is_demo → yetki hatası; DELETE → yetki hatası; UPDATE name serbest", async () => {
    const id = randomUUID();
    const slug = `t103-priv-${randomBytes(3).toString("hex")}`;
    const user = u1;
    await expectDenied(appRaw, "INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'x', true)", [id, slug], ctx(id));
    await expectDenied(appRaw, "INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, 'x', 'SUSPENDED')", [id, slug], ctx(id));
    await expectDenied(appRaw, "UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [t1], ctx(t1));
    await expectDenied(appRaw, "UPDATE public.tenants SET is_demo = true WHERE id = $1", [t1], ctx(t1));
    await expectDenied(appRaw, "UPDATE public.tenants SET slug = 'hijack' WHERE id = $1", [t1], ctx(t1));
    await expectDenied(appRaw, "DELETE FROM public.tenants WHERE id = $1", [t1], ctx(t1));
    await expectDenied(appRaw, "TRUNCATE public.tenants");
    // Tenant bağlamı olmadan tenant eklenemez / izin verilen sütunlarla ekleme yalnızca kendi id'si için çalışır.
    await expectOk(appRaw, "INSERT INTO public.tenants (id, slug, name, created_by_user_id, creation_request_id) VALUES ($1, $2, 'x', $3, $4)", [id, slug, user, randomUUID()], ctx(id));
    const other = await attempt(appRaw, "INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'x')", [randomUUID(), `${slug}-b`], ctx(t1));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe(INSUFFICIENT_PRIVILEGE); // WITH CHECK: id = geçerli tenant değil
    const renamed = await expectOk(appRaw, "UPDATE public.tenants SET name = 'yeni ad' WHERE id = $1 RETURNING name", [t1], ctx(t1));
    expect(renamed).toEqual([{ name: "yeni ad" }]);
    const foreign = await expectOk(appRaw, "UPDATE public.tenants SET name = 'ele geçirildi' WHERE id = $1 RETURNING id", [t2], ctx(t1));
    expect(foreign).toEqual([]);
  });

  it("üyelik/rol/davet/ayar: DELETE yok (roller hariç); çapraz tenant yazma WITH CHECK ile reddedilir; çapraz okuma boş", async () => {
    await expectDenied(appRaw, "DELETE FROM public.tenant_memberships WHERE id = $1", [m1], ctx(t1));
    await expectDenied(appRaw, "DELETE FROM public.invitations", [], ctx(t1));
    await expectDenied(appRaw, "DELETE FROM public.tenant_settings", [], ctx(t1));
    await expectDenied(appRaw, "UPDATE public.tenant_memberships SET user_id = $2 WHERE id = $1", [m1, u1], ctx(t1));
    const cross = await attempt(
      appRaw,
      "INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'PICKER')",
      [t2, m2],
      ctx(t1),
    );
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await expectOk(appRaw, "SELECT id FROM public.tenant_memberships WHERE tenant_id = $1", [t2], ctx(t1))).toEqual([]);
    expect(await expectOk(appRaw, "SELECT id FROM public.membership_roles WHERE tenant_id = $1", [t2], ctx(t1))).toEqual([]);
    // Bağlamsız oturumda hiçbir tenant satırı görünmez.
    for (const t of ["tenants", "tenant_memberships", "membership_roles", "invitations", "tenant_settings"]) {
      expect(await expectOk(appRaw, `SELECT 1 FROM public.${t}`), t).toEqual([]);
    }
    // MINOR-6: satır kilidi için yalnızca id sütununda UPDATE; rol anahtarı/üyelik değiştirilemez.
    await expectDenied(appRaw, "UPDATE public.membership_roles SET role_key = 'READ_ONLY' WHERE membership_id = $1", [m1], ctx(t1));
    await expectDenied(appRaw, "UPDATE public.membership_roles SET membership_id = $2 WHERE membership_id = $1", [m1, m1], ctx(t1));
    // A: UPDATE (id) yetkisi gerçek id değişikliğine dönüşemez (tetikleyici); id'yi aynı bırakan güncelleme serbest.
    const idChange = await attempt(appRaw, "UPDATE public.membership_roles SET id = gen_random_uuid() WHERE membership_id = $1", [m2], ctx(t2));
    expect(idChange.ok).toBe(false);
    if (!idChange.ok) {
      expect(idChange.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(idChange.message).toMatch(/membership_roles_id_immutable/);
    }
    await expectOk(appRaw, "UPDATE public.membership_roles SET id = id WHERE membership_id = $1", [m2], ctx(t2));
    // Rol silme (rol değişimi) serbest.
    await expectOk(appRaw, "DELETE FROM public.membership_roles WHERE membership_id = $1", [m1], ctx(t1));
  });

  it("invitations: token_hash yalnızca SHA-256 hex; aktif davet (tenant_id, e-posta) benzersiz; iptalden sonra yenisi serbest", async () => {
    const email = `dup-${randomBytes(4).toString("hex")}@example.test`;
    await admin(async (c) => {
      const first = await mkInvitation(c, t1, m1, { email });
      const dup = await caught(mkInvitation(c, t1, m1, { email }));
      expect((dup as { code?: string }).code).toBe(UNIQUE_VIOLATION);
      // Başka tenant'ta aynı e-posta serbest.
      await mkInvitation(c, t2, m2, { email });
      await c.query("UPDATE public.invitations SET revoked_at = now() WHERE id = $1", [first.id]);
      await mkInvitation(c, t1, m1, { email });
      const badHash = await caught(c.query(
        `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
         VALUES ($1, 'x@example.test', 'PICKER', 'PLAINTEXT-TOKEN', 'EMAIL', now() + interval '1 day', $2)`, [t1, m1]));
      expect((badHash as { code?: string }).code).toBe(CHECK_VIOLATION);
      const badRole = await caught(c.query(
        `INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'SUPERUSER')`, [t1, m1]));
      expect((badRole as { code?: string }).code).toBe(CHECK_VIOLATION);
    });
  });

  it("token_hash UNIQUE; membership_roles UNIQUE (tenant_id, membership_id, role_key)", async () => {
    await admin(async (c) => {
      const inv = await mkInvitation(c, t1, m1);
      const dup = await caught(c.query(
        `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
         VALUES ($1, $3, 'PICKER', $2, 'EMAIL', now() + interval '1 day', $4)`, [t1, inv.tokenHash, `u-${randomBytes(3).toString("hex")}@example.test`, m1]));
      expect((dup as { code?: string }).code).toBe(UNIQUE_VIOLATION);
      await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'COUNTER')", [t2, m2]);
      const dupRole = await caught(c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'COUNTER')", [t2, m2]));
      expect((dupRole as { code?: string }).code).toBe(UNIQUE_VIOLATION);
      // Bileşik FK: başka tenant'ın üyeliğine rol bağlanamaz.
      const crossFk = await caught(c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'PICKER')", [t1, m2]));
      expect((crossFk as { code?: string }).code).toBe("23503");
    });
  });
});

describe(`withSystemTenant ve demo bekçi tetikleyicisi (target=${env.target})`, () => {
  async function fixture(o: TenantOpts = {}): Promise<{ tenant: string; user: string; user2: string }> {
    return admin(async (c) => ({ tenant: await mkTenant(c, o), user: await mkUser(c), user2: await mkUser(c) }));
  }
  const insertMembership = (tx: TenantTx, tenant: string, user: string) =>
    tx.execute<{ id: string }>(`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ('${tenant}', '${user}', 'ACTIVE', true) RETURNING id`);

  it("ACTIVE tenant: fn çalışır; tenant + system_reason kurulur; sonraki işlemde sızmaz", async () => {
    const f = await fixture();
    const g = await withSystemTenant(app, f.tenant, "email.send", guc);
    expect(g).toEqual({ tenant: f.tenant, user: "", reason: "email.send" });
    const after = await withUser(app, f.user, guc);
    expect(after.reason).toBe("");
    expect(after.tenant).toBe("");
  });

  it("SUSPENDED → TENANT_SUSPENDED; CLOSING → TENANT_CLOSING; yok → FORBIDDEN; boş gerekçe → sorgusuz FORBIDDEN", async () => {
    const s = await fixture({ status: "SUSPENDED" });
    const c = await fixture({ status: "CLOSING" });
    const code = async (t: string, reason = "email.send") => ((await caught(withSystemTenant(app, t, reason, async () => "x"))) as MembershipError).code;
    expect(await code(s.tenant)).toBe("TENANT_SUSPENDED");
    expect(await code(c.tenant)).toBe("TENANT_CLOSING");
    expect(await code(randomUUID())).toBe("FORBIDDEN");
    expect(await code(s.tenant, "   ")).toBe("FORBIDDEN");
  });

  it("withSystemTenant(…, 'email.send') içinde üyelik/rol INSERT ve UPDATE → tetikleyici hatası", async () => {
    const f = await fixture();
    const existing = await admin((c) => mkMember(c, f.tenant, f.user2));
    const ins = errInfo(await caught(withSystemTenant(app, f.tenant, "email.send", (tx) => insertMembership(tx, f.tenant, f.user))));
    expect(ins.codes).toContain(INSUFFICIENT_PRIVILEGE);
    expect(ins.text).toMatch(/tenancy_guard_system_reason/);
    const upd = errInfo(await caught(withSystemTenant(app, f.tenant, "email.send", (tx) => tx.execute(`UPDATE public.tenant_memberships SET is_owner = true WHERE id = '${existing}'`))));
    expect(upd.text).toMatch(/tenancy_guard_system_reason/);
    const role = errInfo(await caught(withSystemTenant(app, f.tenant, "email.send", (tx) =>
      tx.execute(`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ('${f.tenant}', '${existing}', 'COUNTER')`))));
    expect(role.text).toMatch(/tenancy_guard_system_reason/);
  });

  it("'demo.bootstrap' + is_demo=false tenant → tetikleyici hatası", async () => {
    const f = await fixture({ isDemo: false });
    const e = errInfo(await caught(withSystemTenant(app, f.tenant, "demo.bootstrap", (tx) => insertMembership(tx, f.tenant, f.user))));
    expect(e.codes).toContain(INSUFFICIENT_PRIVILEGE);
    expect(e.text).toMatch(/is_demo=true/);
  });

  it("'demo.bootstrap' + is_demo=true tenant → izinli (üyelik + rol); ON CONFLICT DO NOTHING ikinci çağrıda satır döndürmez", async () => {
    const f = await fixture({ isDemo: true });
    const write = (tx: TenantTx) =>
      tx.execute<{ id: string }>(
        `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner)
         VALUES ('${f.tenant}', '${f.user}', 'ACTIVE', true) ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING id`,
      ).then(async (rows) => {
        const id = rows[0]?.id;
        if (id !== undefined) {
          await tx.execute(
            `INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ('${f.tenant}', '${id}', 'TENANT_ADMIN')
             ON CONFLICT (tenant_id, membership_id, role_key) DO NOTHING`,
          );
        }
        return id;
      });
    const first = await withSystemTenant(app, f.tenant, "demo.bootstrap", write);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await withSystemTenant(app, f.tenant, "demo.bootstrap", write)).toBeUndefined();
    const rows = await admin((c) => c.query("SELECT count(*)::int AS n FROM public.membership_roles WHERE tenant_id = $1", [f.tenant]));
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it("withTenant-dışı sarmalayıcılar system_reason kurmaz: demo olmayan tenant'ta withMembership ile üyelik eklenir", async () => {
    const f = await fixture();
    await admin((c) => mkMember(c, f.tenant, f.user, { roles: ["TENANT_ADMIN"], isOwner: true }));
    await withMembership({ client: app, userId: f.user, tenantId: f.tenant }, (tx) => insertMembership(tx, f.tenant, f.user2));
  });
});

describe(`lockOwners (target=${env.target})`, () => {
  it("ACTIVE sahipleri FOR UPDATE ile kilitler ve döndürür; eşzamanlı ikinci çağrı bekler", async () => {
    const f = await admin(async (c) => {
      const tenant = await mkTenant(c);
      const o1 = await mkUser(c);
      const o2 = await mkUser(c);
      const plain = await mkUser(c);
      const removedOwner = await mkUser(c);
      const m1 = await mkMember(c, tenant, o1, { isOwner: true, roles: ["TENANT_ADMIN"] });
      const m2 = await mkMember(c, tenant, o2, { isOwner: true, roles: ["TENANT_ADMIN"] });
      await mkMember(c, tenant, plain);
      await mkMember(c, tenant, removedOwner, { isOwner: true, status: "REMOVED" });
      return { tenant, o1, o2, m1, m2 };
    });
    const inside = gate();
    const hold = gate();
    let pid = 0;
    const a = withMembership({ client: app, userId: f.o1, tenantId: f.tenant }, async (tx) => {
      const owners = await lockOwners(tx, f.tenant);
      pid = await myPid(tx);
      inside.open();
      await hold.wait;
      return owners;
    });
    await inside.wait;
    let bRan = false;
    const b = withMembership({ client: app, userId: f.o2, tenantId: f.tenant }, async (tx) => {
      bRan = true;
      return lockOwners(tx, f.tenant);
    });
    await waitUntilBlockedBy(pid);
    expect(bRan).toBe(false);
    hold.open();
    const ownersA = await a;
    expect(ownersA.map((o) => o.membershipId).sort()).toEqual([f.m1, f.m2].sort());
    expect(ownersA.map((o) => o.userId).sort()).toEqual([f.o1, f.o2].sort());
    expect((await b).map((o) => o.membershipId).sort()).toEqual([f.m1, f.m2].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// wms_probe işlevleri
// ---------------------------------------------------------------------------------------------
describe(`wms_probe.identity_exclusive_to_tenant (target=${env.target})`, () => {
  const exclusive = (tx: TenantTx, user: string) =>
    tx.execute<{ r: boolean }>(`SELECT wms_probe.identity_exclusive_to_tenant('${user}'::uuid) AS r`).then((rows) => rows[0]?.r);

  it("yalnız bu tenant'ta ACTIVE → true; başka tenant'a da ACTIVE üye → false (iki yönden); REMOVED başka üyelik sayılmaz", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const caller = await mkUser(c);
      const solo = await mkUser(c);
      const both = await mkUser(c);
      const removedElsewhere = await mkUser(c);
      await mkMember(c, t1, caller, { roles: ["TENANT_ADMIN"], isOwner: true });
      await mkMember(c, t1, solo);
      await mkMember(c, t1, both);
      await mkMember(c, t2, both);
      await mkMember(c, t1, removedElsewhere);
      await mkMember(c, t2, removedElsewhere, { status: "REMOVED" });
      return { t1, t2, caller, solo, both, removedElsewhere };
    });
    const run = (user: string) => withMembership({ client: app, userId: f.caller, tenantId: f.t1 }, (tx) => exclusive(tx, user));
    expect(await run(f.solo)).toBe(true);
    expect(await run(f.removedElsewhere)).toBe(true);
    expect(await run(f.both)).toBe(false);
    const fromT2 = await withSystemTenant(app, f.t2, "probe.test", (tx) => exclusive(tx, f.both));
    expect(fromT2).toBe(false);
  });

  it("sıfırlı üyelik → false; yalnız başka tenant'a üye → false; REMOVED → false; var olmayan kullanıcı → false; demo tenant → false", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const demo = await mkTenant(c, { isDemo: true });
      const caller = await mkUser(c);
      const zero = await mkUser(c);
      const elsewhere = await mkUser(c);
      const removedHere = await mkUser(c);
      const inDemo = await mkUser(c);
      await mkMember(c, t1, caller, { roles: ["TENANT_ADMIN"], isOwner: true });
      await mkMember(c, t2, elsewhere);
      await mkMember(c, t1, removedHere, { status: "REMOVED" });
      await mkMember(c, demo, inDemo);
      return { t1, demo, caller, zero, elsewhere, removedHere, inDemo };
    });
    const run = (user: string) => withMembership({ client: app, userId: f.caller, tenantId: f.t1 }, (tx) => exclusive(tx, user));
    expect(await run(f.zero)).toBe(false);
    expect(await run(f.elsewhere)).toBe(false);
    expect(await run(f.removedHere)).toBe(false);
    expect(await run(randomUUID())).toBe(false);
    expect(await withSystemTenant(app, f.demo, "probe.test", (tx) => exclusive(tx, f.inDemo))).toBe(false);
  });

  it("MINOR-3: çağıranın tenant'ında ACTIVE üyeliği olmayan hedefin users satırı KİLİTLENMEZ (false, bekleme yok)", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const caller = await mkUser(c);
      const stranger = await mkUser(c);
      const elsewhere = await mkUser(c);
      const removedHere = await mkUser(c);
      await mkMember(c, t1, caller, { roles: ["TENANT_ADMIN"], isOwner: true });
      await mkMember(c, t2, elsewhere);
      await mkMember(c, t1, removedHere, { status: "REMOVED" });
      return { t1, caller, stranger, elsewhere, removedHere };
    });
    const holder = await openClient(env.databaseUrlDirect);
    await holder.query("BEGIN");
    try {
      for (const u of [f.stranger, f.elsewhere, f.removedHere]) {
        // Hedefin users satırı başka bir transaction'da FOR UPDATE kilitli: işlev kilide girişseydi burada takılırdı.
        await holder.query("SELECT id FROM public.users WHERE id = $1 FOR UPDATE", [u]);
      }
      const run = (u: string) => withMembership({ client: app, userId: f.caller, tenantId: f.t1 }, (tx) => exclusive(tx, u));
      for (const u of [f.stranger, f.elsewhere, f.removedHere]) {
        const timeout = new Promise<string>((r) => setTimeout(() => r("TAKILDI"), 5000));
        const res = await Promise.race([run(u), timeout]);
        expect(res, "işlev kilitlenmiş satırda beklememeli").toBe(false);
      }
    } finally {
      await holder.query("ROLLBACK");
    }
  });

  it("tenant bağlamı yokken hata; EXECUTE yalnızca wms_app", async () => {
    const u = await admin((c) => mkUser(c));
    const e = errInfo(await caught(withUser(app, u, (tx) => exclusive(tx, u))));
    expect(e.text).toMatch(/tenant bağlamı yok/);
    await expectDenied(authRaw, "SELECT wms_probe.identity_exclusive_to_tenant($1::uuid)", [u]);
    const priv = await admin((c) =>
      c.query<{ app: boolean; auth: boolean; probe: boolean; public_: boolean }>(
        `SELECT has_function_privilege('wms_app', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS app,
                has_function_privilege('wms_auth', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS auth,
                has_function_privilege('${PROBE_ROLE}', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS probe,
                has_function_privilege('public', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS public_`,
      ),
    );
    expect(priv.rows[0]).toEqual({ app: true, auth: false, probe: true, public_: false });
  });

  it("işlev beklerken (users FOR UPDATE) yeni üyelik eklemesi ve yeniden etkinleştirme BEKLER", async () => {
    const f = await admin(async (c) => {
      const t1 = await mkTenant(c);
      const t2 = await mkTenant(c);
      const t3 = await mkTenant(c);
      const caller = await mkUser(c);
      const target = await mkUser(c);
      await mkMember(c, t1, caller, { roles: ["TENANT_ADMIN"], isOwner: true });
      await mkMember(c, t1, target);
      const dormant = await mkMember(c, t3, target, { status: "REMOVED" });
      return { t1, t2, t3, caller, target, dormant };
    });
    for (const step of ["insert", "reactivate"] as const) {
      const inside = gate();
      const hold = gate();
      let pid = 0;
      const a = withMembership({ client: app, userId: f.caller, tenantId: f.t1 }, async (tx) => {
        const r = await exclusive(tx, f.target);
        pid = await myPid(tx);
        inside.open();
        await hold.wait;
        return r;
      });
      await inside.wait;
      const b = await openClient(env.databaseUrlDirect);
      const stmt =
        step === "insert"
          ? b.query("INSERT INTO public.tenant_memberships (tenant_id, user_id) VALUES ($1, $2)", [f.t2, f.target])
          : b.query("UPDATE public.tenant_memberships SET status = 'ACTIVE', removed_at = NULL WHERE id = $1", [f.dormant]);
      let done = false;
      void stmt.then(() => (done = true), () => (done = true));
      await waitUntilBlockedBy(pid);
      expect(done, `${step}: işlev bitmeden tamamlanmamalı`).toBe(false);
      hold.open();
      expect(await a, "işlev yalnız başlangıç anındaki durumu görür").toBe(true);
      await stmt;
      // Sonraki çağrı artık başka tenant'taki ACTIVE üyeliği görür.
      expect(await withMembership({ client: app, userId: f.caller, tenantId: f.t1 }, (tx) => exclusive(tx, f.target))).toBe(false);
      // Sonraki adım için sıfırla.
      await admin((c) => c.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE user_id = $1 AND tenant_id <> $2", [f.target, f.t1]));
    }
  });
});

interface ResetScenario {
  tenant: string;
  issuerMembership: string;
  target: string;
  targetMembership: string;
  verification: string;
  other?: string;
}

async function resetScenario(o: { otherTenantMembership?: "ACTIVE" | "REMOVED"; tenant?: TenantOpts; expiresInSec?: number } = {}): Promise<ResetScenario> {
  return admin(async (c) => {
    const tenant = await mkTenant(c, o.tenant);
    const issuer = await mkUser(c);
    const target = await mkUser(c);
    const issuerMembership = await mkMember(c, tenant, issuer, { roles: ["TENANT_ADMIN"], isOwner: true });
    const targetMembership = await mkMember(c, tenant, target, { roles: ["PICKER"] });
    let other: string | undefined;
    if (o.otherTenantMembership !== undefined) {
      other = await mkTenant(c);
      await mkMember(c, other, target, { status: o.otherTenantMembership });
    }
    // Grant, üyelik eklemeleri/etkinleştirmelerinden SONRA yazılır (tetikleyici açık grant'i siler).
    // MINOR-2 bekçisi her rolde çalışır: grant, ihraç eden tenant'ın bağlamında yazılır.
    const verification = await mkVerification(c, target);
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
    await c.query(
      `INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [target, tenant, issuerMembership, verification, o.expiresInSec ?? 1800],
    );
    await c.query("COMMIT");
    return { tenant, issuerMembership, target, targetMembership, verification, ...(other === undefined ? {} : { other }) };
  });
}

const grantCount = (verification: string) =>
  admin((c) => c.query<{ g: string; v: string }>(
    `SELECT (SELECT count(*) FROM public.admin_reset_grants WHERE verification_id = $1) AS g,
            (SELECT count(*) FROM public.verifications WHERE id = $1) AS v`, [verification])).then((r) => r.rows[0]);

const consume = async (client: pg.Client, verification: string): Promise<string> => {
  const rows = await expectOk(client, "SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [verification]);
  return String((rows[0] as { r: unknown }).r);
};

describe(`wms_probe.consume_admin_reset_grant (wms_auth; target=${env.target})`, () => {
  it("grant yok → 'absent'", async () => {
    expect(await consume(authRaw, randomUUID())).toBe("absent");
  });

  it("geçerli grant → 'consumed' ve satır silindi (doğrulama kaydı kalır); ikinci çağrı 'absent'", async () => {
    const s = await resetScenario();
    // attempt() ROLLBACK eder: kalıcı tüketim için açık transaction'da çalıştırıp COMMIT ediyoruz.
    await authRaw.query("BEGIN");
    const r = await authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    await authRaw.query("COMMIT");
    expect(r.rows[0]?.r).toBe("consumed");
    expect(await grantCount(s.verification)).toEqual({ g: "0", v: "1" });
    await authRaw.query("BEGIN");
    const again = await authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    await authRaw.query("COMMIT");
    expect(again.rows[0]?.r).toBe("absent");
  });

  const invalids: [string, Parameters<typeof resetScenario>[0], (c: pg.Client, s: ResetScenario) => Promise<unknown>][] = [
    ["ihraç eden üyelik REMOVED", {}, (c, s) => c.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [s.issuerMembership])],
    ["ihraç eden rolü READ_ONLY (users.manage yok)", {}, (c, s) => c.query("UPDATE public.membership_roles SET role_key = 'READ_ONLY' WHERE membership_id = $1", [s.issuerMembership])],
    ["ihraç eden rolü PICKER", {}, (c, s) => c.query("UPDATE public.membership_roles SET role_key = 'PICKER' WHERE membership_id = $1", [s.issuerMembership])],
    ["tenant SUSPENDED", {}, (c, s) => c.query("UPDATE public.tenants SET status = 'SUSPENDED' WHERE id = $1", [s.tenant])],
    ["tenant CLOSING", {}, (c, s) => c.query("UPDATE public.tenants SET status = 'CLOSING' WHERE id = $1", [s.tenant])],
    ["tenant is_demo", {}, (c, s) => c.query("UPDATE public.tenants SET is_demo = true WHERE id = $1", [s.tenant])],
    ["hedef is_owner", {}, (c, s) => c.query("UPDATE public.tenant_memberships SET is_owner = true WHERE id = $1", [s.targetMembership])],
    ["hedefin üyeliği REMOVED", {}, (c, s) => c.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [s.targetMembership])],
    ["hedef başka tenant'ta da ACTIVE", { otherTenantMembership: "ACTIVE" }, async () => undefined],
    ["MAJOR-1: doğrulama kaydı BAŞKA kullanıcıya ait (value ≠ grant.user_id)", {}, async (c, s) => {
      const other = await mkUser(c); // gerçek ama başka bir kullanıcının sıfırlama kaydı
      await c.query("UPDATE public.verifications SET value = $2 WHERE id = $1", [s.verification, other]);
    }],
    ["MAJOR-1: doğrulama kaydı sıfırlama kaydı değil (identifier öneki)", {}, (c, s) => c.query("UPDATE public.verifications SET identifier = 'email-verification:x' WHERE id = $1", [s.verification])],
    ["süresi dolmuş grant", {}, (c, s) => c.query("UPDATE public.admin_reset_grants SET expires_at = now() - interval '1 minute' WHERE verification_id = $1", [s.verification])],
  ];
  it.each(invalids)("%s → 'invalid' ve grant silindi", async (_name, opts, mutate) => {
    const s = await resetScenario(opts);
    await admin((c) => mutate(c, s));
    expect(await grantCount(s.verification)).toEqual({ g: "1", v: "1" });
    await authRaw.query("BEGIN");
    const r = await authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    await authRaw.query("COMMIT");
    expect(r.rows[0]?.r).toBe("invalid");
    expect((await grantCount(s.verification))?.g).toBe("0");
  });

  it("B: kilit beklerken grant'in user_id'si değişirse (kilit yanlış kullanıcıda) → 'invalid', grant silinir", async () => {
    const s = await resetScenario();
    const otherUser = await admin((c) => mkUser(c));
    const mover = await openClient(env.databaseUrlDirect);
    await mover.query("BEGIN");
    const pidRow = await mover.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await mover.query("UPDATE public.admin_reset_grants SET user_id = $2 WHERE verification_id = $1", [s.verification, otherUser]);
    await authRaw.query("BEGIN");
    const consuming = authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    await waitUntilBlockedBy(Number(pidRow.rows[0]?.pid));
    await mover.query("COMMIT");
    expect((await consuming).rows[0]?.r).toBe("invalid");
    await authRaw.query("COMMIT");
    expect((await grantCount(s.verification))?.g).toBe("0");
  });

  it("hedefin başka tenant'taki üyeliği REMOVED ise tekillik sağlanır → 'consumed'", async () => {
    const s = await resetScenario({ otherTenantMembership: "REMOVED" });
    await authRaw.query("BEGIN");
    const r = await authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    await authRaw.query("COMMIT");
    expect(r.rows[0]?.r).toBe("consumed");
  });

  it("iki eşzamanlı çağrıdan yalnızca biri 'consumed', diğeri 'absent' (ikincisi birincinin commit'ini bekler)", async () => {
    const s = await resetScenario();
    const second = await openClient(authUrl);
    await authRaw.query("BEGIN");
    const pidRow = await authRaw.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const first = await authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    expect(first.rows[0]?.r).toBe("consumed");
    await second.query("BEGIN");
    let secondDone = false;
    const q2 = second.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    void q2.then(() => (secondDone = true), () => (secondDone = true));
    await waitUntilBlockedBy(Number(pidRow.rows[0]?.pid));
    expect(secondDone).toBe(false);
    await authRaw.query("COMMIT");
    expect((await q2).rows[0]?.r).toBe("absent");
    await second.query("COMMIT");
  });

  it("çağıranın transaction'ı geri alınırsa silme de geri alınır (kanca tüketimi COMMIT etmelidir)", async () => {
    const s = await resetScenario();
    expect(await consume(authRaw, s.verification)).toBe("consumed"); // attempt() ROLLBACK eder
    expect((await grantCount(s.verification))?.g).toBe("1");
  });

  it("MINOR-4: kilit sırası users → grant: tekillik işlevi users'ı tutarken consume users'ta bekler, grant satırı KİLİTSİZDİR", async () => {
    const s = await resetScenario();
    const issuerUser = await admin((c) => c.query<{ user_id: string }>("SELECT user_id FROM public.tenant_memberships WHERE id = $1", [s.issuerMembership])).then((r) => (r.rows[0] as { user_id: string }).user_id);
    const inside = gate();
    const hold = gate();
    let pid = 0;
    // A: hedefin users satırını FOR UPDATE tutar (tekillik işlevi), commit etmeden bekler.
    const a = withMembership({ client: app, userId: issuerUser, tenantId: s.tenant }, async (tx) => {
      await tx.execute<{ r: boolean }>(`SELECT wms_probe.identity_exclusive_to_tenant('${s.target}'::uuid) AS r`);
      pid = await myPid(tx);
      inside.open();
      await hold.wait;
    });
    await inside.wait;
    await authRaw.query("BEGIN");
    const consuming = authRaw.query<{ r: string }>("SELECT wms_probe.consume_admin_reset_grant($1::uuid) AS r", [s.verification]);
    let done = false;
    void consuming.then(() => (done = true), () => (done = true));
    await waitUntilBlockedBy(pid);
    expect(done, "consume, users kilidi bırakılana kadar beklemeli").toBe(false);
    // Grant satırı henüz kilitlenmemiş olmalı (users önce): NOWAIT kilit alınabilir.
    const probe = await openClient(env.databaseUrlDirect);
    await probe.query("BEGIN");
    const nowait = await probe.query("SELECT id FROM public.admin_reset_grants WHERE verification_id = $1 FOR UPDATE NOWAIT", [s.verification]);
    expect(nowait.rows).toHaveLength(1);
    await probe.query("ROLLBACK");
    hold.open();
    await a;
    expect((await consuming).rows[0]?.r).toBe("consumed");
    await authRaw.query("COMMIT");
  });

  describe("MINOR-2: admin_reset_grants INSERT bekçisi (issuing_tenant_id = bağlam; issuing_membership_id = o tenant'ın ACTIVE üyeliği)", () => {
    const insertGrant = "INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')";
    const ctxOf = (t: string): string[] => [`SELECT set_config('app.current_tenant_id', '${t}', true)`];

    async function setup(): Promise<{ tenant: string; target: string; issuer: string; removedIssuer: string; foreignIssuer: string; foreignTenant: string; verification: string }> {
      return admin(async (c) => {
        const tenant = await mkTenant(c);
        const foreignTenant = await mkTenant(c);
        const target = await mkUser(c);
        const issuerUser = await mkUser(c);
        const removedUser = await mkUser(c);
        const foreignUser = await mkUser(c);
        const issuer = await mkMember(c, tenant, issuerUser, { roles: ["TENANT_ADMIN"] });
        const removedIssuer = await mkMember(c, tenant, removedUser, { roles: ["TENANT_ADMIN"], status: "REMOVED" });
        const foreignIssuer = await mkMember(c, foreignTenant, foreignUser, { roles: ["TENANT_ADMIN"] });
        await mkMember(c, tenant, target);
        const verification = await mkVerification(c, target);
        return { tenant, target, issuer, removedIssuer, foreignIssuer, foreignTenant, verification };
      });
    }

    it("geçerli (bağlam = tenant, ACTIVE üyelik) → yazılır", async () => {
      const f = await setup();
      await expectOk(appRaw, insertGrant, [f.target, f.tenant, f.issuer, f.verification], ctxOf(f.tenant));
    });

    it("bağlam yok / bağlam başka tenant / üyelik başka tenant'ın / üyelik REMOVED / üyelik yok → bekçi hatası (42501)", async () => {
      const f = await setup();
      const cases: [string, unknown[], string[]][] = [
        ["bağlam yok", [f.target, f.tenant, f.issuer, f.verification], []],
        ["bağlam başka tenant", [f.target, f.tenant, f.issuer, f.verification], ctxOf(f.foreignTenant)],
        ["issuing_tenant_id başka tenant, üyelik de onun", [f.target, f.foreignTenant, f.foreignIssuer, f.verification], ctxOf(f.tenant)],
        ["üyelik başka tenant'ın", [f.target, f.tenant, f.foreignIssuer, f.verification], ctxOf(f.tenant)],
        ["üyelik REMOVED", [f.target, f.tenant, f.removedIssuer, f.verification], ctxOf(f.tenant)],
        ["üyelik yok", [f.target, f.tenant, randomUUID(), f.verification], ctxOf(f.tenant)],
      ];
      for (const [name, params, pre] of cases) {
        const r = await attempt(appRaw, insertGrant, params, pre);
        expect(r.ok, name).toBe(false);
        if (!r.ok) {
          expect(r.code, `${name}: ${r.message}`).toBe(INSUFFICIENT_PRIVILEGE);
          expect(r.message, name).toMatch(/admin_reset_grants_guard_issuer/);
        }
      }
    });

    it("bekçi migration rolünde de çalışır (ENABLE ALWAYS): bağlamsız INSERT reddedilir", async () => {
      const f = await setup();
      const adm = await openClient(env.databaseUrlDirect);
      const r = await attempt(adm, insertGrant, [f.target, f.tenant, f.issuer, f.verification]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/admin_reset_grants_guard_issuer/);
    });
  });

  it("wms_auth ve wms_app: admin_reset_grants üzerinde SELECT/UPDATE/DELETE → yetki hatası; wms_app INSERT serbest; wms_app EXECUTE → yetki hatası", async () => {
    const s = await resetScenario();
    for (const client of [authRaw, appRaw]) {
      await expectDenied(client, "SELECT * FROM public.admin_reset_grants");
      await expectDenied(client, "SELECT id FROM public.admin_reset_grants");
      await expectDenied(client, "DELETE FROM public.admin_reset_grants WHERE verification_id = $1", [s.verification]);
      await expectDenied(client, "UPDATE public.admin_reset_grants SET expires_at = now()");
      await expectDenied(client, "DELETE FROM public.admin_reset_grants WHERE verification_id = $1 RETURNING id", [s.verification]);
    }
    await expectDenied(authRaw, "INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at) VALUES ($1, $2, $3, $4, now())", [s.target, s.tenant, s.issuerMembership, randomUUID()]);
    await expectDenied(appRaw, "SELECT wms_probe.consume_admin_reset_grant($1::uuid)", [s.verification]);
    const v2 = await admin((c) => mkVerification(c, s.target));
    const tenantCtx = [`SELECT set_config('app.current_tenant_id', '${s.tenant}', true)`];
    await expectOk(
      appRaw,
      "INSERT INTO public.admin_reset_grants (user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')",
      [s.target, s.tenant, s.issuerMembership, v2],
      tenantCtx,
    );
    // Sunucu alanları (id, created_at) istemciden yazılamaz.
    await expectDenied(appRaw, "INSERT INTO public.admin_reset_grants (id, user_id, issuing_tenant_id, issuing_membership_id, verification_id, expires_at) VALUES ($1, $2, $3, $4, $5, now())", [randomUUID(), s.target, s.tenant, s.issuerMembership, v2], tenantCtx);
  });

  it("üyelik eklenince / yeniden etkinleşince açık grant ve doğrulama kaydı silinir; REMOVED ekleme silmez", async () => {
    const viaInsert = await resetScenario();
    const other = await admin((c) => mkTenant(c));
    await admin((c) => mkMember(c, other, viaInsert.target, { status: "REMOVED" }));
    expect(await grantCount(viaInsert.verification)).toEqual({ g: "1", v: "1" });
    const other2 = await admin((c) => mkTenant(c));
    await admin((c) => mkMember(c, other2, viaInsert.target));
    expect(await grantCount(viaInsert.verification)).toEqual({ g: "0", v: "0" });

    const viaReactivate = await resetScenario({ otherTenantMembership: "REMOVED" });
    expect(await grantCount(viaReactivate.verification)).toEqual({ g: "1", v: "1" });
    await admin((c) => c.query("UPDATE public.tenant_memberships SET status = 'ACTIVE', removed_at = NULL WHERE tenant_id = $1 AND user_id = $2", [viaReactivate.other, viaReactivate.target]));
    expect(await grantCount(viaReactivate.verification)).toEqual({ g: "0", v: "0" });
  });
});

describe(`wms_probe.invitation_for_account_creation (wms_auth; target=${env.target})`, () => {
  let tenant = "";
  let issuer = "";
  beforeAll(async () => {
    const f = await admin(async (c) => {
      const t = await mkTenant(c);
      const u = await mkUser(c);
      const m = await mkMember(c, t, u, { roles: ["TENANT_ADMIN"], isOwner: true });
      return { t, m };
    });
    tenant = f.t;
    issuer = f.m;
  });

  const call = (token: string, claim: string | null) =>
    expectOk(authRaw, "SELECT * FROM wms_probe.invitation_for_account_creation($1, $2::uuid)", [token, claim]);

  it("geçerli davet + eşleşen claim_id → yalnızca e-posta ve delivered_via", async () => {
    const claim = randomUUID();
    const inv = await admin((c) => mkInvitation(c, tenant, issuer, { claimId: claim, via: "SCREEN" }));
    const rows = await call(inv.tokenHash, claim);
    expect(rows).toEqual([{ email_normalized: inv.email, delivered_via: "SCREEN" }]);
  });

  const none: [string, (c: pg.Client, claim: string) => Promise<{ tokenHash: string }>, (claim: string) => string | null][] = [
    ["yanlış claim_id", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim }), () => randomUUID()],
    ["claim_id null", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim }), () => null],
    ["claim süresi dolmuş", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim, claimExpiresInSec: -60 }), (claim) => claim],
    ["davet süresi dolmuş", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim, expiresInSec: -60 }), (claim) => claim],
    ["davet iptal edilmiş", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim, revoked: true }), (claim) => claim],
    ["davet kabul edilmiş", (c, claim) => mkInvitation(c, tenant, issuer, { claimId: claim, accepted: true }), (claim) => claim],
  ];
  it.each(none)("%s → satır dönmez", async (_name, make, claimFor) => {
    const claim = randomUUID();
    const inv = await admin((c) => make(c, claim));
    expect(await call(inv.tokenHash, claimFor(claim))).toEqual([]);
  });

  it("bilinmeyen belirteç → satır dönmez; wms_app EXECUTE → yetki hatası; wms_auth davet tablosunu okuyamaz", async () => {
    expect(await call(randomBytes(32).toString("hex"), randomUUID())).toEqual([]);
    await expectDenied(appRaw, "SELECT * FROM wms_probe.invitation_for_account_creation($1, $2::uuid)", [randomBytes(32).toString("hex"), randomUUID()]);
    await expectDenied(authRaw, "SELECT * FROM public.invitations");
  });
});

// ---------------------------------------------------------------------------------------------
// Şema/rol katalog denetimleri
// ---------------------------------------------------------------------------------------------
describe(`wms_meta / wms_probe erişimi ve katalog (target=${env.target})`, () => {
  it("wms_app ve wms_auth: wms_meta altındaki hiçbir nesneye erişemez", async () => {
    for (const client of [appRaw, authRaw]) {
      await expectDenied(client, "SELECT * FROM wms_meta.schema_migrations");
      await expectDenied(client, "DELETE FROM wms_meta.schema_migrations");
      await expectDenied(client, "CREATE TABLE wms_meta.t103_x (a int)");
    }
  });

  it("MINOR-1: probe politikaları yalnızca SELECT ve yalnızca probe'a bağlı; kilit politikası/UPDATE yetkisi yok (users hariç); wms_app etkilenmez", async () => {
    const f = await admin(async (c) => {
      const a = await mkTenant(c);
      const b = await mkTenant(c);
      return { a, b };
    });
    await admin(async (c) => {
      const pol = await c.query<{ tablename: string; policyname: string; cmd: string; roles: string[] }>(
        `SELECT tablename, policyname, cmd, roles::text[] AS roles FROM pg_policies
          WHERE schemaname = 'public' AND 'wms_identity_probe' = ANY(roles::text[])`,
      );
      expect(pol.rows.map((p) => `${p.tablename}.${p.policyname}.${p.cmd}`).sort()).toEqual([
        "invitations.probe_select.SELECT",
        "membership_roles.probe_select.SELECT",
        "tenant_memberships.probe_select.SELECT",
        "tenants.probe_select.SELECT",
      ]);
      for (const p of pol.rows) expect(p.roles, p.policyname).toEqual(["wms_identity_probe"]);
      const priv = await c.query<Record<string, boolean>>(
        `SELECT has_any_column_privilege('wms_identity_probe', 'public.tenants', 'UPDATE') AS tenants_upd,
                has_any_column_privilege('wms_identity_probe', 'public.tenant_memberships', 'UPDATE') AS memberships_upd,
                has_any_column_privilege('wms_identity_probe', 'public.invitations', 'UPDATE') AS invitations_upd,
                has_any_column_privilege('wms_identity_probe', 'public.membership_roles', 'UPDATE') AS roles_upd,
                has_column_privilege('wms_identity_probe', 'public.users', 'id', 'UPDATE') AS users_upd,
                has_table_privilege('wms_identity_probe', 'public.tenants', 'SELECT') AS tenants_sel`,
      );
      expect(priv.rows[0]).toEqual({ tenants_upd: false, memberships_upd: false, invitations_upd: false, roles_upd: false, users_upd: true, tenants_sel: true });
    });
    // OR'lanma: probe rolü için `USING (true)` izolasyonu kaldırır (tenant bağlamı olmadan TÜM tenant'ları görür) ...
    const asProbe = await openClient(env.databaseUrlDirect);
    const seen = await attempt(asProbe, "SELECT count(*)::int AS n FROM public.tenants WHERE id = ANY($1::uuid[])", [[f.a, f.b]], [`SET LOCAL ROLE ${PROBE_ROLE}`]);
    expect(seen.ok && seen.rows[0]).toEqual({ n: 2 });
    // ... ama yalnızca okuyabilir: tenant tablosuna yazamaz (politika ve yetki yok).
    const write = await attempt(asProbe, "UPDATE public.tenants SET name = name WHERE id = $1", [f.a], [`SET LOCAL ROLE ${PROBE_ROLE}`]);
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe(INSUFFICIENT_PRIVILEGE);
    const lock = await attempt(asProbe, "SELECT id FROM public.tenants WHERE id = $1 FOR UPDATE", [f.a], [`SET LOCAL ROLE ${PROBE_ROLE}`]);
    expect(lock.ok).toBe(false);
    // wms_app için probe politikası görünmez: başka tenant bağlamıyla yalnızca kendi tenant'ı görünür.
    const appSees = await expectOk(appRaw, "SELECT id FROM public.tenants WHERE id = ANY($1::uuid[])", [[f.a, f.b]], [`SELECT set_config('app.current_tenant_id', '${f.a}', true)`]);
    expect(appSees).toEqual([{ id: f.a }]);
  });

  it("wms_probe işlevlerine yalnızca kendi EXECUTE'ları; PUBLIC ve diğer roller yok; probe CREATE yetkisi yok", async () => {
    const r = await admin((c) =>
      c.query<Record<string, boolean>>(
        `SELECT
           has_function_privilege('wms_app',  'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS app_excl,
           has_function_privilege('wms_auth', 'wms_probe.identity_exclusive_to_tenant(uuid)', 'EXECUTE') AS auth_excl,
           has_function_privilege('wms_app',  'wms_probe.consume_admin_reset_grant(uuid)', 'EXECUTE') AS app_consume,
           has_function_privilege('wms_auth', 'wms_probe.consume_admin_reset_grant(uuid)', 'EXECUTE') AS auth_consume,
           has_function_privilege('wms_app',  'wms_probe.invitation_for_account_creation(text, uuid)', 'EXECUTE') AS app_inv,
           has_function_privilege('wms_auth', 'wms_probe.invitation_for_account_creation(text, uuid)', 'EXECUTE') AS auth_inv,
           has_function_privilege('wms_app',  'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') AS app_trg,
           has_function_privilege('wms_auth', 'wms_probe.admin_reset_cleanup_on_membership()', 'EXECUTE') AS auth_trg,
           has_schema_privilege('${PROBE_ROLE}', 'wms_probe', 'CREATE') AS probe_create,
           has_schema_privilege('${PROBE_ROLE}', 'wms_probe', 'USAGE') AS probe_usage,
           has_schema_privilege('wms_app', 'wms_probe', 'USAGE') AS app_usage,
           has_schema_privilege('wms_auth', 'wms_probe', 'USAGE') AS auth_usage,
           has_schema_privilege('wms_app', 'wms_probe', 'CREATE') AS app_create,
           has_schema_privilege('wms_auth', 'wms_probe', 'CREATE') AS auth_create,
           has_schema_privilege('public', 'wms_probe', 'USAGE') AS public_usage`,
      ),
    );
    expect(r.rows[0]).toEqual({
      app_excl: true, auth_excl: false, app_consume: false, auth_consume: true, app_inv: false, auth_inv: true,
      app_trg: false, auth_trg: false, probe_create: false, probe_usage: true, app_usage: true, auth_usage: true,
      app_create: false, auth_create: false, public_usage: false,
    });
  });

  it("katalog: wms_probe işlevleri probe sahipli, SECURITY DEFINER, search_path sabit, ACL'de PUBLIC yok; demo bekçi işlevi migration rolü sahipli ve SECURITY DEFINER değil (m3)", async () => {
    const r = await admin(async (c) => {
      const funcs = await c.query<{ proname: string; owner: string; prosecdef: boolean; proconfig: string[]; acl: string[] | null }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.proacl::text[] AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wms_probe' ORDER BY 1`,
      );
      const guard = await c.query<{ owner: string; prosecdef: boolean; proconfig: string[]; me: string; src: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, current_user::text AS me, p.prosrc AS src
           FROM pg_proc p WHERE p.oid = 'public.tenancy_guard_system_reason()'::regprocedure`,
      );
      return { funcs: funcs.rows, guard: guard.rows[0] };
    });
    expect(r.funcs.map((f) => f.proname)).toEqual([
      "admin_reset_cleanup_on_membership", "consume_admin_reset_grant", "identity_exclusive_to_tenant", "invitation_for_account_creation",
    ]);
    for (const f of r.funcs) {
      expect([f.proname, f.owner, f.prosecdef, f.proconfig]).toEqual([f.proname, PROBE_ROLE, true, ["search_path=pg_catalog, pg_temp"]]);
      expect(f.acl, f.proname).not.toBeNull();
      expect((f.acl ?? []).filter((a) => a.startsWith("=")), `${f.proname}: PUBLIC`).toEqual([]);
    }
    expect(r.guard?.owner).toBe(r.guard?.me); // proowner = migration rolü
    expect(r.guard?.prosecdef).toBe(false);
    expect(r.guard?.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
    // Gövdede şema nitelikli adlar: nitelenmemiş `current_setting(` / `now(` / `FROM tenants` yok.
    expect(r.guard?.src).toContain("pg_catalog.current_setting");
    expect(r.guard?.src).toContain("public.tenants");
    expect(r.guard?.src ?? "").not.toMatch(/(?<![.\w])current_setting\(/);
  });

  it("probe üyelik denetimi (tüm pg_auth_members satırları): migration rolü INHERIT/ADMIN yok ≥1 SET; diğer üyelerde SET/INHERIT yok, wms_app/wms_auth üye değil", async () => {
    const r = await admin((c) =>
      c.query<{ member: string; me: boolean; admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
        `SELECT m.rolname AS member, (am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS me,
                am.admin_option, am.inherit_option, am.set_option
           FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member
          WHERE am.roleid = '${PROBE_ROLE}'::regrole`,
      ),
    );
    const mine = r.rows.filter((x) => x.me);
    const others = r.rows.filter((x) => !x.me);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.some((x) => x.inherit_option || x.admin_option)).toBe(false);
    expect(mine.some((x) => x.set_option)).toBe(true);
    expect(others.some((x) => x.set_option || x.inherit_option)).toBe(false);
    expect(others.map((x) => x.member)).not.toContain("wms_app");
    expect(others.map((x) => x.member)).not.toContain("wms_auth");
  });
});
