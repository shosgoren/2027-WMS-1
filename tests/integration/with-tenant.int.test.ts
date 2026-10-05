// withTenant uygulayıcı duman testi (T-005b) — pooler arkasında (compose: PgBouncer transaction
// mode; neon: DATABASE_URL). AC-05/AC-28 testleri DEĞİLDİR (T-005c bağımsız yazar).
//
// Uygulama tarafı YALNIZCA DATABASE_URL (uygulama rolü, pooler) ve üretim sürücü ayarlarıyla
// (DB_CLIENT_SETTINGS; INT_DB_PREPARE yalnızca T-005d ölçümü için prepare'i geçersiz kılar)
// bağlanır. DATABASE_URL_DIRECT yalnızca sonda fikstürünün kurulumu/kaldırılması içindir.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../packages/db/src/index.ts";
import {
  DB_CLIENT_SETTINGS,
  createTenantContext,
  rawDb,
  type DbClient,
  type TenantTx,
} from "../../packages/db/src/client.ts";
import { APP_ROLE, readIntEnv, redactErrorChain, secretUrls } from "./harness/env.ts";
import { PROBE_SEED, PROBE_TABLE, PROBE_TENANT_A, PROBE_TENANT_B, applyProbe, dropProbe } from "./fixtures/rls-probe.ts";

const env = readIntEnv(process.env);

interface Observation {
  pid: number;
  tenant: string;
}

async function observe(tx: Pick<TenantTx, "execute">): Promise<Observation> {
  const rows = await tx.execute<{ pid: number; tenant: string | null }>(
    "SELECT pg_backend_pid() AS pid, current_setting('app.current_tenant_id', true) AS tenant",
  );
  const row = rows[0];
  if (row === undefined) throw new Error("observe: no row");
  return { pid: Number(row.pid), tenant: row.tenant ?? "" };
}

async function payloads(tx: TenantTx): Promise<string[]> {
  const rows = await tx.execute<{ tenant_id: string; payload: string }>(
    `SELECT tenant_id, payload FROM ${PROBE_TABLE} ORDER BY payload`,
  );
  return rows.map((r) => `${r.tenant_id}:${r.payload}`);
}

function expected(tenantId: string): string[] {
  return PROBE_SEED.filter((r) => r.tenant_id === tenantId)
    .map((r) => `${r.tenant_id}:${r.payload}`)
    .sort();
}

describe(`withTenant (target=${env.target}) — app role via pooler`, () => {
  let client: DbClient;

  beforeAll(async () => {
    await applyProbe(env.databaseUrlDirect);
    client = createDbClient({
      url: env.databaseUrl,
      poolMax: DB_CLIENT_SETTINGS.poolMax,
      prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare,
    });
  });

  afterAll(async () => {
    await client?.close();
    await dropProbe(env.databaseUrlDirect);
  });

  it(`runs as ${APP_ROLE} with the tenant set inside the transaction`, async () => {
    const ctx = createTenantContext(client, PROBE_TENANT_A);
    const r = await withTenant(ctx, async (tx) => {
      const who = await tx.execute<{ current_user: string }>("SELECT current_user");
      return { user: who[0]?.current_user, obs: await observe(tx) };
    });
    expect(r.user).toBe(APP_ROLE);
    expect(r.obs.tenant).toBe(PROBE_TENANT_A);
  });

  it("each tenant sees only its own rows", async () => {
    const a = await withTenant(createTenantContext(client, PROBE_TENANT_A), payloads);
    const b = await withTenant(createTenantContext(client, PROBE_TENANT_B), payloads);
    expect(a).toEqual(expected(PROBE_TENANT_A));
    expect(b).toEqual(expected(PROBE_TENANT_B));
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it("set_config value does not stay on the connection after the transaction", async () => {
    const inside = await withTenant(createTenantContext(client, PROBE_TENANT_A), observe);
    expect(inside.tenant).toBe(PROBE_TENANT_A);

    // Bağlamsız transaction'lar; aynı sunucu bağlantısına (pg_backend_pid) düşene kadar dener.
    // Her gözlemde bağlam boş olmalı; en az bir gözlem aynı backend'de olmalı.
    const db = rawDb(client);
    const seen: Observation[] = [];
    for (let i = 0; i < 50 && !seen.some((o) => o.pid === inside.pid); i++) {
      seen.push(await db.transaction(observe));
    }
    expect(seen.map((o) => o.tenant).every((t) => t === "")).toBe(true);
    expect(seen.some((o) => o.pid === inside.pid)).toBe(true);
  });

  it("error in fn rolls back the transaction and is rethrown unchanged", async () => {
    const ctx = createTenantContext(client, PROBE_TENANT_A);
    const boom = new Error("boom after insert");
    await expect(
      withTenant(ctx, async (tx) => {
        await tx.execute(
          `INSERT INTO ${PROBE_TABLE} (tenant_id, id, payload)
           VALUES ('${PROBE_TENANT_A}', 'a0000000-0000-4000-8000-0000000000ff', 'rolled-back')`,
        );
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await withTenant(ctx, payloads)).toEqual(expected(PROBE_TENANT_A));
  });

  it("writing another tenant's row is rejected by WITH CHECK and nothing is committed", async () => {
    const ctxA = createTenantContext(client, PROBE_TENANT_A);
    const err = await withTenant(ctxA, (tx) =>
      tx.execute(
        `INSERT INTO ${PROBE_TABLE} (tenant_id, id, payload)
         VALUES ('${PROBE_TENANT_B}', 'b0000000-0000-4000-8000-0000000000ff', 'cross-tenant')`,
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Drizzle sorgu hatasını DrizzleQueryError ile sarar; PostgreSQL hatası `cause`'dadır.
    const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
    expect(cause?.code).toBe("42501");
    // Başarısızlıkta konsola basılan metin tek maskeleme yardımcısından geçer (T-005g, G-09).
    expect(redactErrorChain(cause?.message, secretUrls(env))).toMatch(/row-level security/);
    expect(await withTenant(createTenantContext(client, PROBE_TENANT_B), payloads)).toEqual(
      expected(PROBE_TENANT_B),
    );
  });
});
