// RLS sonda fikstürü (T-005b) — YALNIZCA TEST. Üretim şeması/migration DEĞİLDİR.
//
// `tenant_probe` tablosu migration rolüyle (DATABASE_URL_DIRECT, doğrudan bağlantı) kurulur ve
// kaldırılır; sahibi migration rolüdür (I-03: wms_app tablo sahibi değildir). Politika
// docs/spec/15-engineering.md §DB sözleşmesi örneğiyle aynıdır; ENABLE + FORCE RLS.
// wms_app'e yalnızca SELECT/INSERT/UPDATE/DELETE verilir.
//
// Tohum veri sentetiktir (G-09). Tohum, FORCE RLS'ten ÖNCE aynı transaction'da yazılır: FORCE
// sonrası sahip rol de politikaya tabidir ve politikası yalnızca wms_app içindir (Neon'da
// migration rolü superuser değildir).
//
// Bu dosya yalnızca DATABASE_URL_DIRECT alır; uygulama rolü bağlantısı burada kurulmaz.
import pg from "pg";
import { APP_ROLE, redactUrl } from "../harness/env.ts";

export const PROBE_TABLE = "tenant_probe";

/** Sentetik tenant kimlikleri. */
export const PROBE_TENANT_A = "a0000000-0000-4000-8000-00000000000a";
export const PROBE_TENANT_B = "b0000000-0000-4000-8000-00000000000b";

export interface ProbeRow {
  tenant_id: string;
  id: string;
  payload: string;
}

/** Sentetik tohum: A için 2, B için 1 satır. */
export const PROBE_SEED: readonly ProbeRow[] = Object.freeze([
  { tenant_id: PROBE_TENANT_A, id: "a0000000-0000-4000-8000-000000000001", payload: "probe-a-1" },
  { tenant_id: PROBE_TENANT_A, id: "a0000000-0000-4000-8000-000000000002", payload: "probe-a-2" },
  { tenant_id: PROBE_TENANT_B, id: "b0000000-0000-4000-8000-000000000001", payload: "probe-b-1" },
]);

const TENANT_EXPR = "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid";

async function withDirect<T>(directUrl: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: directUrl });
  client.on("error", (e) => console.error(`[rls-probe] connection error: ${redactUrl(e.message, directUrl)}`));
  try {
    await client.connect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`rls-probe: direct connect failed: ${redactUrl(message, directUrl)}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Sonda tablosunu (yeniden) kurar, tohumlar, RLS'i açar ve wms_app'e DML yetkisi verir. */
export async function applyProbe(directUrl: string): Promise<void> {
  await withDirect(directUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
      await c.query(
        `CREATE TABLE ${PROBE_TABLE} (
           tenant_id uuid NOT NULL,
           id uuid NOT NULL,
           payload text NOT NULL,
           PRIMARY KEY (tenant_id, id)
         )`,
      );
      for (const r of PROBE_SEED) {
        await c.query(`INSERT INTO ${PROBE_TABLE} (tenant_id, id, payload) VALUES ($1, $2, $3)`, [
          r.tenant_id,
          r.id,
          r.payload,
        ]);
      }
      await c.query(`ALTER TABLE ${PROBE_TABLE} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${PROBE_TABLE} FORCE ROW LEVEL SECURITY`);
      await c.query(
        `CREATE POLICY ${PROBE_TABLE}_tenant_scope ON ${PROBE_TABLE} FOR ALL TO ${APP_ROLE}
           USING (tenant_id = ${TENANT_EXPR})
           WITH CHECK (tenant_id = ${TENANT_EXPR})`,
      );
      await c.query(`REVOKE ALL ON ${PROBE_TABLE} FROM PUBLIC`);
      await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${APP_ROLE}`);
      await c.query("COMMIT");
    } catch (e) {
      // ROLLBACK de düşerse iki hata birlikte yükselir (hiçbiri yutulmaz, G-07).
      try {
        await c.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([e, rollbackError], "rls-probe: applyProbe failed and ROLLBACK failed");
      }
      throw e;
    }
  });
}

/** Sonda tablosunu kaldırır (yoksa sessizce geçer — idempotent temizlik). */
export async function dropProbe(directUrl: string): Promise<void> {
  await withDirect(directUrl, async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
  });
}
