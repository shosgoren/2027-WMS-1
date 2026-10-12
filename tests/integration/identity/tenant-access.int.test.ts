// T-113: runTenantCommand / runTenantQuery (ADR-016 §5-6, §11; A-38, A-45). Gerçek wms_app bağlantısı + RLS.
// Fikstürler sentetiktir (G-09), rastgele UUID/e-posta; migration rolü yalnızca kurulum/temizlik içindir.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  mapAccessError,
  runTenantCommand,
  runTenantCommandById,
  runTenantQuery,
  type AccessPrincipal,
} from "../../../packages/domain/src/identity/access.ts";
import { listMyTasks, claimTask } from "../../../packages/domain/src/operations/tasks.ts";
import { leaveTenant } from "../../../packages/domain/src/identity/memberships.ts";
import { listMembers } from "../../../packages/domain/src/identity/member-queries.ts";
import { listMyActionsTodayAt } from "../../../packages/domain/src/audit/today-impl.ts";
import { PERMISSIONS, ROLE_KEYS, ROLE_PERMISSIONS, hasPermission, type Permission } from "../../../packages/domain/src/identity/permissions.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const users: string[] = [];
const tenants: string[] = [];
let app: DbClient;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: env.databaseUrlDirect });
  c.on("error", () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Fx {
  tenant: string;
  slug: string;
  user: string;
}
async function fixture(o: { role: string; status?: string; member?: "ACTIVE" | "REMOVED"; demo?: boolean }): Promise<Fx> {
  return admin(async (c) => {
    const u = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T113 fixture', $1) RETURNING id", [
      `t113-${randomBytes(6).toString("hex")}@example.test`,
    ]);
    const user = u.rows[0]!.id;
    users.push(user);
    const tenant = randomUUID();
    const slug = `t113-${randomBytes(6).toString("hex")}`;
    await c.query("INSERT INTO public.tenants (id, slug, name, status, is_demo) VALUES ($1, $2, 'T113', $3, $4)", [
      tenant,
      slug,
      o.status ?? "ACTIVE",
      o.demo ?? false,
    ]);
    tenants.push(tenant);
    const status = o.member ?? "ACTIVE";
    const m = await c.query<{ id: string }>(
      `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner, removed_at)
       VALUES ($1, $2, $3, false, CASE WHEN $3 = 'REMOVED' THEN now() END) RETURNING id`,
      [tenant, user, status],
    );
    await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, m.rows[0]!.id, o.role]);
    return { tenant, slug, user };
  });
}

const principal = (user: string, mfaVerified = true): AccessPrincipal => ({ userId: user, mfaVerified });
const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
};

beforeAll(() => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
});

afterAll(async () => {
  await app.close();
  await admin(async (c) => {
    await c.query("DELETE FROM public.membership_roles WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await c.query("DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await c.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenants]);
    await c.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [users]);
  });
}, 60_000);

describe("ROLE_PERMISSIONS (A-45)", () => {
  it("matches A-45 exactly", () => {
    expect([...ROLE_PERMISSIONS.TENANT_ADMIN].sort()).toEqual([...PERMISSIONS].sort());
    expect([...ROLE_PERMISSIONS.WAREHOUSE_MANAGER].sort()).toEqual(
      [
        "stock.view", "document.create", "document.approve", "stock.post", "reversal.create", "count_diff.approve", "audit.view",
        "tenant.access", "catalog.view", "count.perform",
      ].sort(),
    );
    expect([...ROLE_PERMISSIONS.PICKER].sort()).toEqual(["catalog.view", "stock.post", "stock.view", "tenant.access"]);
    // T-335a: kör sayım güvencesi rol düzeyinde — COUNTER stok miktarı görmez ve belge oluşturmaz.
    expect([...ROLE_PERMISSIONS.COUNTER].sort()).toEqual(["catalog.view", "count.perform", "tenant.access"]);
    expect([...ROLE_PERMISSIONS.READ_ONLY].sort()).toEqual(["catalog.view", "stock.view", "tenant.access"]);
    expect(hasPermission(["COUNTER"], "stock.view")).toBe(false);
    expect(hasPermission(["COUNTER"], "document.create")).toBe(false);
    expect(ROLE_KEYS.filter((r) => hasPermission([r], "count.perform")).sort()).toEqual(["COUNTER", "TENANT_ADMIN", "WAREHOUSE_MANAGER"]);
    expect(ROLE_KEYS.filter((r) => hasPermission([r], "tenant.access"))).toEqual([...ROLE_KEYS]);
    expect(ROLE_KEYS.filter((r) => hasPermission([r], "catalog.view"))).toEqual([...ROLE_KEYS]);
    for (const p of ["users.manage", "settings.manage", "takeout.request"] as Permission[]) {
      expect(ROLE_KEYS.filter((r) => hasPermission([r], p))).toEqual(["TENANT_ADMIN"]);
    }
    expect(hasPermission(["constructor"], "stock.view")).toBe(false);
  });
});

