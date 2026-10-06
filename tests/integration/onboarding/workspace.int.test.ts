// T-121: onboarding domain'i (createWorkspace / continueOnboarding / updateTenantSettings). Gerçek wms_app + RLS.
// Fikstürler sentetiktir (G-09). audit_logs değişmezdir (tenant satırı silinemez): kuruluş ortamı geçicidir (Testcontainers);
// kalıcı hedefte (neon) test tenant'ları kalır.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  continueOnboarding,
  createWorkspace,
  updateTenantSettings,
  APP_DB_SETTINGS,
  type WorkspaceEnv,
} from "../../../packages/domain/src/onboarding/workspace.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
let app: DbClient;
const OPEN: WorkspaceEnv = { WMS_ENV: "ci", SIGNUP_ENABLED: "true", DEMO_EMAIL_DOMAIN: "demo.example.test" };

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: env.databaseUrlDirect });
  c.on("error", () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function newUser(domain = "example.test"): Promise<string> {
  return admin(async (c) => {
    const r = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T121 fixture', $1) RETURNING id", [
      `t121-${randomBytes(6).toString("hex")}@${domain}`,
    ]);
    return r.rows[0]!.id;
  });
}

const principal = (userId: string) => ({ userId, mfaVerified: true });
const uniqueName = (p: string) => `${p} ${randomBytes(4).toString("hex")}`;
const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
};
const count = (sqlText: string, args: unknown[]) =>
  admin(async (c) => Number((await c.query<{ n: string }>(sqlText, args)).rows[0]!.n));

function create(userId: string, over: Partial<Parameters<typeof createWorkspace>[0]> = {}) {
  return createWorkspace({
    db: app,
    env: OPEN,
    principal: principal(userId),
    name: uniqueName("Acme"),
    templateKey: "PACKAGING_SUPPLIES",
    requestId: randomUUID(),
    ...over,
  });
}

beforeAll(() => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
});
afterAll(async () => {
  await app.close();
  await admin((c) => c.query("DROP TRIGGER IF EXISTS t121_fail_step2 ON public.tenant_settings"));
  await admin((c) => c.query("DROP FUNCTION IF EXISTS public.t121_fail_step2()"));
}, 60_000);

it("APP_DB_SETTINGS, DB_CLIENT_SETTINGS ile aynı", () => {
  expect({ ...APP_DB_SETTINGS }).toEqual({ ...DB_CLIENT_SETTINGS });
});

