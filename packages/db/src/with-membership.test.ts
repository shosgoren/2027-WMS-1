// Unit: withMembership ailesi girdi doğrulaması ve SQL biçimi (T-103). Ağ erişimi YOK: sorgu gönderilmediği
// transaction spy'ıyla, SQL biçimi sahte tx ile doğrulanır. Gerçek kilit/RLS davranışı: tests/integration/with-membership.int.test.ts.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_CLIENT_SETTINGS, createDbClient, rawDb, type DbClient, type TenantTx } from "./client.ts";
import { MembershipError, lockOwners, withMembership, withNewTenant, withSystemTenant, withUser } from "./with-membership.ts";

const UNREACHABLE_URL = "postgresql://u:unit-secret-pw@127.0.0.1:1/unit";
const TENANT = "0b3c6a52-6f0e-4a8b-9d1e-2f4a5b6c7d8e";
const USER = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const MEMBERSHIP = "11111111-2222-4333-8444-555555555555";
const REQUEST = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const clients: DbClient[] = [];
function newClient(): DbClient {
  const c = createDbClient({ url: UNREACHABLE_URL, ...DB_CLIENT_SETTINGS });
  clients.push(c);
  return c;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const invalidUuids: unknown[] = ["", "slug-of-tenant", `${TENANT}'; SELECT 1; --`, ` ${TENANT}`, undefined, null, 42];

/** Sorgu metni (içinde `FOR SHARE` vb.) ve parametrelerine göre sıralı yanıt veren sahte tx. */
function fakeTx(client: DbClient, responder: (sqlText: string) => unknown[] = () => []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: vi.fn(async (q: SQL) => {
      const built = new PgDialect().sqlToQuery(q);
      queries.push({ sql: built.sql, params: built.params });
      return responder(built.sql);
    }),
  } as unknown as TenantTx;
  vi.spyOn(rawDb(client), "transaction").mockImplementation(async (cb) => cb(tx as Parameters<typeof cb>[0]));
  return { tx, queries };
}

function membershipResponder(opts: { tenantStatus?: string; membershipStatus?: string; roles?: string[]; noMembership?: boolean; noTenant?: boolean }) {
  return (q: string): unknown[] => {
    if (q.includes("FROM public.tenants")) return opts.noTenant ? [] : [{ status: opts.tenantStatus ?? "ACTIVE" }];
    if (q.includes("FROM public.tenant_memberships"))
      return opts.noMembership ? [] : [{ id: MEMBERSHIP, is_owner: false, status: opts.membershipStatus ?? "ACTIVE", roles_version: 3 }];
    if (q.includes("FROM public.membership_roles")) return (opts.roles ?? ["PICKER"]).map((role_key) => ({ role_key }));
    return [];
  };
}