describe("sayımcı rolü (T-335a)", () => {
  it("COUNTER: tenant.access ve count.perform geçer; stock.view, document.create, stock.post FORBIDDEN", async () => {
    const f = await fixture({ role: "COUNTER" });
    const base = { db: app, principal: principal(f.user), tenantSlug: f.slug };
    for (const p of ["tenant.access", "catalog.view", "count.perform"] as Permission[]) {
      expect(await runTenantQuery({ ...base, permission: p }, async () => "ok")).toBe("ok");
    }
    for (const p of ["stock.view", "document.create", "stock.post"] as Permission[]) {
      expect((await failure(runTenantQuery({ ...base, permission: p }, async () => "x"))).code).toBe("FORBIDDEN");
    }
  });

  it("PICKER/READ_ONLY: count.perform FORBIDDEN, tenant.access geçer", async () => {
    for (const role of ["PICKER", "READ_ONLY"]) {
      const f = await fixture({ role });
      const base = { db: app, principal: principal(f.user), tenantSlug: f.slug };
      expect(await runTenantQuery({ ...base, permission: "tenant.access" }, async () => "ok")).toBe("ok");
      expect((await failure(runTenantQuery({ ...base, permission: "count.perform" }, async () => "x"))).code).toBe("FORBIDDEN");
    }
  });

  it("COUNTER: listMyTasks listeler, claimTask sarmalayıcıyı geçer (olmayan görev NOT_FOUND), listMembers görür, bugün yaptıklarım izin kapısını geçer", async () => {
    const f = await fixture({ role: "COUNTER" });
    const base = { db: app, principal: principal(f.user), tenantSlug: f.slug };
    expect((await listMyTasks(base)).items).toEqual([]);
    expect((await failure(claimTask(base, { taskId: randomUUID(), expectedVersion: 1 }))).code).toBe("NOT_FOUND");
    expect((await listMembers(base, { demoEmailDomain: null })).length).toBe(1);
    // fixture tenant_settings satırı içermez: izin kapısı geçilir, NOT_FOUND (FORBIDDEN değil) dönmesi yeterlidir.
    expect((await failure(listMyActionsTodayAt(base, {}, new Date()))).code).toBe("NOT_FOUND");
  });

  it("COUNTER tenant'tan ayrılabilir", async () => {
    const f = await fixture({ role: "COUNTER" });
    const r = await leaveTenant({ db: app, principal: principal(f.user), tenantSlug: f.slug });
    expect(typeof r.membershipId).toBe("string");
    // leaveTenant audit_logs'a yazar (silinemez, append-only): bu tenant/kullanıcı temizliğe alınmaz (memberships testlerindeki gibi).
    tenants.splice(tenants.indexOf(f.tenant), 1);
    users.splice(users.indexOf(f.user), 1);
  });
});

