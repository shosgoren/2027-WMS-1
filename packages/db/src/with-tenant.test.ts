// Unit: withTenant / createTenantContext / createDbClient (T-005b). Ağ erişimi YOK:
// postgres.js tembel bağlanır; transaction spy'ı sorgu gönderilmediğini kanıtlar.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DB_CLIENT_SETTINGS,
  DbClientConfigError,
  TenantContextError,
  createDbClient,
  createTenantContext,
  rawDb,
  type DbClient,
  type TenantContext,
  type TenantTx,
} from "./client.ts";
import { withTenant } from "./with-tenant.ts";

// Ulaşılamaz port: bir sorgu yanlışlıkla gönderilirse bağlantı hatası verir, sessiz geçmez.
const UNREACHABLE_URL = "postgresql://u:unit-secret-pw@127.0.0.1:1/unit";
const TENANT_A = "0b3c6a52-6f0e-4a8b-9d1e-2f4a5b6c7d8e";

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

describe("withTenant — rejects without querying", () => {
  const invalidIds: unknown[] = [
    "",
    "not-a-uuid",
    "0b3c6a526f0e4a8b9d1e2f4a5b6c7d8e",
    `${TENANT_A}'; SELECT 1; --`,
    ` ${TENANT_A}`,
    undefined,
    null,
    42,
  ];

  it.each(invalidIds)("invalid tenantId %j → TenantContextError(FORBIDDEN), no transaction", async (tenantId) => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    const fn = vi.fn(async () => "unreachable");
    const forged = Object.freeze({ tenantId, client }) as unknown as TenantContext;

    const err = await withTenant(forged, fn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TenantContextError);
    expect((err as TenantContextError).code).toBe("FORBIDDEN");
    expect((err as Error).message).toMatch(/not a UUID/);
    expect(tx).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("missing ctx → TenantContextError, no transaction", async () => {
    const fn = vi.fn(async () => "unreachable");
    await expect(withTenant(undefined as unknown as TenantContext, fn)).rejects.toBeInstanceOf(TenantContextError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("forged ctx with a valid UUID (not from createTenantContext) → rejected, no transaction", async () => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    const forged = Object.freeze({ tenantId: TENANT_A, client }) as unknown as TenantContext;

    await expect(withTenant(forged, async () => "x")).rejects.toThrow(/not created by createTenantContext/);
    expect(tx).not.toHaveBeenCalled();
  });
});

describe("withTenant — transaction-local context on the same tx", () => {
  function fakeTransaction(client: DbClient) {
    const executed: SQL[] = [];
    const fakeTx = {
      execute: vi.fn(async (q: SQL) => {
        executed.push(q);
        return [];
      }),
    } as unknown as TenantTx;
    const spy = vi
      .spyOn(rawDb(client), "transaction")
      .mockImplementation(async (cb) => cb(fakeTx as Parameters<typeof cb>[0]));
    return { fakeTx, executed, spy };
  }

  it("first statement is parameterized set_config(..., true); fn receives the same tx", async () => {
    const client = newClient();
    const { fakeTx, executed, spy } = fakeTransaction(client);
    const ctx = createTenantContext(client, TENANT_A);

    const result = await withTenant(ctx, async (tx) => {
      expect(tx).toBe(fakeTx);
      expect(executed).toHaveLength(1);
      return "done";
    });

    expect(result).toBe("done");
    expect(spy).toHaveBeenCalledTimes(1);
    const first = executed[0];
    if (first === undefined) throw new Error("set_config was not executed");
    const q = new PgDialect().sqlToQuery(first);
    expect(q.sql).toBe("SELECT set_config('app.current_tenant_id', $1, true)");
    expect(q.params).toEqual([TENANT_A]);
    expect(q.sql).not.toContain(TENANT_A);
  });

  it("error from fn propagates unchanged (not swallowed)", async () => {
    const client = newClient();
    fakeTransaction(client);
    const ctx = createTenantContext(client, TENANT_A);
    const boom = new Error("boom");

    await expect(
      withTenant(ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("createTenantContext", () => {
  it("rejects a non-UUID tenantId", () => {
    expect(() => createTenantContext(newClient(), "tenant-a")).toThrow(TenantContextError);
  });

  it("rejects a client not created by createDbClient", () => {
    expect(() => createTenantContext({ close: async () => {} } as unknown as DbClient, TENANT_A)).toThrow(
      DbClientConfigError,
    );
  });

  it("returns a frozen context", () => {
    const ctx = createTenantContext(newClient(), TENANT_A);
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("createDbClient", () => {
  it("DB_CLIENT_SETTINGS: prepare=false (A-öneri, T-005d ölçer), poolMax explicit", () => {
    expect(DB_CLIENT_SETTINGS).toEqual({ poolMax: 10, prepare: false });
    expect(Object.isFrozen(DB_CLIENT_SETTINGS)).toBe(true);
  });

  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["empty url", { url: "", poolMax: 1, prepare: false }, /url is required/],
    ["invalid url", { url: "::nope::", poolMax: 1, prepare: false }, /not a valid URL/],
    ["non-postgres scheme", { url: "mysql://u:unit-secret-pw@h/db", poolMax: 1, prepare: false }, /scheme/],
    ["poolMax 0", { url: UNREACHABLE_URL, poolMax: 0, prepare: false }, /poolMax/],
    ["poolMax missing", { url: UNREACHABLE_URL, prepare: false }, /poolMax/],
    ["prepare missing", { url: UNREACHABLE_URL, poolMax: 1 }, /prepare/],
  ];

  it.each(bad)("%s → DbClientConfigError without leaking the URL", (_name, opts, re) => {
    let err: unknown;
    try {
      createDbClient(opts as unknown as Parameters<typeof createDbClient>[0]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DbClientConfigError);
    expect((err as Error).message).toMatch(re);
    expect((err as Error).message).not.toContain("unit-secret-pw");
  });

  it("returned handle exposes no query API", () => {
    const client = newClient();
    expect(Object.keys(client)).toEqual(["close"]);
  });
});
