// katman: API (sayfa/eylem)
// AC-04 — bağımsız kabul testi (T-124, qa-verifier): "Tenant A, B'nin ID'sini kullanır -> API, DB, dosya, cache, export reddeder".
// Bu dosya YALNIZCA sayfa yükleyicileri (`/t/<slug>` layout + sayfalar) ve Server Action katmanını kanıtlar; route handler/export/
// dosya/cache T-128, DB T-104'tür.
//
// Mock'lar YALNIZCA Next çalışma zamanı ve kimlik çözümüdür: `next/headers` (istek başlıkları), `next/navigation`
// (redirect/notFound -> ayırt edilebilir fırlatma), `next-intl/server` (çeviri anahtarı geri verir), `lib/auth-service`
// (`x-test-user` başlığı = oturumdaki kullanıcı) ve `lib/queue`. Eylem sarmalayıcısı (Origin, hız sınırı, hata maskeleme),
// domain komutları (withMembership), RLS ve `wms_app` rolü GERÇEKTİR. Veriler sentetik (G-09).
//
// Kapsam kuralı: `apps/web/app/t/[slug]` altındaki her sayfa/layout ve `members/actions.ts` / `settings/actions.ts` dışa aktarımları
// dosya sisteminden DİNAMİK listelenir; tabloda karşılığı olmayan yeni bir yükleyici/eylem testi KIRMIZI yapar.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown, headers: new Headers() }));

// `next` / `next-intl` yalnızca apps/web bağımlılığıdır: kökten çözülemez; uygulamanın kopyaları dosya yoluyla hedeflenir.
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
  createPasswordResetToken: () => Promise.reject(new Error("not used")),
  discardPasswordResetToken: () => Promise.resolve(),
  recordPasswordResetLinkIssued: () => Promise.resolve(),
  createInvitedAccount: () => Promise.reject(new Error("account creation must not be reached")),
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
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const SLUG_DIR = path.join(WEB, "app/t/[slug]");
const rnd = (): string => randomBytes(6).toString("hex");

// next-intl: paket koşula göre farklı dosyalara çözülür; hepsi aynı sahte modüle bağlanır (yalnızca çeviri anahtarı döner).
const intlMock = () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
  getFormatter: () => Promise.resolve({ dateTime: () => "" }),
  getLocale: () => Promise.resolve("tr"),
});
const intlRoot = path.join(WEB, "node_modules/next-intl");
for (const variant of ["development/server.react-server.js", "production/server.react-server.js", "development/server.react-client.js", "production/server.react-client.js"]) {
  vi.doMock(path.join(intlRoot, "dist/esm", variant), intlMock);
}
vi.doMock("next-intl/server", intlMock);

let app: DbClient;
let adm: pg.Client;

interface Fx {
  label: string;
  tenant: string;
  slug: string;
  name: string;
  admin: string;
  manager: string;
  picker: string;
  adminMembership: string;
  managerMembership: string;
  pickerMembership: string;
  /** T-207: tenant'a ait sentetik depo (depo sayfası yükleyicileri için). */
  warehouse: string;
  warehouseName: string;
}

async function mkUser(label: string): Promise<{ id: string; email: string }> {
  const email = `t124-${label}-${rnd()}@example.test`.toLowerCase();
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [`T124 ${label}`, email]);
  return { id: (r.rows[0] as { id: string }).id, email };
}
async function mkMember(tenant: string, role: string, label: string, owner = false): Promise<{ user: string; membership: string }> {
  const u = await mkUser(label);
  const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id", [tenant, u.id, owner]);
  const membership = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membership, role]);
  return { user: u.id, membership };
}
async function mkTenant(label: string): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t124-${label.toLowerCase()}-${rnd()}`;
  const name = `T124 ${label} ${rnd()}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, $3)", [tenant, slug, name]);
  await adm.query("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'Europe/Istanbul', 'COMPLETED')", [tenant]);
  const a = await mkMember(tenant, "TENANT_ADMIN", `${label}-admin`, true);
  const m = await mkMember(tenant, "WAREHOUSE_MANAGER", `${label}-manager`);
  const p = await mkMember(tenant, "PICKER", `${label}-picker`);
  const warehouse = randomUUID();
  const warehouseName = `T207 Depo ${label} ${rnd()}`;
  await adm.query("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, $4)", [tenant, warehouse, `W-${label}`, warehouseName]);
  return { label, tenant, slug, name, warehouse, warehouseName, admin: a.user, manager: m.user, picker: p.user, adminMembership: a.membership, managerMembership: m.membership, pickerMembership: p.membership };
}

