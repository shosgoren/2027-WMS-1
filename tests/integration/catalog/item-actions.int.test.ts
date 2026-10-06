// T-216: ürün kartı Server Action'larında yetki ve köken reddi — GERÇEK sorgu yolu (gerçek `wms_app`, RLS, `runTenantCommand`).
// `apps/web/app/t/[slug]/items/actions.test.ts` domain'i sahteler ve yetkiyi KANITLAMAZ; bu dosya kanıtlar.
// Mock'lar yalnızca Next çalışma zamanı ve kimlik çözümüdür (`x-test-user` başlığı = oturumdaki kullanıcı). Fikstürler sentetik (G-09).
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown, headers: new Headers() }));

vi.mock("../../../apps/web/node_modules/next/headers.js", () => ({
  headers: () => Promise.resolve(h.headers),
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
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

import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex");

type Result = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; detail?: string } };
type Actions = Record<string, (arg: unknown) => Promise<Result>>;

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let actions: Actions;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "WMS_ENV"] as const;

let ipN = 0;
function as(user: string | null, origin: string | null = ORIGIN): void {
  const hd = new Headers({ "fly-client-ip": `198.51.100.${(++ipN % 250) + 1}`, "user-agent": "t216-qa" });
  if (origin !== null) hd.set("origin", origin);
  if (user !== null) hd.set("x-test-user", user);
  h.headers = hd;
}

/** Tenant'ın ürün/dönüşüm/barkod durumu ve ilgili denetim kayıtları (etki yok kanıtı için önce/sonra). */
async function state(w: TenantWorld = A): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [w.tenantId])).rows;
  return {
    items: await q("SELECT id, code, name, status, pick_policy, tracking_mode, quantity_scale FROM public.items WHERE tenant_id = $1 ORDER BY id"),
    conversions: await q("SELECT item_id, unit_id, to_base_factor::text AS factor FROM public.unit_conversions WHERE tenant_id = $1 ORDER BY item_id, unit_id"),
    barcodes: await q("SELECT id, item_id, unit_id, barcode, quantity::text AS quantity FROM public.item_barcodes WHERE tenant_id = $1 ORDER BY id"),
    audit: await q("SELECT action, entity_id FROM public.audit_logs WHERE tenant_id = $1 AND (action LIKE 'item.%' OR action LIKE 'item_barcode.%' OR action LIKE 'unit_conversion.%') ORDER BY action, entity_id"),
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
  A = await seedWorld(adm, reg, "A216");
  B = await seedWorld(adm, reg, "B216");
  actions = (await import(/* @vite-ignore */ path.join(WEB, "app/t/[slug]/items/actions.ts"))) as Actions;
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
}, 60_000);

/** Her yazma eylemi, geçerli girdiyle (yetki dışında reddedilecek hiçbir neden yok). */
function writeCalls(barcodeId: string): Array<[string, () => Promise<Result>]> {
  return [
    ["createItemAction", () => actions.createItemAction!({ slug: A.slug, code: `X-${rnd()}`, name: "Yetkisiz", baseUnitId: A.unitId })],
    ["updateItemAction", () => actions.updateItemAction!({ slug: A.slug, itemId: A.itemNoneId, name: `Yeni ${rnd()}` })],
    ["archiveItemAction", () => actions.archiveItemAction!({ slug: A.slug, itemId: A.itemTwoId })],
    ["setConversionAction", () => actions.setConversionAction!({ slug: A.slug, itemId: A.itemNoneId, unitId: A.boxUnitId, factor: "7.5" })],
    ["addBarcodeAction", () => actions.addBarcodeAction!({ slug: A.slug, itemId: A.itemNoneId, unitId: null, barcode: `8${rnd()}${rnd()}`, quantity: null })],
    ["removeBarcodeAction", () => actions.removeBarcodeAction!({ slug: A.slug, barcodeId })],
  ];
}

