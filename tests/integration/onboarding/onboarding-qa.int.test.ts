// T-124 (qa-verifier): onboarding idempotency/eşzamanlılık bağımsız doğrulaması. Uygulayıcının testlerinden (T-121) bağımsız.
// Eşzamanlılık GERÇEK paralel bağlantılarla: her istek kendi havuzunda (ayrı PostgreSQL oturumu), `wms_app` rolüyle.
// Fikstürler sentetik (G-09). audit_logs değişmezdir; test tenant'ları geçici Testcontainers ortamında kalır.
// Test amaçlı tetikleyiciler (t124_*) yalnızca migration rolüyle kurulur ve afterAll'da silinir.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { continueOnboarding, createWorkspace, type WorkspaceEnv } from "../../../packages/domain/src/onboarding/workspace.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const OPEN: WorkspaceEnv = { WMS_ENV: "ci", SIGNUP_ENABLED: "true" };
const CONCURRENCY = 10;
const pools: DbClient[] = [];
let adm: pg.Client;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []): Promise<T[]> =>
  (await adm.query<T>(text, args)).rows;
const n = async (text: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, args))[0]!.n);

function pool(): DbClient {
  const c = createDbClient({ url: env.databaseUrl, poolMax: 1, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  pools.push(c);
  return c;
}

async function newUser(): Promise<string> {
  return (await q<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T124 fixture', $1, true) RETURNING id", [`t124-${randomBytes(6).toString("hex")}@example.test`]))[0]!.id;
}
const principal = (userId: string) => ({ userId, mfaVerified: true });
const uniqueName = (p: string) => `${p} ${randomBytes(4).toString("hex")}`;

function create(db: DbClient, userId: string, over: Partial<Parameters<typeof createWorkspace>[0]> = {}) {
  return createWorkspace({ db, env: OPEN, principal: principal(userId), name: uniqueName("Qa"), templateKey: "PACKAGING_SUPPLIES", requestId: randomUUID(), ...over });
}

/** Her istek ayrı havuzdan, aynı anda. */
function parallel<T>(fn: (db: DbClient, i: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const dbs = Array.from({ length: CONCURRENCY }, () => pool());
  return Promise.allSettled(dbs.map((db, i) => fn(db, i)));
}

beforeAll(async () => {
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
}, 60_000);

afterAll(async () => {
  for (const t of ["t124_fail_step2 ON public.tenant_settings", "t124_fail_create ON public.audit_logs"]) {
    await adm.query(`DROP TRIGGER IF EXISTS ${t}`).catch(() => undefined);
  }
  await adm.query("DROP FUNCTION IF EXISTS public.t124_fail_step2()").catch(() => undefined);
  await adm.query("DROP FUNCTION IF EXISTS public.t124_fail_create()").catch(() => undefined);
  await Promise.all(pools.map((p) => p.close().catch(() => undefined)));
  await adm.end().catch(() => undefined);
}, 120_000);

describe("onboarding idempotency (T-124 madde 1)", () => {
  it("aynı requestId ile 10 eşzamanlı istek (10 ayrı bağlantı) → 1 tenant, 1 sahip üyeliği, 1 rol, 1 settings, 1 tenant.created audit'i", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const name = uniqueName("Eşzamanlı");
    const results = await parallel((db) => create(db, user, { requestId, name }));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof create>>> => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    expect(ok).toHaveLength(CONCURRENCY);
    expect(new Set(ok.map((r) => r.value.tenantId)).size).toBe(1);
    expect(new Set(ok.map((r) => r.value.slug)).size).toBe(1);
    expect(ok.filter((r) => r.value.created)).toHaveLength(1);
    const tenantId = ok[0]!.value.tenantId;
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [tenantId])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND is_owner AND status = 'ACTIVE'", [tenantId, user])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.membership_roles WHERE tenant_id = $1", [tenantId])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_settings WHERE tenant_id = $1", [tenantId])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'", [tenantId])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [tenantId])).toBe(1); // başka yan etki yok
  }, 60_000);

  it("aynı requestId + açık slug ile 10 eşzamanlı istek → yine tek tenant (SLUG_TAKEN yarışı tek sonuca iner)", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const slug = `qa-${randomBytes(5).toString("hex")}`;
    const name = uniqueName("Açık Slug");
    const results = await parallel((db) => create(db, user, { requestId, name, slug }));
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const ok = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value);
    expect(new Set(ok.map((r) => r.tenantId)).size).toBe(1);
    expect(ok.filter((r) => r.created)).toHaveLength(1);
    expect(await n("SELECT count(*) n FROM public.tenants WHERE slug = $1", [slug])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'", [ok[0]!.tenantId])).toBe(1);
  }, 60_000);

  it("farklı requestId (aynı kullanıcı, aynı ad) → ikinci tenant (beklenen), farklı slug; her birinde tek üyelik ve tek audit", async () => {
    const user = await newUser();
    const name = uniqueName("Çift");
    const a = await create(pool(), user, { name });
    const b = await create(pool(), user, { name });
    expect(a.created && b.created).toBe(true);
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.slug).not.toBe(b.slug);
    for (const t of [a.tenantId, b.tenantId]) {
      expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [t])).toBe(1);
      expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'", [t])).toBe(1);
    }
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(2);
  });

  it("10 farklı kullanıcı aynı açık slug'ı eşzamanlı ister → tam 1 başarı, 9 VALIDATION_FAILED, 1 tenant (slug varlığı ayrı kodla sızmaz)", async () => {
    const users = await Promise.all(Array.from({ length: CONCURRENCY }, newUser));
    const slug = `yaris-${randomBytes(5).toString("hex")}`;
    const results = await parallel((db, i) => create(db, users[i]!, { slug }));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(AppError);
      expect((r.reason as AppError).code).toBe("VALIDATION_FAILED");
    }
    expect(await n("SELECT count(*) n FROM public.tenants WHERE slug = $1", [slug])).toBe(1);
    const t = (await q<{ id: string }>("SELECT id FROM public.tenants WHERE slug = $1", [slug]))[0]!.id;
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [t])).toBe(1);
    // Kaybedenler için artık satır yok: aynı kullanıcıların tenant'ı yok.
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = ANY($1::uuid[])", [users])).toBe(1);
  }, 60_000);

  it("atomiklik: tenant.created audit'i yazılırken hata → tenant/üyelik/settings kalmaz; tetikleyici kalkınca aynı requestId created:true", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const name = uniqueName("Atomik");
    await q(`CREATE OR REPLACE FUNCTION public.t124_fail_create() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected tenant.created failure'; END $f$`);
    await q(`CREATE TRIGGER t124_fail_create BEFORE INSERT ON public.audit_logs FOR EACH ROW
      WHEN (NEW.action = 'tenant.created' AND NEW.request_id = '${requestId}') EXECUTE FUNCTION public.t124_fail_create()`);
    try {
      await expect(create(pool(), user, { requestId, name })).rejects.toBeInstanceOf(AppError);
    } finally {
      await q("DROP TRIGGER IF EXISTS t124_fail_create ON public.audit_logs");
    }
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(0);
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE user_id = $1", [user])).toBe(0);
    const ok = await create(pool(), user, { requestId, name });
    expect(ok.created).toBe(true);
    expect(await n("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(1);
  }, 60_000);

  it("onboarding adımı yarıda kesilir → continueOnboarding tamamlar; adım audit'leri tekil (eşzamanlı çift çağrıda da)", async () => {
    const user = await newUser();
    const ws = await create(pool(), user);
    await q(`CREATE OR REPLACE FUNCTION public.t124_fail_step2() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected step 2 failure'; END $f$`);
    await q(`CREATE TRIGGER t124_fail_step2 BEFORE UPDATE ON public.tenant_settings FOR EACH ROW
      WHEN (NEW.tenant_id = '${ws.tenantId}'::uuid AND NEW.onboarding_steps @> '[{"key":"terminology.applied","status":"DONE"}]'::jsonb)
      EXECUTE FUNCTION public.t124_fail_step2()`);
    try {
      await expect(continueOnboarding({ db: pool(), principal: principal(user), slug: ws.slug })).rejects.toBeInstanceOf(AppError);
    } finally {
      await q("DROP TRIGGER IF EXISTS t124_fail_step2 ON public.tenant_settings");
    }
    const mid = (await q<{ onboarding_status: string; onboarding_steps: { key: string; status: string }[] }>("SELECT onboarding_status, onboarding_steps FROM public.tenant_settings WHERE tenant_id = $1", [ws.tenantId]))[0]!;
    expect(mid.onboarding_status).toBe("IN_PROGRESS");
    expect(mid.onboarding_steps.map((s) => s.status)).toEqual(["DONE", "PENDING", "PENDING", "PENDING"]);
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'onboarding.step_completed'", [ws.tenantId])).toBe(1);

    // Kalan adımı eşzamanlı 5 çağrı tamamlamaya çalışır: toplamda adım yalnızca 1 kez uygulanır.
    const dbs = Array.from({ length: 5 }, () => pool());
    const runs = await Promise.allSettled(dbs.map((db) => continueOnboarding({ db, principal: principal(user), slug: ws.slug })));
    expect(runs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const applied = runs.flatMap((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof continueOnboarding>>>).value.applied);
    expect(applied.sort()).toEqual(["locations.applied", "terminology.applied", "units.applied"]);
    for (const r of runs) expect((r as PromiseFulfilledResult<Awaited<ReturnType<typeof continueOnboarding>>>).value.status).toBe("COMPLETED");

    const final = (await q<{ onboarding_status: string }>("SELECT onboarding_status FROM public.tenant_settings WHERE tenant_id = $1", [ws.tenantId]))[0]!;
    expect(final.onboarding_status).toBe("COMPLETED");
    const steps = await q<{ step: string }>("SELECT change_summary->>'step' AS step FROM public.audit_logs WHERE tenant_id = $1 AND action = 'onboarding.step_completed' ORDER BY step", [ws.tenantId]);
    expect(steps.map((s) => s.step)).toEqual(["locations.applied", "settings.applied", "terminology.applied", "units.applied"]);
    // Tamamlandıktan sonra yeni çağrı yan etkisizdir.
    expect(await continueOnboarding({ db: pool(), principal: principal(user), slug: ws.slug })).toEqual({ status: "COMPLETED", applied: [] });
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'onboarding.step_completed'", [ws.tenantId])).toBe(4);
  }, 90_000);

  it("kapı (A-50): SIGNUP_ENABLED kapalı / WMS_ENV prod|tanımsız → FORBIDDEN ve hiçbir satır yazılmaz", async () => {
    const user = await newUser();
    const cases: WorkspaceEnv[] = [{}, { WMS_ENV: "production", SIGNUP_ENABLED: "true" }, { WMS_ENV: "staging", SIGNUP_ENABLED: "true" }, { WMS_ENV: "ci" }, { WMS_ENV: "ci", SIGNUP_ENABLED: "1" }];
    for (const e of cases) {
      const requestId = randomUUID();
      await expect(create(pool(), user, { env: e, requestId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await n("SELECT count(*) n FROM public.tenants WHERE creation_request_id = $1", [requestId])).toBe(0);
    }
  });
});