/** Tenant'ın gözlemlenebilir tüm durumu (etki yok kanıtı için önce/sonra karşılaştırılır). */
async function snapshot(t: Fx): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [t.tenant])).rows;
  return {
    tenant: await q("SELECT name, status FROM public.tenants WHERE id = $1"),
    settings: await q("SELECT locale, time_zone, onboarding_status, terminology FROM public.tenant_settings WHERE tenant_id = $1"),
    memberships: await q("SELECT id, user_id, status, is_owner, roles_version FROM public.tenant_memberships WHERE tenant_id = $1 ORDER BY id"),
    roles: await q("SELECT membership_id, role_key FROM public.membership_roles WHERE tenant_id = $1 ORDER BY membership_id, role_key"),
    invitations: await q("SELECT id, revoked_at, accepted_at FROM public.invitations WHERE tenant_id = $1 ORDER BY id"),
    audit: await q("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1"),
  };
}

let ipN = 0;
const nextIp = (): string => `198.51.100.${((parseInt(rnd().slice(0, 2), 16) + ++ipN) % 250) + 1}`;
function as(user: string | null, origin: string | null = ORIGIN): void {
  const hd = new Headers({ "fly-client-ip": nextIp(), "user-agent": "t124-qa" });
  if (origin !== null) hd.set("origin", origin);
  if (user !== null) hd.set("x-test-user", user);
  h.headers = hd;
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "WMS_ENV", "MAIL_MODE", "MAILPIT_URL", "MAIL_FROM", "DEMO_EMAIL_DOMAIN", "SIGNUP_ENABLED"] as const;

let A: Fx;
let B: Fx;
let outsider: { id: string; email: string };
let bInvite: { invitationId: string; token: string; email: string };

type ActionResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; messageKey?: string; requestId?: string; [k: string]: unknown } };
type Actions = Record<string, (arg: unknown) => Promise<ActionResult>>;
let members: Actions;
let settings: { saveSettingsAction: (f: FormData) => Promise<void> };
let inviteAccept: Actions;
let itemActions: Actions;
/** T-216: her tenant için sentetik birim/ürün/barkod kimlikleri (eylem tablosu B'nin kimlikleriyle çağırır). */
let fx: { A: ItemFx; B: ItemFx };
interface ItemFx {
  unit: string;
  item: string;
  barcode: string;
}

/** Yanıtın karşılaştırılabilir yüzü (requestId çıkarılır). */
function face(r: ActionResult): unknown {
  if (r.ok) return r;
  const error: Record<string, unknown> = { ...r.error };
  delete error.requestId;
  return { ok: false, error };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), // sentetik, koşu başına (gitleaks: literal sır yok)
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
  A = await mkTenant("A");
  B = await mkTenant("B");
  outsider = await mkUser("outsider"); // hiçbir tenant'ın üyesi değil
  // Dinamik yol: kök tsc `next` tiplerini (yalnızca apps/web bağımlılığı) çözemez; çalışma zamanında vitest modülü çözer ve mock'lar geçerlidir.
  const load = (rel: string): Promise<unknown> => import(/* @vite-ignore */ path.join(WEB, rel));
  members = (await load("app/t/[slug]/members/actions.ts")) as Actions;
  settings = (await load("app/t/[slug]/settings/actions.ts")) as typeof settings;
  inviteAccept = (await load("app/invite/[token]/actions.ts")) as Actions;
  itemActions = (await load("app/t/[slug]/items/actions.ts")) as Actions;
  const mkFx = async (t: Fx): Promise<ItemFx> => {
    const unit = (await adm.query<{ id: string }>("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, gen_random_uuid(), $2, 'Birim') RETURNING id", [t.tenant, `U${rnd()}`])).rows[0]!.id;
    const item = (await adm.query<{ id: string }>("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id) VALUES ($1, gen_random_uuid(), $2, 'Fx urun', $3) RETURNING id", [t.tenant, `FX-${rnd()}`, unit])).rows[0]!.id;
    const barcode = (await adm.query<{ id: string }>("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3) RETURNING id", [t.tenant, item, `8${rnd()}`])).rows[0]!.id;
    return { unit, item, barcode };
  };
  fx = { A: await mkFx(A), B: await mkFx(B) };

  // B yöneticisi (meşru) bir davet üretir: hem olumlu kontrol hem de çapraz tenant kabul denemesi için belirteç.
  as(B.admin);
  const email = `t124-invitee-${rnd()}@example.test`;
  const r = await members.inviteMemberAction!({ slug: B.slug, email, roleKey: "PICKER" });
  if (!r.ok) throw new Error(`fixture invite failed: ${r.error.code}`);
  const link = String(r.data.inviteLink ?? "");
  bInvite = { invitationId: String(r.data.invitationId), token: link.slice(link.lastIndexOf("/") + 1), email };
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
}, 60_000);