describe("items/actions.ts yetki ve köken (gerçek sorgu yolu)", () => {
  let barcodeId = "";

  it("olumlu kontrol: yönetici oluşturur, dönüşüm katsayısı dizgi olarak kalır, barkod ekler (testin geçersiz kılınmadığının kanıtı)", async () => {
    const code = `T216-${rnd()}`.toUpperCase();
    as(A.ownerUserId);
    const created = await actions.createItemAction!({ slug: A.slug, code, name: "Yönetici ürünü", baseUnitId: A.unitId });
    expect(created.ok).toBe(true);
    const rows = await adm.query<{ id: string; tracking_mode: string; quantity_scale: number; pick_policy: string }>(
      "SELECT id, tracking_mode, quantity_scale, pick_policy FROM public.items WHERE tenant_id = $1 AND code = $2",
      [A.tenantId, code],
    );
    expect(rows.rows.map(({ tracking_mode, quantity_scale, pick_policy }) => ({ tracking_mode, quantity_scale, pick_policy }))).toEqual([{ tracking_mode: "NONE", quantity_scale: 0, pick_policy: "FIFO" }]);
    const itemId = (rows.rows[0] as { id: string }).id;

    as(A.ownerUserId);
    const conv = await actions.setConversionAction!({ slug: A.slug, itemId, unitId: A.boxUnitId, factor: "12.500000" });
    expect(conv).toEqual({ ok: true, data: { factor: "12.5" } });
    const factor = await adm.query<{ f: string }>("SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE tenant_id = $1 AND item_id = $2", [A.tenantId, itemId]);
    expect(factor.rows).toEqual([{ f: "12.500000" }]);

    as(A.ownerUserId);
    const bc = await actions.addBarcodeAction!({ slug: A.slug, itemId, unitId: A.boxUnitId, barcode: `7${rnd()}${rnd()}`, quantity: "12" });
    expect(bc.ok).toBe(true);
    barcodeId = (bc as { ok: true; data: { barcodeId: string } }).data.barcodeId;
    const stored = await adm.query<{ quantity: string }>("SELECT quantity::text AS quantity FROM public.item_barcodes WHERE tenant_id = $1 AND id = $2", [A.tenantId, barcodeId]);
    expect(stored.rows).toEqual([{ quantity: "12.000000" }]);
  });

  it("PICKER: her yazma eylemi FORBIDDEN, veritabanında ve denetim kaydında hiçbir değişiklik yok", async () => {
    expect(barcodeId).not.toBe("");
    const before = await state();
    for (const [name, call] of writeCalls(barcodeId)) {
      as(A.memberUserId);
      const res = await call();
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.error.code, name).toBe("FORBIDDEN");
    }
    expect(await state()).toEqual(before);
  });

  it("yanlış, farklı ve eksik Origin: her eylem FORBIDDEN, yönetici bile olsa hiçbir değişiklik yok", async () => {
    expect(barcodeId).not.toBe("");
    const before = await state();
    for (const origin of ["https://evil.example.test", `${ORIGIN}.evil.test`, null]) {
      for (const [name, call] of writeCalls(barcodeId)) {
        as(A.ownerUserId, origin);
        const res = await call();
        expect(res.ok, `${name} ${String(origin)}`).toBe(false);
        if (!res.ok) expect(res.error.code, `${name} ${String(origin)}`).toBe("FORBIDDEN");
      }
    }
    expect(await state()).toEqual(before);
  });

  it("oturumsuz: her eylem UNAUTHENTICATED, değişiklik yok", async () => {
    expect(barcodeId).not.toBe("");
    const before = await state();
    for (const [name, call] of writeCalls(barcodeId)) {
      as(null);
      const res = await call();
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.error.code, name).toBe("UNAUTHENTICATED");
    }
    expect(await state()).toEqual(before);
  });
});

