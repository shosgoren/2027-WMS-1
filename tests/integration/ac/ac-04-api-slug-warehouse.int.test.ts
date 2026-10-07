// katman: API (sayfa/eylem)
// AC-04 — bağımsız kabul testi (T-215, qa-verifier): "Tenant A, B'nin ID'sini kullanır -> API, DB, dosya, cache, export reddeder".
// Bu dosya YALNIZCA depo/lokasyon sayfa yükleyicilerini (`/t/<slug>/warehouses...`) ve Server Action katmanını
// (`warehouses/actions.ts`) kanıtlar; üyelik/ayar eylemleri `ac-04-api-slug.int.test.ts`, DB `ac-04-db-isolation`, dosya/cache/export
// ayrı dosyalardadır.
//
// Mock'lar YALNIZCA Next çalışma zamanı ve kimlik çözümüdür (`next/headers`, `next/navigation`, `next-intl/server`, `lib/auth-service`:
// `x-test-user` başlığı = oturumdaki kullanıcı). Eylem sarmalayıcısı, domain komutları, RLS ve `wms_app` rolü GERÇEKTİR. Veri sentetik (G-09).
// Kapsam kuralı: `warehouses/actions.ts` dışa aktarımları dosya sisteminden DİNAMİK okunur; tabloda karşılığı olmayan yeni eylem KIRMIZI yapar.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown, headers: new Headers() }));

vi.mock("../../../apps/web/node_modules/next/headers.js", () => ({
  headers: () => Promise.resolve(h.headers),
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("../../../apps/web/node_modules/next/navigation.js", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { kind: "redirect", to });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { kind: "notFound" });
  },
}));
vi.mock("../../../packages/db/src/index.ts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAppDb: () => h.db }));
vi.mock("../../../apps/web/lib/auth-service.ts", () => ({
  getAuthService: () => ({
    getPrincipal: (headers: Headers) => {
      const u = headers.get("x-test-user");
      return Promise.resolve(u === null ? null : { userId: u, mfaVerified: true });
    },
  }),
}));

const intlMock = () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
  getFormatter: () => Promise.resolve({ dateTime: () => "" }),
  getLocale: () => Promise.resolve("tr"),
});
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const intlRoot = path.join(WEB, "node_modules/next-intl");
for (const variant of ["development/server.react-server.js", "production/server.react-server.js", "development/server.react-client.js", "production/server.react-client.js"]) {
  vi.doMock(path.join(intlRoot, "dist/esm", variant), intlMock);
}
vi.doMock("next-intl/server", intlMock);

import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const SLUG_DIR = path.join(WEB, "app/t/[slug]");
const reg = newRegistry();
const rnd = (): string => randomBytes(5).toString("hex");

type Result = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; detail?: string; requestId?: string; [k: string]: unknown } };
type Actions = Record<string, (arg: unknown) => Promise<Result>>;

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let outsider: string;
let actions: Actions;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "WMS_ENV"] as const;

let ipN = 0;
function as(user: string | null, origin: string | null = ORIGIN): void {
  const hd = new Headers({ "fly-client-ip": `198.51.100.${((ipN++ + parseInt(rnd().slice(0, 2), 16)) % 250) + 1}`, "user-agent": "t215-qa" });
  if (origin !== null) hd.set("origin", origin);
  if (user !== null) hd.set("x-test-user", user);
  h.headers = hd;
}

/** Yanıtın karşılaştırılabilir yüzü (requestId çıkarılır). */
function face(r: Result): unknown {
  if (r.ok) return r;
  const error: Record<string, unknown> = { ...r.error };
  delete error.requestId;
  return { ok: false, error };
}