function files(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, re));
    else if (re.test(name)) out.push(path.relative(SLUG_DIR, full).split(path.sep).join("/"));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// Sayfa yükleyicileri
// ---------------------------------------------------------------------------------------------

const LOADERS = [
  "layout.tsx",
  "page.tsx",
  "members/page.tsx",
  "settings/page.tsx",
  "audit/page.tsx",
  "items/page.tsx",
  "warehouses/page.tsx",
  "warehouses/[warehouseId]/page.tsx",
] as const;
/** T-216: ürün ayrıntısı ek bir dinamik segment (`itemId`) ister; ortak döngüde değil, aşağıdaki özel bloktadır. */
const ITEM_DETAIL = "items/[itemId]/page.tsx" as const;
type Loader = (props: {
  params: Promise<{ slug: string; warehouseId?: string; itemId?: string }>;
  searchParams?: Promise<Record<string, string>>;
  children?: unknown;
}) => Promise<unknown>;

/** `[warehouseId]` yükleyicisi için kimlik: verilmezse slug A'nınsa A'nın, değilse B'nin deposu (çapraz tenant denemesi). */
async function runLoader(
  rel: (typeof LOADERS)[number] | typeof ITEM_DETAIL,
  slug: string,
  warehouseId?: string,
  itemId?: string,
): Promise<{ outcome: "render" | "notFound" | "redirect"; to?: string; value?: unknown }> {
  const mod = (await import(/* @vite-ignore */ path.join(SLUG_DIR, rel))) as { default: Loader };
  const wid = warehouseId ?? (slug === A.slug ? A.warehouse : B.warehouse);
  try {
    const params = itemId === undefined ? { slug, warehouseId: wid } : { slug, warehouseId: wid, itemId };
    const value = await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}), children: null });
    return { outcome: "render", value };
  } catch (e) {
    const k = (e as { kind?: string }).kind;
    if (k === "notFound") return { outcome: "notFound" };
    if (k === "redirect") return { outcome: "redirect", to: (e as { to: string }).to };
    throw e;
  }
}

