// T-123: demo tenant kurulumu (ensureDemoTenant) ve yeniden tohumlama (reseedDemo). Gerçek wms_app + RLS + tetikleyiciler.
// Fikstürler sentetiktir (G-09); parola testte üretilir. Hesap bağdaştırıcısı (DemoAccountPort) bu testte migration rolüyle
// çalışan bir TEST FİKSTÜRÜDÜR (users/accounts yalnızca wms_auth yazabilir; gerçek bağdaştırıcı packages/auth kapsamındadır).
// audit_logs değişmezdir: demo tenant ve audit satırları test ortamında kalır (Testcontainers geçici).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../../packages/auth/src/password.ts";
import { createDbClient, withSystemTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { ensureDemoTenantStep } from "../../../packages/db/src/migrate.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  DEMO_ROLES,
  DEMO_TENANT_ID,
  DEMO_TENANT_NAME,
  bootstrapDemoOwner,
  bootstrapOwnerInTenant,
  reseedDemo,
  type DemoAccountPort,
} from "../../../packages/domain/src/demo/seed.ts";
import { getTemplate } from "../../../packages/domain/src/onboarding/templates.ts";
import { DEMO_RESEED_SINGLETON_KEY, createDemoReseedHandler, startDemoReseedSchedule } from "../../../apps/worker/src/jobs/demo-reseed.ts";
import { QUEUE_SCHEMA, createJobQueue, installQueueSchema } from "../../../packages/queue-adapter/src/index.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const PASSWORD = `Dm-${randomBytes(9).toString("hex")}`; // sentetik, her koşuda yeni
const DEMO_ENV = { WMS_ENV: "local", DEMO_MODE: "1" } as const;
const template = getTemplate("PACKAGING_SUPPLIES")!;

let app: DbClient;
let app2: DbClient;
let adm: pg.Client;

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []): Promise<T[]> =>
  (await adm.query<T>(text, args)).rows;
const n = async (text: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, args))[0]!.n);

/** Test fikstürü: kimlik hesabı bağdaştırıcısı (migration rolü; gerçek: wms_auth). Sözleşme DemoAccountPort ile aynı. */
const accounts: DemoAccountPort = {
  async ensureAccount({ email, name, password }) {
    const existing = await q<{ id: string }>("SELECT id FROM public.users WHERE email = $1", [email]);
    let userId = existing[0]?.id;
    let created = false;
    if (userId === undefined) {
      userId = (await q<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, email]))[0]!.id;
      created = true;
    }
    const acc = await q<{ id: string; password: string | null }>(
      "SELECT id, password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'",
      [userId],
    );
    const row = acc[0];
    if (row === undefined) {
      await q("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [userId, await hashPassword(password)]);
      return { userId, created, passwordUpdated: !created };
    }
    if (row.password !== null && (await verifyPassword({ hash: row.password, password }))) return { userId, created, passwordUpdated: false };
    await q("UPDATE public.accounts SET password = $2 WHERE id = $1", [row.id, await hashPassword(password)]);
    return { userId, created, passwordUpdated: true };
  },
};

const run = () => reseedDemo({ db: app, accounts, password: PASSWORD });

async function demoUserIds(): Promise<Record<string, string>> {
  const rows = await q<{ id: string; email: string }>("SELECT id, email FROM public.users WHERE email = ANY($1)", [Object.values(DEMO_ROLES)]);
  return Object.fromEntries(rows.map((r) => [r.email, r.id]));
}

async function counts() {
  const ids = Object.values(await demoUserIds());
  return {
    users: await n("SELECT count(*) n FROM public.users WHERE email = ANY($1)", [Object.values(DEMO_ROLES)]),
    accounts: await n("SELECT count(*) n FROM public.accounts WHERE user_id = ANY($1::uuid[])", [ids]),
    memberships: await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [DEMO_TENANT_ID]),
    roles: await n("SELECT count(*) n FROM public.membership_roles WHERE tenant_id = $1", [DEMO_TENANT_ID]),
    settings: await n("SELECT count(*) n FROM public.tenant_settings WHERE tenant_id = $1", [DEMO_TENANT_ID]),
    audit: await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [DEMO_TENANT_ID]),
    securityEvents: await n("SELECT count(*) n FROM public.security_events WHERE user_id = ANY($1::uuid[])", [ids]),
  };
}

const auditCount = (reason: string) =>
  n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1 AND reason = $2", [DEMO_TENANT_ID, reason]);

