// AC-05 — bağımsız kabul testi (T-005c, qa-verifier). Uygulayıcının testinden bağımsız yazıldı.
//
// AC-05: Gerçek pooler arkasında, pool 1–2'ye düşürülmüş, 2 tenant × 50 eşzamanlı istek →
// her yanıt yalnızca kendi tenant'ı; transaction dışı sorgu veri döndürmez; prepared statement
// hatası yok. Faz 0'da HTTP katmanı yok: "istek" = bir `withTenant` çağrısı (A-öneri, rapora).
//
// Hedefe göre DALLANMAZ: aynı dosya `pnpm test:int` (compose: PgBouncer transaction mode) ve
// `pnpm test:int:neon` (Neon pooler) altında değişmeden koşar. Uygulama rolü bağlantısı yalnızca
// DATABASE_URL (pooler) üzerinden; DATABASE_URL_DIRECT yalnızca sonda fikstürünün kurulumu için.
// Tohum veri sentetiktir (G-09); URL/parola loglanmaz, yalnızca maskeli host.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// drizzle-orm kökte bağımlılık değildir (pnpm katı çözüm); `packages/db`'nin kurduğu kopya
// (client.ts'nin kullandığı modülle aynı gerçek dosya) parametreli sorgu için kullanılır.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { withTenant } from "../../../packages/db/src/index.ts";
import {
  DB_CLIENT_SETTINGS,
  createDbClient,
  createTenantContext,
  rawDb,
  type DbClient,
  type TenantContext,
} from "../../../packages/db/src/client.ts";
import { maskHost, readIntEnv } from "../harness/env.ts";
import { PROBE_SEED, PROBE_TABLE, PROBE_TENANT_A, PROBE_TENANT_B, applyProbe, dropProbe } from "../fixtures/rls-probe.ts";

const CALLS_PER_TENANT = 50;
const QUERY_REPEATS = 2;
const POOL_SIZES = [1, 2] as const;
const ARTIFACT_DIR = path.resolve(".artifacts/test-int/ac");

/** Prepared statement kaynaklı SQLSTATE'ler (PostgreSQL ek A). */
const PREPARED_SQLSTATES = new Set(["26000", "42P05", "08P01"]);
const PREPARED_MESSAGE_RE = /prepared statement|unnamed portal|bind message/i;

const env = readIntEnv(process.env);
const prepare = env.prepare ?? DB_CLIENT_SETTINGS.prepare;
const prepareSource = env.prepare === undefined ? "DB_CLIENT_SETTINGS" : "INT_DB_PREPARE";
const pgbouncerPoolSize = process.env.INT_PGBOUNCER_POOL_SIZE ?? "n/a (target sağlar)";

const seedCount = (tenant: string): number => PROBE_SEED.filter((r) => r.tenant_id === tenant).length;
const seedIds = (tenant: string): string[] =>
  PROBE_SEED.filter((r) => r.tenant_id === tenant)
    .map((r) => r.id)
    .sort();

interface CapturedError {
  call: number;
  tenant: string;
  sqlstate: string | null;
  message: string;
}

/** Hata zincirinde (DrizzleQueryError.cause → PostgresError) ilk SQLSTATE. */
function sqlstateOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function messageChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return parts.join(" <- ").slice(0, 500);
}

function isPreparedError(e: CapturedError): boolean {
  return (e.sqlstate !== null && PREPARED_SQLSTATES.has(e.sqlstate)) || PREPARED_MESSAGE_RE.test(e.message);
}

/** Belirlenimci karışık sıra (sabit tohumlu LCG + Fisher–Yates): A/B çağrıları iç içe. */
function mixedOrder(perTenant: number, seed: number): string[] {
  const order = [...Array<string>(perTenant).fill(PROBE_TENANT_A), ...Array<string>(perTenant).fill(PROBE_TENANT_B)];
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  return order;
}

