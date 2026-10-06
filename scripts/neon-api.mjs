// T-105 — Neon proje API'si: ana dal + sahip rolünün doğrudan/pooled bağlantı bilgileri, rol uçları.
// Paylaşılan modül (T-106 aynı modülü kullanır). YALNIZCA GitHub Actions'ta çalışır (ajan ortamından Neon'a
// ağ erişimi yok, ADR-013). Yeni bağımlılık yok: `fetch` (HTTP istemcisi ve maskeleyici neon-spike.mjs'ten).
//
// Gizlilik (G-09): elde edilen her gizli/ayırt edici değer (dal kimliği, host'lar, sahip rol adı, parolalar, URI'ler)
// ilk elde edildiği anda `maskSecret` ile `::add-mask::` yapılır ve maskeleyiciye eklenir. Bu modül hiçbir
// URL/parola/host'u stdout'a yazmaz; hata mesajları maskelenmiş Neon iletisi + HTTP durumu taşır.
//
// Neon REST API v2 (G-04; kaynak: neondatabase/website belgeleri content/docs/manage/{roles,branches}.md,
// ana dal bayrağı `default`):
//   GET    /projects/{id}/branches                              → branches[] {id, name, default, primary}
//   GET    /projects/{id}/branches/{br}/endpoints               → endpoints[] {id, type, host}
//   GET    /projects/{id}/branches/{br}/databases               → databases[] {name, owner_name}
//   GET    /projects/{id}/branches/{br}/roles                   → roles[] {name, protected}
//   POST   /projects/{id}/branches/{br}/roles   {role:{name}}   → role.password (yalnızca bu yanıtta), operations[]
//   POST   /projects/{id}/branches/{br}/roles/{name}/reset_password → role.password, operations[]
//   DELETE /projects/{id}/branches/{br}/roles/{name}            → operations[]
//   GET    /projects/{id}/connection_uri?branch_id&database_name&role_name&pooled=<bool> → uri
// UYARI (belge): API/Konsol/CLI ile yaratılan roller `neon_superuser` üyesidir (CREATEDB, CREATEROLE, BYPASSRLS,
// REPLICATION); yalnızca SQL ile yaratılanlar değildir. Çağıran nitelikleri doğrudan bağlantıda doğrular.
import { NeonApiError, createNeonApi, maskSecret, pgUrl, readSpikeEnv } from "./neon-spike.mjs";

export { NeonApiError };

/**
 * @typedef {import("./neon-spike.mjs").Redactor} Redactor
 * @typedef {import("./neon-spike.mjs").FetchLike} FetchLike
 * @typedef {{ host: string, user: string, password: string, database: string }} PsqlTarget
 * @typedef {{
 *   branchId: string, endpointId: string, host: string, poolerHost: string, database: string,
 *   ownerRole: string, ownerDirect: PsqlTarget, ownerDirectUri: string, ownerPooledUri: string,
 * }} MainBranchConnections
 */

/**
 * Zorunlu girdiler (NEON_API_KEY sırrı, NEON_PROJECT_ID değişkeni); eksik olanların yalnızca ADLARI hata iletisinde.
 * @param {Record<string, string | undefined>} env
 * @returns {{ apiKey: string, projectId: string }}
 */
export function readNeonEnv(env) {
  const { apiKey, projectId } = readSpikeEnv(env);
  return { apiKey, projectId };
}

/**
 * `postgresql://user:pass@host/db?...` URI'sinden bağlantı hedefi (psql ortam değişkenleri için).
 * @param {string} uri
 * @returns {PsqlTarget}
 */
export function parsePgUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    throw new NeonApiError("Neon API connection_uri: uri ayrıştırılamadı", 0);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (u.hostname === "" || user === "" || password === "" || database === "") {
    throw new NeonApiError("Neon API connection_uri: uri host/kullanıcı/parola/veritabanı alanlarından biri boş", 0);
  }
  return { host: u.hostname, user, password, database };
}

/**
 * Uç nokta host'undan pooled host: kimliğin hemen ardına `-pooler` (Neon belgesi).
 * @param {string} endpointId
 * @param {string} host
 */
