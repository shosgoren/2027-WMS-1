// T-123a: demo hesap bağdaştırıcısı (createDemoAccountPort), gerçek roller: wms_auth (AUTH_DATABASE_URL) yazar, migration
// rolü yalnızca doğrulama için okur. Parolalar çalışma anında üretilir (G-09). Better Auth ile gerçek giriş denenir.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ACCOUNT_EVENT, DemoAccountError, createDemoAccountPort } from "../../../packages/auth/src/demo-accounts.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, createAuth, readAuthEnv } from "../../../packages/auth/src/index.ts";
import { verifyPassword } from "../../../packages/auth/src/password.ts";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { DEMO_ACCOUNT_EMAIL_DOMAIN, DEMO_ACCOUNT_PASSWORD_MAX_LENGTH, DEMO_ACCOUNT_PASSWORD_MIN_LENGTH } from "../../../packages/auth/src/demo-accounts.ts";
import { DEMO_EMAIL_DOMAIN } from "../../../packages/domain/src/demo/seed.ts";
import { ARGON2_PARAMS, hashPassword } from "../../../packages/auth/src/password.ts";
import { readAuthDatabaseUrl, readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const DOMAIN = "example.invalid";
const DEMO_ENV = { WMS_ENV: "local", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN } as const;
const BASE = "http://localhost:3000";
const rnd = (): string => `Dm-${randomBytes(9).toString("hex")}`;
const PASSWORD = rnd();
const SECRET = randomBytes(32).toString("hex");
const suffix = randomBytes(4).toString("hex");
const email = (tag: string): string => `${tag}-${suffix}@${DOMAIN}`;

let authClient: DbClient;
let adm: pg.Client;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []): Promise<T[]> =>
  (await adm.query<T>(text, args)).rows;

