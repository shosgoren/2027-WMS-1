#!/usr/bin/env node
// T-005d — Neon gerçek pooler koşusu (`pnpm spike:neon`). YALNIZCA GitHub Actions'ta,
// `.github/workflows/neon-spike.yml` içinden koşar (ajan ortamından Neon'a ağ erişimi yok, ADR-013).
//
// Akış: (a) NEON_API_KEY / NEON_PROJECT_ID zorunlu (değer basılmaz) → (b) geçici dal
// `spike-<run_id>` + read_write uç noktası → (c) sahip rolüyle DOĞRUDAN bağlantıda `wms_app`
// (LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION, rastgele parola, hiçbir
// role üye değil) → (d) DATABASE_URL = wms_app + POOLED host, DATABASE_URL_DIRECT = sahip +
// doğrudan host → (e) `WMS_INT_TARGET=neon pnpm test:int` iki kez: üretim ayarı = KAPI koşusu,
// INT_DB_PREPARE ters = TANI koşusu → (f) finally: geçici dalı sil (başarısızsa çıkış ≠ 0).
// `--cleanup`: aynı ada sahip artık dalı siler (iş akışında `if: always()` adımı; idempotent).
//
// Neon REST API v2 (G-04, kaynak: neondatabase/website belgeleri — Context7 /neondatabase/website):
//   POST   /projects/{project_id}/branches            {branch:{name}, endpoints:[{type:"read_write"}]}
//          → branch.id, endpoints[].id|host|region_id, operations[], roles[], databases[],
//            connection_uris[].connection_parameters{database,password,role,host,pooler_host}
//   GET    /projects/{project_id}/operations/{id}     → operation.status (finished|skipped = başarı;
//          failed|error|cancelled = hata; diğerleri sürüyor)
//   GET    /projects/{project_id}/connection_uri?branch_id&database_name&role_name&pooled=false → uri
//   GET    /projects/{project_id}                     → project.region_id, project.pg_version
//   GET    /projects/{project_id}/branches            → branches[]
//   GET    /projects/{project_id}/operations          → operations[] (branch_id, status; silmeden önce bekleme)
//   DELETE /projects/{project_id}/branches/{branch_id} → operations[]
//
// SQL adımları (rol oluşturma, sürüm, pooler kanıtı) `psql` (libpq) ile yapılır: `scripts/**`
// altında PostgreSQL sürücüsü import'u AC-28 lint kuralıyla yasaktır ve yeni bağımlılık eklenmez.
// Bağlantı bilgileri psql'e yalnızca ortam değişkeniyle (PGPASSWORD vb.) verilir, argv'ye değil.
//
// Gizlilik (G-09, kart md. 4 + "Ek m7"): her gizli değer ilk elde edildiği anda Actions'ta
// `::add-mask::` ile maskelenir VE kendi maskeleyicimize eklenir. Alt süreç (test:int, psql)
// çıktısı satır satır maskelenerek konsola geçer; HAM satırda gizli değer / kimlikli postgres URL'si
// / Neon uç nokta kimliği görülürse koşu kırmızıdır (int testlerinde yakalanmayan sürücü hataları
// dahil). `.artifacts/t-005d/` (koşu kopyaları dahil) yazıldıktan sonra taranır; eşleşme → kırmızı.
// Özet yalnızca `.artifacts/t-005d/summary.{json,md}`; iş akışı yalnızca bu iki dosyayı yükler.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const NEON_API_BASE = "https://console.neon.tech/api/v2";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, ".artifacts", "t-005d");
export const INT_ARTIFACT_DIR = path.join(ROOT, ".artifacts", "test-int");
/** Uygulama rolü (repodaki sabit; sır değildir — infra/postgres/init/01-roles.sh ile aynı). */
export const APP_ROLE = "wms_app";
/** Pooler kanıtı için ardışık ayrı istemci oturumu sayısı. */
export const POOLER_PROBE_SESSIONS = 6;

/** Belge kaynakları (özete yazılır; G-04). */
export const SOURCES = Object.freeze({
  pooling: "https://neon.com/docs/connect/connection-pooling (Context7 /neondatabase/website content/docs/connect/connection-pooling.md)",
  branchesApi: "https://neon.com/docs/manage/branches (Create/Delete branch API)",
  operationsApi: "https://neon.com/docs/manage/operations (operation status)",
  sqlRoles: "https://neon.com/docs/manage/roles (SQL ile oluşturulan roller neon_superuser üyesi olmaz)",
});

// ---------------------------------------------------------------------------------------------
// Maskeleme
// ---------------------------------------------------------------------------------------------

/** Kimlik bilgili postgres URL'si (kullanıcı:parola@). */
const CREDENTIAL_URL_RE = /postgres(?:ql)?:\/\/[^\s/@:"'`<>]+:[^\s@"'`<>]+@[^\s"'`<>]*/gi;
/** Herhangi bir postgres URL'si (host içerir). */
const ANY_PG_URL_RE = /postgres(?:ql)?:\/\/[^\s"'`<>]+/gi;
/** Neon uç nokta kimliği / host'u (ör. ep-cool-darkness-123456[-pooler].c-2.<bölge>.aws.neon.tech). */
const NEON_ENDPOINT_RE = /\bep-[a-z0-9]+(?:-[a-z0-9]+){1,4}(?:\.[a-z0-9-]+)*/gi;
/** IPv4 adresi (psql/sürücü bağlantı hatalarında sunucu adresi görünür; özete düşmesin). */
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/**
 * IPv6 adresi: tam (8 grup) veya `::` sıkıştırmalı (en az bir hex grup). Saat damgaları
 * (`18:28:08`) `::` içermediği ve 8 grup olmadığı için eşleşmez.
 */
const IPV6_RE =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}\b)?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}\b/gi;
/** Maskeleyiciye eklenecek gizli değerin asgari uzunluğu (daha kısa değer anlamsız eşleşir). */
export const MIN_SECRET_LENGTH = 4;

/**
 * @typedef {{
 *   add: (value: string | null | undefined) => void,
 *   redact: (text: string) => string,
 *   leaks: (text: string) => string[],
 *   size: () => number,
 * }} Redactor
 */

/**
 * Gizli değer kümesi + genel desenler. `redact` önce bilinen değerleri (uzun olan önce; ham ve
 * URL kodlu biçim) `***` yapar, sonra kalan postgres URL'lerini `<url>`, Neon uç nokta
 * kimliklerini `<neon-endpoint>`, IPv4/IPv6 adreslerini `<ip>` yapar. `leaks` HAM metinde bulunan sızıntı TÜRLERİNİ döndürür
 * (değerleri asla).
 * @returns {Redactor}
 */
export function createRedactor() {
  /** @type {Set<string>} */
  const secrets = new Set();
  /** @type {string[]} */
  let ordered = [];
  return {
    add(value) {
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
      for (const v of [value, encodeURIComponent(value)]) secrets.add(v);
      ordered = [...secrets].sort((a, b) => b.length - a.length);
    },
    redact(text) {
      let out = text;
      for (const s of ordered) out = out.split(s).join("***");
      return out
        .replace(ANY_PG_URL_RE, "<url>")
        .replace(NEON_ENDPOINT_RE, "<neon-endpoint>")
        .replace(IPV4_RE, "<ip>")
        .replace(IPV6_RE, "<ip>");
    },
    leaks(text) {
      /** @type {string[]} */
      const kinds = [];
      if (ordered.some((s) => text.includes(s))) kinds.push("secret-value");
      if (new RegExp(CREDENTIAL_URL_RE.source, "i").test(text)) kinds.push("credential-url");
      if (new RegExp(NEON_ENDPOINT_RE.source, "i").test(text)) kinds.push("neon-endpoint");
      return kinds;
    },
    size() {
      return secrets.size;
    },
  };
}

/**
 * Gizli değeri hem maskeleyiciye ekler hem (Actions'ta) `::add-mask::` komutunu yazar.
 * Actions dışında komut YAZILMAZ (yerel konsola değer düşmesin).
 * @param {Redactor} redactor
 * @param {string | null | undefined} value
 * @param {{ env?: Record<string, string | undefined>, write?: (s: string) => void }} [opts]
 */
export function maskSecret(redactor, value, opts = {}) {
  const env = opts.env ?? process.env;
  const write = opts.write ?? ((s) => process.stdout.write(s));
  if (typeof value !== "string" || value.length === 0) return;
  redactor.add(value);
  if (env.GITHUB_ACTIONS === "true") {
    for (const line of value.split(/\r?\n/)) if (line.length > 0) write(`::add-mask::${line}\n`);
  }
}