describe("withMembership — girdi doğrulaması (sorgusuz ret)", () => {
  it.each(invalidUuids)("geçersiz tenantId %j → FORBIDDEN, transaction yok", async (tenantId) => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    const fn = vi.fn(async () => "unreachable");
    const err = await withMembership({ client, userId: USER, tenantId: tenantId as string }, fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipError);
    expect((err as MembershipError).code).toBe("FORBIDDEN");
    expect(tx).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(invalidUuids)("geçersiz userId %j → FORBIDDEN, transaction yok", async (userId) => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    await expect(withMembership({ client, userId: userId as string, tenantId: TENANT }, async () => "x")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tx).not.toHaveBeenCalled();
  });

  it("params eksik → FORBIDDEN", async () => {
    await expect(withMembership(undefined as never, async () => "x")).rejects.toBeInstanceOf(MembershipError);
  });

  it("withUser: geçersiz userId → sorgusuz ret", async () => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    await expect(withUser(client, "not-a-uuid", async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\t\n", undefined, null, 5])("withSystemTenant: boş/geçersiz gerekçe %j → sorgusuz ret", async (reason) => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    await expect(withSystemTenant(client, TENANT, reason as string, async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx).not.toHaveBeenCalled();
  });

  it("withSystemTenant: geçersiz tenantId → sorgusuz ret", async () => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    await expect(withSystemTenant(client, "demo", "email.send", async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx).not.toHaveBeenCalled();
  });

  it("withNewTenant: geçersiz kimlik/slug/ad → sorgusuz ret", async () => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    const ok = { userId: USER, slug: "acme", name: "Acme", creationRequestId: REQUEST };
    for (const bad of [
      { ...ok, userId: "x" },
      { ...ok, creationRequestId: "x" },
      { ...ok, slug: "" },
      { ...ok, slug: "Acme" },
      { ...ok, slug: "demo" },
      { ...ok, slug: "-acme" },
      { ...ok, slug: "acme-" },
      { ...ok, slug: "ac_me" },
      { ...ok, slug: "a".repeat(64) },
      { ...ok, name: "  " },
    ]) {
      await expect(withNewTenant(client, bad, async () => "x")).rejects.toBeInstanceOf(MembershipError);
    }
    expect(tx).not.toHaveBeenCalled();
  });

  it("lockOwners: geçersiz tenantId → sorgusuz ret", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx(client);
    await expect(lockOwners(tx, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(queries).toHaveLength(0);
  });
});

describe("withMembership — SQL biçimi ve karar tablosu (sahte tx)", () => {
  it("app.current_tenant_id ve app.current_user_id kurar (parametre), tenant ve üyelik FOR SHARE, tenant önce", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx(client, membershipResponder({ roles: ["PICKER", "COUNTER"] }));
    const result = await withMembership({ client, userId: USER, tenantId: TENANT }, async (t, m) => {
      expect(t).toBe(tx);
      expect(m).toEqual({ membershipId: MEMBERSHIP, userId: USER, tenantId: TENANT, isOwner: false, roles: ["PICKER", "COUNTER"], rolesVersion: 3 });
      return "done";
    });
    expect(result).toBe("done");
    const first = queries[0];
    expect(first?.sql).toBe("SELECT set_config('app.current_tenant_id', $1, true)");
    expect(first?.params).toEqual([TENANT]);
    const all = queries.map((q) => q.sql).join("\n");
    // T-117 Supervisor kararı: doğrulanmış üyeliğin kullanıcı kimliği de kurulur (set_config, parametre, transaction-local).
    expect(queries[1]?.sql).toBe("SELECT set_config('app.current_user_id', $1, true)");
    expect(queries[1]?.params).toEqual([USER]);
    expect(all).not.toContain("app.system_reason");
    expect(all).not.toContain(TENANT);
    expect(all).not.toContain(USER);
    const tenantIdx = queries.findIndex((q) => q.sql.includes("FROM public.tenants"));
    const memberIdx = queries.findIndex((q) => q.sql.includes("FROM public.tenant_memberships"));
    expect(tenantIdx).toBeGreaterThan(0);
    expect(memberIdx).toBeGreaterThan(tenantIdx);
    expect(queries[tenantIdx]?.sql).toMatch(/FOR SHARE\s*$/);
    expect(queries[memberIdx]?.sql).toMatch(/FOR SHARE\s*$/);
    // MINOR-6: rol satırları da FOR SHARE (rol silme/ekleme yarışı), üyelikten sonra.
    const rolesIdx = queries.findIndex((q) => q.sql.includes("FROM public.membership_roles"));
    expect(rolesIdx).toBeGreaterThan(memberIdx);
    expect(queries[rolesIdx]?.sql).toMatch(/FOR SHARE\s*$/);
  });

  const denials: [string, Parameters<typeof membershipResponder>[0], string][] = [
    ["üyelik yok", { noMembership: true }, "FORBIDDEN"],
    ["REMOVED", { membershipStatus: "REMOVED" }, "FORBIDDEN"],
    ["tenant yok", { noTenant: true }, "FORBIDDEN"],
    ["SUSPENDED", { tenantStatus: "SUSPENDED" }, "TENANT_SUSPENDED"],
    ["CLOSING", { tenantStatus: "CLOSING" }, "TENANT_CLOSING"],
    ["bilinmeyen tenant durumu", { tenantStatus: "WEIRD" }, "FORBIDDEN"],
    // Üye olmayana tenant durumu sızdırılmaz: üyelik yoksa SUSPENDED olsa da FORBIDDEN.
    ["üye değil + SUSPENDED", { noMembership: true, tenantStatus: "SUSPENDED" }, "FORBIDDEN"],
    ["REMOVED + SUSPENDED", { membershipStatus: "REMOVED", tenantStatus: "SUSPENDED" }, "FORBIDDEN"],
  ];
  it.each(denials)("%s → %s", async (_name, opts, code) => {
    const client = newClient();
    fakeTx(client, membershipResponder(opts));
    const fn = vi.fn(async () => "unreachable");
    const err = await withMembership({ client, userId: USER, tenantId: TENANT }, fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipError);
    expect((err as MembershipError).code).toBe(code);
    expect(fn).not.toHaveBeenCalled();
  });

  it("permission: allowedRoles ve fonksiyon biçimi", async () => {
    const client = newClient();
    fakeTx(client, membershipResponder({ roles: ["PICKER"] }));
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, permission: { allowedRoles: ["PICKER", "COUNTER"] } }, async () => "ok")).resolves.toBe("ok");
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, permission: { allowedRoles: ["TENANT_ADMIN"] } }, async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, permission: { allowedRoles: [] } }, async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const check = vi.fn((roles: readonly string[]) => roles.includes("PICKER"));
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, permission: check }, async () => "ok")).resolves.toBe("ok");
    expect(check).toHaveBeenCalledWith(["PICKER"]);
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, permission: () => false }, async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fn hatası AYNEN yeniden fırlatılır", async () => {
    const client = newClient();
    fakeTx(client, membershipResponder({}));
    const boom = new Error("boom");
    await expect(withMembership({ client, userId: USER, tenantId: TENANT }, async () => { throw boom; })).rejects.toBe(boom);
  });
});