describe("runTenantCommand / runTenantQuery", () => {
  const cases: [string, Permission, Permission][] = [
    ["TENANT_ADMIN", "users.manage", "stock.view"],
    ["WAREHOUSE_MANAGER", "audit.view", "users.manage"],
    ["PICKER", "stock.post", "document.create"],
    ["COUNTER", "count.perform", "stock.view"],
    ["READ_ONLY", "stock.view", "stock.post"],
  ];
  for (const [role, allowed, denied] of cases) {
    it(`${role}: ${allowed} allowed${role === "TENANT_ADMIN" ? "" : `, ${denied} FORBIDDEN`}`, async () => {
      const f = await fixture({ role });
      const base = { db: app, principal: principal(f.user), tenantSlug: f.slug };
      const r = await runTenantCommand({ ...base, permission: allowed }, async (_tx, m) => m.roles);
      expect(r).toEqual([role]);
      expect(await runTenantQuery({ ...base, permission: allowed }, async () => "ok")).toBe("ok");
      if (role !== "TENANT_ADMIN") {
        const e = await failure(runTenantCommand({ ...base, permission: denied }, async () => "x"));
        expect(e.code).toBe("FORBIDDEN");
        expect(e.detail).toBeUndefined();
      }
    });
  }

  it("no principal -> UNAUTHENTICATED", async () => {
    const f = await fixture({ role: "READ_ONLY" });
    const e = await failure(runTenantCommand({ db: app, principal: null, tenantSlug: f.slug, permission: "stock.view" }, async () => 1));
    expect(e.code).toBe("UNAUTHENTICATED");
    expect(e.httpStatus).toBe(401);
  });

  it("another tenant's slug -> NOT_FOUND (same as nonexistent slug)", async () => {
    const mine = await fixture({ role: "READ_ONLY" });
    const other = await fixture({ role: "READ_ONLY" });
    const a = await failure(runTenantQuery({ db: app, principal: principal(mine.user), tenantSlug: other.slug, permission: "stock.view" }, async () => 1));
    const b = await failure(runTenantQuery({ db: app, principal: principal(mine.user), tenantSlug: "t113-nope", permission: "stock.view" }, async () => 1));
    expect(a.code).toBe("NOT_FOUND");
    expect(a.toBody()).toEqual(b.toBody());
  });

  it("REMOVED membership -> FORBIDDEN by id (slug path cannot resolve it: NOT_FOUND)", async () => {
    const f = await fixture({ role: "COUNTER", member: "REMOVED" });
    const byId = await failure(runTenantCommandById({ db: app, principal: principal(f.user), tenantId: f.tenant, permission: "stock.view" }, async () => 1));
    expect(byId.code).toBe("FORBIDDEN");
    const bySlug = await failure(runTenantCommand({ db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "stock.view" }, async () => 1));
    expect(bySlug.code).toBe("NOT_FOUND");
  });

  it("SUSPENDED / CLOSING tenant", async () => {
    const s = await fixture({ role: "TENANT_ADMIN", status: "SUSPENDED" });
    const c = await fixture({ role: "TENANT_ADMIN", status: "CLOSING" });
    expect((await failure(runTenantCommand({ db: app, principal: principal(s.user), tenantSlug: s.slug, permission: "stock.view" }, async () => 1))).code).toBe("TENANT_SUSPENDED");
    expect((await failure(runTenantQuery({ db: app, principal: principal(c.user), tenantSlug: c.slug, permission: "stock.view" }, async () => 1))).code).toBe("TENANT_CLOSING");
  });

  it("TENANT_ADMIN without MFA -> FORBIDDEN/MFA_REQUIRED on command AND query; demo tenant exempt", async () => {
    const f = await fixture({ role: "TENANT_ADMIN" });
    const p = principal(f.user, false);
    const cmd = await failure(runTenantCommand({ db: app, principal: p, tenantSlug: f.slug, permission: "settings.manage" }, async () => 1));
    expect([cmd.code, cmd.detail]).toEqual(["FORBIDDEN", "MFA_REQUIRED"]);
    const qry = await failure(runTenantQuery({ db: app, principal: p, tenantSlug: f.slug, permission: "stock.view" }, async () => 1));
    expect([qry.code, qry.detail]).toEqual(["FORBIDDEN", "MFA_REQUIRED"]);
    expect(qry.toBody().error.messageKey).toBe("errors.forbidden.mfa_required");
    const demo = await fixture({ role: "TENANT_ADMIN", demo: true });
    expect(await runTenantCommand({ db: app, principal: principal(demo.user, false), tenantSlug: demo.slug, permission: "settings.manage" }, async () => "ok")).toBe("ok");
    // MFA yalnızca TENANT_ADMIN için zorunlu
    const ro = await fixture({ role: "READ_ONLY" });
    expect(await runTenantQuery({ db: app, principal: principal(ro.user, false), tenantSlug: ro.slug, permission: "stock.view" }, async () => "ok")).toBe("ok");
  });

  it("recentAuth: only REAUTH_REQUIRED -> RECENT_AUTH_REQUIRED; plain UNAUTHENTICATED stays; infra error -> INTERNAL", async () => {
    const f = await fixture({ role: "TENANT_ADMIN" });
    const base = { db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "users.manage" as const };
    const reauth = await failure(runTenantCommand({ ...base, recentAuth: async () => { throw Object.assign(new Error("x"), { code: "UNAUTHENTICATED", reason: "REAUTH_REQUIRED" }); } }, async () => 1));
    expect([reauth.code, reauth.detail]).toEqual(["UNAUTHENTICATED", "RECENT_AUTH_REQUIRED"]);
    const plain = await failure(runTenantCommand({ ...base, recentAuth: async () => { throw Object.assign(new Error("x"), { code: "UNAUTHENTICATED" }); } }, async () => 1));
    expect([plain.code, plain.detail]).toEqual(["UNAUTHENTICATED", undefined]);
    const boom = new Error("boom secret");
    const infra = await failure(runTenantCommand({ ...base, recentAuth: async () => { throw boom; } }, async () => 1));
    expect(infra.code).toBe("INTERNAL");
    expect(infra.cause).toBe(boom);
    expect(JSON.stringify(infra.toBody())).not.toContain("boom");
    expect(await runTenantCommand({ ...base, recentAuth: async () => undefined }, async () => "ok")).toBe("ok");
  });

  it("recentAuth runs AFTER membership/permission/MFA checks and BEFORE the command", async () => {
    const calls: string[] = [];
    const recentAuth = async () => { calls.push("recentAuth"); };
    const f = await fixture({ role: "READ_ONLY" });
    const denied = await failure(runTenantCommand({ db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "stock.post", recentAuth }, async () => 1));
    expect(denied.code).toBe("FORBIDDEN");
    const susp = await fixture({ role: "READ_ONLY", status: "SUSPENDED" });
    expect((await failure(runTenantCommand({ db: app, principal: principal(susp.user), tenantSlug: susp.slug, permission: "stock.view", recentAuth }, async () => 1))).code).toBe("TENANT_SUSPENDED");
    const adm = await fixture({ role: "TENANT_ADMIN" });
    const mfa = await failure(runTenantCommand({ db: app, principal: principal(adm.user, false), tenantSlug: adm.slug, permission: "users.manage", recentAuth }, async () => 1));
    expect(mfa.detail).toBe("MFA_REQUIRED");
    expect(calls).toEqual([]);
    await runTenantCommand({ db: app, principal: principal(adm.user), tenantSlug: adm.slug, permission: "users.manage", recentAuth }, async () => { calls.push("fn"); });
    expect(calls).toEqual(["recentAuth", "fn"]);
  });

  it("unrecognised errors -> INTERNAL (no message/SQLSTATE in body, original in cause); permissions are frozen", async () => {
    const f = await fixture({ role: "READ_ONLY" });
    const original = Object.assign(new Error("relation \"secret_table\" does not exist"), { code: "42P01" });
    const e = await failure(runTenantQuery({ db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "stock.view" }, async () => { throw original; }));
    expect([e.code, e.httpStatus, e.retryable]).toEqual(["INTERNAL", 500, false]);
    expect(e.cause).toBe(original);
    expect(JSON.stringify(e.toBody())).not.toMatch(/secret_table|42P01/);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_KEYS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const r of ROLE_KEYS) expect(Object.isFrozen(ROLE_PERMISSIONS[r])).toBe(true);
    expect(() => (ROLE_PERMISSIONS.READ_ONLY as Permission[]).push("users.manage")).toThrow();
    expect(hasPermission(["READ_ONLY"], "users.manage")).toBe(false);
  });
});

