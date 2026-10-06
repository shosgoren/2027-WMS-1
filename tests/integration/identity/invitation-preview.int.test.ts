// T-117d: davet önizleme işlevi (migration 0008) — gerçek wms_app bağlantısı + RLS. Fikstürler sentetik (G-09).
// Geçerli davet dışındaki her durum (yok/süresi dolmuş/iptal/kabul/askıda tenant/demo) AYNI biçimde 0 satır döner.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { previewInvitation } from "../../../packages/domain/src/identity/invitations.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let app: DbClient;
let adm: pg.Client;
let appPg: pg.Client; // wms_app ile ham sorgu (superuser DEĞİL)
const tenants: string[] = [];

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  appPg = new pg.Client({ connectionString: env.databaseUrl });
  appPg.on("error", () => undefined);
  try {
    await adm.connect();
    await appPg.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
}, 60_000);

afterAll(async () => {
  await adm.end();
  await appPg.end();
  await app.close();
});

interface Fx {
  tenant: string;
  membership: string;
}
async function mkTenant(o: { name?: string; status?: string; demo?: boolean } = {}): Promise<Fx> {
  const tenant = randomUUID();
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, $3, $4)", [
    tenant,
    `t117d-${randomBytes(6).toString("hex")}`,
    o.name ?? "T117d Çalışma Alanı",
    o.demo ?? false,
  ]);
  tenants.push(tenant);
  const u = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T117d fixture', $1, true) RETURNING id", [
    `t117d-${randomBytes(6).toString("hex")}@example.test`,
  ]);
  const m = await adm.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false) RETURNING id",
    [tenant, (u.rows[0] as { id: string }).id],
  );
  const membership = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'TENANT_ADMIN')", [tenant, membership]);
  if (o.status !== undefined) await adm.query("UPDATE public.tenants SET status = $2 WHERE id = $1", [tenant, o.status]);
  return { tenant, membership };
}
async function mkInvite(
  fx: Fx,
  o: { role?: string; expiresIn?: string; revoked?: boolean; accepted?: boolean } = {},
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adm.query(
    `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id, revoked_at, accepted_at)
     VALUES ($1, $2, $3, $4, 'SCREEN', now() + $5::interval, $6, CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() END)`,
    [fx.tenant, `t117d-${randomBytes(6).toString("hex")}@example.test`, o.role ?? "COUNTER", sha(token), o.expiresIn ?? "1 hour", fx.membership, o.revoked ?? false, o.accepted ?? false],
  );
  return token;
}
async function rawPreview(tokenHash: string): Promise<Record<string, unknown>[]> {
  return (await appPg.query("SELECT * FROM wms_probe.invitation_preview_for_token($1)", [tokenHash])).rows;
}

describe(`invitation_preview_for_token (0008, T-117d; target=${env.target})`, () => {
  it("geçerli davet: yalnızca (tenant_name, role_key, expires_at); e-posta/kimlik/slug yok", async () => {
    const fx = await mkTenant({ name: "Örnek Depo A.Ş." });
    const token = await mkInvite(fx, { role: "PICKER", expiresIn: "5 hours" });
    const rows = await rawPreview(sha(token));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object).sort()).toEqual(["expires_at", "role_key", "tenant_name"]);
    expect(rows[0]).toMatchObject({ tenant_name: "Örnek Depo A.Ş.", role_key: "PICKER" });
    const left = new Date(rows[0]?.expires_at as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(4 * 3_600_000);
    expect(left).toBeLessThan(5 * 3_600_000 + 60_000);
  });

  it("geçersiz durumlar (yok, süresi dolmuş, iptal, kabul, askıda tenant, kapanan tenant, demo, NULL, biçimsiz) hepsi 0 satır", async () => {
    const ok = await mkTenant();
    const expired = await mkInvite(ok, { expiresIn: "-1 minute" });
    const revoked = await mkInvite(ok, { revoked: true });
    const accepted = await mkInvite(ok, { accepted: true });
    const suspended = await mkInvite(await mkTenant({ status: "SUSPENDED" }));
    const closing = await mkInvite(await mkTenant({ status: "CLOSING" }));
    const demo = await mkInvite(await mkTenant({ demo: true }));
    for (const t of [expired, revoked, accepted, suspended, closing, demo, randomBytes(32).toString("base64url")]) {
      expect(await rawPreview(sha(t))).toEqual([]);
    }
    expect(await rawPreview("not-a-hash")).toEqual([]);
    expect(await rawPreview("")).toEqual([]);
    expect((await appPg.query("SELECT * FROM wms_probe.invitation_preview_for_token(NULL)")).rows).toEqual([]);
  });

  it("previewInvitation: geçerli → ad+rol+süre; geçersiz/biçimsiz/başka türde → null", async () => {
    const fx = await mkTenant({ name: "Önizleme Ltd." });
    const token = await mkInvite(fx, { role: "READ_ONLY" });
    const p = await previewInvitation({ db: app, token });
    expect(p).toEqual({ tenantName: "Önizleme Ltd.", roleKey: "READ_ONLY", expiresAt: expect.any(Date) });
    expect(Object.keys(p as object).sort()).toEqual(["expiresAt", "roleKey", "tenantName"]);
    expect(await previewInvitation({ db: app, token: await mkInvite(fx, { revoked: true }) })).toBeNull();
    expect(await previewInvitation({ db: app, token: randomBytes(32).toString("base64url") })).toBeNull();
    expect(await previewInvitation({ db: app, token: "short" })).toBeNull();
    expect(await previewInvitation({ db: app, token: 42 })).toBeNull();
    expect(await previewInvitation({ db: app, token: undefined })).toBeNull();
  });

  it("wms_app doğrudan invitations'a bağlamsız ve başka tenant bağlamında erişemez (RLS)", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    await mkInvite(b);
    const noCtx = await appPg.query("SELECT id FROM public.invitations WHERE tenant_id = $1", [b.tenant]);
    expect(noCtx.rows).toEqual([]);
    const crossTenant = await withTenant(createTenantContext(app, a.tenant), (tx) =>
      tx.execute(`SELECT id FROM public.invitations WHERE tenant_id = '${b.tenant}'`),
    );
    expect([...crossTenant]).toEqual([]);
  });
});