export function poolerHostFor(endpointId, host) {
  if (!host.startsWith(`${endpointId}.`)) {
    throw new NeonApiError("Neon API endpoints: host uç nokta kimliğiyle başlamıyor (pooler host türetilemedi)", 0);
  }
  return `${endpointId}-pooler${host.slice(endpointId.length)}`;
}

/**
 * Proje kapsamlı Neon API'si (neon-spike.mjs istemcisi üzerine rol/dal-okuma uçları).
 * @param {{
 *   apiKey: string, projectId: string, redactor: Redactor, fetchImpl?: FetchLike,
 *   sleep?: (ms: number) => Promise<unknown>, pollIntervalMs?: number, pollTimeoutMs?: number,
 *   env?: Record<string, string | undefined>, write?: (s: string) => void,
 * }} opts
 */
export function createNeonProjectApi(opts) {
  const { redactor, env, write } = opts;
  const base = createNeonApi(opts);
  /** @param {string | null | undefined} v */
  const mask = (v) => maskSecret(redactor, v, { ...(env ? { env } : {}), ...(write ? { write } : {}) });
  mask(opts.apiKey);
  const br = (/** @type {string} */ id) => `/branches/${encodeURIComponent(id)}`;

  return {
    mask,
    /**
     * Ana (varsayılan) dal: `default` bayrağı (yoksa eski `primary`); tam bir tane olmalı.
     * @returns {Promise<{ id: string, name: string }>}
     */
    async findMainBranch() {
      const branches = await base.listBranches();
      let main = branches.filter((b) => b?.default === true);
      if (main.length === 0) main = branches.filter((b) => b?.primary === true);
      if (main.length !== 1 || typeof main[0]?.id !== "string") {
        throw new NeonApiError(`Neon API branch/list: tam bir ana dal bekleniyordu, ${main.length} bulundu`, 0);
      }
      mask(main[0].id);
      return { id: main[0].id, name: String(main[0].name ?? "") };
    },
    /**
     * @param {string} branchId
     * @returns {Promise<{ id: string, host: string, poolerHost: string }>}
     */
    async getReadWriteEndpoint(branchId) {
      const r = await base.request("endpoint/list", "GET", `${br(branchId)}/endpoints`);
      const eps = (Array.isArray(r?.endpoints) ? r.endpoints : []).filter((/** @type {any} */ e) => e?.type === "read_write");
      if (eps.length !== 1 || typeof eps[0]?.id !== "string" || typeof eps[0]?.host !== "string") {
        throw new NeonApiError(`Neon API endpoint/list: tam bir read_write uç nokta bekleniyordu, ${eps.length} bulundu`, 0);
      }
      const poolerHost = poolerHostFor(eps[0].id, eps[0].host);
      for (const v of [eps[0].id, eps[0].host, poolerHost]) mask(v);
      return { id: eps[0].id, host: eps[0].host, poolerHost };
    },
    /**
     * @param {string} branchId
     * @param {string} [wanted] birden çok veritabanı varsa zorunlu ad
     * @returns {Promise<{ name: string, ownerName: string }>}
     */
    async getDatabase(branchId, wanted) {
      const r = await base.request("database/list", "GET", `${br(branchId)}/databases`);
      let dbs = Array.isArray(r?.databases) ? r.databases : [];
      if (wanted) dbs = dbs.filter((/** @type {any} */ d) => d?.name === wanted);
      if (dbs.length !== 1 || typeof dbs[0]?.name !== "string" || typeof dbs[0]?.owner_name !== "string") {
        throw new NeonApiError(`Neon API database/list: tam bir veritabanı bekleniyordu, ${dbs.length} bulundu`, 0);
      }
      mask(dbs[0].name);
      mask(dbs[0].owner_name);
      return { name: dbs[0].name, ownerName: dbs[0].owner_name };
    },
    /**
     * @param {string} branchId
     * @returns {Promise<string[]>}
     */
    async listRoles(branchId) {
      const r = await base.request("role/list", "GET", `${br(branchId)}/roles`);
      return (Array.isArray(r?.roles) ? r.roles : []).map((/** @type {any} */ x) => String(x?.name ?? "")).filter((/** @type {string} */ n) => n !== "");
    },
    /**
     * Rol oluşturur; parola sağlayıcıda üretilir (SQL metnine düşmez) ve yalnızca bu yanıtta döner.
     * @param {string} branchId
     * @param {string} name
     * @returns {Promise<string>} parola (zaten maskelenmiş)
     */
    async createRole(branchId, name) {
      const r = await base.request("role/create", "POST", `${br(branchId)}/roles`, { role: { name } });
      const pw = r?.role?.password;
      if (typeof pw !== "string" || pw === "") throw new NeonApiError("Neon API role/create: yanıtta parola yok", 0);
      mask(pw);
      await base.waitOperations("role/create", Array.isArray(r?.operations) ? r.operations : []);
      return pw;
    },
    /**
     * @param {string} branchId
     * @param {string} name
     * @returns {Promise<string>} yeni parola (maskelenmiş)
     */
    async resetRolePassword(branchId, name) {
      const r = await base.request("role/reset_password", "POST", `${br(branchId)}/roles/${encodeURIComponent(name)}/reset_password`);
      const pw = r?.role?.password;
      if (typeof pw !== "string" || pw === "") throw new NeonApiError("Neon API role/reset_password: yanıtta parola yok", 0);
      mask(pw);
      await base.waitOperations("role/reset_password", Array.isArray(r?.operations) ? r.operations : []);
      return pw;
    },
    /**
     * @param {string} branchId
     * @param {string} name
     */
    async deleteRole(branchId, name) {
      const r = await base.request("role/delete", "DELETE", `${br(branchId)}/roles/${encodeURIComponent(name)}`);
      await base.waitOperations("role/delete", Array.isArray(r?.operations) ? r.operations : []);
    },
    /**
     * Rolün bağlantı URI'si (belgelenen `connection_uri` ucu).
     * @param {{ branchId: string, databaseName: string, roleName: string, pooled: boolean }} q
     * @returns {Promise<string>}
     */
    async getConnectionUri(q) {
      const qs = new URLSearchParams({
        branch_id: q.branchId,
        database_name: q.databaseName,
        role_name: q.roleName,
        pooled: q.pooled ? "true" : "false",
      });
      const r = await base.request("connection_uri/get", "GET", `/connection_uri?${qs.toString()}`);
      if (typeof r?.uri !== "string") throw new NeonApiError("Neon API connection_uri/get: uri alanı yok", 0);
      mask(r.uri);
      return r.uri;
    },
    /**
     * Ana dal + sahip rolün doğrudan ve pooled bağlantıları. Hepsi maskelenir; hiçbiri yazdırılmaz.
     * @param {{ databaseName?: string }} [o]
     * @returns {Promise<MainBranchConnections>}
     */
    async resolveMainBranch(o = {}) {
      const branch = await this.findMainBranch();
      const ep = await this.getReadWriteEndpoint(branch.id);
      const db = await this.getDatabase(branch.id, o.databaseName);
      const ownerDirectUri = await this.getConnectionUri({ branchId: branch.id, databaseName: db.name, roleName: db.ownerName, pooled: false });
      const ownerPooledUri = await this.getConnectionUri({ branchId: branch.id, databaseName: db.name, roleName: db.ownerName, pooled: true });
      const ownerDirect = parsePgUri(ownerDirectUri);
      mask(ownerDirect.password);
      return {
        branchId: branch.id,
        endpointId: ep.id,
        host: ep.host,
        poolerHost: ep.poolerHost,
        database: db.name,
        ownerRole: db.ownerName,
        ownerDirect,
        ownerDirectUri,
        ownerPooledUri,
      };
    },
  };
}

/** Rol bağlantı URL'si (TLS tam doğrulama); çağıran `mask` ile maskelemekten sorumludur. */
export { pgUrl as roleUrl };