describe("sayfa yükleyicileri (/t/<slug>)", () => {
  it("@AC-04 kapsam: apps/web/app/t/[slug] altındaki her page/layout bu tabloda (yeni yükleyici testsiz kalamaz)", () => {
    expect(files(SLUG_DIR, /^(page|layout)\.[cm]?[jt]sx?$/)).toEqual([...LOADERS, ITEM_DETAIL].sort());
  });

  for (const rel of LOADERS) {
    it(`@AC-04 sayfa ${rel}: A kullanıcısı B'nin slug'ıyla -> 404 (ya da hiçbir B verisi çizmeden boş); var olmayan slug ile aynı sonuç`, async () => {
      as(A.admin);
      const cross = await runLoader(rel, B.slug);
      as(A.admin);
      const missing = await runLoader(rel, `yok-${rnd()}`);
      // Ana ekran (page.tsx) 404'ü layout'a bırakır ve üyelik yoksa sessizce boş döner (kendi içeriği yok): çizim değeri null olmalı.
      if (rel === "page.tsx") {
        expect(cross).toEqual({ outcome: "render", value: null });
      } else {
        expect(cross.outcome).toBe("notFound");
      }
      expect(cross).toEqual(missing); // varlık sızmaz: B'nin slug'ı ile hiç var olmayan slug ayırt edilemez
      // B'ye özgü hiçbir şey (ad, kullanıcı adları) sonuçta yok.
      expect(JSON.stringify(cross)).not.toContain(B.name);
    });

    it(`@AC-04 sayfa ${rel}: hiçbir tenant'ın üyesi olmayan oturum B'nin slug'ıyla -> 404; oturumsuz -> /login`, async () => {
      as(outsider.id);
      const r = await runLoader(rel, B.slug);
      if (rel === "page.tsx") expect(r).toEqual({ outcome: "render", value: null });
      else expect(r.outcome).toBe("notFound");
      as(null);
      const anon = await runLoader(rel, B.slug);
      expect(anon.outcome).toBe("redirect");
      expect(anon.to).toMatch(/^\/login\?next=/);
    });

    it(`@AC-04 sayfa ${rel}: olumlu kontrol — A kullanıcısı kendi slug'ında çizer (testin geçersiz kılınmadığının kanıtı)`, async () => {
      as(A.admin);
      const r = await runLoader(rel, A.slug);
      expect(`${r.outcome} ${r.to ?? ""}`).toBe("render ");
      expect(r.value).not.toBeNull();
    });
  }

  it("@AC-04 depo sayfası: A yöneticisi KENDİ slug'ında B'nin depo kimliğini açamaz -> 404 (var olmayan kimlikle aynı), B verisi çizilmez", async () => {
    as(A.admin);
    const cross = await runLoader("warehouses/[warehouseId]/page.tsx", A.slug, B.warehouse);
    as(A.admin);
    const missing = await runLoader("warehouses/[warehouseId]/page.tsx", A.slug, randomUUID());
    expect(cross.outcome).toBe("notFound");
    expect(cross).toEqual(missing);
    expect(JSON.stringify(cross)).not.toContain(B.warehouseName);
    // Depo listesi yalnızca kendi tenant'ının deposunu içerir.
    as(A.admin);
    const list = await runLoader("warehouses/page.tsx", A.slug);
    expect(list.outcome).toBe("render");
    expect(JSON.stringify(list.value)).toContain(A.warehouse);
    expect(JSON.stringify(list.value)).not.toContain(B.warehouse);
    expect(JSON.stringify(list.value)).not.toContain(B.warehouseName);
  });

  it("@AC-04 sayfa üyelik sınırı: B'nin ÜYESİ olan kullanıcı A'nın slug'ında 404; B yöneticisi kendi slug'ında çizer", async () => {
    for (const user of [B.admin, B.manager, B.picker]) {
      as(user);
      expect((await runLoader("layout.tsx", A.slug)).outcome).toBe("notFound");
      as(user);
      expect((await runLoader("members/page.tsx", A.slug)).outcome).toBe("notFound");
    }
    as(B.admin);
    expect((await runLoader("members/page.tsx", B.slug)).outcome).toBe("render");
  });
});