/** Tenant'ın depo/lokasyon/sayım kilidi/denetim durumu (etki yok kanıtı için önce/sonra). */
async function snapshot(t: TenantWorld): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [t.tenantId])).rows;
  return {
    warehouses: await q("SELECT id, code, name, status FROM public.warehouses WHERE tenant_id = $1 ORDER BY id"),
    locations: await q("SELECT id, warehouse_id, parent_id, code, name, kind, status, depth FROM public.locations WHERE tenant_id = $1 ORDER BY id"),
    locks: await q("SELECT location_id, status FROM public.location_count_locks WHERE tenant_id = $1 ORDER BY location_id"),
    audit: await q("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1"),
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), WMS_ENV: "ci" });
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  h.db = app;
  A = await seedWorld(adm, reg, "A215");
  B = await seedWorld(adm, reg, "B215");
  outsider = await mkUser(adm, reg, "outsider215");
  actions = (await import(/* @vite-ignore */ path.join(SLUG_DIR, "warehouses/actions.ts"))) as Actions;
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Sayfa yükleyicileri
// ---------------------------------------------------------------------------------------------

type Loader = (props: { params: Promise<{ slug: string; warehouseId?: string }>; searchParams?: Promise<Record<string, string>> }) => Promise<unknown>;
async function runLoader(rel: string, slug: string, warehouseId: string): Promise<{ outcome: "render" | "notFound" | "redirect"; to?: string; value?: unknown }> {
  const mod = (await import(/* @vite-ignore */ path.join(SLUG_DIR, rel))) as { default: Loader };
  try {
    const value = await mod.default({ params: Promise.resolve({ slug, warehouseId }), searchParams: Promise.resolve({}) });
    return { outcome: "render", value };
  } catch (e) {
    const k = (e as { kind?: string }).kind;
    if (k === "notFound") return { outcome: "notFound" };
    if (k === "redirect") return { outcome: "redirect", to: (e as { to: string }).to };
    throw e;
  }
}

