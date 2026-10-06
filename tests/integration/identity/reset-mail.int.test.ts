// T-116d: web'in sıfırlama e-postası kurulumu (`buildResetMail`) + gerçek Better Auth işleyicisi (A-42). Fikstürler sentetik (G-09).
// Kuyruk sahte (yalnızca `enqueuePlatform` kaydı); amaç port bağlama, tekdüze yanıt (hesap varlığı sızmaz) ve fail-closed 503.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { createAuth, readAuthEnv, type AuthService, type ResetMailPort } from "../../../packages/auth/src/index.ts";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

vi.mock("../../../apps/web/lib/queue.ts", () => ({ getSenderQueue: () => Promise.resolve(undefined) }));
const { buildResetMail } = await import("../../../apps/web/lib/auth-service.ts");

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const MAIL_ENV = {
  MAIL_MODE: "mailpit",
  MAILPIT_URL: "http://localhost:8025",
  MAIL_FROM: "noreply@example.test",
  WMS_ENV: "ci",
  QUEUE_SEAL_KEY: randomBytes(32).toString("hex"),
};

let authClient: DbClient;
let adm: pg.Client;
const createdUsers: string[] = [];

function mkAuth(resetMail?: ResetMailPort): AuthService {
  return createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl }),
    ...(resetMail === undefined ? {} : { resetMail }),
  });
}

beforeAll(async () => {
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect, authUrl])}`);
  }
}, 120_000);

afterAll(async () => {
  await adm.query("DELETE FROM public.verifications WHERE value = ANY($1::text[])", [createdUsers]).catch(() => undefined);
  if (createdUsers.length > 0) await adm.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [createdUsers]).catch(() => undefined);
  await adm.end();
  await authClient.close();
}, 60_000);

let ip = 0;
const rndEmail = (): string => `t116d-${randomBytes(6).toString("hex")}@example.test`;

async function mkUser(): Promise<string> {
  const email = rndEmail();
  const u = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T116d fixture', $1, true) RETURNING id", [email]);
  const id = (u.rows[0] as { id: string }).id;
  createdUsers.push(id);
  await adm.query("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [id, await hashPassword(`P${randomBytes(12).toString("hex")}`)]);
  return email;
}

function ask(svc: AuthService, email: string): Promise<Response> {
  ip += 1;
  return svc.handler(
    new Request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "fly-client-ip": `198.51.100.${(ip % 250) + 1}`, "user-agent": "t116d-int" },
      body: JSON.stringify({ email }),
    }),
  );
}

function recorder(): { jobs: unknown[]; queue: { enqueuePlatform: (j: unknown) => Promise<{ jobId: string }> } } {
  const jobs: unknown[] = [];
  return { jobs, queue: { enqueuePlatform: (j) => (jobs.push(j), Promise.resolve({ jobId: "j" })) } };
}

describe("web sıfırlama e-postası kurulumu (T-116d, A-42)", () => {
  it("port bağlı: tek email.send platform işi, mühürlü, düz e-posta/bağlantı yok; var olmayan e-posta aynı yanıt, iş yok", async () => {
    const { jobs, queue } = recorder();
    const port = buildResetMail(MAIL_ENV, { queue: queue as never });
    expect(port).toBeDefined();
    const svc = mkAuth(port);
    const email = await mkUser();
    const known = await ask(svc, email);
    const unknown = await ask(svc, rndEmail());
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const body = await known.text();
    expect(body).toBe(await unknown.text());
    expect(body).not.toMatch(/reset-password|token/i);
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as { type: string; payload: { template: string; sealed: Record<string, unknown> } };
    expect(job.type).toBe("email.send");
    expect(job.payload.template).toBe("password_reset");
    expect(Object.keys(job.payload.sealed).sort()).toEqual(["ct", "iv", "kid", "tag", "v"]);
    const text = JSON.stringify(job);
    expect(text).not.toContain(email);
    expect(text).not.toContain("reset-password");
  });

  it("kuyruk yok: 503 MAIL_DELIVERY_DISABLED, iş yok (var/yok aynı)", async () => {
    const svc = mkAuth(buildResetMail(MAIL_ENV, { queue: undefined }));
    const email = await mkUser();
    const a = await ask(svc, email);
    const b = await ask(svc, rndEmail());
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(await a.text()).toBe(await b.text());
  });

  it("yanlış kip (production'da mailpit): port yok, 503", async () => {
    const { jobs, queue } = recorder();
    const port = buildResetMail({ ...MAIL_ENV, WMS_ENV: "production" }, { queue: queue as never });
    expect(port).toBeUndefined();
    const res = await ask(mkAuth(port), await mkUser());
    expect(res.status).toBe(503);
    expect(jobs).toHaveLength(0);
  });
});