/**
 * Akışı satır satır maskeleyerek `write`'a geçirir; ham satırda sızıntı görülürse `onLeak(tür)`.
 * Parça sınırında bölünen gizli değer kaçmasın diye yalnızca tam satırlar işlenir.
 * @param {Redactor} redactor
 * @param {(s: string) => void} write
 * @param {(kinds: string[]) => void} onLeak
 */
export function createLineFilter(redactor, write, onLeak) {
  let buf = "";
  /** @param {string} line */
  const emit = (line) => {
    const kinds = redactor.leaks(line);
    if (kinds.length > 0) onLeak(kinds);
    write(redactor.redact(line));
  };
  return {
    /** @param {string} chunk */
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, i + 1));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf.length > 0) emit(buf);
      buf = "";
    },
  };
}

/**
 * Dizindeki tüm dosyaları sızıntı için tarar; bulunan (göreli yol, tür) listesi — değer yok.
 * @param {string} dir
 * @param {Redactor} redactor
 * @returns {{ file: string, kinds: string[] }[]}
 */
export function scanDirForLeaks(dir, redactor) {
  /** @type {{ file: string, kinds: string[] }[]} */
  const found = [];
  if (!existsSync(dir)) return found;
  /** @param {string} d */
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const kinds = redactor.leaks(readFileSync(p, "utf8"));
        if (kinds.length > 0) found.push({ file: path.relative(dir, p), kinds });
      }
    }
  };
  walk(dir);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Ortam
// ---------------------------------------------------------------------------------------------

export class SpikeEnvError extends Error {
  name = "SpikeEnvError";
}

/**
 * Zorunlu girdiler. Eksik olanların yalnızca ADLARI hata mesajında yer alır.
 * @param {Record<string, string | undefined>} env
 * @returns {{ apiKey: string, projectId: string, branchName: string }}
 */
export function readSpikeEnv(env) {
  const apiKey = (env.NEON_API_KEY ?? "").trim();
  const projectId = (env.NEON_PROJECT_ID ?? "").trim();
  const missing = [...(apiKey === "" ? ["NEON_API_KEY"] : []), ...(projectId === "" ? ["NEON_PROJECT_ID"] : [])];
  if (missing.length > 0) {
    throw new SpikeEnvError(
      `missing ${missing.join(", ")} (repo sırrı NEON_API_KEY, repo değişkeni NEON_PROJECT_ID; iş akışı neon-spike.yml)`,
    );
  }
  return { apiKey, projectId, branchName: branchNameFor(env) };
}

/**
 * Geçici dal adı: `spike-<run_id>` (yeniden denemede `-<attempt>` eki); Actions dışında zaman damgası.
 * @param {Record<string, string | undefined>} env
 */
export function branchNameFor(env) {
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  const attempt = (env.GITHUB_RUN_ATTEMPT ?? "1").trim();
  if (/^[0-9]+$/.test(runId)) return attempt === "1" || attempt === "" ? `spike-${runId}` : `spike-${runId}-${attempt}`;
  return `spike-local-${Date.now()}`;
}

// ---------------------------------------------------------------------------------------------
// Neon REST API
// ---------------------------------------------------------------------------------------------

export class NeonApiError extends Error {
  name = "NeonApiError";
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const TERMINAL_OK = new Set(["finished", "skipped"]);
const TERMINAL_FAIL = new Set(["failed", "error", "cancelled"]);

/**
 * @typedef {(url: string, init: { method: string, headers: Record<string, string>, body?: string, signal: AbortSignal }) =>
 *   Promise<{ status: number, text(): Promise<string> }>} FetchLike
 * @typedef {{ id: string, status: string, action?: string }} NeonOperation
 */

/**
 * İnce Neon API istemcisi. Hata mesajında kimlik/yol değil yalnızca işlem etiketi + HTTP durumu
 * + maskelenmiş Neon mesajı yer alır.
 * @param {{
 *   apiKey: string, projectId: string, redactor: Redactor, fetchImpl?: FetchLike,
 *   sleep?: (ms: number) => Promise<unknown>, pollIntervalMs?: number, pollTimeoutMs?: number,
 *   requestTimeoutMs?: number, lockedRetries?: number,
 * }} opts
 */
export function createNeonApi(opts) {
  const {
    apiKey,
    projectId,
    redactor,
    fetchImpl = /** @type {FetchLike} */ (/** @type {unknown} */ (fetch)),
    sleep = delay,
    pollIntervalMs = 2000,
    pollTimeoutMs = 300_000,
    requestTimeoutMs = 30_000,
    lockedRetries = 10,
  } = opts;
  const base = `${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}`;

  /**
   * @param {string} label
   * @param {string} method
   * @param {string} suffix
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function request(label, method, suffix, body) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
      /** @type {{ status: number, text(): Promise<string> }} */
      let res;
      try {
        res = await fetchImpl(`${base}${suffix}`, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctrl.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new NeonApiError(`Neon API ${label}: istek başarısız: ${redactor.redact(msg)}`, 0);
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      // 423 Locked: dalda süren işlem var → bekle, yeniden dene (Neon API belgesi).
      if (res.status === 423 && attempt < lockedRetries) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        let detail = "";
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.message === "string") detail = parsed.message;
        } catch {
          detail = "";
        }
        throw new NeonApiError(
          `Neon API ${label}: HTTP ${res.status}${detail ? `: ${redactor.redact(detail).slice(0, 300)}` : ""}`,
          res.status,
        );
      }
      try {
        return text === "" ? {} : JSON.parse(text);
      } catch {
        throw new NeonApiError(`Neon API ${label}: yanıt JSON değil`, res.status);
      }
    }
  }

  /**
   * İşlemler terminal olana dek yoklar; başarısız terminal durum → hata.
   * @param {string} label
   * @param {NeonOperation[]} operations
   */
  async function waitOperations(label, operations) {
    const deadline = Date.now() + pollTimeoutMs;
    for (const op of operations) {
      let status = op.status;
      while (!TERMINAL_OK.has(status)) {
        if (TERMINAL_FAIL.has(status)) {
          throw new NeonApiError(`Neon API ${label}: işlem ${op.action ?? "?"} durumu ${status}`, 0);
        }
        if (Date.now() > deadline) {
          throw new NeonApiError(`Neon API ${label}: işlem ${op.action ?? "?"} zaman aşımı (son durum ${status})`, 0);
        }
        await sleep(pollIntervalMs);
        const r = await request(`${label}/operation`, "GET", `/operations/${encodeURIComponent(op.id)}`);
        status = String(r?.operation?.status ?? "unknown");
      }
    }
  }

  return {
    request,
    waitOperations,
    /** @returns {Promise<any>} */
    getProject: () => request("project/get", "GET", ""),
    /** @param {string} name @returns {Promise<any>} */
    createBranch: (name) =>
      request("branch/create", "POST", "/branches", { branch: { name }, endpoints: [{ type: "read_write" }] }),
    /** @returns {Promise<any[]>} */
    async listBranches() {
      const r = await request("branch/list", "GET", "/branches");
      return Array.isArray(r?.branches) ? r.branches : [];
    },
    /**
     * Dalın bekleyen (terminal olmayan) işlemleri: `GET /projects/{id}/operations` (ilk sayfa,
     * en yeni işlemler) → `branch_id` eşleşen ve durumu terminal olmayanlar.
     * @param {string} branchId
     * @returns {Promise<NeonOperation[]>}
     */
    async pendingOperations(branchId) {
      const r = await request("operation/list", "GET", "/operations");
      const ops = Array.isArray(r?.operations) ? r.operations : [];
      return ops.filter(
        (/** @type {any} */ op) =>
          op?.branch_id === branchId && typeof op?.id === "string" && !TERMINAL_OK.has(op?.status) && !TERMINAL_FAIL.has(op?.status),
      );
    },
    /**
     * Önce dalın bekleyen işlemleri (üst sınır `pollTimeoutMs`) beklenir, sonra silinir ve silme
     * işlemleri tamamlanana dek yoklanır.
     * @param {string} branchId
     */
    async deleteBranch(branchId) {
      const pending = await this.pendingOperations(branchId);
      await waitOperations("branch/pending", pending);
      const r = await request("branch/delete", "DELETE", `/branches/${encodeURIComponent(branchId)}`);
      await waitOperations("branch/delete", Array.isArray(r?.operations) ? r.operations : []);
    },
    /**
     * @param {{ branchId: string, databaseName: string, roleName: string }} q
     * @returns {Promise<string>}
     */
    async getDirectUri(q) {
      const qs = new URLSearchParams({
        branch_id: q.branchId,
        database_name: q.databaseName,
        role_name: q.roleName,
        pooled: "false",
      });
      const r = await request("connection_uri/get", "GET", `/connection_uri?${qs.toString()}`);
      if (typeof r?.uri !== "string") throw new NeonApiError("Neon API connection_uri/get: uri alanı yok", 0);
      return r.uri;
    },
  };
}