describe("createWorkspace", () => {
  it("tenant + sahip TENANT_ADMIN üyeliği + settings + tenant.created audit'i", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const r = await create(user, { requestId, name: "Çağrı Ambalaj" });
    expect(r.created).toBe(true);
    expect(r.slug).toMatch(/^cagri-ambalaj/);
    await admin(async (c) => {
      const m = await c.query("SELECT m.is_owner, r.role_key FROM public.tenant_memberships m JOIN public.membership_roles r ON r.membership_id = m.id WHERE m.tenant_id = $1 AND m.user_id = $2", [r.tenantId, user]);
      expect(m.rows).toEqual([{ is_owner: true, role_key: "TENANT_ADMIN" }]);
      const s = await c.query("SELECT * FROM public.tenant_settings WHERE tenant_id = $1", [r.tenantId]);
      expect(s.rows[0]).toMatchObject({ sector_template_key: "PACKAGING_SUPPLIES", sector_template_version: 1, onboarding_status: "IN_PROGRESS" });
      expect(s.rows[0].terminology["location.bin"]).toBe("Göz Kodu");
      expect(s.rows[0].onboarding_steps.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual([
        "settings.applied:PENDING",
        "terminology.applied:PENDING",
      ]);
      const a = await c.query("SELECT actor_user_id, change_summary FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'", [r.tenantId]);
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0].actor_user_id).toBe(user);
    });
  });

  it("slug 'demo' / 'Demo' → VALIDATION_FAILED ve tenant satırı oluşmaz", async () => {
    const user = await newUser();
    for (const slug of ["demo", "Demo"]) {
      const requestId = randomUUID();
      const e = await failure(create(user, { slug, requestId }));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(await count("SELECT count(*) n FROM public.tenants WHERE creation_request_id = $1", [requestId])).toBe(0);
    }
    expect(await count("SELECT count(*) n FROM public.tenants WHERE slug = 'demo' AND created_by_user_id = $1", [user])).toBe(0);
  });

  it("aynı requestId ile iki eşzamanlı istek → tek tenant", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const name = uniqueName("Eşzamanlı");
    const [a, b] = await Promise.all([create(user, { requestId, name }), create(user, { requestId, name })]);
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.slug).toBe(b.slug);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await count("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1 AND creation_request_id = $2", [user, requestId])).toBe(1);
    expect(await count("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'", [a.tenantId])).toBe(1);
  });

  it("aynı requestId + AÇIK slug ile eşzamanlı çift istek → aynı sonuç, tek tenant (SLUG_TAKEN yarışı yutulur)", async () => {
    for (let i = 0; i < 5; i++) {
      const user = await newUser();
      const requestId = randomUUID();
      const slug = `r-${randomBytes(5).toString("hex")}`;
      const name = uniqueName("Yarış");
      const [a, b] = await Promise.all([create(user, { requestId, slug, name }), create(user, { requestId, slug, name })]);
      expect(a.tenantId).toBe(b.tenantId);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(await count("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(1);
    }
  });

  it("tekrar aynı parametrelerle → created:false; ad ya da şablon değişince ret (ikinci tenant yok)", async () => {
    const user = await newUser();
    const requestId = randomUUID();
    const name = uniqueName("Tekrar");
    const first = await create(user, { requestId, name });
    const again = await create(user, { requestId, name });
    expect(again).toEqual({ tenantId: first.tenantId, slug: first.slug, created: false });
    expect((await failure(create(user, { requestId, name: `${name} 2` }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(create(user, { requestId, name, templateKey: "GENERIC" }))).code).toBe("VALIDATION_FAILED");
    expect(await count("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [user])).toBe(1);
  });

  it("başka kullanıcının requestId'si çakışmaz; otomatik slug çakışmasında sonekle devam, tekrar aynı slug", async () => {
    const u1 = await newUser();
    const u2 = await newUser();
    const requestId = randomUUID();
    const name = uniqueName("Ortak Ad");
    const a = await create(u1, { requestId, name });
    const b = await create(u2, { requestId, name });
    expect(b.created).toBe(true);
    expect(b.tenantId).not.toBe(a.tenantId);
    expect(b.slug).not.toBe(a.slug); // taban slug u1'de, u2 sonekli aday
    expect(await create(u2, { requestId, name })).toEqual({ tenantId: b.tenantId, slug: b.slug, created: false });
  });

  it("açık slug başka tenant'ta kullanımda → ayrılmış kelimeyle AYNI yanıt (slug varlığı sızmaz)", async () => {
    const u1 = await newUser();
    const u2 = await newUser();
    const slug = `s-${randomBytes(5).toString("hex")}`;
    await create(u1, { slug });
    const taken = await failure(create(u2, { slug }));
    const reserved = await failure(create(u2, { slug: "admin" }));
    expect(taken.code).toBe("VALIDATION_FAILED");
    expect(taken.toBody()).toEqual(reserved.toBody());
    expect(taken.detail).toBeUndefined();
  });

  it("SIGNUP_ENABLED kapalı, staging/production (bayrak açık olsa da) ve bayrak tanımsız → FORBIDDEN, tenant yok", async () => {
    const user = await newUser();
    const cases: WorkspaceEnv[] = [
      { WMS_ENV: "ci" },
      { WMS_ENV: "local", SIGNUP_ENABLED: "false" },
      { WMS_ENV: "staging", SIGNUP_ENABLED: "true" },
      { WMS_ENV: "production", SIGNUP_ENABLED: "true" },
      { SIGNUP_ENABLED: "true" },
    ];
    for (const e of cases) {
      const requestId = randomUUID();
      expect((await failure(create(user, { env: e, requestId }))).code).toBe("FORBIDDEN");
      expect(await count("SELECT count(*) n FROM public.tenants WHERE creation_request_id = $1", [requestId])).toBe(0);
    }
  });

  it("demo kullanıcısı (DEMO_EMAIL_DOMAIN) → FORBIDDEN, tenant yok", async () => {
    const demo = await newUser("demo.example.test");
    const requestId = randomUUID();
    expect((await failure(create(demo, { requestId, env: { ...OPEN, DEMO_EMAIL_DOMAIN: " DEMO.Example.test " } }))).code).toBe("FORBIDDEN");
    expect(await count("SELECT count(*) n FROM public.tenants WHERE created_by_user_id = $1", [demo])).toBe(0);
  });

  it("oturumsuz → UNAUTHENTICATED; geçersiz şablon/requestId/ad → VALIDATION_FAILED", async () => {
    const user = await newUser();
    expect((await failure(create(user, { principal: null }))).code).toBe("UNAUTHENTICATED");
    expect((await failure(create(user, { templateKey: "NOPE" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(create(user, { requestId: "x" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(create(user, { name: "  " }))).code).toBe("VALIDATION_FAILED");
  });
});

describe("continueOnboarding", () => {
  it("adım 2'de hata enjekte edilir; yeniden çağrı kalan adımdan tamamlar (adım 1 tekrarlanmaz)", async () => {
    const user = await newUser();
    const ws = await create(user);
    await admin(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION public.t121_fail_step2() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN RAISE EXCEPTION 'injected step 2 failure'; END $f$`);
      await c.query(`CREATE TRIGGER t121_fail_step2 BEFORE UPDATE ON public.tenant_settings FOR EACH ROW
        WHEN (NEW.tenant_id = '${ws.tenantId}'::uuid AND NEW.onboarding_steps @> '[{"key":"terminology.applied","status":"DONE"}]'::jsonb)
        EXECUTE FUNCTION public.t121_fail_step2()`);
    });
    const e = await failure(continueOnboarding({ db: app, principal: principal(user), slug: ws.slug }));
    expect(e.code).toBe("INTERNAL");
    const mid = await admin(async (c) => (await c.query("SELECT onboarding_status, onboarding_steps FROM public.tenant_settings WHERE tenant_id = $1", [ws.tenantId])).rows[0]);
    expect(mid.onboarding_status).toBe("IN_PROGRESS");
    expect(mid.onboarding_steps.map((s: { key: string; status: string }) => s.status)).toEqual(["DONE", "PENDING"]);

    await admin((c) => c.query("DROP TRIGGER t121_fail_step2 ON public.tenant_settings"));
    const r = await continueOnboarding({ db: app, principal: principal(user), slug: ws.slug });
    expect(r).toEqual({ status: "COMPLETED", applied: ["terminology.applied"] });
    const again = await continueOnboarding({ db: app, principal: principal(user), slug: ws.slug });
    expect(again).toEqual({ status: "COMPLETED", applied: [] });
    expect(
      await count("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'onboarding.step_completed'", [ws.tenantId]),
    ).toBe(2);
  });

  it("üye olmayan kullanıcı → NOT_FOUND (varlık sızmaz)", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const ws = await create(owner);
    expect((await failure(continueOnboarding({ db: app, principal: principal(stranger), slug: ws.slug }))).code).toBe("NOT_FOUND");
  });
});

describe("updateTenantSettings", () => {
  it("ad/dil/saat dilimi güncellenir ve önceki/sonraki özetiyle audit'lenir; değişmezse audit yok; geçersiz → ret", async () => {
    const user = await newUser();
    const ws = await create(user);
    const next = { name: uniqueName("Yeni Ad"), locale: "en", timeZone: "Europe/Berlin" };
    expect(await updateTenantSettings(app, ws.slug, principal(user), next)).toEqual({ changed: true });
    expect(await updateTenantSettings(app, ws.slug, principal(user), next)).toEqual({ changed: false });
    await admin(async (c) => {
      const t = await c.query("SELECT t.name, s.locale, s.time_zone FROM public.tenants t JOIN public.tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1", [ws.tenantId]);
      expect(t.rows[0]).toEqual({ name: next.name, locale: "en", time_zone: "Europe/Berlin" });
      const a = await c.query("SELECT change_summary FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.settings_changed'", [ws.tenantId]);
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0].change_summary.locale).toEqual({ from: "tr", to: "en" });
      expect(a.rows[0].change_summary.timeZone).toEqual({ from: "Europe/Istanbul", to: "Europe/Berlin" });
    });
    for (const bad of [{ ...next, locale: "xx" }, { ...next, timeZone: "Mars/Base" }, { ...next, name: "" }]) {
      expect((await failure(updateTenantSettings(app, ws.slug, principal(user), bad))).code).toBe("VALIDATION_FAILED");
    }
  });

  it("settings.manage olmayan rol → FORBIDDEN", async () => {
    const owner = await newUser();
    const ws = await create(owner);
    const reader = await newUser();
    await admin(async (c) => {
      const m = await c.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false) RETURNING id", [ws.tenantId, reader]);
      await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'READ_ONLY')", [ws.tenantId, m.rows[0]!.id]);
    });
    const e = await failure(updateTenantSettings(app, ws.slug, principal(reader), { name: "x", locale: "tr", timeZone: "Europe/Istanbul" }));
    expect(e.code).toBe("FORBIDDEN");
  });
});