describe("ürün ayrıntı sayfası (/t/<slug>/items/<itemId>) — T-216", () => {
  let itemA: { id: string; code: string; name: string };
  let itemB: { id: string; code: string; name: string };

  async function mkItem(t: Fx): Promise<{ id: string; code: string; name: string }> {
    const unit = await adm.query<{ id: string }>("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, gen_random_uuid(), $2, 'Birim') RETURNING id", [t.tenant, `U${rnd()}`]);
    const code = `ITM-${rnd()}`;
    const name = `Gizli urun ${rnd()}`;
    const r = await adm.query<{ id: string }>(
      "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id) VALUES ($1, gen_random_uuid(), $2, $3, $4) RETURNING id",
      [t.tenant, code, name, (unit.rows[0] as { id: string }).id],
    );
    return { id: (r.rows[0] as { id: string }).id, code, name };
  }

  beforeAll(async () => {
    itemA = await mkItem(A);
    itemB = await mkItem(B);
  }, 60_000);

  it("@AC-04 sayfa items/[itemId]: B'nin slug'ı + B'nin ürünü ile var olmayan slug + var olmayan ürün -> 404 ve birebir aynı yanıt; B verisi yok", async () => {
    as(A.admin);
    const cross = await runLoader(ITEM_DETAIL, B.slug, undefined, itemB.id);
    as(A.admin);
    const missing = await runLoader(ITEM_DETAIL, `yok-${rnd()}`, undefined, randomUUID());
    expect(cross).toEqual({ outcome: "notFound" });
    expect(cross).toEqual(missing);
    expect(JSON.stringify(cross)).not.toContain(itemB.code);
    expect(JSON.stringify(cross)).not.toContain(itemB.name);
  });

  it("@AC-04 sayfa items/[itemId]: A'nın slug'ında B'nin itemId'si -> 404, var olmayan itemId ile aynı yanıt; B ürün verisi taşımaz", async () => {
    as(A.admin);
    const cross = await runLoader(ITEM_DETAIL, A.slug, undefined, itemB.id);
    as(A.admin);
    const missing = await runLoader(ITEM_DETAIL, A.slug, undefined, randomUUID());
    expect(cross).toEqual({ outcome: "notFound" });
    expect(cross).toEqual(missing);
    expect(JSON.stringify(cross)).not.toContain(itemB.code);
    expect(JSON.stringify(cross)).not.toContain(itemB.name);
  });

  it("@AC-04 sayfa items/[itemId]: UUID olmayan kimlik 404; hiçbir tenant'ın üyesi olmayan oturum 404; oturumsuz /login", async () => {
    as(A.admin);
    expect(await runLoader(ITEM_DETAIL, A.slug, undefined, "not-a-uuid")).toEqual({ outcome: "notFound" });
    as(outsider.id);
    expect(await runLoader(ITEM_DETAIL, B.slug, undefined, itemB.id)).toEqual({ outcome: "notFound" });
    as(null);
    const anon = await runLoader(ITEM_DETAIL, B.slug, undefined, itemB.id);
    expect(anon.outcome).toBe("redirect");
    expect(anon.to).toMatch(/^\/login\?next=/);
  });

  it("@AC-04 sayfa items/[itemId]: B üyesi A'nın slug'ında kendi ürün kimliğiyle bile 404", async () => {
    for (const user of [B.admin, B.manager, B.picker]) {
      as(user);
      expect(await runLoader(ITEM_DETAIL, A.slug, undefined, itemB.id)).toEqual({ outcome: "notFound" });
    }
  });

  it("@AC-04 sayfa items ve items/[itemId]: stock.view izni olmayan (rolsüz) üye hata değil kilitli görünüm alır (500 yok)", async () => {
    const u = await mkUser("norole");
    await adm.query("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false)", [A.tenant, u.id]);
    for (const [rel, itemId] of [["items/page.tsx", undefined], [ITEM_DETAIL, itemA.id]] as const) {
      as(u.id);
      const r = await runLoader(rel, A.slug, undefined, itemId);
      expect(`${r.outcome} ${r.to ?? ""}`, rel).toBe("render ");
      // Sayfa kilitli görünüm bileşenini (async sunucu bileşeni) döndürür; çizilince neden + sonraki eylem anahtarları görünür.
      const el = r.value as { type: () => Promise<unknown> };
      expect(typeof el.type, rel).toBe("function");
      const json = JSON.stringify(await el.type());
      expect(json, rel).toContain('"locked"');
      expect(json, rel).toContain("lockedAction");
      expect(json, rel).not.toContain(itemA.code);
      expect(json, rel).not.toContain(itemA.name);
    }
  });

  it("@AC-04 sayfa items/[itemId]: olumlu kontrol — A kullanıcısı kendi ürününü kendi slug'ında çizer (testin geçersiz kılınmadığının kanıtı)", async () => {
    as(A.admin);
    const r = await runLoader(ITEM_DETAIL, A.slug, undefined, itemA.id);
    expect(`${r.outcome} ${r.to ?? ""}`).toBe("render ");
    expect(r.value).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Server Action'lar
// ---------------------------------------------------------------------------------------------

type Call = (slug: string, victim: { membership: string; invitation: string }) => Promise<ActionResult>;
const ACTIONS: Record<string, Call> = {
  inviteMemberAction: (slug) => members.inviteMemberAction!({ slug, email: `t124-x-${rnd()}@example.test`, roleKey: "PICKER" }),
  revokeInvitationAction: (slug, v) => members.revokeInvitationAction!({ slug, invitationId: v.invitation }),
  changeRoleAction: (slug, v) => members.changeRoleAction!({ slug, memberId: v.membership, roleKey: "TENANT_ADMIN" }),
  removeMemberAction: (slug, v) => members.removeMemberAction!({ slug, memberId: v.membership }),
  leaveTenantAction: (slug) => members.leaveTenantAction!({ slug }),
  transferOwnershipAction: (slug, v) => members.transferOwnershipAction!({ slug, toMemberId: v.membership }),
  issuePasswordResetLinkAction: (slug, v) => members.issuePasswordResetLinkAction!({ slug, memberId: v.membership }),
};

/** T-216: ürün kartı eylemleri; hepsi B'nin birim/ürün/barkod kimlikleriyle çağrılır (A veya B slug'ında). */
const ITEM_ACTIONS: Record<string, Call> = {
  createItemAction: (slug) => itemActions.createItemAction!({ slug, code: `X-${rnd()}`, name: "Ele geçirme", baseUnitId: fx.B.unit }),
  updateItemAction: (slug) => itemActions.updateItemAction!({ slug, itemId: fx.B.item, name: "Ele Gecirildi" }),
  archiveItemAction: (slug) => itemActions.archiveItemAction!({ slug, itemId: fx.B.item }),
  setConversionAction: (slug) => itemActions.setConversionAction!({ slug, itemId: fx.B.item, unitId: fx.B.unit, factor: "12" }),
  addBarcodeAction: (slug) => itemActions.addBarcodeAction!({ slug, itemId: fx.B.item, unitId: null, barcode: `9${rnd()}`, quantity: null }),
  removeBarcodeAction: (slug) => itemActions.removeBarcodeAction!({ slug, barcodeId: fx.B.barcode }),
};

describe("Server Action'lar", () => {
  it("@AC-04 kapsam: members/actions.ts dışa aktarımlarının tamamı tabloda; ayarlar eylemi ayrıca sınanır", () => {
    expect(Object.keys(members).sort()).toEqual(Object.keys(ACTIONS).sort());
    expect(Object.keys(itemActions).sort()).toEqual(Object.keys(ITEM_ACTIONS).sort());
    expect(Object.keys(settings)).toEqual(["saveSettingsAction"]);
    expect(Object.keys(inviteAccept)).toEqual(["acceptInvitationAction"]);
  });

  for (const [name, call] of Object.entries({ ...ACTIONS, ...ITEM_ACTIONS })) {
    it(`@AC-04 ${name}: A yöneticisi B'nin slug'ıyla -> NOT_FOUND (var olmayan slug ile aynı yanıt); B'de hiçbir değişiklik yok`, async () => {
      const victim = { membership: B.managerMembership, invitation: bInvite.invitationId };
      const beforeB = await snapshot(B);
      const beforeA = await snapshot(A);
      as(A.admin);
      const cross = await call(B.slug, victim);
      as(A.admin);
      const missing = await call(`yok-${rnd()}`, victim);
      expect(cross.ok, JSON.stringify(cross)).toBe(false);
      if (!cross.ok) expect(cross.error.code).toBe("NOT_FOUND");
      expect(face(cross)).toEqual(face(missing));
      expect(JSON.stringify(cross)).not.toContain(B.slug);
      expect(JSON.stringify(cross)).not.toContain(B.name);
      expect(await snapshot(B)).toEqual(beforeB);
      expect(await snapshot(A)).toEqual(beforeA);
    });

    it(`@AC-04 ${name}: hiçbir tenant'ın üyesi olmayan kullanıcı ve B'nin düşük yetkili üyesi (A slug'ıyla) -> NOT_FOUND/FORBIDDEN, etki yok`, async () => {
      const victim = { membership: A.managerMembership, invitation: bInvite.invitationId };
      const beforeA = await snapshot(A);
      const beforeB = await snapshot(B);
      for (const user of [outsider.id, B.picker, B.admin]) {
        as(user);
        const r = await call(A.slug, victim);
        expect(r.ok, `${name} ${user}`).toBe(false);
        if (!r.ok) expect(["NOT_FOUND", "FORBIDDEN"]).toContain(r.error.code);
      }
      expect(await snapshot(A)).toEqual(beforeA);
      expect(await snapshot(B)).toEqual(beforeB);
    });
  }

  it("@AC-04 saveSettingsAction: A yöneticisi B'nin slug'ıyla ayar değişikliği -> NOT_FOUND ile yönlendirme; B'nin adı/dili/saat dilimi değişmez", async () => {
    const before = await snapshot(B);
    const form = (slug: string): FormData => {
      const f = new FormData();
      f.set("slug", slug);
      f.set("name", "Ele Gecirildi");
      f.set("locale", "en");
      f.set("timeZone", "Europe/Berlin");
      return f;
    };
    const run = async (slug: string): Promise<string> => {
      as(A.admin);
      try {
        await settings.saveSettingsAction(form(slug));
      } catch (e) {
        if ((e as { kind?: string }).kind === "redirect") return (e as { to: string }).to;
        throw e;
      }
      throw new Error("expected redirect");
    };
    const cross = await run(B.slug);
    const missing = await run(`yok-${rnd()}`);
    expect(cross).toBe(`/t/${B.slug}/settings?error=NOT_FOUND`);
    expect(missing.replace(/\/t\/[^/]+/, "")).toBe(cross.replace(/\/t\/[^/]+/, ""));
    expect(await snapshot(B)).toEqual(before);
    // Olumlu kontrol: aynı eylem kendi slug'ında çalışır.
    as(A.admin);
    const ownForm = form(A.slug);
    ownForm.set("name", A.name);
    ownForm.set("locale", "tr");
    ownForm.set("timeZone", "Europe/Istanbul");
    await expect(settings.saveSettingsAction(ownForm)).rejects.toMatchObject({ kind: "redirect", to: `/t/${A.slug}/settings?unchanged=1` });
  });

  it("@AC-04 acceptInvitationAction: B'nin davet belirteciyle A kullanıcısının kabulü -> FORBIDDEN (e-posta uyuşmazlığı); üyelik/kabul oluşmaz", async () => {
    const beforeB = await snapshot(B);
    for (const user of [A.admin, outsider.id]) {
      as(user);
      const r = await inviteAccept.acceptInvitationAction!({ token: bInvite.token });
      expect(r.ok, JSON.stringify(r)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
      expect(await adm.query("SELECT 1 FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [B.tenant, user])).toHaveProperty("rowCount", 0);
    }
    expect(await snapshot(B)).toEqual(beforeB);
    // Kimliği doğrulanmamış kabul de hesap açmadan, parola vermeden hiçbir şey yazmaz (B davetini tüketmez).
    as(null);
    const anon = await inviteAccept.acceptInvitationAction!({ token: bInvite.token });
    expect(anon.ok).toBe(false);
    expect(await snapshot(B)).toEqual(beforeB);
  });

  it("@AC-04 doğrudan B'nin membershipId'siyle A slug'ında komut: changeRole/removeMember/transferOwnership/sıfırlama -> ret, A ve B'de etki yok", async () => {
    const beforeA = await snapshot(A);
    const beforeB = await snapshot(B);
    const target = B.managerMembership;
    as(A.admin);
    const results: [string, ActionResult][] = [];
    results.push(["changeRole", await members.changeRoleAction!({ slug: A.slug, memberId: target, roleKey: "PICKER" })]);
    as(A.admin);
    results.push(["removeMember", await members.removeMemberAction!({ slug: A.slug, memberId: target })]);
    as(A.admin);
    results.push(["transferOwnership", await members.transferOwnershipAction!({ slug: A.slug, toMemberId: target })]);
    as(A.admin);
    results.push(["issuePasswordResetLink", await members.issuePasswordResetLinkAction!({ slug: A.slug, memberId: target })]);
    as(A.admin);
    results.push(["revokeInvitation", await members.revokeInvitationAction!({ slug: A.slug, invitationId: bInvite.invitationId })]);
    for (const [name, r] of results) {
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(["NOT_FOUND", "FORBIDDEN"], name).toContain(r.error.code);
    }
    expect(await snapshot(A)).toEqual(beforeA);
    expect(await snapshot(B)).toEqual(beforeB);
    // B'nin yöneticisi aynı hedefle B slug'ında çalışabilir (olumlu kontrol: hedef gerçekten geçerli bir üyelik).
    as(B.admin);
    const ok = await members.changeRoleAction!({ slug: B.slug, memberId: target, roleKey: "WAREHOUSE_MANAGER" });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("@AC-04 Origin/oturum: B slug'ında Origin'siz çağrı FORBIDDEN, oturumsuz UNAUTHENTICATED (slug varlığına bakılmadan; B'ye etki yok)", async () => {
    const beforeB = await snapshot(B);
    as(A.admin, null);
    const noOrigin = await members.changeRoleAction!({ slug: B.slug, memberId: B.managerMembership, roleKey: "TENANT_ADMIN" });
    expect(noOrigin.ok === false && noOrigin.error.code).toBe("FORBIDDEN");
    as(null);
    const anon = await members.changeRoleAction!({ slug: B.slug, memberId: B.managerMembership, roleKey: "TENANT_ADMIN" });
    expect(anon.ok === false && anon.error.code).toBe("UNAUTHENTICATED");
    expect(await snapshot(B)).toEqual(beforeB);
  });
});