async function wipeDemoMemberships(): Promise<void> {
  await q("DELETE FROM public.membership_roles WHERE tenant_id = $1", [DEMO_TENANT_ID]);
  await q("DELETE FROM public.tenant_memberships WHERE tenant_id = $1", [DEMO_TENANT_ID]);
}

async function mkForeignUser(tag: string): Promise<string> {
  return (await q<{ id: string }>("INSERT INTO public.users (name, email) VALUES ($1, $2) RETURNING id", [`T123 ${tag}`, `t123-${tag}-${randomBytes(5).toString("hex")}@example.test`]))[0]!.id;
}

async function mkMembership(tenantId: string, userId: string, o: { owner?: boolean; roles: string[]; status?: string }): Promise<string> {
  const id = (await q<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantId, userId, o.status ?? "ACTIVE", o.owner ?? false],
  ))[0]!.id;
  for (const r of o.roles) await q("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenantId, id, r]);
  return id;
}

async function demoState() {
  const rows = await q<{ email: string; status: string; is_owner: boolean; roles: string[] | null }>(
    `SELECT u.email, m.status, m.is_owner,
            (SELECT array_agg(r.role_key ORDER BY r.role_key) FROM public.membership_roles r WHERE r.tenant_id = m.tenant_id AND r.membership_id = m.id) AS roles
       FROM public.tenant_memberships m JOIN public.users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 ORDER BY u.email`,
    [DEMO_TENANT_ID],
  );
  return rows;
}

function expectedDemoState() {
  return Object.entries(DEMO_ROLES)
    .map(([role, email]) => ({ email, status: "ACTIVE", is_owner: role === "TENANT_ADMIN", roles: [role] }))
    .sort((a, b) => (a.email < b.email ? -1 : 1));
}

const sqlstateIn = (e: unknown): string | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== null && cur !== undefined; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  app2 = createDbClient({ url: env.databaseUrl, ...DB_CLIENT_SETTINGS });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
});
afterAll(async () => {
  await app.close();
  await app2.close();
  await adm.end();
}, 60_000);

