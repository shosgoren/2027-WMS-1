// Sağlık denetimi (T-129): `/api/health` için YALNIZCA salt-okunur, tenant'sız yoklamalar. Web rolü (`wms_app`) ile çalışır;
// satır içeriği okunmaz (yalnızca `SELECT 1` ve pg-boss şema sürümü sütunu, `wms_app` için `GRANT SELECT (version)` var).
// Hata ayrıntısı DÖNMEZ (bağlantı bilgisi/SQL sızmasın, G-09): çağıran yalnızca ok/fail görür, sınıf adı log'a gider.
import { sql } from "drizzle-orm";
import { rawDb, type DbClient } from "./client.ts";

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: "timeout" | "error"; readonly errorName?: string };

async function probe(run: () => Promise<unknown>, timeoutMs: number): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([run().then(() => "ok" as const), timeout]);
    return outcome === "ok" ? { ok: true } : { ok: false, reason: "timeout" };
  } catch (err) {
    return { ok: false, reason: "error", errorName: err instanceof Error ? err.name : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

/** `SELECT 1` (bağlantı + kimlik doğrulama + havuz). Zaman aşımında havuzdaki bekleyen sorgu kendi başına biter. */
export function pingDatabase(client: DbClient, timeoutMs: number): Promise<ProbeResult> {
  return probe(() => rawDb(client).execute(sql`SELECT 1`), timeoutMs);
}

/**
 * Kuyruk şeması erişimi: `pgboss.version` tablosunun `version` sütunu (şema kurulu + `wms_app` USAGE/SELECT). İş satırı
 * (`job*`) okunmaz; RLS'ten bağımsızdır. Şema yok/yetki yok → `error`.
 */
export function pingQueueSchema(client: DbClient, timeoutMs: number): Promise<ProbeResult> {
  return probe(() => rawDb(client).execute(sql`SELECT version FROM pgboss.version LIMIT 1`), timeoutMs);
}