function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pagesUnder(full));
    else if (/^(page|layout)\.[cm]?[jt]sx?$/.test(name)) out.push(path.relative(SLUG_DIR, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const WAREHOUSE_LOADERS = ["warehouses/page.tsx", "warehouses/[warehouseId]/page.tsx"] as const;

describe("depo sayfa yükleyicileri (/t/<slug>/warehouses)", () => {
  it("@AC-04 kapsam: warehouses altındaki her page/layout bu tabloda", () => {
    expect(pagesUnder(path.join(SLUG_DIR, "warehouses"))).toEqual([...WAREHOUSE_LOADERS].sort());
  });

  for (const rel of WAREHOUSE_LOADERS) {
    it(`@AC-04 ${rel}: A kullanıcısı B'nin slug'ıyla -> 404, var olmayan slug ile aynı sonuç, B verisi çizilmez`, async () => {
      as(A.ownerUserId);
      const cross = await runLoader(rel, B.slug, B.warehouseId);
      as(A.ownerUserId);
      const missing = await runLoader(rel, `yok-${rnd()}`, B.warehouseId);
      expect(cross).toEqual({ outcome: "notFound" });
      expect(cross).toEqual(missing);
    });

    it(`@AC-04 ${rel}: tenant üyesi olmayan oturum -> 404; oturumsuz -> /login; A kendi slug'ında çizer (olumlu kontrol)`, async () => {
      as(outsider);
      expect(await runLoader(rel, B.slug, B.warehouseId)).toEqual({ outcome: "notFound" });
      as(A.memberUserId); // A'nın PICKER'ı B slug'ında da üye değildir
      expect(await runLoader(rel, B.slug, B.warehouseId)).toEqual({ outcome: "notFound" });
      as(null);
      const anon = await runLoader(rel, B.slug, B.warehouseId);
      expect(anon.outcome).toBe("redirect");
      expect(anon.to).toMatch(/^\/login\?next=/);
      as(A.ownerUserId);
      const own = await runLoader(rel, A.slug, A.warehouseId);
      expect(own.outcome).toBe("render");
      expect(own.value).not.toBeNull();
    });
  }

  it("@AC-04 /t/<A-slug>/warehouses/<B-depo-kimliği>: 404 (var olmayan kimlikle aynı); liste ve ağaç B verisi taşımaz", async () => {
    as(A.ownerUserId);
    const cross = await runLoader("warehouses/[warehouseId]/page.tsx", A.slug, B.warehouseId);
    as(A.ownerUserId);
    const missing = await runLoader("warehouses/[warehouseId]/page.tsx", A.slug, randomUUID());
    expect(cross).toEqual({ outcome: "notFound" });
    expect(cross).toEqual(missing);
    as(A.ownerUserId);
    const list = await runLoader("warehouses/page.tsx", A.slug, A.warehouseId);
    expect(list.outcome).toBe("render");
    const dump = JSON.stringify(list.value);
    expect(dump).toContain(A.warehouseId);
    expect(dump).not.toContain(B.warehouseId);
    as(A.ownerUserId);
    const tree = await runLoader("warehouses/[warehouseId]/page.tsx", A.slug, A.warehouseId);
    expect(tree.outcome).toBe("render");
    expect(JSON.stringify(tree.value)).not.toContain(B.childLocationId);
  });
});

// ---------------------------------------------------------------------------------------------
// Server Action'lar
// ---------------------------------------------------------------------------------------------

/** Her eylem için B'ye ait kimliklerle çağrı kurar. */
type Call = (slug: string) => Promise<Result>;
const loc = (code: string): string => `${code}-${rnd()}`.toUpperCase();
const ACTIONS: Record<string, Call> = {
  createWarehouseAction: (slug) => actions.createWarehouseAction!({ slug, code: loc("W"), name: "Ele Gecirildi" }),
  archiveWarehouseAction: (slug) => actions.archiveWarehouseAction!({ slug, warehouseId: B.warehouseId }),
  createLocationAction: (slug) => actions.createLocationAction!({ slug, warehouseId: B.warehouseId, parentId: null, code: loc("L"), name: "Ele Gecirildi", kind: "STORAGE" }),
  archiveLocationAction: (slug) => actions.archiveLocationAction!({ slug, locationId: B.childLocationId }),
  renameWarehouseAction: (slug) => actions.renameWarehouseAction!({ slug, warehouseId: B.warehouseId, code: loc("W") }),
  renameLocationAction: (slug) => actions.renameLocationAction!({ slug, locationId: B.childLocationId, code: loc("L") }),
  loadMoreLocationsAction: (slug) =>
    actions.loadMoreLocationsAction!({ slug, warehouseId: B.warehouseId, after: { depth: 0, code: "A", id: randomUUID() } }),
};

describe("depo Server Action'ları", () => {
  it("@AC-04 kapsam: warehouses/actions.ts dışa aktarımlarının tamamı tabloda (yeni eylem testsiz kalamaz)", () => {
    expect(Object.keys(actions).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  for (const [name, call] of Object.entries(ACTIONS)) {
    it(`@AC-04 ${name}: A yöneticisi B'nin slug'ıyla -> NOT_FOUND (var olmayan slug ile aynı yanıt); A ve B'de hiçbir değişiklik yok`, async () => {
      const beforeA = await snapshot(A);
      const beforeB = await snapshot(B);
      as(A.ownerUserId);
      const cross = await call(B.slug);
      as(A.ownerUserId);
      const missing = await call(`yok-${rnd()}`);
      expect(cross.ok, JSON.stringify(cross)).toBe(false);
      if (!cross.ok) expect(cross.error.code).toBe("NOT_FOUND");
      expect(face(cross)).toEqual(face(missing));
      expect(JSON.stringify(cross)).not.toContain(B.slug);
      expect(JSON.stringify(cross)).not.toContain(B.warehouseId);
      expect(await snapshot(B)).toEqual(beforeB);
      expect(await snapshot(A)).toEqual(beforeA);
    });

    it(`@AC-04 ${name}: tenant üyesi olmayan kullanıcı ve B'nin yöneticisi (A slug'ıyla, B kimlikleriyle) -> NOT_FOUND, etki yok`, async () => {
      const beforeA = await snapshot(A);
      const beforeB = await snapshot(B);
      for (const user of [outsider, B.ownerUserId, B.memberUserId]) {
        as(user);
        const r = await call(A.slug);
        expect(r.ok, `${name} ${user}`).toBe(false);
        if (!r.ok) expect(["NOT_FOUND", "FORBIDDEN"]).toContain(r.error.code);
      }
      expect(await snapshot(A)).toEqual(beforeA);
      expect(await snapshot(B)).toEqual(beforeB);
    });
  }

  it("@AC-04 A slug'ında B'nin warehouseId'si: createLocation/archiveWarehouse/archiveLocation/loadMore -> NOT_FOUND (var olmayan kimlikle aynı yanıt), etki yok", async () => {
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    const pairs: Array<[string, (id: string) => Promise<Result>]> = [
      ["createLocation", (id) => actions.createLocationAction!({ slug: A.slug, warehouseId: id, parentId: null, code: "ZZ1", name: "x", kind: "STORAGE" })],
      ["archiveWarehouse", (id) => actions.archiveWarehouseAction!({ slug: A.slug, warehouseId: id })],
      ["loadMore", (id) => actions.loadMoreLocationsAction!({ slug: A.slug, warehouseId: id, after: { depth: 0, code: "A", id: randomUUID() } })],
      ["archiveLocation", (id) => actions.archiveLocationAction!({ slug: A.slug, locationId: id })],
      ["renameWarehouse", (id) => actions.renameWarehouseAction!({ slug: A.slug, warehouseId: id, code: "ZZ4" })],
      ["renameLocation", (id) => actions.renameLocationAction!({ slug: A.slug, locationId: id, code: "ZZ5" })],
    ];
    for (const [name, fn] of pairs) {
      const foreign = name === "archiveLocation" || name === "renameLocation" ? B.childLocationId : B.warehouseId;
      as(A.ownerUserId);
      const cross = await fn(foreign);
      as(A.ownerUserId);
      const missing = await fn(randomUUID());
      expect(cross.ok, `${name} ${JSON.stringify(cross)}`).toBe(false);
      if (!cross.ok) expect(cross.error.code, name).toBe("NOT_FOUND");
      expect(face(cross), name).toEqual(face(missing));
    }
    expect(await snapshot(A)).toEqual(beforeA);
    expect(await snapshot(B)).toEqual(beforeB);
  });

  it("@AC-04 A slug'ında A deposu + B'nin parentId'si ile createLocation -> PARENT_INVALID (var olmayan ebeveynle aynı yanıt; B'nin lokasyonu sızmaz), etki yok", async () => {
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    const call = (parentId: string): Promise<Result> =>
      actions.createLocationAction!({ slug: A.slug, warehouseId: A.warehouseId, parentId, code: "ZZ2", name: "x", kind: "STORAGE" });
    as(A.ownerUserId);
    const cross = await call(B.rootLocationId);
    as(A.ownerUserId);
    const missing = await call(randomUUID());
    expect(cross.ok, JSON.stringify(cross)).toBe(false);
    if (!cross.ok) {
      expect(cross.error.code).toBe("VALIDATION_FAILED");
      expect(cross.error.detail).toBe("PARENT_INVALID");
    }
    expect(face(cross)).toEqual(face(missing));
    expect(await snapshot(A)).toEqual(beforeA);
    expect(await snapshot(B)).toEqual(beforeB);
    // Olumlu kontrol: aynı çağrı A'nın KENDİ ebeveyniyle başarılı olur (reddin sebebi gerçekten yabancı kimliktir).
    as(A.ownerUserId);
    const ok = await call(A.rootLocationId);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("@AC-04 A slug'ında B'nin warehouseId'si + B'nin parentId'si birlikte -> NOT_FOUND (depo ebeveynden önce çözülür); B lokasyon sayısı değişmez", async () => {
    const before = (await adm.query("SELECT count(*)::int AS n FROM public.locations WHERE tenant_id = $1", [B.tenantId])).rows[0];
    as(A.ownerUserId);
    const r = await actions.createLocationAction!({ slug: A.slug, warehouseId: B.warehouseId, parentId: B.rootLocationId, code: "ZZ3", name: "x", kind: "STORAGE" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    expect((await adm.query("SELECT count(*)::int AS n FROM public.locations WHERE tenant_id = $1", [B.tenantId])).rows[0]).toEqual(before);
    expect((await adm.query("SELECT count(*)::int AS n FROM public.locations WHERE tenant_id = $1 AND code = 'ZZ3'", [A.tenantId])).rows[0]).toEqual({ n: 0 });
  });
});