beforeAll(async () => {
  authClient = createDbClient({ url: authUrl, poolMax: 2, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  await adm.connect();
});

afterAll(async () => {
  await authClient.close();
  await adm.end().catch(() => undefined);
}, 60_000);

describe("demo hesap bağdaştırıcısı", () => {
  it("parola sınırları @wms/auth ile aynı", () => {
    expect(DEMO_ACCOUNT_PASSWORD_MIN_LENGTH).toBe(PASSWORD_MIN_LENGTH);
    expect(DEMO_ACCOUNT_PASSWORD_MAX_LENGTH).toBe(PASSWORD_MAX_LENGTH);
  });

  it("oluşturma idempotent: iki koşu tek kullanıcı/tek hesap; ikinci koşu yazmaz", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const e = email("idem");
    const a = await port.ensureAccount({ email: e, name: "Demo Idem", password: PASSWORD });
    const b = await port.ensureAccount({ email: e, name: "Demo Idem", password: PASSWORD });
    expect(a.created).toBe(true);
    expect(a.passwordUpdated).toBe(false);
    expect(b).toEqual({ userId: a.userId, created: false, passwordUpdated: false });
    const users = await q<{ email_verified: boolean; two_factor_enabled: boolean }>(
      "SELECT email_verified, two_factor_enabled FROM public.users WHERE email = $1",
      [e],
    );
    expect(users).toEqual([{ email_verified: true, two_factor_enabled: false }]);
    const acc = await q<{ provider_id: string; account_id: string; password: string }>(
      "SELECT provider_id, account_id, password FROM public.accounts WHERE user_id = $1",
      [a.userId],
    );
    expect(acc).toHaveLength(1);
    expect(acc[0]!.provider_id).toBe("credential");
    expect(acc[0]!.account_id).toBe(a.userId);
    expect(acc[0]!.password.startsWith("$argon2id$")).toBe(true);
    const ev = await q<{ event_type: string }>("SELECT event_type FROM public.security_events WHERE user_id = $1", [a.userId]);
    expect(ev.map((r) => r.event_type)).toEqual([DEMO_ACCOUNT_EVENT.created]);
  });

  it("parola değişince eşitler (oturumlar kapanır, olay yazılır); aynı parolada yazmaz", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const e = email("sync");
    const first = await port.ensureAccount({ email: e, name: "Demo Sync", password: PASSWORD });
    await q(
      "INSERT INTO public.sessions (expires_at, token, user_id) VALUES (now() + interval '1 hour', $1, $2)",
      [randomBytes(16).toString("hex"), first.userId],
    );
    const next = rnd();
    const r = await port.ensureAccount({ email: e, name: "Demo Sync", password: next });
    expect(r).toEqual({ userId: first.userId, created: false, passwordUpdated: true });
    const row = (await q<{ password: string }>("SELECT password FROM public.accounts WHERE user_id = $1", [first.userId]))[0]!;
    expect(await verifyPassword({ hash: row.password, password: next })).toBe(true);
    expect(await verifyPassword({ hash: row.password, password: PASSWORD })).toBe(false);
    expect(await q("SELECT 1 FROM public.sessions WHERE user_id = $1", [first.userId])).toHaveLength(0);
    const again = await port.ensureAccount({ email: e, name: "Demo Sync", password: next });
    expect(again.passwordUpdated).toBe(false);
    const ev = await q<{ event_type: string }>("SELECT event_type FROM public.security_events WHERE user_id = $1 ORDER BY occurred_at, id", [first.userId]);
    expect(ev.map((x) => x.event_type).sort()).toEqual([DEMO_ACCOUNT_EVENT.created, DEMO_ACCOUNT_EVENT.passwordReset].sort());
  });

  it("eşzamanlı iki çağrı tek kullanıcı üretir", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const e = email("race");
    const [a, b] = await Promise.all([
      port.ensureAccount({ email: e, name: "Demo Race", password: PASSWORD }),
      port.ensureAccount({ email: e, name: "Demo Race", password: PASSWORD }),
    ]);
    expect(a.userId).toBe(b.userId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await q("SELECT 1 FROM public.users WHERE email = $1", [e])).toHaveLength(1);
    expect(await q("SELECT 1 FROM public.accounts WHERE user_id = $1", [a.userId])).toHaveLength(1);
  });

  it("demo dışı alan adı reddedilir ve hiçbir şey yazılmaz", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const bad = `x-${suffix}@example.com`;
    await expect(port.ensureAccount({ email: bad, name: "X", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(port.ensureAccount({ email: `y-${suffix}@sub.${DOMAIN}`, name: "X", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(port.ensureAccount({ email: email("short"), name: "X", password: "kisa" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await q("SELECT 1 FROM public.users WHERE email = $1", [bad])).toHaveLength(0);
    expect(await q("SELECT 1 FROM public.users WHERE email = $1", [email("short")])).toHaveLength(0);
  });

  it.each([
    ["WMS_ENV=production", { WMS_ENV: "production", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN }, "FORBIDDEN"],
    ["WMS_ENV yok", { DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN }, "FORBIDDEN"],
    ["WMS_ENV=ci", { WMS_ENV: "ci", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: DOMAIN }, "FORBIDDEN"],
    ["DEMO_MODE=0", { WMS_ENV: "local", DEMO_MODE: "0", DEMO_EMAIL_DOMAIN: DOMAIN }, "FORBIDDEN"],
    ["DEMO_MODE yok", { WMS_ENV: "staging", DEMO_EMAIL_DOMAIN: DOMAIN }, "FORBIDDEN"],
    ["DEMO_EMAIL_DOMAIN başka geçerli alan", { WMS_ENV: "local", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: "other.invalid" }, "VALIDATION_FAILED"],
    ["DEMO_EMAIL_DOMAIN yok", { WMS_ENV: "local", DEMO_MODE: "1" }, "VALIDATION_FAILED"],
    ["DEMO_EMAIL_DOMAIN geçersiz", { WMS_ENV: "local", DEMO_MODE: "1", DEMO_EMAIL_DOMAIN: "not a domain" }, "VALIDATION_FAILED"],
  ] as const)("ortam kapısı fail-closed: %s", async (_name, e, code) => {
    expect(() => createDemoAccountPort({ authDb: authClient, env: e })).toThrow(DemoAccountError);
    try {
      createDemoAccountPort({ authDb: authClient, env: e });
    } catch (err) {
      expect((err as DemoAccountError).code).toBe(code);
    }
  });

  it("kapı kurulumdan sonra ortam değişirse de çağrıda yeniden denetlenir", async () => {
    const mutable: Record<string, string | undefined> = { ...DEMO_ENV };
    const port = createDemoAccountPort({ authDb: authClient, env: mutable });
    mutable.WMS_ENV = "production";
    await expect(port.ensureAccount({ email: email("late"), name: "L", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await q("SELECT 1 FROM public.users WHERE email = $1", [email("late")])).toHaveLength(0);
  });

  it("alan adı sabiti seed ile tek kaynak; Argon2 parametreleri ve çıktısı password.ts ile uyumlu", async () => {
    expect(DEMO_ACCOUNT_EMAIL_DOMAIN).toBe(DEMO_EMAIL_DOMAIN);
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const pw = rnd();
    const r = await port.ensureAccount({ email: email("interop"), name: "Demo Interop", password: pw });
    const row = (await q<{ password: string }>("SELECT password FROM public.accounts WHERE user_id = $1", [r.userId]))[0]!;
    const params = (h: string): string => h.split("$").slice(1, 4).join("$"); // argon2id$v=19$m=…,t=…,p=…
    const reference = await hashPassword(pw);
    expect(params(row.password)).toBe(params(reference));
    expect(params(row.password)).toBe(`argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`);
    expect(await verifyPassword({ hash: row.password, password: pw })).toBe(true);
    // password.ts özetini de kabul eder (aynı parola → güncelleme yok).
    await q("UPDATE public.accounts SET password = $2 WHERE user_id = $1", [r.userId, reference]);
    expect((await port.ensureAccount({ email: email("interop"), name: "Demo Interop", password: pw })).passwordUpdated).toBe(false);
  });

  it("MFA'lı mevcut kullanıcı devralınır: two_factor_enabled=false, two_factors silinir, oturumlar kapanır, olay yazılır", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const e = email("mfa");
    const first = await port.ensureAccount({ email: e, name: "Demo Mfa", password: PASSWORD });
    await q("UPDATE public.users SET two_factor_enabled = true WHERE id = $1", [first.userId]);
    await q("INSERT INTO public.two_factors (secret, backup_codes, user_id) VALUES ('s', 'b', $1)", [first.userId]);
    await q("INSERT INTO public.sessions (expires_at, token, user_id) VALUES (now() + interval '1 hour', $1, $2)", [randomBytes(16).toString("hex"), first.userId]);
    const r = await port.ensureAccount({ email: e, name: "Demo Mfa", password: PASSWORD });
    expect(r).toEqual({ userId: first.userId, created: false, passwordUpdated: false });
    expect((await q<{ two_factor_enabled: boolean }>("SELECT two_factor_enabled FROM public.users WHERE id = $1", [first.userId]))[0]!.two_factor_enabled).toBe(false);
    expect(await q("SELECT 1 FROM public.two_factors WHERE user_id = $1", [first.userId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM public.sessions WHERE user_id = $1", [first.userId])).toHaveLength(0);
    const ev = await q<{ event_type: string }>("SELECT event_type FROM public.security_events WHERE user_id = $1", [first.userId]);
    expect(ev.map((x) => x.event_type)).toContain(DEMO_ACCOUNT_EVENT.passwordReset);
  });

  it("rol doğrulaması: wms_auth dışı bağlantı FORBIDDEN, hiçbir şey yazılmaz", async () => {
    const wrong = createDbClient({ url: env.databaseUrl, poolMax: 1, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
    try {
      const port = createDemoAccountPort({ authDb: wrong, env: DEMO_ENV });
      await expect(port.verifyRole()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(port.ensureAccount({ email: email("role"), name: "R", password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await q("SELECT 1 FROM public.users WHERE email = $1", [email("role")])).toHaveLength(0);
      await expect(createDemoAccountPort({ authDb: authClient, env: DEMO_ENV }).verifyRole()).resolves.toBeUndefined();
    } finally {
      await wrong.close();
    }
  });

  it("Better Auth şeması (users/accounts) beklenen sütun kümesinde: sürüm yükseltmesinde yeni zorunlu sütun bu testi kırar", async () => {
    const cols = async (t: string): Promise<string[]> =>
      (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t]))
        .map((r) => r.column_name)
        .sort();
    expect(await cols("users")).toEqual(
      ["created_at", "email", "email_verified", "id", "image", "invitation_claim_id", "name", "two_factor_enabled", "updated_at"].sort(),
    );
    expect(await cols("accounts")).toEqual(
      [
        "access_token", "access_token_expires_at", "account_id", "created_at", "id", "id_token", "password",
        "provider_id", "refresh_token", "refresh_token_expires_at", "scope", "updated_at", "user_id",
      ].sort(),
    );
    // Bağdaştırıcının yazdığı sütunlar zorunlu (NOT NULL, varsayılansız) tüm sütunları kapsamalı.
    const required = async (t: string): Promise<string[]> =>
      (await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL",
        [t],
      )).map((r) => r.column_name).sort();
    expect(await required("users")).toEqual(["email", "name"]);
    expect(await required("accounts")).toEqual(["account_id", "provider_id", "user_id"]);
  });

  it("parola hiçbir tabloda/olayda düz değil; hata mesajı değer taşımaz", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const pw = rnd();
    const e = email("plain");
    const r = await port.ensureAccount({ email: e, name: "Demo Plain", password: pw });
    const dump = JSON.stringify({
      users: await q("SELECT * FROM public.users WHERE id = $1", [r.userId]),
      accounts: await q("SELECT * FROM public.accounts WHERE user_id = $1", [r.userId]),
      events: await q("SELECT * FROM public.security_events WHERE user_id = $1", [r.userId]),
    });
    expect(dump.includes(pw)).toBe(false);
    expect(dump.includes("argon2id")).toBe(true); // yalnızca özet
    const events = await q<{ detail: unknown; ip: unknown; user_agent: unknown }>("SELECT detail, ip, user_agent FROM public.security_events WHERE user_id = $1", [r.userId]);
    expect(events[0]!.detail).toEqual({});
    // Hata nesnesi parola taşımaz (reddedilen çağrı).
    const err = await port.ensureAccount({ email: `z@example.com`, name: "Z", password: pw }).catch((x: unknown) => x);
    expect(String((err as Error).message)).not.toContain(pw);
    expect(JSON.stringify(err)).not.toContain(pw);
  });

  it("oluşan kullanıcı Better Auth ile giriş yapabilir; yanlış parola reddedilir", async () => {
    const port = createDemoAccountPort({ authDb: authClient, env: DEMO_ENV });
    const e = email("login");
    await port.ensureAccount({ email: e, name: "Demo Login", password: PASSWORD });
    const service = createAuth({
      client: authClient,
      env: readAuthEnv({
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: BASE,
        DATABASE_URL: env.databaseUrl,
        AUTH_DATABASE_URL: authUrl,
      }),
    });
    const post = (password: string, ip: string): Promise<Response> =>
      service.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": ip, "user-agent": "t123a-int-test" },
          body: JSON.stringify({ email: e, password }),
        }),
      );
    const ok = await post(PASSWORD, "203.0.113.201");
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
    const bad = await post(rnd(), "203.0.113.202");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // Parola eşitlemesinden sonra yeni parola geçerli, eski değil.
    const next = rnd();
    await port.ensureAccount({ email: e, name: "Demo Login", password: next });
    expect((await post(next, "203.0.113.203")).status).toBe(200);
    expect((await post(PASSWORD, "203.0.113.204")).status).toBeGreaterThanOrEqual(400);
  });
});
