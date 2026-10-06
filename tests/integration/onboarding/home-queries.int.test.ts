// T-122a: ana ekran/ayarlar salt okunur sorguları. Gerçek wms_app bağlantısı + RLS. Fikstürler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { listMyActionsToday } from "../../../packages/domain/src/audit/today.ts";
import { getTenantSettings } from "../../../packages/domain/src/onboarding/settings-queries.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);

let app: DbClient;
let adm: pg.Client;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

interface Member {
  userId: string;
  membershipId: string;
  email: string;
  name: string;
}
interface Fx {
  tenant: string;
  slug: string;
  owner: Member;
}
const rnd = (): string => randomBytes(6).toString("hex");
async function mkMember(tenant: string, role: string, opts: { owner?: boolean; email?: string; userId?: string; name?: string } = {}): Promise<Member> {
  const email = opts.email ?? `t122a-${rnd()}@example.test`;
  const name = opts.name ?? `T122a ${rnd()}`;
  let userId = opts.userId;
  if (userId === undefined) {
    const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, email]);
    userId = (r.rows[0] as { id: string }).id;
  }
  const m = await adm.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenant, userId, opts.owner ?? false],
  );
  const membershipId = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, membershipId, role]);
  return { userId, membershipId, email, name };
}
async function mkTenant(opts: { demo?: boolean; name?: string; tz?: string } = {}): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t122a-${rnd()}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, $3, $4)", [tenant, slug, opts.name ?? "T122a", opts.demo ?? false]);
  await adm.query("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', $2, 'COMPLETED')", [tenant, opts.tz ?? "UTC"]);
  const owner = await mkMember(tenant, "TENANT_ADMIN", { owner: true });
  return { tenant, slug, owner };
}
async function audit(fx: Fx, actor: Member, action: string): Promise<void> {
  await adm.query(
    "INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, ip, user_agent, change_summary) VALUES ($1, $2, $3, '203.0.113.9', 'ua-test', '{\"secret\":\"x\"}'::jsonb)",
    [fx.tenant, actor.userId, action],
  );
}
const acc = (fx: Fx, actor: Member) => ({ db: app, principal: { userId: actor.userId, mfaVerified: true }, tenantSlug: fx.slug });
const inMs = (ms: number): Date => new Date(Date.now() + ms);

describe("getTenantSettings", () => {
  it("settings.manage sahibi ad/dil/saat dilimi/slug okur", async () => {
    const fx = await mkTenant({ name: "Ayar Ltd", tz: "Europe/Istanbul" });
    expect(await getTenantSettings(acc(fx, fx.owner))).toEqual({ name: "Ayar Ltd", locale: "tr", timeZone: "Europe/Istanbul", slug: fx.slug });
  });
  it("izinsiz rol → FORBIDDEN", async () => {
    const fx = await mkTenant();
    const picker = await mkMember(fx.tenant, "PICKER");
    await expect(getTenantSettings(acc(fx, picker))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("başka tenant'ın slug'ı (üye değil) → NOT_FOUND", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    await expect(getTenantSettings({ ...acc(b, b.owner), tenantSlug: a.slug })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listMyActionsToday", () => {
  it("yalnızca kendi satırları; başka kullanıcı ve başka tenant satırı yok; ham alan dönmez", async () => {
    const fx = await mkTenant();
    const other = await mkMember(fx.tenant, "PICKER");
    const fy = await mkTenant();
    await audit(fx, fx.owner, "member.invited");
    await audit(fx, other, "member.removed");
    await audit(fx, fx.owner, "gelecek.eylem");
    await audit(fy, fy.owner, "tenant.created");
    const page = await listMyActionsToday(acc(fx, fx.owner), { limit: 20 });
    expect(page.items.map((i) => i.action).sort()).toEqual(["gelecek.eylem", "member.invited"]);
    expect(page.items.find((i) => i.action === "gelecek.eylem")?.summaryKey).toBe("audit.other");
    expect(page.items.find((i) => i.action === "member.invited")?.summaryKey).toBe("audit.member.invited");
    for (const i of page.items) expect(Object.keys(i).sort()).toEqual(["action", "occurredAt", "summaryKey"]);
    expect(JSON.stringify(page)).not.toMatch(/203\.0\.113|ua-test|secret/);
    expect((await listMyActionsToday(acc(fx, other))).items.map((i) => i.action)).toEqual(["member.removed"]);
  });
  it("keyset: limit ve imleçle sayfalar, tekrar/atlama yok", async () => {
    const fx = await mkTenant();
    for (let i = 0; i < 5; i++) await audit(fx, fx.owner, `member.invited`);
    const seen: string[] = [];
    let cursor;
    let pages = 0;
    do {
      const p = await listMyActionsToday(acc(fx, fx.owner), { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...p.items.map((i) => `${i.occurredAt.getTime()}`));
      cursor = p.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(seen).toHaveLength(5);
    expect(pages).toBe(3);
  });
  it("gün sınırı tenant saat dilimine göre", async () => {
    const tz = "Asia/Kolkata"; // DST yok, UTC+05:30
    const fx = await mkTenant({ tz });
    await audit(fx, fx.owner, "member.invited");
    const r = await adm.query<{ t: Date }>("SELECT occurred_at AS t FROM public.audit_logs WHERE tenant_id = $1", [fx.tenant]);
    const t = (r.rows[0] as { t: Date }).t;
    const local = new Date(t.getTime() + 330 * 60_000); // Kolkata duvar saati (UTC alanları)
    const minutesToMidnight = 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes());
    const before = new Date(t.getTime() + (minutesToMidnight - 1) * 60_000);
    const after = new Date(t.getTime() + (minutesToMidnight + 1) * 60_000);
    expect((await listMyActionsToday(acc(fx, fx.owner), { now: before })).items).toHaveLength(1);
    expect((await listMyActionsToday(acc(fx, fx.owner), { now: after })).items).toHaveLength(0);
    // Aynı an, farklı dilimde (UTC): sonuç o dilimin günüyle belirlenir
    const fz = await mkTenant({ tz: "UTC" });
    await audit(fz, fz.owner, "member.invited");
    const r2 = await adm.query<{ t: Date }>("SELECT occurred_at AS t FROM public.audit_logs WHERE tenant_id = $1", [fz.tenant]);
    const t2 = (r2.rows[0] as { t: Date }).t;
    const utcMin = 24 * 60 - (t2.getUTCHours() * 60 + t2.getUTCMinutes());
    expect((await listMyActionsToday(acc(fz, fz.owner), { now: new Date(t2.getTime() + (utcMin - 1) * 60_000) })).items).toHaveLength(1);
    expect((await listMyActionsToday(acc(fz, fz.owner), { now: new Date(t2.getTime() + (utcMin + 1) * 60_000) })).items).toHaveLength(0);
  });
  it("dünkü satır bugün listesinde yok; okuma izni her rolde (READ_ONLY)", async () => {
    const fx = await mkTenant();
    const ro = await mkMember(fx.tenant, "READ_ONLY");
    await audit(fx, ro, "member.left");
    expect((await listMyActionsToday(acc(fx, ro))).items).toHaveLength(1);
    expect((await listMyActionsToday(acc(fx, ro), { now: inMs(36 * 3600_000) })).items).toHaveLength(0);
  });
  it("limit > 20 → VALIDATION_FAILED", async () => {
    const fx = await mkTenant();
    await expect(listMyActionsToday(acc(fx, fx.owner), { limit: 21 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