describe("items/actions.ts tenant'lar arası (gerçek sorgu yolu)", () => {
  /** Altı eylem; `ids` hangi tenant'ın kimlikleriyle çağrılacağını belirler. */
  function calls(slug: string, ids: { itemId: string; unitId: string; barcodeId: string }): Array<[string, () => Promise<Result>]> {
    return [
      ["createItemAction", () => actions.createItemAction!({ slug, code: `X-${rnd()}`, name: "Çapraz", baseUnitId: ids.unitId })],
      ["updateItemAction", () => actions.updateItemAction!({ slug, itemId: ids.itemId, name: `Çapraz ${rnd()}` })],
      ["archiveItemAction", () => actions.archiveItemAction!({ slug, itemId: ids.itemId })],
      ["setConversionAction", () => actions.setConversionAction!({ slug, itemId: ids.itemId, unitId: ids.unitId, factor: "3" })],
      ["addBarcodeAction", () => actions.addBarcodeAction!({ slug, itemId: ids.itemId, unitId: ids.unitId, barcode: `8${rnd()}${rnd()}`, quantity: null })],
      ["removeBarcodeAction", () => actions.removeBarcodeAction!({ slug, barcodeId: ids.barcodeId })],
    ];
  }
  const face = (r: Result): unknown => (r.ok ? r : { ok: false, error: { code: r.error.code, detail: r.error.detail } });

  it("A yöneticisi B'nin slug'ıyla: her eylem NOT_FOUND ve var olmayan slug'la aynı yanıt; A ve B'de değişiklik yok", async () => {
    // B'de silinecek bir barkod bulunsun (removeBarcodeAction gerçekten bir şeyi hedefleyebilsin).
    const bBarcode = (await adm.query<{ id: string }>("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3) RETURNING id", [B.tenantId, B.itemNoneId, `7${rnd()}${rnd()}`])).rows[0]!.id;
    const ids = { itemId: B.itemNoneId, unitId: B.boxUnitId, barcodeId: bBarcode };
    const beforeA = await state(A);
    const beforeB = await state(B);
    const cross = calls(B.slug, ids);
    const missing = calls(`yok-${rnd()}`, ids);
    for (const [i, [name, call]] of cross.entries()) {
      as(A.ownerUserId);
      const c = await call();
      as(A.ownerUserId);
      const m = await (missing[i] as [string, () => Promise<Result>])[1]();
      expect(c.ok, name).toBe(false);
      if (!c.ok) expect(c.error.code, name).toBe("NOT_FOUND");
      expect(face(c), name).toEqual(face(m));
      expect(JSON.stringify(c), name).not.toContain(B.slug);
    }
    expect(await state(A)).toEqual(beforeA);
    expect(await state(B)).toEqual(beforeB);
  });

  it("A slug'ında B'nin itemId/barcodeId/unitId'si: her eylem NOT_FOUND, B ve A'da değişiklik yok", async () => {
    const bBarcode = (await adm.query<{ id: string }>("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3) RETURNING id", [B.tenantId, B.itemNoneId, `6${rnd()}${rnd()}`])).rows[0]!.id;
    const beforeA = await state(A);
    const beforeB = await state(B);
    for (const [name, call] of calls(A.slug, { itemId: B.itemNoneId, unitId: B.boxUnitId, barcodeId: bBarcode })) {
      as(A.ownerUserId);
      const r = await call();
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error.code, name).toBe("NOT_FOUND");
    }
    // Karışık: A'nın ürünü + B'nin birimi (dönüşüm/barkod) de reddedilir.
    as(A.ownerUserId);
    const mixedConv = await actions.setConversionAction!({ slug: A.slug, itemId: A.itemNoneId, unitId: B.boxUnitId, factor: "3" });
    as(A.ownerUserId);
    const mixedBc = await actions.addBarcodeAction!({ slug: A.slug, itemId: A.itemNoneId, unitId: B.boxUnitId, barcode: `5${rnd()}${rnd()}`, quantity: null });
    for (const r of [mixedConv, mixedBc]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    }
    expect(await state(A)).toEqual(beforeA);
    expect(await state(B)).toEqual(beforeB);
  });
});
