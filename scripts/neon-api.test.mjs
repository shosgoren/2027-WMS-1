import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRedactor } from "./neon-spike.mjs";
import { NeonApiError, createNeonProjectApi, parsePgUri, poolerHostFor, readNeonEnv } from "./neon-api.mjs";

/** Koşu başına rastgele sahte değer (literal sır yok). */
const rnd = (/** @type {string} */ prefix) => `${prefix}${randomBytes(9).toString("hex")}`;
const API_KEY = rnd("k");
const GEN_PW = rnd("g");
const MASK_PW = rnd("m");
const BASE = "https://console.neon.tech/api/v2/projects/dry-heart-13671059";

/**
 * @param {(url: string, init: any) => { status: number, body: unknown }} handler
 */
function fakeFetch(handler) {
  /** @type {{ url: string, method: string, body: string | undefined }[]} */
  const calls = [];
  const impl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, method: init.method, body: init.body });
    const r = handler(url, init);
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { impl, calls };
}

/** @param {ReturnType<typeof fakeFetch>["impl"]} fetchImpl @param {string[]} [writes] */
function mk(fetchImpl, writes = [], env = {}) {
  const redactor = createRedactor();
  const api = createNeonProjectApi({
    apiKey: API_KEY,
    projectId: "dry-heart-13671059",
    redactor,
    fetchImpl,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    env,
    write: (s) => void writes.push(s),
  });
  return { api, redactor };
}

describe("readNeonEnv", () => {
  it("eksik girdi: yalnızca ADLAR hata iletisinde", () => {
    expect(() => readNeonEnv({})).toThrow(/NEON_API_KEY, NEON_PROJECT_ID/);
    expect(readNeonEnv({ NEON_API_KEY: " k ", NEON_PROJECT_ID: "p" })).toEqual({ apiKey: "k", projectId: "p" });
  });
});

describe("parsePgUri / poolerHostFor", () => {
  it("URI'den hedef; yüzde kodlu parola çözülür", () => {
    expect(parsePgUri("postgresql://own%40er:p%2Fw%3A1@ep-a-b-123.c-2.eu.aws.neon.tech/neondb?sslmode=require")).toEqual({
      host: "ep-a-b-123.c-2.eu.aws.neon.tech",
      user: "own@er",
      password: "p/w:1",
      database: "neondb",
    });
  });
  it("parolasız / bozuk URI reddedilir (iletide URI yok)", () => {
    expect(() => parsePgUri("postgresql://u@h/db")).toThrow(NeonApiError);
    expect(() => parsePgUri("nonsense-with-secret")).toThrow(/ayrıştırılamadı/);
    try {
      parsePgUri("nonsense-with-secret");
    } catch (e) {
      expect(String(e)).not.toContain("nonsense-with-secret");
    }
  });
  it("pooler host: kimliğin ardına -pooler", () => {
    expect(poolerHostFor("ep-a-b-123", "ep-a-b-123.c-2.eu.aws.neon.tech")).toBe("ep-a-b-123-pooler.c-2.eu.aws.neon.tech");
    expect(() => poolerHostFor("ep-x", "ep-a-b-123.c-2.eu.aws.neon.tech")).toThrow(/pooler host türetilemedi/);
  });
});