describe("withUser / withSystemTenant / withNewTenant — set_config biçimi", () => {
  it("withUser yalnızca app.current_user_id kurar", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx(client);
    await withUser(client, USER, async (t) => {
      expect(t).toBe(tx);
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe("SELECT set_config('app.current_user_id', $1, true)");
    expect(queries[0]?.params).toEqual([USER]);
  });

  it("withSystemTenant tenant + system_reason kurar, sonra tenant FOR SHARE; ACTIVE değilse ret", async () => {
    const client = newClient();
    const { queries } = fakeTx(client, (q) => (q.includes("FROM public.tenants") ? [{ status: "ACTIVE" }] : []));
    await expect(withSystemTenant(client, TENANT, "email.send", async () => "ok")).resolves.toBe("ok");
    expect(queries.map((q) => q.sql).slice(0, 2)).toEqual([
      "SELECT set_config('app.current_tenant_id', $1, true)",
      "SELECT set_config('app.system_reason', $1, true)",
    ]);
    expect(queries[1]?.params).toEqual(["email.send"]);
    expect(queries[2]?.sql).toMatch(/FROM public\.tenants.*FOR SHARE/s);

    for (const [status, code] of [["SUSPENDED", "TENANT_SUSPENDED"], ["CLOSING", "TENANT_CLOSING"]] as const) {
      vi.restoreAllMocks();
      fakeTx(client, () => [{ status }]);
      await expect(withSystemTenant(client, TENANT, "email.send", async () => "x")).rejects.toMatchObject({ code });
    }
    vi.restoreAllMocks();
    fakeTx(client, () => []);
    await expect(withSystemTenant(client, TENANT, "email.send", async () => "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("withNewTenant: tenant kimliği içeride üretilir; tenant, üyelik (is_owner) ve TENANT_ADMIN rolü aynı tx'te; system_reason kurmaz", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx(client, (q) => {
      if (q.includes("INSERT INTO public.tenants")) return [{ id: "inserted" }];
      if (q.includes("INSERT INTO public.tenant_memberships")) return [{ id: MEMBERSHIP }];
      return [];
    });
    const out = await withNewTenant(client, { userId: USER, slug: "acme", name: "Acme", creationRequestId: REQUEST }, async (t, m) => {
      expect(t).toBe(tx);
      return m;
    });
    expect(out.created).toBe(true);
    expect(out.membershipId).toBe(MEMBERSHIP);
    expect(out.userId).toBe(USER);
    expect(out.tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const insertTenant = queries.find((q) => q.sql.startsWith("INSERT INTO public.tenants"));
    expect(insertTenant?.params[0]).toBe(out.tenantId);
    expect(insertTenant?.sql).toContain("ON CONFLICT (created_by_user_id, creation_request_id) DO NOTHING");
    expect(queries.map((q) => q.sql).filter((s) => s.startsWith("INSERT")).map((s) => s.split("(")[0]?.trim())).toEqual([
      "INSERT INTO public.tenants",
      "INSERT INTO public.tenant_memberships",
      "INSERT INTO public.membership_roles",
    ]);
    expect(queries.map((q) => q.sql).join("\n")).not.toContain("app.system_reason");
  });

  it("withNewTenant: aynı (kullanıcı, istek) için mevcut tenant döner (created=false); hiçbir INSERT yok", async () => {
    const client = newClient();
    const { queries } = fakeTx(client, (q) => {
      if (q.includes("FROM public.tenants")) return [{ id: TENANT, slug: "acme", name: "Acme", status: "ACTIVE" }];
      if (q.includes("FROM public.tenant_memberships")) return [{ id: MEMBERSHIP }];
      return [];
    });
    const out = await withNewTenant(client, { userId: USER, slug: "acme", name: "Acme", creationRequestId: REQUEST }, async (_t, m) => m);
    expect(out).toEqual({ tenantId: TENANT, membershipId: MEMBERSHIP, userId: USER, created: false });
    expect(queries.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
  });

  it("withNewTenant: slug çakışması → SLUG_TAKEN, PostgreSQL ayrıntısı sızmaz", async () => {
    const client = newClient();
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "tenants_slug_key"'), {
      code: "23505",
      constraint_name: "tenants_slug_key",
    });
    const wrapped = Object.assign(new Error("Failed query: INSERT INTO public.tenants ..."), { cause: pgError });
    fakeTx(client, (q) => {
      if (q.includes("INSERT INTO public.tenants")) throw wrapped;
      return [];
    });
    const err = await withNewTenant(client, { userId: USER, slug: "acme", name: "Acme", creationRequestId: REQUEST }, async () => "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipError);
    expect((err as MembershipError).code).toBe("SLUG_TAKEN");
    expect((err as MembershipError).message).not.toMatch(/tenants_slug_key|duplicate|INSERT/);
    expect((err as MembershipError).cause).toBeUndefined();
  });

  it("lockOwners FOR UPDATE ve sahip kimlikleri döner", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx(client, () => [{ id: MEMBERSHIP, user_id: USER }]);
    await expect(lockOwners(tx, TENANT)).resolves.toEqual([{ membershipId: MEMBERSHIP, userId: USER }]);
    expect(queries[0]?.sql).toMatch(/is_owner AND status = 'ACTIVE'\s+ORDER BY id\s+FOR UPDATE\s*$/);
    expect(queries[0]?.params).toEqual([TENANT]);
  });
});

describe("withMembership — timeouts seçeneği (T-213 kart eki 1)", () => {
  it("timeouts verilirse tenant/üyelik FOR SHARE okumasından ÖNCE, yalnızca set_config(true) ile kurulur", async () => {
    const client = newClient();
    const { queries } = fakeTx(client, membershipResponder({ roles: ["PICKER"] }));
    await withMembership({ client, userId: USER, tenantId: TENANT, timeouts: { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 } }, async () => "ok");
    const timeoutIdx = queries.findIndex((q) => q.sql.includes("'lock_timeout'"));
    const tenantIdx = queries.findIndex((q) => q.sql.includes("FROM public.tenants"));
    const memberIdx = queries.findIndex((q) => q.sql.includes("FROM public.tenant_memberships"));
    expect(timeoutIdx).toBe(2); // tenant ve kullanıcı bağlamından hemen sonra
    expect(timeoutIdx).toBeLessThan(tenantIdx);
    expect(timeoutIdx).toBeLessThan(memberIdx);
    expect(queries[timeoutIdx]?.sql).toContain("set_config('statement_timeout', $2, true)");
    expect(queries[timeoutIdx]?.params).toEqual(["2000ms", "10000ms"]);
  });
  it("seçeneksiz çağrıda zaman aşımı sorgusu yok (davranış değişmez)", async () => {
    const client = newClient();
    const { queries } = fakeTx(client, membershipResponder({ roles: ["PICKER"] }));
    await withMembership({ client, userId: USER, tenantId: TENANT }, async () => "ok");
    expect(queries.some((q) => q.sql.includes("lock_timeout"))).toBe(false);
  });
  it("geçersiz timeouts sorgusuz RangeError", async () => {
    const client = newClient();
    const { queries } = fakeTx(client, membershipResponder({ roles: ["PICKER"] }));
    await expect(withMembership({ client, userId: USER, tenantId: TENANT, timeouts: { lockTimeoutMs: 0, statementTimeoutMs: 1000 } }, async () => "x")).rejects.toBeInstanceOf(RangeError);
    expect(queries).toHaveLength(0);
  });
});
