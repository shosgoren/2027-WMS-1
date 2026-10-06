// katman: API (sayfa/eylem)
// AC-04 — bağımsız kabul testi (T-219, qa-verifier): "Tenant A, B'nin ID'sini kullanır -> API, DB, dosya, cache, export reddeder".
// Kapsam: ürün/birim/barkod Server Action'ları (`/t/<slug>/items/actions.ts`) ve `/t/<slug>/items` sayfası.
//   (1) A oturumu + B slug'ı -> her eylem NOT_FOUND, var olmayan slug'la aynı yanıt, B'de etki yok.
//   (2) A oturumu + A slug'ı + B'nin itemId/unitId/barcodeId'si -> NOT_FOUND, var olmayan kimlikle AYNI yanıt (varlık sızmaz).
// Mock'lar YALNIZCA Next çalışma zamanı ve kimlik çözümüdür (ac-04-api-slug.int.test.ts ile aynı desen); eylem sarmalayıcısı, domain
// komutları, RLS ve `wms_app` rolü GERÇEKTİR. Veriler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
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
  ensureRecentAuth: () => Promise.resolve(),
  getAuthService: () => ({
    getPrincipal: (headers: Headers) => {
      const u = headers.get("x-test-user");
      return Promise.resolve(u === null ? null : { userId: u, mfaVerified: true });
    },
  }),
}));
vi.mock("../../../apps/web/lib/queue.ts", () => ({ getSenderQueue: () => Promise.resolve(undefined) }));

import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const rnd = (): string => randomBytes(6).toString("hex");

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let bBarcode: string;
let aBarcode: string;
type ActionResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; requestId?: string; [k: string]: unknown } };
type Actions = Record<string, (arg: unknown) => Promise<ActionResult>>;
let act: Actions;

let ipN = 0;
const nextIp = (): string => `198.51.100.${((parseInt(rnd().slice(0, 2), 16) + ++ipN) % 250) + 1}`;
function as(user: string | null): void {
  const hd = new Headers({ "fly-client-ip": nextIp(), "user-agent": "t219-qa", origin: ORIGIN });
  if (user !== null) hd.set("x-test-user", user);
  h.headers = hd;
}
function face(r: ActionResult): unknown {
  if (r.ok) return r;
  const error: Record<string, unknown> = { ...r.error };
  delete error.requestId;
  return { ok: false, error };
}
/** B tenant'ının gözlemlenebilir katalog durumu (etki yok kanıtı). */
async function snapshot(t: TenantWorld): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [t.tenantId])).rows;
  return {
    items: await q("SELECT id, code, name, status, tracking_mode, quantity_scale, pick_policy FROM public.items WHERE tenant_id = $1 ORDER BY id"),
    conv: await q("SELECT item_id, unit_id, to_base_factor::text AS f FROM public.unit_conversions WHERE tenant_id = $1 ORDER BY item_id, unit_id"),
    barcodes: await q("SELECT id, item_id, unit_id, barcode, quantity::text AS q FROM public.item_barcodes WHERE tenant_id = $1 ORDER BY id"),
    units: await q("SELECT id, code, name, status FROM public.units WHERE tenant_id = $1 ORDER BY id"),
    audit: await q("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1"),
  };
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "WMS_ENV", "MAIL_MODE", "MAILPIT_URL", "MAIL_FROM", "DEMO_EMAIL_DOMAIN", "SIGNUP_ENABLED"] as const;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), // sentetik, koşu başına
    WMS_ENV: "ci",
    MAIL_MODE: "mailpit",
    MAILPIT_URL: "http://localhost:8025",
    MAIL_FROM: "noreply@example.test",
  });
  delete process.env.DEMO_EMAIL_DOMAIN;
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  h.db = app;
  const reg = newRegistry();
  A = await seedWorld(adm, reg, "A");
  B = await seedWorld(adm, reg, "B");
  const mk = async (w: TenantWorld): Promise<string> =>
    (await adm.query<{ id: string }>("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3) RETURNING id", [w.tenantId, w.itemTwoId, `8${rnd()}`])).rows[0]!.id;
  bBarcode = await mk(B);
  aBarcode = await mk(A);
  act = (await import(/* @vite-ignore */ path.join(WEB, "app/t/[slug]/items/actions.ts"))) as Actions;
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
}, 60_000);

/** Her çağrı B'nin kimlikleriyle yapılır; `slug` A ya da B ya da var olmayan olabilir. */
type Call = (slug: string) => Promise<ActionResult>;
const calls = (): Record<string, Call> => ({
  createItemAction: (slug) => act.createItemAction!({ slug, code: `X-${rnd()}`, name: "Ele geçirme", baseUnitId: B.unitId }),
  updateItemAction: (slug) => act.updateItemAction!({ slug, itemId: B.itemId, name: "Ele Gecirildi" }),
  archiveItemAction: (slug) => act.archiveItemAction!({ slug, itemId: B.itemTwoId }),
  setConversionAction: (slug) => act.setConversionAction!({ slug, itemId: B.itemId, unitId: B.boxUnitId, factor: "99" }),
  addBarcodeAction: (slug) => act.addBarcodeAction!({ slug, itemId: B.itemId, unitId: null, barcode: `9${rnd()}`, quantity: null }),
  removeBarcodeAction: (slug) => act.removeBarcodeAction!({ slug, barcodeId: bBarcode }),
});

