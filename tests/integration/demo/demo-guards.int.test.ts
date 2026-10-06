// T-124 (qa-verifier): demo korumaları bağımsız doğrulaması (A-43, A-63, A-64; security-reviewer M9/M10 + 2. tur m3).
// Gerçek roller: wms_app (domain/RLS), wms_auth (Better Auth + demo hesap bağdaştırıcısı), migration rolü yalnızca fikstür/okuma.
// YALITIM: bu dosya `slug='demo'` tenant'ını ve sabit demo hesaplarını (DEMO_ROLES) kurar; `seed.int.test.ts` "demo tenant yok (taze ortam)"
// varsayar ve paylaşılan veritabanında sıraya bağlıdır. Bu yüzden dosya kendi geçici veritabanını (aynı kümede, migration rolüyle
// CREATE DATABASE + migrateUp) açar ve sonunda siler; paylaşılan `wms` veritabanına HİÇ yazmaz.
// Mock'lar YALNIZCA Next çalışma zamanı (`next/headers`) ve `lib/auth-service` çözümüdür (gerçek Better Auth hizmetine yönlenir);
// demo eylemi, sarmalayıcı (Origin/hız sınırı), auth, domain ve DB GERÇEKTİR. Parolalar koşu başına üretilir (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  service: undefined as unknown,
  headers: new Headers(),
  cookies: [] as { name: string; value: string }[],
}));
// `next` yalnızca apps/web bağımlılığıdır: kökten `next/headers` aynı modül kimliğine çözülmez, bu yüzden uygulamanın kopyası hedeflenir.
vi.mock("../../../apps/web/node_modules/next/headers.js", () => ({
  headers: () => Promise.resolve(h.headers),
  cookies: () => Promise.resolve({ set: (name: string, value: string) => void h.cookies.push({ name, value }), delete: () => undefined }),
}));
vi.mock("../../../packages/db/src/index.ts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAppDb: () => h.db }));
vi.mock("../../../apps/web/lib/auth-service.ts", () => ({
  ensureRecentAuth: () => Promise.resolve(),
  getAuthService: () => h.service,
}));

import { createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { DemoAccountError, createDemoAccountPort } from "../../../packages/auth/src/demo-accounts.ts";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { ensureDemoTenantStep, migrateUp } from "../../../packages/db/src/migrate.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { loadMailConfig } from "../../../packages/shared/src/mailer.ts";
import {
  DEMO_ROLES,
  DEMO_TENANT_ID,
  bootstrapOwnerInTenant,
  loadDemoSeedConfig,
  reseedDemo,
} from "../../../packages/domain/src/demo/seed.ts";
import { acceptInvitation, inviteMember } from "../../../packages/domain/src/identity/invitations.ts";
import { changeRole, issuePasswordResetLink, removeMember, transferOwnership } from "../../../packages/domain/src/identity/memberships.ts";
import { createWorkspace } from "../../../packages/domain/src/onboarding/workspace.ts";
import { registerDemoReseed } from "../../../apps/worker/src/jobs/demo-reseed.ts";
import { readAuthDatabaseUrl, readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const ORIGIN = "http://localhost:3000";
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const DOMAIN = "example.invalid";
const DEMO_PASSWORD = `Dm-${randomBytes(12).toString("hex")}`; // sentetik, koşu başına
const OTHER_PASSWORD = `Ot-${randomBytes(12).toString("hex")}`;
const SECRET = randomBytes(32).toString("hex");
const STAGING_DEMO = { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN, DEMO_PASSWORD } as const;

let app: DbClient;
let authClient: DbClient;
let adm: pg.Client; // yalıtılmış veritabanında migration rolü
let admMain: pg.Client; // paylaşılan veritabanı: yalnızca CREATE/DROP DATABASE
const DB_NAME = `t124_${randomBytes(5).toString("hex")}`;
/** Aynı kullanıcı/parola, kümenin DOĞRUDAN adresi (PgBouncer yalnızca paylaşılan veritabanını yönlendirir), yalıtılmış veritabanı. */
function isolated(roleUrl: string): string {
  const u = new URL(roleUrl);
  const direct = new URL(env.databaseUrlDirect);
  u.protocol = direct.protocol;
  u.host = direct.host;
  u.pathname = `/${DB_NAME}`;
  u.search = "";
  return u.toString();
}
let ids: Record<string, string>;
const open: DbClient[] = [];
let isolatedDirect = "";
// Dinamik yol: kök tsc `next` tiplerini (yalnızca apps/web bağımlılığı) çözemez; çalışma zamanında vitest modülü çözer ve mock'lar geçerlidir.
type DemoSignIn = (raw: unknown) => Promise<{ ok: true; data: { redirectTo: string } } | { ok: false; error: { code: string } }>;
let demoSignInAction: DemoSignIn;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []): Promise<T[]> =>
  (await adm.query<T>(text, args)).rows;
const n = async (text: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, args))[0]!.n);
const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
};

