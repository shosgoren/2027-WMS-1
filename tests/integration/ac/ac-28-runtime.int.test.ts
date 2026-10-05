// AC-28 (çalışma anı kısmı) — bağımsız kabul testi (T-005c, qa-verifier).
//
// AC-28: Tenant modülünde `withTenant` dışında global istemci kullanılır → çalışma anında sorgu
// satır döndürmez / yazma reddedilir. Ham istemci (`@wms/db/internal`, uygulama rolü wms_app,
// pooler üzerinden DATABASE_URL) `withTenant` dışında kullanılır:
//   SELECT → 0 satır · INSERT → RLS ihlali (SQLSTATE assert edilir, mesaj metni değil) ·
//   UPDATE/DELETE → 0 satır etkiler.
// Pozitif kontrol: aynı tablo `withTenant` içinde tohum satırlarını gösterir (0 satır trivial değil)
// ve ham yazma denemeleri sonrası tohum değişmemiştir.
//
// Hedefe göre DALLANMAZ (compose PgBouncer ve Neon pooler'da aynı dosya). Lint kısmı:
// tests/unit/ac/ac-28-lint.test.ts. Tohum veri sentetiktir (G-09).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { withTenant } from "../../../packages/db/src/index.ts";
import {
  DB_CLIENT_SETTINGS,
  createDbClient,
  createTenantContext,
  rawDb,
  type DbClient,
} from "../../../packages/db/src/client.ts";
import { readIntEnv } from "../harness/env.ts";
import { PROBE_SEED, PROBE_TABLE, PROBE_TENANT_A, PROBE_TENANT_B, applyProbe, dropProbe } from "../fixtures/rls-probe.ts";

/** PostgreSQL `insufficient_privilege` — "new row violates row-level security policy". */
const RLS_VIOLATION_SQLSTATE = "42501";
const ARTIFACT_DIR = path.resolve(".artifacts/test-int/ac");
const NEW_ROW_ID = "a0000000-0000-4000-8000-0000000000c8";

const env = readIntEnv(process.env);
const prepare = env.prepare ?? DB_CLIENT_SETTINGS.prepare;
const T = sql.raw(PROBE_TABLE);

function sqlstateOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const evidence: Record<string, unknown> = { ac: "AC-28", target: env.target, prepare };

let client: DbClient;

/** Pozitif kontrol: `withTenant` içinde tenant'ın satırları (id + payload). */
async function rowsVia(tenant: string): Promise<{ id: string; payload: string }[]> {
  return withTenant(createTenantContext(client, tenant), (tx) =>
    tx.execute<{ id: string; payload: string }>(sql`SELECT id::text AS id, payload FROM ${T} ORDER BY id`),
  ).then((r) => [...r]);
}

function seedOf(tenant: string): { id: string; payload: string }[] {
  return PROBE_SEED.filter((r) => r.tenant_id === tenant)
    .map((r) => ({ id: r.id, payload: r.payload }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

beforeAll(async () => {
  await applyProbe(env.databaseUrlDirect);
  client = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare });
});

afterAll(async () => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(path.join(ARTIFACT_DIR, "ac-28-runtime.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await client.close();
  await dropProbe(env.databaseUrlDirect);
});

describe("AC-28 çalışma anı: withTenant dışında ham istemci", () => {
  it("@AC-28 pozitif kontrol: withTenant içinde tohum satırları görünür (0 satır trivial değil)", async () => {
    expect(await rowsVia(PROBE_TENANT_A)).toEqual(seedOf(PROBE_TENANT_A));
    expect(await rowsVia(PROBE_TENANT_B)).toEqual(seedOf(PROBE_TENANT_B));
  });

  it("@AC-28 ham istemci SELECT (transaction dışı ve bağlamsız transaction içinde) 0 satır", async () => {
    const db = rawDb(client);
    const who = await db.execute<{ u: string }>(sql`SELECT current_user AS u`);
    const plain = await db.execute<{ id: string }>(sql`SELECT id::text AS id FROM ${T}`);
    const filtered = await db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM ${T} WHERE tenant_id IN (${PROBE_TENANT_A}::uuid, ${PROBE_TENANT_B}::uuid)`,
    );
    const counted = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${T}`);
    const inTx = await db.transaction((tx) => tx.execute<{ id: string }>(sql`SELECT id::text AS id FROM ${T}`));
    evidence.select = {
      currentUser: who[0]?.u,
      plain: plain.length,
      filtered: filtered.length,
      count: counted[0]?.n,
      inTxWithoutContext: inTx.length,
    };
    expect(who[0]?.u).toBe("wms_app");
    expect(plain).toHaveLength(0);
    expect(filtered).toHaveLength(0);
    expect(counted[0]?.n).toBe(0);
    expect(inTx).toHaveLength(0);
  });

  it(`@AC-28 ham istemci INSERT RLS ihlaliyle reddedilir (SQLSTATE ${RLS_VIOLATION_SQLSTATE})`, async () => {
    const db = rawDb(client);
    let caught: unknown;
    try {
      await db.execute(sql`INSERT INTO ${T} (tenant_id, id, payload) VALUES (${PROBE_TENANT_A}::uuid, ${NEW_ROW_ID}::uuid, ${"ac28-raw-insert"})`);
    } catch (e) {
      caught = e;
    }
    evidence.insert = { rejected: caught !== undefined, sqlstate: sqlstateOf(caught) };
    expect(caught, "ham INSERT reddedilmeliydi").toBeDefined();
    expect(sqlstateOf(caught)).toBe(RLS_VIOLATION_SQLSTATE);
    // Satır yazılmadı.
    expect(await rowsVia(PROBE_TENANT_A)).toEqual(seedOf(PROBE_TENANT_A));
  });

  it("@AC-28 ham istemci UPDATE ve DELETE 0 satır etkiler; tohum değişmez", async () => {
    const db = rawDb(client);
    const upd = await db.execute(sql`UPDATE ${T} SET payload = ${"ac28-raw-update"}`);
    const updTargeted = await db.execute(
      sql`UPDATE ${T} SET payload = ${"ac28-raw-update"} WHERE tenant_id = ${PROBE_TENANT_A}::uuid`,
    );
    const del = await db.execute(sql`DELETE FROM ${T}`);
    const delTargeted = await db.execute(sql`DELETE FROM ${T} WHERE tenant_id = ${PROBE_TENANT_B}::uuid`);
    evidence.updateDelete = {
      update: upd.count,
      updateTargeted: updTargeted.count,
      delete: del.count,
      deleteTargeted: delTargeted.count,
    };
    expect(upd.count).toBe(0);
    expect(updTargeted.count).toBe(0);
    expect(del.count).toBe(0);
    expect(delTargeted.count).toBe(0);
    expect(await rowsVia(PROBE_TENANT_A)).toEqual(seedOf(PROBE_TENANT_A));
    expect(await rowsVia(PROBE_TENANT_B)).toEqual(seedOf(PROBE_TENANT_B));
  });
});
