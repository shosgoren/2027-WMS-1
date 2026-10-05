#!/usr/bin/env node
// `pnpm infra:smoke`: `docker compose up -d --wait` sonrası yerel altyapının duman testi (T-002d).
// Yeni npm bağımlılığı yok: SQL kontrolleri konteynerlerdeki `psql` ile `docker compose exec`
// üzerinden, HTTP kontrolleri Node'un yerleşik `fetch`'i ile yapılır. Parolalar yalnızca
// konteyner ortamında kalır; bu betik onları okumaz ve basmaz.
// Çıktı: başarısız kontrollerin nedeni + tek özet satırı. Herhangi bir FAIL → çıkış kodu 1.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_TIMEOUT_MS = 5000;

/**
 * @typedef {"pg" | "pgbouncer" | "minio" | "mailpit"} CheckName
 * @typedef {{ name: CheckName, ok: boolean, reason?: string }} CheckResult
 */

/**
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function compose(args) {
  const r = spawnSync("docker", ["compose", ...args], { cwd: ROOT, encoding: "utf8" });
  if (r.error) {
    return { ok: false, stdout: "", stderr: r.error.message };
  }
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
}

/**
 * Konteyner içinde `sh -c` ile komut çalıştırır (ortam değişkenleri konteynerinkidir).
 * @param {string} service
 * @param {string} script
 */
function execIn(service, script) {
  return compose(["exec", "-T", service, "sh", "-c", script]);
}

/**
 * `psql -At` çıktısında `SHOW CONFIG` satırlarından bir anahtarın değerini bulur
 * (sütunlar: key|value|default|changeable).
 * @param {string} output
 * @param {string} key
 * @returns {string | null}
 */
export function configValue(output, key) {
  for (const line of output.split("\n")) {
    const cols = line.trim().split("|");
    if (cols[0] === key && cols[1] !== undefined) {
      return cols[1];
    }
  }
  return null;
}

/**
 * @param {CheckResult[]} results
 * @returns {string}
 */
export function summaryLine(results) {
  const parts = results.map((r) => {
    const label = r.name === "pgbouncer" && r.ok ? "pgbouncer(transaction)" : r.name;
    return `${label} ${r.ok ? "OK" : "FAIL"}`;
  });
  return `infra: ${parts.join(" · ")}`;
}

/** @returns {CheckResult} */
function checkPostgres() {
  // Doğrudan bağlantı (migration rolü, konteyner içi soket) ile wms_app rol öznitelikleri.
  const r = execIn(
    "postgres",
    `psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'wms_app'"`,
  );
  if (!r.ok) {
    return { name: "pg", ok: false, reason: `psql başarısız: ${r.stderr}` };
  }
  const row = r.stdout.trim();
  if (row !== "f|f") {
    return {
      name: "pg",
      ok: false,
      reason: `wms_app için rolsuper|rolbypassrls beklenen "f|f", gelen "${row || "(rol yok)"}"`,
    };
  }
  return { name: "pg", ok: true };
}

/** @returns {CheckResult} */
function checkPgbouncer() {
  // 1) Uygulama yolu: PgBouncer üzerinden wms_app ile SELECT 1.
  const q = execIn(
    "postgres",
    `PGPASSWORD="$WMS_APP_PASSWORD" psql -X -A -t -v ON_ERROR_STOP=1 -h pgbouncer -p 6432 -U wms_app -d "$POSTGRES_DB" -c "SELECT 1, current_user"`,
  );
  if (!q.ok) {
    return { name: "pgbouncer", ok: false, reason: `wms_app ile SELECT 1 başarısız: ${q.stderr}` };
  }
  if (q.stdout.trim() !== "1|wms_app") {
    return { name: "pgbouncer", ok: false, reason: `SELECT 1 beklenmeyen sonuç: "${q.stdout.trim()}"` };
  }
  // 2) Yönetim konsolu: pool_mode = transaction.
  const c = execIn(
    "pgbouncer",
    `PGPASSWORD="$PGBOUNCER_ADMIN_PASSWORD" psql -X -A -t -h 127.0.0.1 -p 6432 -U pgbouncer_admin -d pgbouncer -c "SHOW CONFIG"`,
  );
  if (!c.ok) {
    return { name: "pgbouncer", ok: false, reason: `SHOW CONFIG başarısız: ${c.stderr}` };
  }
  const mode = configValue(c.stdout, "pool_mode");
  if (mode !== "transaction") {
    return { name: "pgbouncer", ok: false, reason: `pool_mode beklenen "transaction", gelen "${mode ?? "(yok)"}"` };
  }
  return { name: "pgbouncer", ok: true };
}

/**
 * `docker compose port` ile ana makinedeki adresi bulur ve URL'ye GET atar; 200 bekler.
 * @param {CheckName} name
 * @param {string} service
 * @param {number} containerPort
 * @param {string} urlPath
 * @returns {Promise<CheckResult>}
 */
async function checkHttp(name, service, containerPort, urlPath) {
  const p = compose(["port", service, String(containerPort)]);
  const hostPort = p.stdout.trim().split("\n")[0]?.split(":").pop();
  if (!p.ok || !hostPort) {
    return { name, ok: false, reason: `${service}:${containerPort} için yayımlanmış port yok: ${p.stderr}` };
  }
  const url = `http://127.0.0.1:${hostPort}${urlPath}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.status !== 200) {
      return { name, ok: false, reason: `${url} → HTTP ${res.status}` };
    }
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, reason: `${url} → ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main() {
  /** @type {CheckResult[]} */
  const results = [
    checkPostgres(),
    checkPgbouncer(),
    await checkHttp("minio", "minio", 9000, "/minio/health/live"),
    await checkHttp("mailpit", "mailpit", 8025, "/"),
  ];
  for (const r of results) {
    if (!r.ok) {
      console.error(`[${r.name}] ${r.reason ?? "bilinmeyen hata"}`);
    }
  }
  console.log(summaryLine(results));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