describe("createNeonProjectApi", () => {
  it("ana dal: `default` bayrağı; birden çok/sıfır ana dal → hata", async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { branches: [{ id: "br-a", name: "dev", default: false }, { id: "br-main", name: "main", default: true }] } }));
    expect(await mk(ok.impl).api.findMainBranch()).toEqual({ id: "br-main", name: "main" });
    expect(ok.calls[0]?.url).toBe(`${BASE}/branches`);
    const none = fakeFetch(() => ({ status: 200, body: { branches: [{ id: "br-a", default: false }] } }));
    await expect(mk(none.impl).api.findMainBranch()).rejects.toThrow(/tam bir ana dal/);
    const two = fakeFetch(() => ({ status: 200, body: { branches: [{ id: "br-a", default: true }, { id: "br-b", default: true }] } }));
    await expect(mk(two.impl).api.findMainBranch()).rejects.toThrow(/2 bulundu/);
  });

  it("rol oluşturma: belgelenen uç nokta + gövde; parola yanıttan, işlem beklenir", async () => {
    const f = fakeFetch((url, init) => {
      if (init.method === "POST") return { status: 201, body: { role: { name: "wms_app", password: GEN_PW }, operations: [{ id: "op1", status: "running", action: "apply_config" }] } };
      return { status: 200, body: { operation: { status: "finished" } } };
    });
    const { api, redactor } = mk(f.impl);
    const pw = await api.createRole("br-main", "wms_app");
    expect(pw).toBe(GEN_PW);
    expect(f.calls[0]?.url).toBe(`${BASE}/branches/br-main/roles`);
    expect(f.calls[0]?.method).toBe("POST");
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({ role: { name: "wms_app" } });
    expect(f.calls[1]?.url).toBe(`${BASE}/operations/op1`);
    expect(redactor.redact(`x ${GEN_PW} y`)).toBe("x *** y");
  });

  it("parola sıfırlama + silme uçları; yanıtta parola yoksa hata", async () => {
    const f = fakeFetch((url, init) =>
      init.method === "DELETE" ? { status: 200, body: { operations: [] } } : { status: 200, body: { role: { name: "r" }, operations: [] } },
    );
    const { api } = mk(f.impl);
    await expect(api.resetRolePassword("br-main", "wms_app")).rejects.toThrow(/yanıtta parola yok/);
    expect(f.calls[0]?.url).toBe(`${BASE}/branches/br-main/roles/wms_app/reset_password`);
    await api.deleteRole("br-main", "wms_app");
    expect(f.calls[1]?.method).toBe("DELETE");
    expect(f.calls[1]?.url).toBe(`${BASE}/branches/br-main/roles/wms_app`);
  });

  it("resolveMainBranch: doğrudan + pooled sahip URI; değerler maskelenir, Actions dışında stdout'a hiçbir şey yazılmaz", async () => {
    const OWNER_PW = rnd("o");
    const f = fakeFetch((url) => {
      if (url.endsWith("/branches")) return { status: 200, body: { branches: [{ id: "br-main", name: "main", default: true }] } };
      if (url.includes("/endpoints")) return { status: 200, body: { endpoints: [{ id: "ep-cool-dark-123456", type: "read_write", host: "ep-cool-dark-123456.c-2.eu-central-1.aws.neon.tech" }] } };
      if (url.includes("/databases")) return { status: 200, body: { databases: [{ name: "neondb", owner_name: "neondb_owner" }] } };
      const pooled = url.includes("pooled=true");
      const host = pooled ? "ep-cool-dark-123456-pooler.c-2.eu-central-1.aws.neon.tech" : "ep-cool-dark-123456.c-2.eu-central-1.aws.neon.tech";
      return { status: 200, body: { uri: `postgresql://neondb_owner:${OWNER_PW}@${host}/neondb?sslmode=require` } };
    });
    /** @type {string[]} */
    const writes = [];
    const { api, redactor } = mk(f.impl, writes, {});
    const c = await api.resolveMainBranch();
    expect(writes).toEqual([]);
    expect(c.ownerDirect).toEqual({ host: "ep-cool-dark-123456.c-2.eu-central-1.aws.neon.tech", user: "neondb_owner", password: OWNER_PW, database: "neondb" });
    expect(c.poolerHost).toBe("ep-cool-dark-123456-pooler.c-2.eu-central-1.aws.neon.tech");
    const qs = f.calls.filter((x) => x.url.includes("/connection_uri")).map((x) => new URL(x.url).searchParams.get("pooled"));
    expect(qs).toEqual(["false", "true"]);
    const dump = redactor.redact(JSON.stringify(c));
    for (const secret of [OWNER_PW, "ep-cool-dark-123456", "neondb_owner", "br-main"]) expect(dump).not.toContain(secret);
    expect(redactor.leaks(JSON.stringify(c)).length).toBeGreaterThan(0);
  });

  it("Actions'ta her gizli değer ::add-mask:: ile maskelenir", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { role: { name: "r", password: MASK_PW }, operations: [] } }));
    /** @type {string[]} */
    const writes = [];
    const { api } = mk(f.impl, writes, { GITHUB_ACTIONS: "true" });
    await api.createRole("br-main", "wms_app");
    expect(writes).toContain(`::add-mask::${API_KEY}\n`);
    expect(writes).toContain(`::add-mask::${MASK_PW}\n`);
  });
});