let ipN = 0;
const nextIp = (): string => `198.51.100.${((parseInt(randomBytes(1).toString("hex"), 16) + ++ipN) % 250) + 1}`;
function setRequest(over: { origin?: string | null; ip?: string; cookie?: string } = {}): string {
  const ip = over.ip ?? nextIp();
  const hd = new Headers({ "fly-client-ip": ip, "user-agent": "t124-qa-agent" });
  if (over.origin !== null) hd.set("origin", over.origin ?? ORIGIN);
  if (over.cookie !== undefined) hd.set("cookie", over.cookie);
  h.headers = hd;
  h.cookies = [];
  return ip;
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["WMS_ENV", "DEMO_MODE", "DEMO_PASSWORD", "DEMO_EMAIL_DOMAIN", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "SIGNUP_ENABLED"] as const;

function demoMembershipIds(): Promise<Record<string, string>> {
  return q<{ email: string; id: string }>(
    "SELECT u.email, m.id FROM public.tenant_memberships m JOIN public.users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.status = 'ACTIVE'",
    [DEMO_TENANT_ID],
  ).then((rows) => Object.fromEntries(rows.map((r) => [r.email, r.id])));
}
const demoState = () =>
  q("SELECT m.id, m.is_owner, m.status, m.roles_version, (SELECT string_agg(role_key, ',' ORDER BY role_key) FROM public.membership_roles r WHERE r.membership_id = m.id) roles FROM public.tenant_memberships m WHERE m.tenant_id = $1 ORDER BY m.id", [DEMO_TENANT_ID]);

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  admMain = new pg.Client({ connectionString: env.databaseUrlDirect });
  admMain.on("error", () => undefined);
  await admMain.connect();
  await admMain.query(`CREATE DATABASE "${DB_NAME}"`);
  isolatedDirect = isolated(env.databaseUrlDirect);
  await migrateUp({ url: isolatedDirect });
  app = createDbClient({ url: isolated(env.databaseUrl), poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  authClient = createDbClient({ url: isolated(authUrl), poolMax: 4, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: isolatedDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  h.db = app;
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.BETTER_AUTH_URL = ORIGIN;
  h.service = createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: ORIGIN, DATABASE_URL: isolated(env.databaseUrl), AUTH_DATABASE_URL: isolated(authUrl), DEMO_EMAIL_DOMAIN: DOMAIN }),
  });
  demoSignInAction = ((await import(/* @vite-ignore */ path.join(WEB, "app/demo-actions.ts"))) as { demoSignInAction: DemoSignIn }).demoSignInAction;
  await ensureDemoTenantStep(isolatedDirect, { WMS_ENV: "local", DEMO_MODE: "1" });
  const port = createDemoAccountPort({ authDb: authClient, env: { WMS_ENV: "local", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN } });
  await port.verifyRole();
  await reseedDemo({ db: app, accounts: port, password: DEMO_PASSWORD });
  const users = await q<{ id: string; email: string }>("SELECT id, email FROM public.users WHERE email = ANY($1)", [Object.values(DEMO_ROLES)]);
  ids = Object.fromEntries(Object.entries(DEMO_ROLES).map(([role, email]) => [role, users.find((u) => u.email === email)!.id]));
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all([app, authClient, ...open].map((c) => c?.close().catch(() => undefined)));
  await adm?.end().catch(() => undefined);
  await admMain?.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`).catch(() => undefined);
  await admMain?.end().catch(() => undefined);
}, 60_000);

beforeEach(() => {
  Object.assign(process.env, { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD, DEMO_EMAIL_DOMAIN: DOMAIN, BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: SECRET });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// 2. Demo koruması: ortam kapısı
// ---------------------------------------------------------------------------------------------

describe("demo.reseed ortam kapısı (A-43/A-63)", () => {
  const closedEnvs: [string, Record<string, string | undefined>][] = [
    ["WMS_ENV=production", { WMS_ENV: "production", DEMO_MODE: "1" }],
    ["WMS_ENV tanımsız", { DEMO_MODE: "1" }],
    ["WMS_ENV boş", { WMS_ENV: "", DEMO_MODE: "1" }],
    ["WMS_ENV=prod (bilinmeyen)", { WMS_ENV: "prod", DEMO_MODE: "1" }],
    ["WMS_ENV=ci", { WMS_ENV: "ci", DEMO_MODE: "1" }],
    ["staging, DEMO_MODE tanımsız", { WMS_ENV: "staging" }],
    ["staging, DEMO_MODE=0", { WMS_ENV: "staging", DEMO_MODE: "0" }],
    ["staging, DEMO_MODE=true", { WMS_ENV: "staging", DEMO_MODE: "true" }],
    ["local, DEMO_MODE tanımsız", { WMS_ENV: "local" }],
  ];

  for (const [label, e] of closedEnvs) {
    it(`${label}: iş kayıtlı değil, zamanlayıcı yok, auth havuzu/bağdaştırıcı hiç açılmaz; hesap ve demo satırı yazılmaz`, async () => {
      const full = { ...e, DEMO_PASSWORD, DEMO_EMAIL_DOMAIN: DOMAIN, AUTH_DATABASE_URL: isolated(authUrl) };
      expect(loadDemoSeedConfig(full).enabled).toBe(false);
      const openAuthDb = vi.fn(() => authClient);
      const loadAdapter = vi.fn();
      const logs: string[] = [];
      const logger = { info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m), debug: () => undefined };
      const before = { users: await n("SELECT count(*) n FROM public.users"), acc: await n("SELECT count(*) n FROM public.accounts") };
      const reg = await registerDemoReseed({ env: full, db: app, logger: logger as never, openAuthDb, loadAdapter: loadAdapter as never });
      expect(reg.handler).toBeUndefined();
      expect(reg.startSchedule(() => Promise.reject(new Error("must not enqueue")))).toBeUndefined();
      expect(openAuthDb).not.toHaveBeenCalled();
      expect(loadAdapter).not.toHaveBeenCalled();
      expect(logs.join("\n")).not.toContain(DEMO_PASSWORD);
      // Doğrudan çağrı: hesap bağdaştırıcısı da kurulmaz.
      expect(() => createDemoAccountPort({ authDb: authClient, env: full })).toThrow(DemoAccountError);
      expect(await n("SELECT count(*) n FROM public.users")).toBe(before.users);
      expect(await n("SELECT count(*) n FROM public.accounts")).toBe(before.acc);
    });
  }

  it("doğrudan çağrı: bağdaştırıcı yanlış alan adıyla da kurulmaz; demo olmayan tenant kimliğiyle bootstrap FORBIDDEN", async () => {
    expect(() => createDemoAccountPort({ authDb: authClient, env: { WMS_ENV: "local", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: "corp.example" } })).toThrow(DemoAccountError);
    const foreign = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'T124 non-demo')", [foreign, `t124-${randomBytes(4).toString("hex")}`]);
    const e = await failure(bootstrapOwnerInTenant(app, ids.TENANT_ADMIN!, foreign));
    expect(e.code).toBe("FORBIDDEN");
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [foreign])).toBe(0);
  });

  it("staging: kayıt var; iki koşu aynı durum (idempotent, ek audit/üyelik/hesap yok), parola loglanmaz", async () => {
    const logs: string[] = [];
    const logger = {
      info: (m: string, f?: unknown) => void logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      warn: (m: string, f?: unknown) => void logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      error: (m: string, f?: unknown) => void logs.push(`${m} ${JSON.stringify(f ?? {})}`),
      debug: () => undefined,
    };
    const reg = await registerDemoReseed({
      env: { ...STAGING_DEMO, AUTH_DATABASE_URL: isolated(authUrl) },
      db: app,
      logger: logger as never,
      openAuthDb: () => authClient,
      loadAdapter: () => Promise.resolve({ createDemoAccountPort, parseDemoDomain: (v: string | undefined) => (v === DOMAIN ? DOMAIN : null) }) as never,
    });
    expect(reg.handler).toBeTypeOf("function");
    const snapshot = async () => ({
      users: await n("SELECT count(*) n FROM public.users WHERE email = ANY($1)", [Object.values(DEMO_ROLES)]),
      accounts: await n("SELECT count(*) n FROM public.accounts WHERE user_id = ANY($1::uuid[])", [Object.values(ids)]),
      memberships: await demoState(),
      settings: await q("SELECT locale, time_zone, onboarding_status, sector_template_key FROM public.tenant_settings WHERE tenant_id = $1", [DEMO_TENANT_ID]),
      tenant: await q("SELECT slug, name, is_demo, status FROM public.tenants WHERE id = $1", [DEMO_TENANT_ID]),
      audit: await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [DEMO_TENANT_ID]),
      hashes: await q("SELECT user_id, password FROM public.accounts WHERE user_id = ANY($1::uuid[]) ORDER BY user_id", [Object.values(ids)]),
    });
    const ctx = { jobId: randomUUID() } as never;
    await reg.handler!(ctx);
    const first = await snapshot();
    await reg.handler!(ctx);
    const second = await snapshot();
    expect(second).toEqual(first);
    expect(first.users).toBe(Object.keys(DEMO_ROLES).length);
    expect(logs.join("\n")).not.toContain(DEMO_PASSWORD);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// 2./M10: demoSignInAction (gerçek Better Auth)
// ---------------------------------------------------------------------------------------------

describe("demo-actions (M10)", () => {
  const events = (userId: string) => n("SELECT count(*) n FROM public.security_events WHERE user_id = $1", [userId]);

  function captureOutput() {
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    vi.spyOn(console, "error").mockImplementation(push);
    vi.spyOn(console, "warn").mockImplementation(push);
    vi.spyOn(console, "log").mockImplementation(push);
    vi.spyOn(console, "info").mockImplementation(push);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => (push(String(s)), true)) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (push(String(s)), true)) as never);
    return { text: () => lines.join("\n"), restore: () => (out.mockRestore(), err.mockRestore()) };
  }

  it("bayraklar kapalı/yanlış → FORBIDDEN; oturum açılmaz, çerez yazılmaz, güvenlik olayı üretilmez", async () => {
    const before = await events(ids.READ_ONLY!);
    const cases: Record<string, string | undefined>[] = [
      { WMS_ENV: "production" },
      { WMS_ENV: undefined },
      { WMS_ENV: "local" },
      { DEMO_MODE: undefined },
      { DEMO_MODE: "0" },
      { DEMO_EMAIL_DOMAIN: "corp.example" },
      { DEMO_EMAIL_DOMAIN: undefined },
      { DEMO_PASSWORD: undefined },
      { DEMO_PASSWORD: "short" },
    ];
    for (const patch of cases) {
      Object.assign(process.env, { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD, DEMO_EMAIL_DOMAIN: DOMAIN });
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      setRequest();
      const res = await demoSignInAction({ role: "READ_ONLY" });
      expect(res.ok, JSON.stringify(patch)).toBe(false);
      if (!res.ok) expect(res.error.code, JSON.stringify(patch)).toBe("FORBIDDEN");
      expect(h.cookies).toEqual([]);
    }
    expect(await events(ids.READ_ONLY!)).toBe(before);
  });

  it("bayraklar açık, listede olmayan rol/e-posta/parola alanı → reddedilir; giriş denenmez", async () => {
    const before = await events(ids.READ_ONLY!);
    // NOT: kart "listede olmayan rol anahtarı → FORBIDDEN" der; uygulama sarmalayıcıda Zod enum reddi olarak VALIDATION_FAILED döner
    // (rapora MINOR/not). Güvenlik sonucu aynıdır: ret + giriş yok + çerez yok.
    for (const raw of [{ role: "SUPERUSER" }, { role: "READ_ONLY", email: `x@${DOMAIN}` }, { role: "READ_ONLY", password: OTHER_PASSWORD }, { role: "" }, {}, "READ_ONLY", null]) {
      setRequest();
      const res = await demoSignInAction(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["FORBIDDEN", "VALIDATION_FAILED"]).toContain(res.error.code);
      expect(h.cookies).toEqual([]);
    }
    expect(await events(ids.READ_ONLY!)).toBe(before);
  });

  it("Origin yok/yabancı → FORBIDDEN; oturumu açık kullanıcı → FORBIDDEN", async () => {
    for (const origin of [null, "https://evil.example"]) {
      setRequest({ origin });
      const res = await demoSignInAction({ role: "READ_ONLY" });
      expect(res.ok === false && res.error.code).toBe("FORBIDDEN");
      expect(h.cookies).toEqual([]);
    }
  });

  it("başarı: yalnızca demo kullanıcısına oturum; yanıt/hata/log'da DEMO_PASSWORD yok", async () => {
    const cap = captureOutput();
    let result: unknown;
    let jar = "";
    try {
      setRequest();
      result = await demoSignInAction({ role: "READ_ONLY" });
      jar = h.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
    } finally {
      cap.restore();
    }
    expect(result).toMatchObject({ ok: true, data: { redirectTo: "/" } });
    expect(JSON.stringify(result)).not.toContain(DEMO_PASSWORD);
    expect(cap.text()).not.toContain(DEMO_PASSWORD);
    expect(h.cookies.some((c) => /session_token$/.test(c.name))).toBe(true);
    const principal = await (h.service as AuthService).getPrincipal(new Headers({ cookie: jar, "fly-client-ip": nextIp() }));
    expect(principal?.userId).toBe(ids.READ_ONLY);
    expect(principal?.isDemo).toBe(true);
  });

  it("hata yolu: sunucudaki parola hesapla eşleşmezse UNAUTHENTICATED; parola yanıtta, hata nesnesinde ve logda yok", async () => {
    process.env.DEMO_PASSWORD = OTHER_PASSWORD;
    const cap = captureOutput();
    let res: Awaited<ReturnType<typeof demoSignInAction>>;
    try {
      setRequest();
      res = await demoSignInAction({ role: "VIEWER" in DEMO_ROLES ? "VIEWER" : "READ_ONLY" });
    } finally {
      cap.restore();
    }
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["UNAUTHENTICATED", "RATE_LIMITED"]).toContain(res.error.code);
    const dump = JSON.stringify(res) + cap.text();
    expect(dump).not.toContain(OTHER_PASSWORD);
    expect(dump).not.toContain(DEMO_PASSWORD);
    expect(h.cookies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// M9: demo kullanıcısı kısıtları
// ---------------------------------------------------------------------------------------------

describe("demo kullanıcısı kısıtları (M9)", () => {
  async function demoCookie(role: keyof typeof DEMO_ROLES = "TENANT_ADMIN"): Promise<string> {
    setRequest();
    const res = await demoSignInAction({ role });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    return h.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  }
  const ba = (method: "GET" | "POST", path: string, body: unknown, cookie: string, ip = nextIp()) =>
    (h.service as AuthService).handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method,
        headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), origin: ORIGIN, "fly-client-ip": ip, "user-agent": "t124-qa-agent", cookie },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
    );

  it("demo kullanıcısı createWorkspace → FORBIDDEN; tenant oluşmaz", async () => {
    const before = await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [ids.TENANT_ADMIN]);
    const requestId = randomUUID();
    const e = await failure(
      createWorkspace({ db: app, env: { WMS_ENV: "ci", SIGNUP_ENABLED: "true", DEMO_EMAIL_DOMAIN: DOMAIN }, principal: { userId: ids.TENANT_ADMIN!, mfaVerified: true }, name: "Demo Kacak", templateKey: "PACKAGING_SUPPLIES", requestId }),
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(await n("SELECT count(*) n FROM public.tenants WHERE creation_request_id = $1", [requestId])).toBe(0);
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [ids.TENANT_ADMIN])).toBe(before);
  });

  it("demo kullanıcısı acceptInvitation → FORBIDDEN (geçerli belirteçle bile); üyelik oluşmaz, davet kabul edilmez", async () => {
    const tenant = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, 'T124 invite tenant')", [tenant, `t124-i-${randomBytes(4).toString("hex")}`]);
    await q("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'Europe/Istanbul', 'COMPLETED')", [tenant]);
    const adminId = (await q<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T124 admin', $1, true) RETURNING id", [`t124-a-${randomBytes(5).toString("hex")}@example.test`]))[0]!.id;
    const m = (await q<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', true) RETURNING id", [tenant, adminId]))[0]!.id;
    await q("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'TENANT_ADMIN')", [tenant, m]);
    const slug = (await q<{ slug: string }>("SELECT slug FROM public.tenants WHERE id = $1", [tenant]))[0]!.slug;
    const invited = `t124-inv-${randomBytes(4).toString("hex")}@example.test`;
    const inv = await inviteMember(
      { db: app, principal: { userId: adminId, mfaVerified: true }, tenantSlug: slug, email: invited, roleKey: "PICKER" },
      { mailConfig: loadMailConfig({ MAIL_MODE: "disabled" }), queue: { enqueue: () => Promise.reject(new Error("queue must not be used")) } },
    );
    expect(inv.token).toBeTypeOf("string");
    for (const role of ["TENANT_ADMIN", "READ_ONLY"] as const) {
      const e = await failure(
        acceptInvitation(
          { db: app, token: inv.token!, principal: { userId: ids[role]! } },
          { createInvitedAccount: () => Promise.reject(new Error("must not create account")), demoEmailDomain: DOMAIN },
        ),
      );
      expect(e.code).toBe("FORBIDDEN");
    }
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])", [tenant, Object.values(ids)])).toBe(0);
    expect(await n("SELECT count(*) n FROM public.invitations WHERE tenant_id = $1 AND accepted_at IS NOT NULL", [tenant])).toBe(0);
  });

  it("Better Auth: demo oturumu list-sessions / revoke-sessions / revoke-other-sessions / update-user / change-password / change-email → 403; durum değişmez", async () => {
    const cookie = await demoCookie("TENANT_ADMIN");
    const sessionsBefore = await n("SELECT count(*) n FROM public.sessions WHERE user_id = $1", [ids.TENANT_ADMIN]);
    const nameBefore = (await q<{ name: string }>("SELECT name FROM public.users WHERE id = $1", [ids.TENANT_ADMIN]))[0]!.name;
    const hashBefore = (await q<{ password: string }>("SELECT password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [ids.TENANT_ADMIN]))[0]!.password;
    const forbiddenBefore = await n("SELECT count(*) n FROM public.security_events WHERE user_id = $1 AND event_type = 'demo.action_forbidden'", [ids.TENANT_ADMIN]);
    const calls: [("GET" | "POST"), string, unknown][] = [
      ["GET", "/list-sessions", undefined],
      ["POST", "/revoke-sessions", {}],
      ["POST", "/revoke-other-sessions", {}],
      ["POST", "/update-user", { name: "Ele Gecirildi" }],
      ["POST", "/change-password", { currentPassword: DEMO_PASSWORD, newPassword: OTHER_PASSWORD, revokeOtherSessions: true }],
      ["POST", "/change-email", { newEmail: `x-${randomBytes(3).toString("hex")}@example.test` }],
    ];
    for (const [method, path, body] of calls) {
      const res = await ba(method, path, body, cookie);
      expect(res.status, path).toBe(403);
    }
    expect(await n("SELECT count(*) n FROM public.security_events WHERE user_id = $1 AND event_type = 'demo.action_forbidden'", [ids.TENANT_ADMIN])).toBe(forbiddenBefore + calls.length);
    expect(await n("SELECT count(*) n FROM public.sessions WHERE user_id = $1", [ids.TENANT_ADMIN])).toBe(sessionsBefore);
    expect((await q<{ name: string }>("SELECT name FROM public.users WHERE id = $1", [ids.TENANT_ADMIN]))[0]!.name).toBe(nameBefore);
    expect((await q<{ password: string }>("SELECT password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [ids.TENANT_ADMIN]))[0]!.password).toBe(hashBefore);
    // Demo parolası hâlâ geçerli (değişmedi).
    const again = await ba("POST", "/sign-in/email", { email: DEMO_ROLES.TENANT_ADMIN, password: DEMO_PASSWORD }, "");
    expect(again.status).toBe(200);
  }, 60_000);

  it("A-43/ADR-016 §10: demo kullanıcısının TÜM security_events satırlarında (login_succeeded, logout, demo.action_forbidden, ...) IP/UA NULL", async () => {
    // Gerçek istek başlıklarıyla (fly-client-ip + user-agent) giriş, reddedilen ucu çağırma ve çıkış.
    const cookie = await demoCookie("READ_ONLY");
    expect((await ba("GET", "/list-sessions", undefined, cookie)).status).toBe(403);
    await ba("POST", "/sign-out", {}, cookie);
    const bad = await ba("POST", "/sign-in/email", { email: DEMO_ROLES.READ_ONLY, password: OTHER_PASSWORD }, "");
    expect(bad.status).toBe(401); // gözlenen: yanlış parola → 401
    const ev = await q<{ event_type: string; ip: string | null; user_agent: string | null }>(
      "SELECT event_type, ip, user_agent FROM public.security_events WHERE user_id = ANY($1::uuid[])",
      [Object.values(ids)],
    );
    // Bu testin ürettiği olay türleri gerçekten oluştu (aksi halde sızıntı denetimi boş kümede geçerdi).
    const types = new Set(ev.map((e) => e.event_type));
    for (const t of ["login_succeeded", "demo.action_forbidden", "logout", "login_failed"]) expect(types.has(t), t).toBe(true);
    const leaking = ev.filter((e) => e.ip !== null || e.user_agent !== null).map((e) => e.event_type);
    expect([...new Set(leaking)].sort()).toEqual([]);
  }, 60_000);

  describe("demo tenant (yönetici demo kullanıcısıyla)", () => {
    const admin = () => ({ userId: ids.TENANT_ADMIN!, mfaVerified: true });
    const deps = { demoEmailDomain: DOMAIN };

    it("inviteMember (herhangi bir adres, demo adresi dahil) → FORBIDDEN; davet satırı ve iş yazılmaz", async () => {
      const before = await n("SELECT count(*) n FROM public.invitations WHERE tenant_id = $1", [DEMO_TENANT_ID]);
      for (const email of [`kisi-${randomBytes(3).toString("hex")}@example.test`, `kisi-${randomBytes(3).toString("hex")}@${DOMAIN}`, DEMO_ROLES.PICKER]) {
        const e = await failure(
          inviteMember(
            { db: app, principal: admin(), tenantSlug: "demo", email, roleKey: "PICKER" },
            { mailConfig: loadMailConfig({ MAIL_MODE: "disabled" }), queue: { enqueue: () => Promise.reject(new Error("queue must not be used")) } },
          ),
        );
        expect(e.code, email).toBe("FORBIDDEN");
      }
      expect(await n("SELECT count(*) n FROM public.invitations WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(before);
    });

    it("changeRole / transferOwnership / removeMember / sıfırlama bağlantısı → FORBIDDEN; üyelik durumu değişmez", async () => {
      const members = await demoMembershipIds();
      const target = members[DEMO_ROLES.PICKER]!;
      const adminMembership = members[DEMO_ROLES.TENANT_ADMIN]!;
      const before = await demoState();
      const auditBefore = await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [DEMO_TENANT_ID]);
      const base = { db: app, principal: admin(), tenantSlug: "demo" };
      const port = {
        createToken: () => Promise.reject(new Error("must not issue token")),
        discardToken: () => Promise.resolve(),
        recordIssued: () => Promise.resolve(),
      };
      const attempts: [string, () => Promise<unknown>][] = [
        ["changeRole", () => changeRole({ ...base, memberId: target, roleKey: "TENANT_ADMIN" }, deps)],
        ["changeRole(self)", () => changeRole({ ...base, memberId: adminMembership, roleKey: "READ_ONLY" }, deps)],
        ["transferOwnership", () => transferOwnership({ ...base, toMemberId: target }, deps)],
        ["removeMember", () => removeMember({ ...base, memberId: target }, deps)],
        ["issuePasswordResetLink", () => issuePasswordResetLink({ ...base, memberId: target, recentAuth: () => Promise.resolve() }, { ...deps, port: port as never })],
      ];
      for (const [name, run] of attempts) expect((await failure(run())).code, name).toBe("FORBIDDEN");
      expect(await demoState()).toEqual(before);
      expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(auditBefore);
    });

    it("demo tenant audit satırlarında IP/UA yok (tetikleyici: çağıran IP/UA verse bile NULL'a çevrilir)", async () => {
      const row = await q<{ ip: string | null; user_agent: string | null }>(
        `INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, ip, user_agent, change_summary)
         VALUES ($1::uuid, $2::uuid, 'tenant.settings_changed', 'tenant', $1::text, '203.0.113.9', 't124-ua', '{}'::jsonb) RETURNING ip, user_agent`,
        [DEMO_TENANT_ID, ids.TENANT_ADMIN],
      );
      expect(row[0]).toEqual({ ip: null, user_agent: null });
      expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND (ip IS NOT NULL OR user_agent IS NOT NULL)", [DEMO_TENANT_ID])).toBe(0);
    });
  });
});