/**
 * @typedef {{
 *   branchId: string, endpointId: string, regionId: string | null,
 *   host: string, poolerHost: string, database: string, ownerRole: string, ownerPassword: string | null,
 * }} BranchConnection
 */

/**
 * Dal oluşturma yanıtından bağlantı bilgileri. `pooler_host` yoksa belgelenen `-pooler` ekiyle
 * türetilir (uç nokta kimliğinin hemen ardına).
 * @param {any} res
 * @returns {BranchConnection}
 */
export function extractConnection(res) {
  const branchId = res?.branch?.id;
  const endpoint = Array.isArray(res?.endpoints) ? res.endpoints.find((/** @type {any} */ e) => e?.type === "read_write") ?? res.endpoints[0] : undefined;
  const params = Array.isArray(res?.connection_uris) ? res.connection_uris[0]?.connection_parameters : undefined;
  const db = Array.isArray(res?.databases) ? res.databases[0] : undefined;
  const host = params?.host ?? endpoint?.host;
  const endpointId = endpoint?.id;
  const database = params?.database ?? db?.name;
  const ownerRole = params?.role ?? db?.owner_name;
  if (typeof branchId !== "string" || typeof endpointId !== "string" || typeof host !== "string") {
    throw new NeonApiError("Neon API branch/create: yanıtta branch.id / endpoints[].id / host yok", 0);
  }
  if (typeof database !== "string" || typeof ownerRole !== "string") {
    throw new NeonApiError("Neon API branch/create: yanıtta veritabanı / sahip rol adı yok", 0);
  }
  let poolerHost = params?.pooler_host;
  if (typeof poolerHost !== "string") {
    if (!host.startsWith(`${endpointId}.`)) {
      throw new NeonApiError("Neon API branch/create: pooler_host yok ve host uç nokta kimliğiyle başlamıyor", 0);
    }
    poolerHost = `${endpointId}-pooler${host.slice(endpointId.length)}`;
  }
  return {
    branchId,
    endpointId,
    regionId: typeof endpoint?.region_id === "string" ? endpoint.region_id : null,
    host,
    poolerHost,
    database,
    ownerRole,
    ownerPassword: typeof params?.password === "string" ? params.password : null,
  };
}

/**
 * Bağlantı URL'si (TLS sertifika + host doğrulamalı: `sslmode=verify-full`; hem postgres.js hem pg
 * bunu tam doğrulama olarak uygular).
 * @param {{ user: string, password: string, host: string, database: string }} c
 */
export function pgUrl(c) {
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}/${encodeURIComponent(c.database)}?sslmode=verify-full`;
}

// ---------------------------------------------------------------------------------------------
// psql
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ host: string, user: string, password: string, database: string }} PsqlTarget
 * @typedef {{ ok: boolean, stdout: string, sqlstate: string | null, error: string | null }} PsqlResult
 */

/**
 * psql VERBOSITY=verbose hata satırı: `ERROR:  42501: permission denied ...`.
 * @param {string} stderr
 * @returns {string | null}
 */
export function parsePsqlSqlstate(stderr) {
  const m = /(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(stderr);
  return m ? (m[1] ?? null) : null;
}

/**
 * SQL'i stdin'den psql'e verir; bağlantı bilgisi yalnızca ortamda (argv'de değil).
 * @param {PsqlTarget} t
 * @param {string} sql
 * @param {Redactor} redactor
 * @param {number} [timeoutMs]
 * @returns {PsqlResult}
 */
export function runPsql(t, sql, redactor, timeoutMs = 120_000) {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], {
    input: sql,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      PATH: process.env.PATH ?? "",
      // Çıktı ayrıştırıcıları (SQLSTATE, `Time:`) yerele bağlı olmasın (T-005d PR #31 MINOR-4).
      LC_ALL: "C",
      LC_MESSAGES: "C",
      PGHOST: t.host,
      PGUSER: t.user,
      PGPASSWORD: t.password,
      PGDATABASE: t.database,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGCONNECT_TIMEOUT: "60",
      PGAPPNAME: "wms-neon-spike",
    },
  });
  if (r.error) return { ok: false, stdout: "", sqlstate: null, error: redactor.redact(r.error.message) };
  const stderr = r.stderr ?? "";
  if (r.status !== 0) {
    return { ok: false, stdout: "", sqlstate: parsePsqlSqlstate(stderr), error: redactor.redact(stderr.trim()).slice(0, 500) };
  }
  return { ok: true, stdout: (r.stdout ?? "").trim(), sqlstate: null, error: null };
}

/** PostgreSQL'in varsayılan SCRAM yineleme sayısı (`scram_iterations`, PG 16+ varsayılanı 4096). */
export const SCRAM_ITERATIONS = 4096;

/**
 * RFC 5802 / RFC 7677 SCRAM-SHA-256 anahtarları:
 *   SaltedPassword = PBKDF2-HMAC-SHA-256(parola, tuz, yineleme, 32)
 *   ClientKey = HMAC(SaltedPassword, "Client Key"); StoredKey = SHA-256(ClientKey)
 *   ServerKey = HMAC(SaltedPassword, "Server Key")
 * Parola yalnızca yazdırılabilir ASCII kabul edilir: bu kümede SASLprep (RFC 4013) özdeşliktir.
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} iterations
 */
export function scramSha256Keys(password, salt, iterations) {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("SCRAM: password must be printable ASCII (SASLprep identity)");
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return { clientKey, storedKey, serverKey };
}

/**
 * PostgreSQL `pg_authid.rolpassword` SCRAM biçimi (RFC 5803; PG belgesi §pg_authid):
 * `SCRAM-SHA-256$<yineleme>:<tuz>$<StoredKey>:<ServerKey>` (tuz ve anahtarlar Base64).
 * `CREATE ROLE ... PASSWORD '<bu dize>'` sunucuya düz parola yerine özet gönderir.
 * @param {string} password
 * @param {{ salt?: Buffer, iterations?: number }} [opts]
 */
export function scramSha256Verifier(password, opts = {}) {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? SCRAM_ITERATIONS;
  const { storedKey, serverKey } = scramSha256Keys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * `wms_app` oluşturma SQL'i (compose 01-roles.sh ile aynı öznitelikler). Parola yalnızca [0-9a-f];
 * sunucuya DÜZ PAROLA GİTMEZ, istemcide üretilen SCRAM-SHA-256 özeti gider.
 * @param {string} password
 * @param {{ salt?: Buffer, iterations?: number }} [opts]
 */
export function createAppRoleSql(password, opts = {}) {
  if (!/^[0-9a-f]{32,}$/.test(password)) throw new Error("app role password must be hex");
  return appRoleSql(scramSha256Verifier(password, opts));
}

/**
 * `CREATE ROLE wms_app ... PASSWORD '<değer>'`. Değer yalnızca SCRAM özeti ya da hex parola
 * karakterlerinden oluşur (tırnak/kaçış yok).
 * @param {string} passwordValue
 */
function appRoleSql(passwordValue) {
  if (!/^[A-Za-z0-9+/=$:-]+$/.test(passwordValue)) throw new Error("app role password value has unexpected characters");
  return `CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${passwordValue}';\n`;
}

/**
 * Parolanın sunucu tarafında reddedildiğini gösteren SQLSTATE'ler: 22023 invalid_parameter_value
 * (PostgreSQL `check_password_hook` / passwordcheck'in kullandığı kod), 28P01 invalid_password.
 */
export const PASSWORD_REJECT_SQLSTATES = new Set(["22023", "28P01"]);

/**
 * Rol oluşturma hatası parolanın (ör. önceden özetlenmiş SCRAM değerinin) reddi mi? Yalnızca
 * sunucunun SQLSTATE'li ERROR'u sayılır; bağlantı hatası (SQLSTATE yok) asla.
 * @param {PsqlResult} r
 */