describe("katalog eylemleri (API: Server Action)", () => {
  it("@AC-04 kapsam: items/actions.ts dışa aktarımlarının tamamı bu tabloda (yeni eylem testsiz kalamaz)", () => {
    expect(Object.keys(act).sort()).toEqual(Object.keys(calls()).sort());
  });

  for (const name of Object.keys(calls())) {
    it(`@AC-04 ${name}: A yöneticisi B'nin slug'ıyla -> NOT_FOUND, var olmayan slug'la aynı yanıt; B'de değişiklik yok; B'nin adı/slug'ı sızmaz`, async () => {
      const before = await snapshot(B);
      as(A.ownerUserId);
      const cross = await calls()[name]!(B.slug);
      as(A.ownerUserId);
      const missing = await calls()[name]!(`yok-${rnd()}`);
      expect(cross.ok, JSON.stringify(cross)).toBe(false);
      if (!cross.ok) expect(cross.error.code).toBe("NOT_FOUND");
      expect(face(cross)).toEqual(face(missing));
      expect(JSON.stringify(cross)).not.toContain(B.slug);
      expect(JSON.stringify(cross)).not.toContain(B.tenantId);
      expect(await snapshot(B)).toEqual(before);
    });
  }

  it("@AC-04 A'nın slug'ında B'nin itemId/unitId/barcodeId'si: addBarcode/setUnitConversion/update/archive/removeBarcode -> NOT_FOUND, rastgele kimlikle birebir aynı yanıt; B'de etki yok", async () => {
    const before = await snapshot(B);
    const beforeA = await snapshot(A);
    const run = async (mk: (ids: { item: string; unit: string; box: string; barcode: string }) => Promise<ActionResult>, foreign: boolean): Promise<ActionResult> => {
      as(A.ownerUserId);
      return mk(foreign ? { item: B.itemId, unit: B.unitId, box: B.boxUnitId, barcode: bBarcode } : { item: randomUUID(), unit: randomUUID(), box: randomUUID(), barcode: randomUUID() });
    };
    const cases: Record<string, (ids: { item: string; unit: string; box: string; barcode: string }) => Promise<ActionResult>> = {
      "addBarcode(B itemId)": (i) => act.addBarcodeAction!({ slug: A.slug, itemId: i.item, unitId: null, barcode: `7${rnd()}`, quantity: null }),
      "addBarcode(A itemId + B unitId)": (i) => act.addBarcodeAction!({ slug: A.slug, itemId: A.itemId, unitId: i.box, barcode: `7${rnd()}`, quantity: "2" }),
      "setConversion(B itemId)": (i) => act.setConversionAction!({ slug: A.slug, itemId: i.item, unitId: A.boxUnitId, factor: "5" }),
      "setConversion(A itemId + B unitId)": (i) => act.setConversionAction!({ slug: A.slug, itemId: A.itemId, unitId: i.box, factor: "5" }),
      "updateItem(B itemId)": (i) => act.updateItemAction!({ slug: A.slug, itemId: i.item, name: "Ele Gecirildi" }),
      "archiveItem(B itemId)": (i) => act.archiveItemAction!({ slug: A.slug, itemId: i.item }),
      "removeBarcode(B barcodeId)": (i) => act.removeBarcodeAction!({ slug: A.slug, barcodeId: i.barcode }),
      "createItem(B baseUnitId)": (i) => act.createItemAction!({ slug: A.slug, code: `X-${rnd()}`, name: "Ele geçirme", baseUnitId: i.unit }),
    };
    for (const [name, mk] of Object.entries(cases)) {
      const cross = await run(mk, true);
      const missing = await run(mk, false);
      expect(cross.ok, `${name}: ${JSON.stringify(cross)}`).toBe(false);
      if (!cross.ok) expect(cross.error.code, name).toBe("NOT_FOUND");
      expect(face(cross), name).toEqual(face(missing));
      expect(JSON.stringify(cross), name).not.toContain(B.itemId);
      expect(JSON.stringify(cross), name).not.toContain(B.boxUnitId);
    }
    expect(await snapshot(B)).toEqual(before);
    expect(await snapshot(A)).toEqual(beforeA);
    // Olumlu kontrol: aynı eylem A'nın KENDİ kimlikleriyle çalışır (testin geçersiz kılınmadığının kanıtı).
    as(A.ownerUserId);
    const ok = await act.setConversionAction!({ slug: A.slug, itemId: A.itemId, unitId: A.boxUnitId, factor: "5" });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    as(A.ownerUserId);
    const okBc = await act.removeBarcodeAction!({ slug: A.slug, barcodeId: aBarcode });
    expect(okBc.ok, JSON.stringify(okBc)).toBe(true);
  });

  it("@AC-04 hiçbir tenant'ın üyesi olmayan oturum ve B'nin düşük yetkili üyesi (A slug'ıyla) -> NOT_FOUND/FORBIDDEN, etki yok; oturumsuz -> UNAUTHENTICATED", async () => {
    const outsider = (await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T219 outsider', $1, true) RETURNING id", [`t219-${rnd()}@example.test`])).rows[0]!.id;
    const beforeA = await snapshot(A);
    for (const name of Object.keys(calls())) {
      for (const user of [outsider, B.ownerUserId, B.memberUserId, A.memberUserId]) {
        as(user);
        const r = await calls()[name]!(A.slug);
        expect(r.ok, `${name} ${user}`).toBe(false);
        if (!r.ok) expect(["NOT_FOUND", "FORBIDDEN"], `${name} ${user}`).toContain(r.error.code);
      }
      as(null);
      const anon = await calls()[name]!(A.slug);
      expect(anon.ok === false && anon.error.code, name).toBe("UNAUTHENTICATED");
    }
    expect(await snapshot(A)).toEqual(beforeA);
  });
});