describe("VERSION_CONFLICT (ADR-016 §11 m13)", () => {
  const pgError = (code: string) => Object.assign(new Error(`secret sql detail ${code}`), { code });

  it("forced deadlock -> VERSION_CONFLICT retryable, no raw SQLSTATE/message in body", async () => {
    const f = await fixture({ role: "PICKER" });
    const k = Math.floor(Math.random() * 1_000_000) + 1_000_000;
    let locked = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const run = (first: number, second: number) =>
      runTenantCommand({ db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "stock.post" }, async (tx) => {
        await tx.execute(`SELECT pg_advisory_xact_lock(${first})`);
        if (++locked === 2) release();
        await both;
        await tx.execute(`SELECT pg_advisory_xact_lock(${second})`);
        return "done";
      });
    const results = await Promise.allSettled([run(k, k + 1), run(k + 1, k)]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const e = rejected[0]!.reason as AppError;
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.retryable]).toEqual(["VERSION_CONFLICT", true]);
    expect(JSON.stringify(e.toBody())).not.toMatch(/40P01|deadlock|advisory/i);
  });

  it("query retries once; command never retries", async () => {
    const f = await fixture({ role: "READ_ONLY" });
    const base = { db: app, principal: principal(f.user), tenantSlug: f.slug, permission: "stock.view" as const };
    let n = 0;
    expect(await runTenantQuery(base, async () => { if (++n === 1) throw pgError("40001"); return "ok"; })).toBe("ok");
    expect(n).toBe(2);
    n = 0;
    const q = await failure(runTenantQuery(base, async () => { n++; throw pgError("40P01"); }));
    expect([q.code, q.retryable, n]).toEqual(["VERSION_CONFLICT", true, 2]);
    n = 0;
    const c = await failure(runTenantCommand(base, async () => { n++; throw pgError("40001"); }));
    expect([c.code, c.retryable, n]).toEqual(["VERSION_CONFLICT", true, 1]);
  });

  it("mapAccessError: nested cause SQLSTATE mapped; unknown errors -> INTERNAL", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: pgError("40P01") });
    expect((mapAccessError(wrapped) as AppError).code).toBe("VERSION_CONFLICT");
    const other = pgError("23505");
    const mapped = mapAccessError(other) as AppError;
    expect([mapped.code, mapped.cause]).toEqual(["INTERNAL", other]);
  });
});