export function isPasswordRejection(r) {
  if (r.ok || r.sqlstate === null) return false;
  if (/connection to server/i.test(r.error ?? "")) return false;
  if (PASSWORD_REJECT_SQLSTATES.has(r.sqlstate)) return true;
  // Metin eşleşmesi dar tutulur: 42xxx (sözdizimi, yetki, çakışan rol) asla parola reddi değildir
  // ve yalnızca birincil ERROR satırına bakılır — psql'in `LINE n: … PASSWORD '***'` bağlamı ya da
  // DETAIL/HINT satırları yeniden denemeyi tetiklemez.
  if (r.sqlstate.startsWith("42")) return false;
  const primary = (r.error ?? "").split(/\r?\n/).find((l) => /\bERROR:/.test(l)) ?? "";
  return /password/i.test(primary);
}

/**
 * @typedef {{ path: "scram" | "plaintext", ok: boolean, sqlstate: string | null, error: string | null }} RoleAttempt
 * @typedef {{ ok: boolean, path: "scram" | "plaintext-retry", attempts: RoleAttempt[] }} RoleCreation
 */

/**
 * `wms_app`'i oluşturur. Önce istemcide üretilen SCRAM-SHA-256 özeti gönderilir (sunucuya düz
 * parola gitmez). Neon özetlenmiş parolayı REDDEDERSE (`isPasswordRejection`) bir kez 192 bit
 * rastgele DÜZ parolayla yeniden denenir — Supervisor kararı (2026-10-05). Gerekçe/kabul edilen
 * risk: parola koşu başına rastgeledir, yalnızca bu koşunun GEÇİCİ dalındaki role aittir, dal (ve
 * rol) koşu sonunda silinir; bağlantı TLS + tam sertifika doğrulamalıdır (verify-full); değer
 * maskelenir. Neon'un parola entropi denetimi düz parolayı görmek isteyebilir (Neon belgesi: SQL
 * ile oluşturulan rolde ≥60 bit). Başka nedenli hata (yetki, bağlantı, çakışan rol…) → yeniden
 * deneme YOK (BLOCKED).
 * @param {{
 *   direct: PsqlTarget, password: string, redactor: Redactor, mask: (v: string) => void,
 *   run?: (t: PsqlTarget, sql: string, r: Redactor) => PsqlResult, salt?: Buffer,
 * }} o
 * @returns {RoleCreation}
 */
export function createAppRole(o) {
  if (!/^[0-9a-f]{48,}$/.test(o.password)) throw new Error("app role password must be ≥192-bit hex");
  const run = o.run ?? runPsql;
  const verifier = scramSha256Verifier(o.password, o.salt ? { salt: o.salt } : {});
  // StoredKey/ServerKey çevrimdışı saldırıya/sunucu taklidine yarar: özet de gizli değer sayılır.
  o.mask(verifier);
  /** @type {RoleAttempt[]} */
  const attempts = [];
  const first = run(o.direct, appRoleSql(verifier), o.redactor);
  attempts.push({ path: "scram", ok: first.ok, sqlstate: first.sqlstate, error: first.error });
  if (first.ok) return { ok: true, path: "scram", attempts };
  if (!isPasswordRejection(first)) return { ok: false, path: "scram", attempts };
  const second = run(o.direct, appRoleSql(o.password), o.redactor);
  attempts.push({ path: "plaintext", ok: second.ok, sqlstate: second.sqlstate, error: second.error });
  return { ok: second.ok, path: "plaintext-retry", attempts };
}

export const APP_ROLE_CHECK_SQL = `SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)
FROM pg_roles r WHERE r.rolname = '${APP_ROLE}';\n`;

export const OWNER_CHECK_SQL = `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole,
  EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname = 'neon_superuser')
FROM pg_roles r WHERE r.rolname = current_user;\n`;

/** @param {string} s */
const bool = (s) => s === "t";

/**
 * `APP_ROLE_CHECK_SQL` çıktısı → beklenen özniteliklerle uyum.
 * @param {string} stdout
 */
export function parseAppRoleCheck(stdout) {
  const f = stdout.split("|");
  if (f.length !== 7) return { ok: false, detail: "beklenmeyen çıktı" };
  const attrs = {
    login: bool(f[0] ?? ""),
    superuser: bool(f[1] ?? ""),
    bypassrls: bool(f[2] ?? ""),
    createdb: bool(f[3] ?? ""),
    createrole: bool(f[4] ?? ""),
    replication: bool(f[5] ?? ""),
    memberships: Number(f[6]),
  };
  const ok =
    attrs.login && !attrs.superuser && !attrs.bypassrls && !attrs.createdb && !attrs.createrole && !attrs.replication && attrs.memberships === 0;
  return { ok, detail: attrs };
}

/** @param {string} stdout */
export function parseOwnerCheck(stdout) {
  const f = stdout.split("|");
  if (f.length !== 4) return null;
  return { superuser: bool(f[0] ?? ""), bypassrls: bool(f[1] ?? ""), createrole: bool(f[2] ?? ""), neonSuperuserMember: bool(f[3] ?? "") };
}

// ---------------------------------------------------------------------------------------------
// test:int sonuçları
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ total: number, passed: number, failed: number, status: "PASS" | "FAIL" | "YOK" }} Tally
 */

/** @param {{ status?: unknown }[]} list @returns {Tally} */
function tally(list) {
  const passed = list.filter((a) => a.status === "passed").length;
  const failed = list.filter((a) => a.status !== "passed").length;
  return { total: list.length, passed, failed, status: list.length === 0 ? "YOK" : failed === 0 ? "PASS" : "FAIL" };
}

/**
 * Vitest JSON raporundan AC-05 (pool 1, 2), AC-28 ve harness sayıları.
 * @param {any} report
 */