describe("ensureDemoTenant (migration rolü, db:migrate sonu)", () => {
  it("WMS_ENV=production / tanımsız / DEMO_MODE yok veya 0 → hiçbir şey yapmaz", async () => {
    const before = await n("SELECT count(*) n FROM public.tenants WHERE slug = 'demo'");
    expect(before).toBe(0); // demo tenant bu testten önce yok (taze ortam)
    for (const e of [
      { WMS_ENV: "production", DEMO_MODE: "1" },
      { DEMO_MODE: "1" },
      { WMS_ENV: "staging" },
      { WMS_ENV: "staging", DEMO_MODE: "0" },
      { WMS_ENV: "ci", DEMO_MODE: "1" },
    ]) {
      expect(await ensureDemoTenantStep(env.databaseUrlDirect, e)).toBe("disabled");
    }
    expect(await n("SELECT count(*) n FROM public.tenants WHERE slug = 'demo'")).toBe(0);
  });

  it("slug 'demo' farklı kimlikle varsa hata; satıra dokunulmaz", async () => {
    const foreign = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, 'demo', 'Foreign Demo', true)", [foreign]);
    try {
      await expect(ensureDemoTenantStep(env.databaseUrlDirect, DEMO_ENV)).rejects.toThrow(/fail-closed/);
      expect((await q<{ id: string; name: string }>("SELECT id, name FROM public.tenants WHERE slug = 'demo'"))).toEqual([{ id: foreign, name: "Foreign Demo" }]);
    } finally {
      await q("DELETE FROM public.tenants WHERE id = $1", [foreign]);
    }
    expect(await n("SELECT count(*) n FROM public.tenants WHERE slug = 'demo'")).toBe(0);
  });

  it("local|staging + DEMO_MODE=1 → belirlenimli kimlikle kurar; ikinci koşu aynı (idempotent)", async () => {
    expect(await ensureDemoTenantStep(env.databaseUrlDirect, DEMO_ENV)).toBe("created");
    const row = (await q<{ id: string; slug: string; name: string; is_demo: boolean; status: string }>(
      "SELECT id, slug, name, is_demo, status FROM public.tenants WHERE slug = 'demo'",
    ))[0];
    expect(row).toEqual({ id: DEMO_TENANT_ID, slug: "demo", name: DEMO_TENANT_NAME, is_demo: true, status: "ACTIVE" });
    expect(await n("SELECT count(*) n FROM public.tenant_settings WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(1);
    expect(await ensureDemoTenantStep(env.databaseUrlDirect, { WMS_ENV: "staging", DEMO_MODE: "1" })).toBe("exists");
    expect(await n("SELECT count(*) n FROM public.tenants WHERE slug = 'demo'")).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_settings WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(1);
    // Üyelik/kullanıcı kurmaz.
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(0);
  });
});

describe("bootstrapDemoOwner (demo.bootstrap)", () => {
  it("is_demo=false tenant kimliğiyle çağrı → hata, üyelik yazılmaz", async () => {
    const owner = await mkForeignUser("boot-owner");
    const tenantId = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T123 non-demo', false)", [tenantId, `t123-${randomBytes(5).toString("hex")}`]);
    let err: unknown;
    try {
      await bootstrapOwnerInTenant(app, owner, tenantId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("FORBIDDEN");
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [tenantId])).toBe(0);
    expect(await n("SELECT count(*) n FROM public.membership_roles WHERE tenant_id = $1", [tenantId])).toBe(0);
  });

  it("DB tetikleyicisi: demo olmayan tenant'ta 'demo.bootstrap' ve demo tenant'ta 'demo.reseed' ile üyelik INSERT'i reddedilir", async () => {
    const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
    const user = await mkForeignUser("trigger");
    const tenantId = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T123 trigger', false)", [tenantId, `t123-${randomBytes(5).toString("hex")}`]);
    const insert = (tid: string) => (tx: { execute: (q: unknown) => Promise<unknown> }) =>
      tx.execute(sql`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES (${tid}::uuid, ${user}::uuid, 'ACTIVE', false)`);
    const e1 = await withSystemTenant(app, tenantId, "demo.bootstrap", insert(tenantId) as never).then(() => undefined, (e: unknown) => e);
    expect(e1).toBeDefined();
    expect(sqlstateIn(e1)).toBe("42501");
    const e2 = await withSystemTenant(app, DEMO_TENANT_ID, "demo.reseed", insert(DEMO_TENANT_ID) as never).then(() => undefined, (e: unknown) => e);
    expect(e2).toBeDefined();
    expect(sqlstateIn(e2)).toBe("42501");
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE user_id = $1", [user])).toBe(0);
  });

  it("boş demo tenant: ilk koşu sahip üyeliği + tek demo.bootstrap audit; ikinci koşu yeni audit yazmaz", async () => {
    await wipeDemoMemberships();
    const owner = (await accounts.ensureAccount({ email: DEMO_ROLES.TENANT_ADMIN, name: "Demo Yönetici", password: PASSWORD })).userId;
    const before = await auditCount("demo.bootstrap");
    expect(await bootstrapDemoOwner(app, { ownerUserId: owner })).toEqual({ written: true });
    expect(await auditCount("demo.bootstrap")).toBe(before + 1);
    const m = await q<{ is_owner: boolean; status: string; roles: string[] }>(
      `SELECT m.is_owner, m.status, array_agg(r.role_key) AS roles FROM public.tenant_memberships m
         JOIN public.membership_roles r ON r.membership_id = m.id WHERE m.tenant_id = $1 AND m.user_id = $2 GROUP BY m.id`,
      [DEMO_TENANT_ID, owner],
    );
    expect(m).toEqual([{ is_owner: true, status: "ACTIVE", roles: ["TENANT_ADMIN"] }]);
    const row = (await q<{ actor_user_id: string | null; ip: string | null; user_agent: string | null }>(
      "SELECT actor_user_id, ip, user_agent FROM public.audit_logs WHERE tenant_id = $1 AND reason = 'demo.bootstrap' ORDER BY occurred_at DESC LIMIT 1",
      [DEMO_TENANT_ID],
    ))[0];
    expect(row).toEqual({ actor_user_id: null, ip: null, user_agent: null }); // aktör = sistem; demo'da IP/UA yok
    expect(await bootstrapDemoOwner(app, { ownerUserId: owner })).toEqual({ written: false });
    expect(await auditCount("demo.bootstrap")).toBe(before + 1);
  });

  it("var olan ACTIVE sahip üyeliğe TENANT_ADMIN rolü eklenince roles_version artar", async () => {
    await wipeDemoMemberships();
    const owner = (await accounts.ensureAccount({ email: DEMO_ROLES.TENANT_ADMIN, name: "Demo Yönetici", password: PASSWORD })).userId;
    const mid = await mkMembership(DEMO_TENANT_ID, owner, { owner: true, roles: [] }); // ACTIVE sahip, rolsüz
    const version = async () => Number((await q<{ v: number }>("SELECT roles_version v FROM public.tenant_memberships WHERE id = $1", [mid]))[0]!.v);
    const v0 = await version();
    expect(await bootstrapDemoOwner(app, { ownerUserId: owner })).toEqual({ written: true });
    expect(await version()).toBe(v0 + 1);
    expect(await n("SELECT count(*) n FROM public.membership_roles WHERE membership_id = $1 AND role_key = 'TENANT_ADMIN'", [mid])).toBe(1);
    expect(await bootstrapDemoOwner(app, { ownerUserId: owner })).toEqual({ written: false });
    expect(await version()).toBe(v0 + 1);
  });

  it("eşzamanlı iki bootstrap (ayrı bağlantılar): tek sahip üyelik, tek TENANT_ADMIN rol, tek audit, hata yok", async () => {
    await wipeDemoMemberships();
    const owner = (await accounts.ensureAccount({ email: DEMO_ROLES.TENANT_ADMIN, name: "Demo Yönetici", password: PASSWORD })).userId;
    const before = await auditCount("demo.bootstrap");
    const results = await Promise.all([bootstrapDemoOwner(app, { ownerUserId: owner }), bootstrapDemoOwner(app2, { ownerUserId: owner })]);
    expect(results.filter((r) => r.written).length).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1 AND is_owner AND status = 'ACTIVE'", [DEMO_TENANT_ID])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.tenant_memberships WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(1);
    expect(await n("SELECT count(*) n FROM public.membership_roles WHERE tenant_id = $1 AND role_key = 'TENANT_ADMIN'", [DEMO_TENANT_ID])).toBe(1);
    expect(await auditCount("demo.bootstrap")).toBe(before + 1);
  });
});

describe("reseedDemo", () => {
  it("boş demo tenant: hesaplar + üyelikler + rol + ayar; parola hiçbir yerde yok; ikinci koşu aynı sonuç", async () => {
    await wipeDemoMemberships();
    const first = await run();
    expect(first.memberships.created).toBe(4); // yönetici bootstrap ile; diğer dördü onarımla
    expect(await demoState()).toEqual(expectedDemoState());
    const s = (await q<{ name: string; locale: string; time_zone: string; sector_template_key: string; sector_template_version: number; terminology: unknown; onboarding_status: string }>(
      `SELECT t.name, s.locale, s.time_zone, s.sector_template_key, s.sector_template_version, s.terminology, s.onboarding_status
         FROM public.tenants t JOIN public.tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`,
      [DEMO_TENANT_ID],
    ))[0]!;
    expect(s).toMatchObject({ name: DEMO_TENANT_NAME, locale: "tr", time_zone: "Europe/Istanbul", sector_template_key: "PACKAGING_SUPPLIES", sector_template_version: 2, onboarding_status: "COMPLETED" });
    expect(s.terminology).toEqual(template.terminology);

    const c1 = await counts();
    const second = await run();
    expect(second).toEqual({
      accountsCreated: 0,
      passwordsUpdated: 0,
      bootstrapped: false,
      memberships: { created: 0, reactivated: 0, rolesFixed: 0, ownershipChanged: false, removed: 0 },
      settings: { nameOrLocaleChanged: false, templateChanged: false },
      catalog: { itemsCreated: 0, locationsCreated: 0, stockDocuments: 0, stockLines: 0 },
    });
    expect(await counts()).toEqual(c1); // satır sayıları eşit
    expect(await demoState()).toEqual(expectedDemoState());

    // Parola: audit, güvenlik olayları ve audit özetinde yok (G-09).
    const ids = Object.values(await demoUserIds());
    const ev = await q<{ t: string }>("SELECT (e.*)::text AS t FROM public.security_events e WHERE user_id = ANY($1::uuid[])", [ids]);
    expect(ev.some((r) => r.t.includes(PASSWORD))).toBe(false);
    const au = await q<{ t: string }>("SELECT (a.*)::text AS t FROM public.audit_logs a WHERE tenant_id = $1", [DEMO_TENANT_ID]);
    expect(au.some((r) => r.t.includes(PASSWORD))).toBe(false);
    expect(au.length).toBeGreaterThan(0);
  });

  it("bozulmuş rol/üyelik/ayar/parola onarılır; ziyaretçi tenant'ı ve ziyaretçinin demo tenant dışı üyelikleri etkilenmez", async () => {
    await run();
    const ids = await demoUserIds();
    // Ziyaretçi tenant'ı (staging'de kayıt olan kullanıcının kendi tenant'ı) + demo kullanıcısının orada üyeliği.
    const visitor = await mkForeignUser("visitor");
    const visitorTenant = randomUUID();
    await q("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T123 Visitor', false)", [visitorTenant, `t123-v-${randomBytes(5).toString("hex")}`]);
    await q("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'en', 'UTC', 'IN_PROGRESS')", [visitorTenant]);
    await mkMembership(visitorTenant, visitor, { owner: true, roles: ["TENANT_ADMIN"] });
    await mkMembership(visitorTenant, ids[DEMO_ROLES.PICKER]!, { roles: ["READ_ONLY"] });
    const snap = async () =>
      JSON.stringify(
        await q(
          `SELECT 'm' k, m::text v FROM public.tenant_memberships m WHERE tenant_id = $1
           UNION ALL SELECT 'r', r::text FROM public.membership_roles r WHERE tenant_id = $1
           UNION ALL SELECT 's', s::text FROM public.tenant_settings s WHERE tenant_id = $1
           UNION ALL SELECT 't', t::text FROM public.tenants t WHERE id = $1 ORDER BY 1, 2`,
          [visitorTenant],
        ),
      );
    const visitorBefore = await snap();
    const visitorAudit = await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [visitorTenant]);

    // Bozma: sef rolü PICKER; sayım üyeliği REMOVED; toplayıcı sahip; izleyici rolsüz; ad/ayar bozuk; parola bozuk.
    const mid = async (email: string) => (await q<{ id: string }>("SELECT m.id FROM public.tenant_memberships m JOIN public.users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email = $2", [DEMO_TENANT_ID, email]))[0]!.id;
    const sef = await mid(DEMO_ROLES.WAREHOUSE_MANAGER);
    await q("DELETE FROM public.membership_roles WHERE membership_id = $1", [sef]);
    await q("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'PICKER')", [DEMO_TENANT_ID, sef]);
    await q("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [await mid(DEMO_ROLES.COUNTER)]);
    await q("UPDATE public.tenant_memberships SET is_owner = true WHERE id = $1", [await mid(DEMO_ROLES.PICKER)]);
    await q("DELETE FROM public.membership_roles WHERE membership_id = $1", [await mid(DEMO_ROLES.READ_ONLY)]);
    await q("UPDATE public.tenants SET name = 'Hacked Co' WHERE id = $1", [DEMO_TENANT_ID]);
    await q("UPDATE public.tenant_settings SET locale = 'en', time_zone = 'UTC', terminology = '{}'::jsonb, sector_template_key = 'GENERIC', onboarding_status = 'IN_PROGRESS' WHERE tenant_id = $1", [DEMO_TENANT_ID]);
    await q("UPDATE public.accounts SET password = $2 WHERE user_id = $1 AND provider_id = 'credential'", [ids[DEMO_ROLES.TENANT_ADMIN], await hashPassword("some-other-password-123")]);
    // Demo dışı kullanıcı: demo tenant'ta ACTIVE üye.
    const stranger = await mkForeignUser("stranger");
    await mkMembership(DEMO_TENANT_ID, stranger, { roles: ["READ_ONLY"] });

    const r = await run();
    expect(r.passwordsUpdated).toBe(1);
    expect(r.memberships).toMatchObject({ created: 0, reactivated: 1, rolesFixed: 2, ownershipChanged: true, removed: 1 });
    expect(r.settings).toEqual({ nameOrLocaleChanged: true, templateChanged: true });
    // MINOR-2: ad/dil onarımı audit'i gerekçe `demo.reseed` taşır; aktör demo sahibi.
    const sa = await q<{ reason: string | null; actor_user_id: string }>(
      "SELECT reason, actor_user_id FROM public.audit_logs WHERE tenant_id = $1 AND action = 'tenant.settings_changed' AND change_summary ? 'name' ORDER BY occurred_at DESC LIMIT 1",
      [DEMO_TENANT_ID],
    );
    expect(sa).toEqual([{ reason: "demo.reseed", actor_user_id: ids[DEMO_ROLES.TENANT_ADMIN] }]);
    const active = (await demoState()).filter((x) => x.status === "ACTIVE" && (Object.values(DEMO_ROLES) as string[]).includes(x.email));
    expect(active).toEqual(expectedDemoState());
    expect((await demoState()).find((x) => x.email.startsWith("t123-stranger"))).toMatchObject({ status: "REMOVED", is_owner: false });
    const row = (await q<{ name: string; locale: string; time_zone: string; sector_template_key: string; terminology: unknown; onboarding_status: string }>(
      "SELECT t.name, s.locale, s.time_zone, s.sector_template_key, s.terminology, s.onboarding_status FROM public.tenants t JOIN public.tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1",
      [DEMO_TENANT_ID],
    ))[0]!;
    expect(row).toMatchObject({ name: DEMO_TENANT_NAME, locale: "tr", time_zone: "Europe/Istanbul", sector_template_key: "PACKAGING_SUPPLIES", onboarding_status: "COMPLETED" });
    expect(row.terminology).toEqual(template.terminology);
    const hash = (await q<{ password: string }>("SELECT password FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [ids[DEMO_ROLES.TENANT_ADMIN]]))[0]!.password;
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);

    // Ziyaretçi tenant'ı bayt bayt aynı; ziyaretçi/demo kullanıcısının oradaki üyelikleri korunur; orada audit yok.
    expect(await snap()).toBe(visitorBefore);
    expect(await n("SELECT count(*) n FROM public.audit_logs WHERE tenant_id = $1", [visitorTenant])).toBe(visitorAudit);
    // Onarım sonrası tekrar: değişiklik yok.
    const again = await run();
    expect(again.memberships).toEqual({ created: 0, reactivated: 0, rolesFixed: 0, ownershipChanged: false, removed: 0 });
    expect(again.settings).toEqual({ nameOrLocaleChanged: false, templateChanged: false });
  });

  it("demo dışı sahip: sahiplik demo yöneticisine devredilir, sonra çıkarılır; son sahip hatası yok", async () => {
    await run();
    const ids = await demoUserIds();
    const admin = ids[DEMO_ROLES.TENANT_ADMIN]!;
    const foreign = await mkForeignUser("old-owner");
    // Senaryo A: demo yöneticisi hiç üye değil; demo tenant'ın tek sahibi demo dışı kullanıcı.
    await wipeDemoMemberships();
    await mkMembership(DEMO_TENANT_ID, foreign, { owner: true, roles: ["TENANT_ADMIN"] });
    const ra = await run();
    expect(ra.bootstrapped).toBe(true); // sahip vardı: yönetici sahipsiz TENANT_ADMIN olarak kuruldu
    expect(ra.memberships).toMatchObject({ ownershipChanged: true, removed: 1 });
    const st = await demoState();
    expect(st.filter((x) => x.is_owner && x.status === "ACTIVE").map((x) => x.email)).toEqual([DEMO_ROLES.TENANT_ADMIN]);
    expect(st.find((x) => x.email.startsWith("t123-old-owner"))).toMatchObject({ status: "REMOVED", is_owner: false });
    expect(await auditCount("demo.reseed")).toBeGreaterThan(0);
    const ownerAudits = await q<{ actor_user_id: string }>("SELECT actor_user_id FROM public.audit_logs WHERE tenant_id = $1 AND action IN ('ownership.transferred','member.removed') AND reason = 'demo.reseed'", [DEMO_TENANT_ID]);
    expect(ownerAudits.length).toBeGreaterThanOrEqual(2);
    expect(ownerAudits.every((a) => a.actor_user_id === admin)).toBe(true); // aktör = demo sahibi (m8)

    // Senaryo B: yönetici ACTIVE ama sahip değil; demo dışı kullanıcı sahip.
    const foreign2 = await mkForeignUser("old-owner2");
    await q("UPDATE public.tenant_memberships SET is_owner = false WHERE tenant_id = $1 AND user_id = $2", [DEMO_TENANT_ID, admin]);
    await mkMembership(DEMO_TENANT_ID, foreign2, { owner: true, roles: ["TENANT_ADMIN"] });
    const rb = await run();
    expect(rb.memberships).toMatchObject({ ownershipChanged: true, removed: 1 });
    expect((await demoState()).filter((x) => x.is_owner && x.status === "ACTIVE").map((x) => x.email)).toEqual([DEMO_ROLES.TENANT_ADMIN]);
  });

  it("demo tenant yoksa açık hata (worker tenant oluşturmaz)", async () => {
    // Var olmayan kimlikle bootstrap: withSystemTenant FORBIDDEN → NOT_FOUND.
    let err: unknown;
    try {
      await bootstrapOwnerInTenant(app, await mkForeignUser("missing"), randomUUID());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("NOT_FOUND");
  });
});

describe("worker işi ve zamanlama", () => {
  const logs: { level: string; msg: string; fields: unknown }[] = [];
  const logger = {
    info: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "info", msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) => void logs.push({ level: "error", msg, fields }),
  };
  const ctx = { jobId: "job-1", type: "demo.reseed", hasTenant: true, actorUserId: null, payload: {}, inTenant: () => Promise.reject(new Error("unused")) } as never;

  it("handler reseedDemo'yu çalıştırır; log parola içermez", async () => {
    logs.length = 0;
    await createDemoReseedHandler({ db: app, accounts, password: PASSWORD, logger })(ctx);
    expect(logs.map((l) => l.msg)).toEqual(["demo.reseed done"]);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("handler hatayı yutmaz (yeniden denenebilsin); log yalnızca hata adı/kodu", async () => {
    logs.length = 0;
    const failing: DemoAccountPort = { ensureAccount: () => Promise.reject(new Error(`boom ${PASSWORD}`)) };
    await expect(createDemoReseedHandler({ db: app, accounts: failing, password: PASSWORD, logger })(ctx)).rejects.toThrow("boom");
    expect(logs).toEqual([{ level: "error", msg: "demo.reseed failed", fields: { jobId: "job-1", error: "Error" } }]);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("zamanlayıcı: açılışta bir kez, sonra günlük 03:00 UTC; hata loglanır ve tur sürer; stop sonrası yok", async () => {
    logs.length = 0;
    let calls = 0;
    let failNext = false;
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    let nowMs = Date.parse("2026-10-06T10:00:00.000Z");
    const sched = startDemoReseedSchedule({
      logger,
      now: () => new Date(nowMs),
      enqueue: async () => {
        calls++;
        if (failNext) throw new Error("db down");
        return { jobId: calls === 1 ? "j1" : null };
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
    });
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(17 * 3600 * 1000); // 10:00 → ertesi gün 03:00
    failNext = true;
    nowMs = Date.parse("2026-10-07T03:00:00.000Z");
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    expect(logs.some((l) => l.level === "error" && l.msg === "demo.reseed enqueue failed")).toBe(true);
    expect(timers).toHaveLength(2); // hata sonrası yeniden kuruldu
    expect(timers[1]!.ms).toBe(24 * 3600 * 1000);
    sched.stop();
    expect(timers[1]!.cleared).toBe(true);
  });

  it("zamanlayıcının enqueue'su (withSystemTenant + singletonKey): eşzamanlı/ardışık çağrılarda tek iş; iş yükünde tenant kimliği yok", async () => {
    await installQueueSchema({ url: env.databaseUrlDirect });
    const queue = createJobQueue({
      connectionString: env.databaseUrl,
      max: 2,
      runInTenant: (tenantId, reason, fn) => withSystemTenant(app, tenantId, `queue.${reason}`, fn),
    });
    await queue.start();
    try {
      const enqueue = () =>
        withSystemTenant(app, DEMO_TENANT_ID, "demo.schedule", (tx) =>
          queue.enqueue(tx, { type: "demo.reseed", payload: {}, singletonKey: DEMO_RESEED_SINGLETON_KEY }),
        );
      const [a, b] = await Promise.all([enqueue(), enqueue()]);
      expect([a.jobId, b.jobId].filter((x) => x !== null)).toHaveLength(1);
      expect((await enqueue()).jobId).toBeNull();
      const jobs = await q<{ data: Record<string, unknown> }>(`SELECT data FROM ${QUEUE_SCHEMA}.job WHERE name = 'demo.reseed' AND data->>'tenantId' = $1`, [DEMO_TENANT_ID]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data.payload).toEqual({});
    } finally {
      await queue.stop();
      // Başka dosyaların tüketicileri 'demo.reseed' türünü alabilir: bu testin işi kuyrukta bırakılmaz.
      await q(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE name = 'demo.reseed' AND data->>'tenantId' = $1`, [DEMO_TENANT_ID]);
    }
  });
});