function writeArtifact(name: string, data: unknown): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(path.join(ARTIFACT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
}

/** Ham istemciyle (transaction dışı, bağlamsız) `n` eşzamanlı sonda okuması. */
async function rawProbeOutsideTx(client: DbClient, n: number): Promise<{ rows: number; settings: (string | null)[] }> {
  const db = rawDb(client);
  const results = await Promise.all(
    Array.from({ length: n }, async () => {
      const rows = await db.execute<{ id: string }>(sql`SELECT id::text AS id FROM ${sql.raw(PROBE_TABLE)}`);
      const setting = await db.execute<{ tenant: string | null }>(
        sql`SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant`,
      );
      return { rows: rows.length, setting: setting[0]?.tenant ?? null };
    }),
  );
  return { rows: results.reduce((a, r) => a + r.rows, 0), settings: results.map((r) => r.setting) };
}

beforeAll(async () => {
  await applyProbe(env.databaseUrlDirect);
  console.log(
    `[AC-05] target=${env.target} app=${maskHost(env.databaseUrl)} prepare=${String(prepare)} (kaynak: ${prepareSource}) ` +
      `pgbouncer_default_pool_size=${pgbouncerPoolSize}`,
  );
});

afterAll(async () => {
  await dropProbe(env.databaseUrlDirect);
});

for (const poolMax of POOL_SIZES) {
  describe(`AC-05 pool=${poolMax}`, () => {
    let client: DbClient;
    let ctx: Record<string, TenantContext>;

    beforeAll(() => {
      client = createDbClient({ url: env.databaseUrl, poolMax, prepare });
      ctx = {
        [PROBE_TENANT_A]: createTenantContext(client, PROBE_TENANT_A),
        [PROBE_TENANT_B]: createTenantContext(client, PROBE_TENANT_B),
      };
    });

    afterAll(async () => {
      await client.close();
    });

    it(`@AC-05 pool=${poolMax}: 2 tenant × ${CALLS_PER_TENANT} eşzamanlı withTenant — yalnız kendi satırları, prepared hata 0, bağlam sızmaz`, async () => {
      const order = mixedOrder(CALLS_PER_TENANT, 0x5eed + poolMax);
      const switches = order.reduce((n, t, i) => (i > 0 && order[i - 1] !== t ? n + 1 : n), 0);
      expect(order.filter((t) => t === PROBE_TENANT_A)).toHaveLength(CALLS_PER_TENANT);
      expect(order.filter((t) => t === PROBE_TENANT_B)).toHaveLength(CALLS_PER_TENANT);
      expect(switches).toBeGreaterThan(CALLS_PER_TENANT / 2); // gerçekten karışık

      const errors: CapturedError[] = [];
      let foreignRows = 0;
      let wrongCount = 0;
      let wrongSetting = 0;
      let completed = 0;

      await Promise.all(
        order.map(async (tenant, call) => {
          try {
            const runs = await withTenant(ctx[tenant] as TenantContext, async (tx) => {
              const out: { tenant_id: string; id: string }[][] = [];
              for (let i = 0; i < QUERY_REPEATS; i++) {
                // Aynı parametreli sorgu (tekrar → prepared statement yolu).
                out.push(
                  await tx.execute<{ tenant_id: string; id: string }>(
                    sql`SELECT tenant_id::text AS tenant_id, id::text AS id FROM ${sql.raw(PROBE_TABLE)} WHERE payload LIKE ${"probe-%"} ORDER BY id`,
                  ),
                );
              }
              const s = await tx.execute<{ tenant: string | null }>(
                sql`SELECT current_setting('app.current_tenant_id', true) AS tenant`,
              );
              return { out, setting: s[0]?.tenant ?? null };
            });
            if (runs.setting !== tenant) wrongSetting++;
            for (const rows of runs.out) {
              foreignRows += rows.filter((r) => r.tenant_id !== tenant).length;
              const ids = rows.map((r) => r.id).sort();
              if (JSON.stringify(ids) !== JSON.stringify(seedIds(tenant))) wrongCount++;
            }
            completed++;
          } catch (e) {
            errors.push({ call, tenant, sqlstate: sqlstateOf(e), message: messageChain(e) });
          }
        }),
      );

      const after = await rawProbeOutsideTx(client, Math.max(4, poolMax * 4));
      const preparedErrors = errors.filter(isPreparedError);
      const summary = {
        ac: "AC-05",
        target: env.target,
        poolMax,
        pgbouncerDefaultPoolSize: pgbouncerPoolSize,
        prepare,
        prepareSource,
        calls: order.length,
        completed,
        queryRepeatsPerCall: QUERY_REPEATS,
        seed: { [PROBE_TENANT_A]: seedCount(PROBE_TENANT_A), [PROBE_TENANT_B]: seedCount(PROBE_TENANT_B) },
        tenantSwitchesInOrder: switches,
        foreignRows,
        wrongCount,
        wrongSetting,
        errors: errors.length,
        preparedErrors: preparedErrors.length,
        errorSqlstates: [...new Set(errors.map((e) => e.sqlstate ?? "none"))],
        errorDetails: errors,
        outsideTxRows: after.rows,
        outsideTxSettings: after.settings,
      };
      writeArtifact(`ac-05-pool-${poolMax}.json`, summary);
      console.log(
        `[AC-05] pool=${poolMax} prepare=${String(prepare)} çağrı=${order.length} tamam=${completed} yabancı_satır=${foreignRows} ` +
          `yanlış_sayı=${wrongCount} hata=${errors.length} prepared_hata=${preparedErrors.length} ` +
          `sqlstate=${summary.errorSqlstates.join(",") || "-"} tx_dışı_satır=${after.rows}`,
      );

      expect(errors, "withTenant çağrı hataları (SQLSTATE + mesaj)").toEqual([]);
      expect(preparedErrors).toHaveLength(0);
      expect(completed).toBe(CALLS_PER_TENANT * 2);
      expect(foreignRows).toBe(0);
      expect(wrongCount).toBe(0);
      expect(wrongSetting).toBe(0);
      // Koşu sonrası: aynı havuzun bağlantılarında transaction dışı sorgu veri döndürmez.
      expect(after.rows).toBe(0);
      expect(after.settings.every((s) => s === null)).toBe(true);
    });

    it(`@AC-05 pool=${poolMax}: yarıda hata atıp geri alınan withTenant sonrası bağlamsız sorgu 0 satır`, async () => {
      const boom = new Error("ac05-intentional-abort");
      let seenInside = -1;
      await expect(
        withTenant(ctx[PROBE_TENANT_A] as TenantContext, async (tx) => {
          const rows = await tx.execute<{ id: string }>(
            sql`SELECT id::text AS id FROM ${sql.raw(PROBE_TABLE)} WHERE payload LIKE ${"probe-%"}`,
          );
          seenInside = rows.length;
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(seenInside).toBe(seedCount(PROBE_TENANT_A));

      const after = await rawProbeOutsideTx(client, Math.max(4, poolMax * 4));
      writeArtifact(`ac-05-pool-${poolMax}-abort.json`, { poolMax, prepare, seenInside, outsideTxRows: after.rows, outsideTxSettings: after.settings });
      expect(after.rows).toBe(0);
      expect(after.settings.every((s) => s === null)).toBe(true);
    });
  });
}