export function parseVitestReport(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  /** @type {{ file: string, fullName: string, status: unknown }[]} */
  const all = [];
  for (const f of files) {
    const file = String(f?.name ?? "").replaceAll("\\", "/");
    for (const a of Array.isArray(f?.assertionResults) ? f.assertionResults : []) {
      all.push({ file, fullName: String(a?.fullName ?? a?.title ?? ""), status: a?.status });
    }
  }
  return {
    total: tally(all),
    ac05Pool1: tally(all.filter((a) => a.fullName.includes("@AC-05 pool=1"))),
    ac05Pool2: tally(all.filter((a) => a.fullName.includes("@AC-05 pool=2"))),
    ac28: tally(all.filter((a) => a.fullName.includes("@AC-28"))),
    harness: tally(all.filter((a) => /\/tests\/integration\/harness\//.test(a.file))),
    fileErrors: files.filter((/** @type {any} */ f) => f?.status === "failed" && (!Array.isArray(f?.assertionResults) || f.assertionResults.length === 0)).length,
  };
}

/**
 * AC-05 artefaktından özet alanları (hata metinleri DEĞİL; yalnızca sayılar ve SQLSTATE'ler).
 * @param {any} a
 */
export function pickAc05(a) {
  if (a === null || typeof a !== "object") return null;
  return {
    prepare: a.prepare,
    prepareSource: a.prepareSource,
    calls: a.calls,
    completed: a.completed,
    foreignRows: a.foreignRows,
    wrongCount: a.wrongCount,
    errors: a.errors,
    preparedErrors: a.preparedErrors,
    errorSqlstates: Array.isArray(a.errorSqlstates) ? a.errorSqlstates.filter((/** @type {unknown} */ s) => typeof s === "string" && /^([0-9A-Z]{5}|none)$/.test(s)) : [],
    outsideTxRows: a.outsideTxRows,
  };
}

/**
 * Kapı koşusu geçti mi: süreç 0, AC-05 pool 1 + pool 2, AC-28, harness PASS, sızıntı yok.
 * @param {{ exitCode: number | null, results: ReturnType<typeof parseVitestReport> | null, leakLines: number }} run
 */
export function gatePassed(run) {
  const r = run.results;
  return (
    run.exitCode === 0 &&
    run.leakLines === 0 &&
    r !== null &&
    r.fileErrors === 0 &&
    [r.ac05Pool1, r.ac05Pool2, r.ac28, r.harness].every((t) => t.status === "PASS")
  );
}

// ---------------------------------------------------------------------------------------------
// Özet
// ---------------------------------------------------------------------------------------------

/**
 * Özet nesnesi. Girdideki hiçbir alan URL/host/kullanıcı/parola taşımaz; yine de son çıktı
 * maskeleyiciden geçer ve sızıntı varsa `leaks` doludur (çağıran kırmızı yapar).
 * @param {any} d
 */
export function buildSummary(d) {
  const gate = d.gate ?? null;
  const diag = d.diag ?? null;
  const observed = d.pooler?.observed === true;
  return {
    task: "T-005d",
    date: d.date,
    result: d.result,
    blocked: d.blocked ?? null,
    adr004: {
      region: { value: d.region ?? "gözlenemedi", source: "Neon API GET /projects/{id} → project.region_id", question: "Q-01" },
      pooler: {
        type: "PgBouncer, pool_mode=transaction (belge)",
        version: "gözlenemedi (Neon PgBouncer sürümünü yayımlamıyor; istemciden sorgulanamıyor)",
        source: SOURCES.pooling,
        evidence: d.pooler ?? null,
        a01: observed ? "teyit (belge + çoklama gözlendi; sürüm gözlenemedi)" : "kısmi: belgeye dayanır, çoklama gözlenemedi",
        question: "Q-02",
      },
      postgres: {
        projectPgVersion: d.projectPgVersion ?? "gözlenemedi",
        serverVersionPooled: d.serverVersionPooled ?? "gözlenemedi",
        serverVersionDirect: d.serverVersionDirect ?? "gözlenemedi",
        question: "Q-05",
      },
      driver: { name: "postgres (postgres.js)", version: d.driverVersion ?? "gözlenemedi", question: "Q-03" },
      drizzle: { version: d.drizzleVersion ?? "gözlenemedi", question: "Q-03" },
      preparedStatements: {
        production: gate?.prepare ?? null,
        gateRun: gate ? { prepare: gate.prepare, pool1: gate.ac05?.pool1 ?? null, pool2: gate.ac05?.pool2 ?? null } : "çalıştırılmadı",
        diagnosticRun: diag ? { prepare: diag.prepare, pool1: diag.ac05?.pool1 ?? null, pool2: diag.ac05?.pool2 ?? null } : "çalıştırılmadı",
        poolerSetting: "max_prepared_statements=1000 (belge; kullanıcı ayarlayamaz)",
        source: SOURCES.pooling,
        question: "Q-04",
      },
      directConnection: {
        method: "uç noktanın -pooler eki OLMAYAN host'u + dal sahibi rol (dal oluşturma yanıtı)",
        roleCreated: d.appRole ?? "çalıştırılmadı",
        owner: d.owner ?? "gözlenemedi",
        migrationRoleWorks: d.migrationRoleWorks ?? "gözlenemedi",
        source: SOURCES.sqlRoles,
        question: "Q-06",
      },
      run: { date: d.date, result: d.result, artifact: ".artifacts/t-005d/summary.md" },
    },
    runs: {
      gate: gate ? runView(gate) : "çalıştırılmadı",
      diagnostic: diag ? runView(diag) : "çalıştırılmadı",
    },
    notes: [
      "AC-05 'pool 1–2': Neon PgBouncer default_pool_size = 0.9 × max_connections ve kullanıcı ayarlayamaz (belge). " +
        "Bu koşuda pool 1–2 YALNIZCA istemci havuzuyla (postgres.js max) uygulanmıştır; sunucu tarafı havuz boyutu kontrolümüzde değildir. AC metni değiştirilmedi; yorum Supervisor'a.",
      "Tanı koşusu INT_DB_PREPARE'i üretim ayarının tersine çevirir; sonucu bilgi amaçlıdır, kapıyı belirlemez.",
    ],
    latency: d.latency ?? "çalıştırılmadı",
    leakCheck: d.leakCheck ?? null,
    cleanup: d.cleanup ?? null,
  };
}

/** @param {any} r */
function runView(r) {
  return {
    prepare: r.prepare,
    exitCode: r.exitCode,
    status: r.status,
    tests: r.results ?? null,
    ac05: r.ac05 ?? null,
    leakLines: r.leakLines,
    timing: r.timing ?? null,
  };
}

/**
 * Markdown tablo hücresi: nesne → JSON; `|` kaçışlanır, satır sonları boşluk olur (çok satırlı
 * psql hata metni tabloyu bozmasın).
 * @param {unknown} v
 */
export function cell(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return String(s).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** @param {Tally | null | undefined} t */
const tl = (t) => (t ? `${t.status} (${t.passed}/${t.total})` : "-");

/** @param {any} p */
const prep = (p) =>
  p && typeof p === "object"
    ? `hata=${p.errors} prepared_hata=${p.preparedErrors} sqlstate=${(p.errorSqlstates ?? []).join(",") || "-"} çağrı=${p.calls} tamam=${p.completed} yabancı_satır=${p.foreignRows} tx_dışı_satır=${p.outsideTxRows}`
    : "-";

/**
 * Markdown özet (ADR-004 tablosunun 8 alanı + koşular + notlar).
 * @param {ReturnType<typeof buildSummary>} s
 */
export function renderSummaryMd(s) {
  const a = s.adr004;
  /** @param {any} run @param {string} name */
  const runRows = (run, name) =>
    typeof run === "string"
      ? [`| ${name} | ${run} | - | - | - | - |`]
      : [
          `| ${name} | prepare=${String(run.prepare)} · çıkış=${run.exitCode} · **${run.status}** | ${tl(run.tests?.ac05Pool1)} | ${tl(run.tests?.ac05Pool2)} | ${tl(run.tests?.ac28)} | ${tl(run.tests?.harness)} |`,
        ];
  const pp = a.preparedStatements;
  /** @param {any} r */
  const ppRun = (r) => (typeof r === "string" ? r : `prepare=${String(r.prepare)}; pool1: ${prep(r.pool1)}; pool2: ${prep(r.pool2)}`);
  const ev = a.pooler.evidence;
  const evText = ev
    ? `${ev.sessions} ayrı istemci oturumu → ${ev.distinctBackendPids} farklı sunucu PID'i (doğrudan kontrol: ${ev.directSessions} oturum → ${ev.directDistinctBackendPids}); çoklama gözlendi: ${ev.observed ? "evet" : "hayır"}`
    : "gözlenemedi";
  const dc = a.directConnection;
  const lines = [
    `# T-005d — Neon pooler koşusu özeti`,
    ``,
    `- Tarih: ${s.date}`,
    `- Sonuç: **${s.result}**${s.blocked ? ` — BLOCKED: ${s.blocked}` : ""}`,
    ``,
    `## ADR-004 alanları`,
    ``,
    `| Alan | Değer | Soru |`,
    `|---|---|---|`,
    `| Neon bölgesi | ${a.region.value} (kaynak: ${a.region.source}) | Q-01 |`,
    `| Pooler türü ve sürümü | ${a.pooler.type}; sürüm: ${a.pooler.version}; kanıt: ${evText}; A-01: ${a.pooler.a01} (kaynak: ${a.pooler.source}) | Q-02 |`,
    `| PostgreSQL ana sürümü | proje pg_version=${a.postgres.projectPgVersion}; server_version pooled=${a.postgres.serverVersionPooled}, doğrudan=${a.postgres.serverVersionDirect} | Q-05 |`,
    `| Sürücü ve sürümü | ${a.driver.name} ${a.driver.version} (kurulu) | Q-03 |`,
    `| Drizzle sürümü | drizzle-orm ${a.drizzle.version} (kurulu) | Q-03 |`,
    `| Prepared statement | üretim prepare=${String(pp.production)}; kapı: ${ppRun(pp.gateRun)}; tanı: ${ppRun(pp.diagnosticRun)}; pooler: ${pp.poolerSetting} | Q-04 |`,
    `| Doğrudan bağlantı yöntemi | ${dc.method}; wms_app: ${cell(dc.roleCreated)}; sahip rol: ${cell(dc.owner)}; migration rolüyle çalışma: ${dc.migrationRoleWorks} (kaynak: ${dc.source}) | Q-06 |`,
    `| Koşu tarihi ve sonucu | ${a.run.date} · ${a.run.result} · \`${a.run.artifact}\` | — |`,
    ``,
    `## Koşular`,
    ``,
    `| Koşu | Ayar / sonuç | AC-05 pool=1 | AC-05 pool=2 | AC-28 | harness |`,
    `|---|---|---|---|---|---|`,
    ...runRows(s.runs.gate, "kapı"),
    ...runRows(s.runs.diagnostic, "tanı"),
    ``,
    `## Gecikme (zaman aşımı tanısı)`,
    ``,
    `- Ölçüm: ${cell(s.latency)}`,
    `- Test zaman aşımı (--testTimeout): ${cell(s.latency !== "çalıştırılmadı" && s.latency.testTimeout ? s.latency.testTimeout : "çalıştırılmadı")}`,
    `- Koşu süreleri: kapı ${cell(typeof s.runs.gate === "string" ? s.runs.gate : s.runs.gate.timing)}; tanı ${cell(typeof s.runs.diagnostic === "string" ? s.runs.diagnostic : s.runs.diagnostic.timing)}`,
    ``,
    `## Notlar`,
    ``,
    ...s.notes.map((n) => `- ${n}`),
    ``,
    `## Sızıntı ve temizlik`,
    ``,
    `- Sızıntı kontrolü: ${s.leakCheck ? JSON.stringify(s.leakCheck) : "çalıştırılmadı"}`,
    `- Geçici dal silme: ${s.cleanup ?? "çalıştırılmadı"}`,
    ``,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Çalıştırma
// ---------------------------------------------------------------------------------------------

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Kurulu paket sürümü (`packages/db` bağımlılığı). @param {string} name */
function installedVersion(name) {
  const v = readJson(path.join(ROOT, "packages", "db", "node_modules", name, "package.json"))?.version;
  return typeof v === "string" ? v : null;
}

/**
 * `pnpm test:int` (neon hedefi) — çıktı satır satır maskelenir; ham satırda sızıntı sayılır.
 * @param {{ mode: "gate" | "diag", prepare: boolean | undefined, databaseUrl: string, databaseUrlDirect: string, testTimeoutMs: number, hookTimeoutMs: number, redactor: Redactor, log: (s: string) => void }} o
 */
async function runIntTests(o) {
  rmSync(INT_ARTIFACT_DIR, { recursive: true, force: true });
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, WMS_INT_TARGET: "neon", DATABASE_URL: o.databaseUrl, DATABASE_URL_DIRECT: o.databaseUrlDirect };
  // Neon API girdileri test sürecine verilmez.
  delete env.NEON_API_KEY;
  delete env.NEON_PROJECT_ID;
  if (o.prepare === undefined) delete env.INT_DB_PREPARE;
  else env.INT_DB_PREPARE = String(o.prepare);
  let leakLines = 0;
  /** @type {Set<string>} */
  const leakKinds = new Set();
  /** @type {string[]} */
  const logLines = [];
  const filter = createLineFilter(
    o.redactor,
    (s) => {
      process.stdout.write(s);
      logLines.push(s);
    },
    (kinds) => {
      leakLines++;
      for (const k of kinds) leakKinds.add(k);
    },
  );
  o.log(`[spike:neon] ${o.mode} koşusu: testTimeout=${o.testTimeoutMs}ms hookTimeout=${o.hookTimeoutMs}ms WMS_INT_TARGET=neon INT_DB_PREPARE=${o.prepare === undefined ? "(yok → üretim ayarı)" : String(o.prepare)}`);
  const wallStart = performance.now();
  const exitCode = await new Promise((resolve) => {
    const child = spawn("pnpm", ["test:int", `--testTimeout=${o.testTimeoutMs}`, `--hookTimeout=${o.hookTimeoutMs}`], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => filter.push(c));
    child.stderr.on("data", (c) => filter.push(c));
    child.on("error", (e) => {
      filter.push(`[spike:neon] pnpm başlatılamadı: ${e.message}\n`);
      resolve(null);
    });
    child.on("close", (code) => {
      filter.end();
      resolve(code);
    });
  });
  // Koşu kopyası (yüklenmez; sızıntı taramasına girer).
  const runDir = path.join(OUT_DIR, "runs", o.mode);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  if (existsSync(INT_ARTIFACT_DIR)) cpSync(INT_ARTIFACT_DIR, path.join(runDir, "test-int"), { recursive: true });
  writeFileSync(path.join(runDir, "console.redacted.log"), logLines.join(""));
  const report = readJson(path.join(INT_ARTIFACT_DIR, "report.json"));
  const results = report === null ? null : parseVitestReport(report);
  const ac05 = {
    pool1: pickAc05(readJson(path.join(INT_ARTIFACT_DIR, "ac", "ac-05-pool-1.json"))),
    pool2: pickAc05(readJson(path.join(INT_ARTIFACT_DIR, "ac", "ac-05-pool-2.json"))),
  };
  const timing = { wallMs: Math.round(performance.now() - wallStart), ac05Tests: report === null ? [] : pickAc05Durations(report) };
  const run = { mode: o.mode, exitCode: /** @type {number | null} */ (exitCode), results, ac05, timing, leakLines, leakKinds: [...leakKinds] };
  const prepareUsed = ac05.pool1?.prepare ?? ac05.pool2?.prepare ?? o.prepare ?? null;
  const ok = o.mode === "gate" ? gatePassed(run) : run.exitCode === 0 && leakLines === 0;
  return { ...run, prepare: prepareUsed, status: ok ? "PASS" : "FAIL" };
}

/**
 * Sıralı yüzdelik (en yakın sıra, doğrusal ara değer yok): p in [0,100]. Boş → null.
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/**
 * psql `\timing` çıktısındaki "Time: 12.345 ms" satırlarından milisaniye listesi.
 * @param {string} stdout
 */
export function parsePsqlTimings(stdout) {
  /** @type {number[]} */
  const out = [];
  for (const m of stdout.matchAll(/^Time:\s+([0-9]+(?:\.[0-9]+)?)\s+ms/gm)) out.push(Number(m[1]));
  return out;
}

/** @param {number[]} v */
function dist(v) {
  const r = (/** @type {number | null} */ x) => (x === null ? null : Math.round(x * 10) / 10);
  return { n: v.length, p50: r(percentile(v, 50)), p95: r(percentile(v, 95)), max: r(percentile(v, 100)) };
}

/** Gecikme ölçümünde tekrar sayıları. */
export const LATENCY_PROBE = { roundTrips: 30, transactions: 20, connects: 3, stmtsPerTx: 6, budgetMs: 120_000 };

/**
 * withTenant'ın ağ şeklini (BEGIN, 4 sorgu — set_config dahil —, COMMIT = 6 gidiş-dönüş) sürücüsüz taklit eder
 * (T-005d zaman aşımı kök neden ölçümü). psql `\timing` istemci tarafı gidiş-dönüş süresini verir;
 * `connect` = psql süreci başlatma + TCP + TLS + kimlik doğrulama + `SELECT 1` duvar saati (ilk bağlantı).
 * Sonuçta URL/host/kullanıcı yok; yalnızca sayılar.
 * @param {PsqlTarget} t
 * @param {Redactor} redactor
 * @param {() => number} [now]
 */
export function measureLatency(t, redactor, now = () => performance.now()) {
  const started = now();
  /** @param {string} sql */
  const run = (sql) => {
    const left = LATENCY_PROBE.budgetMs - (now() - started);
    if (left <= 0) return { ok: false, stdout: "", sqlstate: null, error: "ölçüm süre sınırı aşıldı" };
    return runPsql(t, sql, redactor, Math.ceil(left));
  };
  /** @param {{ error: string | null, sqlstate: string | null }} r */
  const fail = (r) => ({ error: r.error, sqlstate: r.sqlstate });
  /** @type {number[]} */
  const connect = [];
  for (let i = 0; i < LATENCY_PROBE.connects; i++) {
    const t0 = now();
    const r = run("SELECT 1;\n");
    if (!r.ok) return fail(r);
    connect.push(now() - t0);
  }
  const rt = run(`\\timing on\n${"SELECT 1;\n".repeat(LATENCY_PROBE.roundTrips)}`);
  if (!rt.ok) return fail(rt);
  const roundTrip = parsePsqlTimings(rt.stdout);
  if (roundTrip.length !== LATENCY_PROBE.roundTrips) {
    return { error: `ölçüm geçersiz: ${roundTrip.length} Time satırı, beklenen ${LATENCY_PROBE.roundTrips}`, sqlstate: null };
  }
  const txScript = `BEGIN;\nSELECT 1;\nSELECT 1;\nSELECT 1;\nSELECT 1;\nCOMMIT;\n`;
  const tx = run(`\\timing on\n${txScript.repeat(LATENCY_PROBE.transactions)}`);
  if (!tx.ok) return fail(tx);
  const all = parsePsqlTimings(tx.stdout);
  const expected = LATENCY_PROBE.transactions * LATENCY_PROBE.stmtsPerTx;
  if (all.length !== expected) return { error: `ölçüm geçersiz: ${all.length} Time satırı, beklenen ${expected}`, sqlstate: null };
  /** @type {number[]} */
  const perTx = [];
  for (let i = 0; i < all.length; i += LATENCY_PROBE.stmtsPerTx) perTx.push(all.slice(i, i + LATENCY_PROBE.stmtsPerTx).reduce((a, b) => a + b, 0));
  return { error: null, sqlstate: null, connectMs: dist(connect), roundTripMs: dist(roundTrip), withTenantShapedTxMs: dist(perTx), roundTripsPerTx: LATENCY_PROBE.stmtsPerTx };
}

/** Test zaman aşımı bütçesi sabitleri (Supervisor kararı; G-11: assertion değil, ağ gecikmesiyle orantılı bütçe). */
export const TEST_TIMEOUT = { defaultMs: 30_000, hookDefaultMs: 60_000, maxMs: 600_000, calls: 100, stepsPerCall: 6, safety: 3 };

/**
 * `--testTimeout` değeri: clamp(max(30000, ceil(3 × 600 × adım-RTT_p95_ms)), üst sınır 600000).
 * Ölçüm yok/geçersiz → 30000 (fail-closed: bütçe büyütülmez).
 * @param {{ error?: unknown, roundTripMs?: { p95?: number | null } } | null | undefined} pooledLatency
 * @returns {{ ms: number, hookMs: number, measured: boolean, rttP95Ms: number | null, formula: string }}
 */
export function computeTestTimeoutMs(pooledLatency) {
  const formula = `clamp(max(${TEST_TIMEOUT.defaultMs}, ceil(${TEST_TIMEOUT.safety} × ${TEST_TIMEOUT.calls * TEST_TIMEOUT.stepsPerCall} × RTT_p95_ms)), ${TEST_TIMEOUT.maxMs})`;
  const rtt = pooledLatency?.error ? null : (pooledLatency?.roundTripMs?.p95 ?? null);
  if (typeof rtt !== "number" || !Number.isFinite(rtt) || rtt <= 0) {
    return { ms: TEST_TIMEOUT.defaultMs, hookMs: TEST_TIMEOUT.hookDefaultMs, measured: false, rttP95Ms: null, formula: `ölçülemedi → ${TEST_TIMEOUT.defaultMs} (varsayılan); ${formula}` };
  }
  const raw = Math.ceil(TEST_TIMEOUT.safety * TEST_TIMEOUT.calls * TEST_TIMEOUT.stepsPerCall * rtt);
  const ms = Math.min(TEST_TIMEOUT.maxMs, Math.max(TEST_TIMEOUT.defaultMs, raw));
  // hookTimeout aynı bütçeyle ölçeklenir (afterAll `client.close()` bekleyen sorguları bekler; PR #31 MINOR-2).
  return { ms, hookMs: Math.min(TEST_TIMEOUT.maxMs, Math.max(TEST_TIMEOUT.hookDefaultMs, ms)), measured: true, rttP95Ms: rtt, formula };
}

/**
 * Vitest raporundan AC-05 testlerinin süreleri (ms) ve durumları; zaman aşımı (≥ testTimeout)
 * görünür olsun diye başarısızlar da dahil. Test adı kısaltılır, hata metni alınmaz.
 * @param {any} report
 */
export function pickAc05Durations(report) {
  /** @type {{ test: string, status: unknown, durationMs: number | null }[]} */
  const out = [];
  for (const f of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const a of Array.isArray(f?.assertionResults) ? f.assertionResults : []) {
      const name = String(a?.fullName ?? a?.title ?? "");
      if (!name.includes("@AC-05")) continue;
      const m = /@AC-05 pool=(\d)[^:]*:\s*(.{0,40})/.exec(name);
      out.push({
        test: m ? `pool=${m[1]} ${m[2]}` : name.slice(0, 60),
        status: a?.status,
        durationMs: typeof a?.duration === "number" ? Math.round(a.duration) : null,
      });
    }
  }
  return out;
}

/**
 * Çoklama kanıtı: pooled host'a `n` ayrı psql oturumu (ayrı TCP/istemci bağlantısı), her biri
 * `pg_backend_pid()`; farklı PID sayısı < oturum sayısı → farklı istemci bağlantıları aynı sunucu
 * sürecini paylaştı (çoklayan pooler). Doğrudan host kontrol olarak 2 oturum.
 * @param {PsqlTarget} pooled
 * @param {PsqlTarget} direct
 * @param {Redactor} redactor
 */
function poolerEvidence(pooled, direct, redactor) {
  /** @param {PsqlTarget} t @param {number} n */
  const pids = (t, n) => {
    /** @type {string[]} */
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = runPsql(t, "SELECT pg_backend_pid();\n", redactor);
      if (!r.ok) return { error: r.error, sqlstate: r.sqlstate, pids: out };
      out.push(r.stdout);
    }
    return { error: null, sqlstate: null, pids: out };
  };
  const p = pids(pooled, POOLER_PROBE_SESSIONS);
  const d = pids(direct, 2);
  if (p.error !== null || d.error !== null) {
    return { observed: false, error: p.error ?? d.error, sqlstate: p.sqlstate ?? d.sqlstate };
  }
  const distinct = new Set(p.pids).size;
  const directDistinct = new Set(d.pids).size;
  return {
    observed: distinct < POOLER_PROBE_SESSIONS && directDistinct === 2,
    sessions: POOLER_PROBE_SESSIONS,
    distinctBackendPids: distinct,
    directSessions: 2,
    directDistinctBackendPids: directDistinct,
  };
}

/**
 * Özeti yazar, `.artifacts/t-005d/` dizinini tarar. Sızıntı → özet yine yazılır (maskeli) ama
 * `leakCheck.ok=false`.
 * @param {any} data
 * @param {Redactor} redactor
 * @param {{ consoleLeakLines: number }} extra
 */
function writeSummary(data, redactor, extra) {
  mkdirSync(OUT_DIR, { recursive: true });
  const pre = scanDirForLeaks(OUT_DIR, redactor);
  const leakCheck = {
    ok: pre.length === 0 && extra.consoleLeakLines === 0,
    consoleLeakLines: extra.consoleLeakLines,
    artifactFilesWithLeaks: pre.map((f) => `${f.file} (${f.kinds.join(",")})`),
  };
  const summary = buildSummary({ ...data, leakCheck });
  const json = redactor.redact(`${JSON.stringify(summary, null, 2)}\n`);
  const md = redactor.redact(renderSummaryMd(summary));
  writeFileSync(path.join(OUT_DIR, "summary.json"), json);
  writeFileSync(path.join(OUT_DIR, "summary.md"), md);
  const post = scanDirForLeaks(OUT_DIR, redactor);
  return { summary, md, ok: leakCheck.ok && post.length === 0 };
}

/**
 * @param {{ env?: Record<string, string | undefined>, log?: (s: string) => void }} [o]
 * @returns {Promise<number>}
 */
export async function main(o = {}) {
  const env = o.env ?? process.env;
  const log = o.log ?? ((s) => console.log(s));
  const redactor = createRedactor();
  /** @type {{ apiKey: string, projectId: string, branchName: string }} */
  let cfg;
  try {
    cfg = readSpikeEnv(env);
  } catch (e) {
    log(`[spike:neon] FAIL: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  maskSecret(redactor, cfg.apiKey, { env });
  maskSecret(redactor, cfg.projectId, { env });
  const api = createNeonApi({ apiKey: cfg.apiKey, projectId: cfg.projectId, redactor });
  /** @param {string} s */
  const say = (s) => log(redactor.redact(s));

  if (process.argv.includes("--cleanup")) return cleanup(api, cfg.branchName, redactor, say);

  const date = new Date().toISOString();
  /** @type {any} */
  const data = { date, result: "FAIL", driverVersion: installedVersion("postgres"), drizzleVersion: installedVersion("drizzle-orm") };
  /** @type {string | null} */
  let branchId = null;
  let consoleLeakLines = 0;
  let exitCode = 1;
  try {
    const project = await api.getProject();
    data.region = typeof project?.project?.region_id === "string" ? project.project.region_id : null;
    data.projectPgVersion = project?.project?.pg_version ?? null;

    say(`[spike:neon] geçici dal oluşturuluyor: ${cfg.branchName}`);
    const created = await api.createBranch(cfg.branchName);
    if (typeof created?.branch?.id === "string") {
      branchId = created.branch.id;
      maskSecret(redactor, branchId, { env });
    }
    const conn = extractConnection(created);
    for (const v of [conn.endpointId, conn.host, conn.poolerHost, conn.ownerRole, conn.ownerPassword]) maskSecret(redactor, v, { env });
    await api.waitOperations("branch/create", Array.isArray(created?.operations) ? created.operations : []);
    let ownerPassword = conn.ownerPassword;
    if (ownerPassword === null) {
      const uri = await api.getDirectUri({ branchId: conn.branchId, databaseName: conn.database, roleName: conn.ownerRole });
      maskSecret(redactor, uri, { env });
      ownerPassword = decodeURIComponent(new URL(uri).password);
      maskSecret(redactor, ownerPassword, { env });
    }
    if (data.region === null) data.region = conn.regionId;
    say(`[spike:neon] dal hazır (bölge ${data.region ?? "?"})`);

    /** @type {PsqlTarget} */
    const direct = { host: conn.host, user: conn.ownerRole, password: ownerPassword, database: conn.database };
    const appPassword = randomBytes(24).toString("hex");
    maskSecret(redactor, appPassword, { env });
    /** @type {PsqlTarget} */
    const pooled = { host: conn.poolerHost, user: APP_ROLE, password: appPassword, database: conn.database };

    const owner = runPsql(direct, OWNER_CHECK_SQL, redactor);
    data.owner = owner.ok ? parseOwnerCheck(owner.stdout) : `hata (SQLSTATE ${owner.sqlstate ?? "?"}): ${owner.error}`;
    const sv = runPsql(direct, "SHOW server_version;\n", redactor);
    data.serverVersionDirect = sv.ok ? sv.stdout : `hata (SQLSTATE ${sv.sqlstate ?? "?"})`;

    const creation = createAppRole({ direct, password: appPassword, redactor, mask: (v) => maskSecret(redactor, v, { env }) });
    data.appRole = { created: creation.ok, path: creation.path, attempts: creation.attempts, check: "çalıştırılmadı" };
    if (!creation.ok) {
      const last = creation.attempts[creation.attempts.length - 1];
      data.blocked = `Q-06: wms_app sahip rolüyle doğrudan bağlantıda oluşturulamadı (yol ${creation.path}, SQLSTATE ${last?.sqlstate ?? "yok"})`;
      say(`[spike:neon] BLOCKED ${data.blocked}`);
      return 1;
    }
    say(`[spike:neon] wms_app oluşturuldu (yol: ${creation.path})`);
    const check = runPsql(direct, APP_ROLE_CHECK_SQL, redactor);
    const parsed = check.ok
      ? parseAppRoleCheck(check.stdout)
      : { ok: false, detail: `hata (SQLSTATE ${check.sqlstate ?? "?"}): ${check.error}` };
    data.appRole.check = parsed;
    if (!parsed.ok) {
      data.blocked = "Q-06: wms_app öznitelikleri/üyelikleri beklenenden farklı";
      say(`[spike:neon] BLOCKED ${data.blocked}`);
      return 1;
    }

    const svp = runPsql(pooled, "SHOW server_version;\n", redactor);
    data.serverVersionPooled = svp.ok ? svp.stdout : `hata (SQLSTATE ${svp.sqlstate ?? "?"}): ${svp.error}`;
    data.pooler = poolerEvidence(pooled, direct, redactor);

    const databaseUrl = pgUrl(pooled);
    const databaseUrlDirect = pgUrl(direct);
    maskSecret(redactor, databaseUrl, { env });
    maskSecret(redactor, databaseUrlDirect, { env });

    data.latency = {
      pooled: measureLatency(pooled, redactor),
      direct: measureLatency(direct, redactor),
      runnerNote: "GitHub-hosted runner → Neon (istemci tarafı, psql \\timing); AC-05 testlerinin gerçek süreleri runs.*.timing.ac05Tests",
    };
    data.latency.testTimeout = computeTestTimeoutMs(data.latency.pooled);
    say(`[spike:neon] gecikme: ${JSON.stringify(data.latency.pooled)}`);
    say(`[spike:neon] test zaman aşımı: ${data.latency.testTimeout.ms} ms (${data.latency.testTimeout.measured ? `RTT p95 ${data.latency.testTimeout.rttP95Ms} ms` : "ölçülemedi"})`);

    const gate = await runIntTests({ mode: "gate", prepare: undefined, testTimeoutMs: data.latency.testTimeout.ms, hookTimeoutMs: data.latency.testTimeout.hookMs, databaseUrl, databaseUrlDirect, redactor, log: say });
    consoleLeakLines += gate.leakLines;
    data.gate = gate;
    data.migrationRoleWorks =
      gate.ac05.pool1 !== null || gate.ac05.pool2 !== null
        ? "evet — sonda fikstürü (CREATE TABLE/POLICY/GRANT) DATABASE_URL_DIRECT ile kuruldu"
        : "gözlenemedi (AC-05 artefaktı yok)";

    const production = gate.ac05.pool1?.prepare ?? gate.ac05.pool2?.prepare;
    if (typeof production === "boolean") {
      const diag = await runIntTests({ mode: "diag", prepare: !production, testTimeoutMs: data.latency.testTimeout.ms, hookTimeoutMs: data.latency.testTimeout.hookMs, databaseUrl, databaseUrlDirect, redactor, log: say });
      consoleLeakLines += diag.leakLines;
      data.diag = diag;
    } else {
      say("[spike:neon] tanı koşusu çalıştırılmadı: kapı koşusunda üretim prepare değeri gözlenemedi");
    }

    data.result = gate.status === "PASS" ? "PASS" : "FAIL (kapı)";
    exitCode = gate.status === "PASS" ? 0 : 1;
    return exitCode;
  } catch (e) {
    data.error = redactor.redact(e instanceof Error ? e.message : String(e));
    say(`[spike:neon] FAIL: ${data.error}`);
    return 1;
  } finally {
    if (branchId !== null) {
      try {
        await api.deleteBranch(branchId);
        data.cleanup = "silindi";
        say("[spike:neon] geçici dal silindi");
      } catch (e) {
        data.cleanup = `SİLİNEMEDİ: ${redactor.redact(e instanceof Error ? e.message : String(e))}`;
        say(`[spike:neon] FAIL geçici dal silinemedi`);
        exitCode = 1;
      }
    } else {
      data.cleanup = "dal oluşturulmadı";
    }
    if (exitCode !== 0 && data.result === "PASS") data.result = "FAIL (temizlik)";
    const written = writeSummary(data, redactor, { consoleLeakLines });
    if (!written.ok) {
      say("[spike:neon] FAIL maskelenmemiş gizli değer konsolda veya .artifacts/t-005d/ altında görüldü");
    }
    say(`[spike:neon] özet: ${written.summary.result} · .artifacts/t-005d/summary.md`);
    // Tanı log'dan okunabilsin (artefakt indirilemeyebilir): YALNIZCA sızıntı denetimi geçtiyse,
    // maskelenmiş özet (yeniden maskelenerek) iş log'una basılır.
    if (written.ok) {
      log("::group::summary.md");
      for (const line of written.md.split("\n")) say(line);
      log("::endgroup::");
    }
    if (!written.ok || data.cleanup !== "silindi") process.exitCode = 1;
  }
}

/**
 * Artık geçici dalı (aynı ad) siler; yoksa OK.
 * @param {ReturnType<typeof createNeonApi>} api
 * @param {string} name
 * @param {Redactor} redactor
 * @param {(s: string) => void} say
 */
async function cleanup(api, name, redactor, say) {
  try {
    const leftovers = (await api.listBranches()).filter((b) => b?.name === name && typeof b?.id === "string");
    for (const b of leftovers) {
      redactor.add(b.id);
      await api.deleteBranch(b.id);
    }
    say(`[spike:neon] temizlik: ${leftovers.length} artık dal silindi`);
    return 0;
  } catch (e) {
    say(`[spike:neon] FAIL temizlik: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  process.exitCode = Math.max(code, typeof process.exitCode === "number" ? process.exitCode : 0);
}
