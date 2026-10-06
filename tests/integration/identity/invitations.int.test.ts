// T-117: davet yaşam döngüsü (ADR-016 §3, §10, §12; ADR-014 §11; A-42). Gerçek wms_app / wms_auth bağlantıları + RLS +
// gerçek pg-boss kuyruğu. Fikstürler sentetik (G-09); parolalar/gizler çalışma anında üretilir. Migration rolü yalnızca
// kurulum/doğrulama içindir. Audit append-only olduğundan audit satırı yazan tenant/kullanıcılar silinmez (kısa ömürlü ortam).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withMembership, withSystemTenant, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { createAuth, readAuthEnv, type AuthService } from "../../../packages/auth/src/index.ts";
import { QUEUE_SCHEMA, createJobQueue, installQueueSchema, type PgBossJobQueue } from "../../../packages/queue-adapter/src/index.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { JOB_PAYLOAD_SCHEMAS } from "../../../packages/shared/src/queue.ts";
import { loadMailConfig, type MailConfig, type MailMessage } from "../../../packages/shared/src/mailer.ts";
import { runTenantCommand } from "../../../packages/domain/src/identity/access.ts";
import {
  acceptInvitation,
  inviteMember,
  revokeInvitation,
  type AcceptInvitationDeps,
  type InvitationDeps,
} from "../../../packages/domain/src/identity/invitations.ts";
import { createDeliverInvitationHandler } from "../../../apps/worker/src/jobs/deliver-invitation.ts";
import { createActionGuard, type GuardDeps } from "../../../apps/web/lib/action-guard.ts";
import { safeNext } from "../../../apps/web/lib/safe-redirect.ts";
import { closeSenderQueue, getSenderQueue } from "../../../apps/web/lib/queue.ts";
import { readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const authUrl = readAuthDatabaseUrl(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect, authUrl];
const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = `P${randomBytes(12).toString("hex")}`;
const DEMO_DOMAIN = "demo-t117.example.invalid";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let app: DbClient;
let authClient: DbClient;
let auth: AuthService;
let adm: pg.Client;
let queue: PgBossJobQueue;
const tenants: string[] = [];

const mailOn: MailConfig = loadMailConfig({ MAIL_MODE: "mailpit", MAILPIT_URL: "http://localhost:8025", MAIL_FROM: "noreply@example.test" });
const mailOff: MailConfig = loadMailConfig({});

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  authClient = createDbClient({ url: authUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  auth = createAuth({
    client: authClient,
    env: readAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DATABASE_URL: env.databaseUrl, AUTH_DATABASE_URL: authUrl }),
  });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
    await installQueueSchema({ url: env.databaseUrlDirect });
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  queue = createJobQueue({
    connectionString: env.databaseUrl,
    max: 3,
    pollingIntervalSeconds: 0.5,
    stopTimeoutMs: 5000,
    runInTenant: (tenantId, _reason, fn) => withTenant(createTenantContext(app, tenantId), fn),
  });
  await queue.start();
}, 120_000);

afterAll(async () => {
  await queue.stop();
  await adm.query(`DELETE FROM ${QUEUE_SCHEMA}.job WHERE name = 'invitation.deliver' AND data->>'tenantId' = ANY($1::text[])`, [tenants]).catch(() => undefined);
  await adm.end();
  await app.close();
  await authClient.close();
}, 60_000);

const deps = (mail: MailConfig = mailOn): InvitationDeps => ({ mailConfig: mail, queue });

// ---------------------------------------------------------------------------------------------
// Fikstürler
// ---------------------------------------------------------------------------------------------
interface Fx {
  tenant: string;
  slug: string;
  admin: string;
  adminMembership: string;
}
async function mkUser(email: string, verified = true): Promise<string> {
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ('T117 fixture', $1, $2) RETURNING id", [email, verified]);
  return (r.rows[0] as { id: string }).id;
}
const rndEmail = (domain = "example.test"): string => `t117-${randomBytes(6).toString("hex")}@${domain}`;
async function mkTenant(opts: { demo?: boolean } = {}): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t117-${randomBytes(6).toString("hex")}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name, is_demo) VALUES ($1, $2, 'T117', $3)", [tenant, slug, opts.demo ?? false]);
  tenants.push(tenant);
  const admin = await mkUser(rndEmail());
  const adminMembership = await mkMember(tenant, admin, "TENANT_ADMIN");
  return { tenant, slug, admin, adminMembership };
}
async function mkMember(tenant: string, user: string, role: string, status: "ACTIVE" | "REMOVED" = "ACTIVE"): Promise<string> {
  const m = await adm.query<{ id: string }>(
    `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner, removed_at)
     VALUES ($1, $2, $3, false, CASE WHEN $3 = 'REMOVED' THEN now() END) RETURNING id`,
    [tenant, user, status],
  );
  const id = (m.rows[0] as { id: string }).id;
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, id, role]);
  return id;
}
const principalOf = (userId: string) => ({ userId, mfaVerified: true });

/** Doğrudan davet satırı (komut yolundan bağımsız fikstür). */
async function mkInvite(
  fx: Fx,
  o: { email: string; role?: string; via?: "EMAIL" | "SCREEN"; expiresIn?: string; revoked?: boolean; accepted?: boolean },
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const r = await adm.query<{ id: string }>(
    `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id, revoked_at, accepted_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7, CASE WHEN $8 THEN now() END, CASE WHEN $9 THEN now() END) RETURNING id`,
    [fx.tenant, o.email, o.role ?? "PICKER", sha(token), o.via ?? "SCREEN", o.expiresIn ?? "1 hour", fx.adminMembership, o.revoked ?? false, o.accepted ?? false],
  );
  return { id: (r.rows[0] as { id: string }).id, token };
}

async function invRow(id: string): Promise<{ token_hash: string; delivered_via: string; accepted_at: Date | null; revoked_at: Date | null; claim_id: string | null }> {
  const r = await adm.query("SELECT token_hash, delivered_via, accepted_at, revoked_at, claim_id FROM public.invitations WHERE id = $1", [id]);
  return r.rows[0];
}
async function jobsFor(invitationId: string): Promise<{ data: { tenantId: string | null; actorUserId: string | null; payload: Record<string, unknown> } }[]> {
  const r = await adm.query(`SELECT data FROM ${QUEUE_SCHEMA}.job WHERE name = 'invitation.deliver' AND data->'payload'->>'invitationId' = $1`, [invitationId]);
  return r.rows;
}
async function auditActions(tenant: string, entityId: string): Promise<{ action: string; change_summary: Record<string, unknown> }[]> {
  const r = await adm.query("SELECT action, change_summary FROM public.audit_logs WHERE tenant_id = $1 AND entity_id = $2 ORDER BY occurred_at, id", [tenant, entityId]);
  return r.rows;
}

const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
};

const acceptDeps = (overrides: Partial<AcceptInvitationDeps> = {}): AcceptInvitationDeps => ({
  createInvitedAccount: (input) => auth.createInvitedAccount(input),
  demoEmailDomain: DEMO_DOMAIN,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// inviteMember / revokeInvitation
// ---------------------------------------------------------------------------------------------
describe(`inviteMember (target=${env.target})`, () => {
  it("TENANT_ADMIN: teslim edilebilir → EMAIL, yer tutucu özet, kuyrukta yalnızca invitationId; düz belirteç dönmez", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const r = await inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: `  ${email.toUpperCase()} `, roleKey: "PICKER" }, deps());
    expect(r.delivery).toBe("EMAIL");
    expect(r).not.toHaveProperty("token");
    const row = await invRow(r.invitationId);
    expect(row.delivered_via).toBe("EMAIL");
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = await adm.query("SELECT email_normalized, role_key, expires_at > now() + interval '71 hours' AS ttl FROM public.invitations WHERE id = $1", [r.invitationId]);
    expect(stored.rows[0]).toMatchObject({ email_normalized: email.toLowerCase(), role_key: "PICKER", ttl: true });
    const jobs = await jobsFor(r.invitationId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.payload).toEqual({ invitationId: r.invitationId }); // yalnızca kimlik (M2)
    expect(jobs[0]?.data.tenantId).toBe(fx.tenant);
    expect(jobs[0]?.data.actorUserId).toBe(fx.admin);
    expect(JSON.stringify(jobs[0]?.data)).not.toMatch(/token|@/i);
    const audit = await auditActions(fx.tenant, r.invitationId);
    expect(audit.map((a) => a.action)).toEqual(["member.invited"]);
    expect(JSON.stringify(audit)).not.toContain(email.toLowerCase());
  });

  it("izinsiz rol (WAREHOUSE_MANAGER) → FORBIDDEN; hiçbir davet/iş yazılmaz", async () => {
    const fx = await mkTenant();
    const wm = await mkUser(rndEmail());
    await mkMember(fx.tenant, wm, "WAREHOUSE_MANAGER");
    const e = await failure(inviteMember({ db: app, principal: principalOf(wm), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" }, deps()));
    expect(e.code).toBe("FORBIDDEN");
    const n = await adm.query("SELECT count(*)::int AS n FROM public.invitations WHERE tenant_id = $1", [fx.tenant]);
    expect(n.rows[0].n).toBe(0);
  });

  it("teslim kapalı → SCREEN: belirteç bir kez döner, DB'de yalnızca SHA-256; audit ve kuyrukta düz değer yok", async () => {
    const fx = await mkTenant();
    const r = await inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "READ_ONLY" }, deps(mailOff));
    expect(r.delivery).toBe("SCREEN");
    expect(r.screenReason).toBe("DELIVERY_UNAVAILABLE");
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await invRow(r.invitationId);
    expect(row.delivered_via).toBe("SCREEN");
    expect(row.token_hash).toBe(sha(r.token ?? ""));
    const dump = await adm.query("SELECT row_to_json(i)::text AS j FROM public.invitations i WHERE id = $1", [r.invitationId]);
    expect(dump.rows[0].j).not.toContain(r.token ?? "x");
    expect(JSON.stringify(await auditActions(fx.tenant, r.invitationId))).not.toContain(r.token ?? "x");
    expect(await jobsFor(r.invitationId)).toHaveLength(0);
  });

  it("kuyruğa yazılamazsa SCREEN'e düşer (A-42), screenReason görünür; sahte başarı yok", async () => {
    const fx = await mkTenant();
    const logs: Record<string, unknown>[] = [];
    const secret = `postgres://u:${randomBytes(6).toString("hex")}@db/x`;
    const broken: InvitationDeps = {
      mailConfig: mailOn,
      queue: { enqueue: () => Promise.reject(Object.assign(new Error(`connect failed ${secret}`), { name: "QueueFault", code: "ECONNREFUSED" })) },
      log: (e) => void logs.push(e),
    };
    const r = await inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" }, broken);
    expect(r.delivery).toBe("SCREEN");
    expect(r.screenReason).toBe("QUEUE_UNAVAILABLE");
    expect(r.token).toBeDefined();
    expect((await invRow(r.invitationId)).delivered_via).toBe("SCREEN");
    // MINOR-2: kök neden maskeli loglanır (sınıf/kod); mesaj (bağlantı bilgisi) loga girmez.
    expect(logs).toEqual([{ level: "error", msg: "invitation enqueue failed", error: "QueueFault", code: "ECONNREFUSED" }]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("aynı e-postaya yeni davet eskisini iptal eder (audit: superseded)", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const base = { db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email, roleKey: "PICKER" };
    const first = await inviteMember(base, deps(mailOff));
    const second = await inviteMember(base, deps(mailOff));
    expect((await invRow(first.invitationId)).revoked_at).not.toBeNull();
    expect((await invRow(second.invitationId)).revoked_at).toBeNull();
    expect((await auditActions(fx.tenant, first.invitationId)).map((a) => a.action)).toEqual(["member.invited", "invitation.revoked"]);
  });

  it("is_demo tenant'ta davet tamamen kapalı → FORBIDDEN (EMAIL/SCREEN fark etmez)", async () => {
    const fx = await mkTenant({ demo: true });
    for (const mail of [mailOn, mailOff]) {
      const e = await failure(inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: `x@${"example.invalid"}`, roleKey: "PICKER" }, deps(mail)));
      expect(e.code).toBe("FORBIDDEN");
    }
  });

  it("e-postası zaten ACTIVE üye olan kişiye davet → VALIDATION_FAILED; geçersiz e-posta/rol → VALIDATION_FAILED", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const u = await mkUser(email);
    await mkMember(fx.tenant, u, "PICKER");
    const base = { db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug };
    expect((await failure(inviteMember({ ...base, email, roleKey: "PICKER" }, deps()))).code).toBe("VALIDATION_FAILED");
    expect((await failure(inviteMember({ ...base, email: "not-an-email", roleKey: "PICKER" }, deps()))).code).toBe("VALIDATION_FAILED");
    expect((await failure(inviteMember({ ...base, email: rndEmail(), roleKey: "ROOT" }, deps()))).code).toBe("VALIDATION_FAILED");
  });

  it("revokeInvitation: izinli iptal eder (audit), ikinci kez NOT_FOUND, izinsiz FORBIDDEN; iptal edilen belirteç kabul edilemez", async () => {
    const fx = await mkTenant();
    const inv = await mkInvite(fx, { email: rndEmail() });
    const reader = await mkUser(rndEmail());
    await mkMember(fx.tenant, reader, "READ_ONLY");
    expect((await failure(revokeInvitation({ db: app, principal: principalOf(reader), tenantSlug: fx.slug, invitationId: inv.id }))).code).toBe("FORBIDDEN");
    await revokeInvitation({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, invitationId: inv.id });
    expect((await auditActions(fx.tenant, inv.id)).map((a) => a.action)).toEqual(["invitation.revoked"]);
    expect((await failure(revokeInvitation({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, invitationId: inv.id }))).code).toBe("NOT_FOUND");
    const e = await failure(acceptInvitation({ db: app, token: inv.token, principal: principalOf(fx.admin) }, acceptDeps()));
    expect(e.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------------------------
// Worker teslimi
// ---------------------------------------------------------------------------------------------
describe("invitation.deliver (worker)", () => {
  const logger = { info: () => undefined, error: () => undefined };
  const handlerWith = (sent: MailMessage[], fail = false) =>
    createDeliverInvitationHandler({
      config: mailOn,
      mailer: { send: (m) => (fail ? Promise.reject(new Error("smtp down")) : (sent.push(m), Promise.resolve())) },
      logger,
      appBaseUrl: BASE,
    });
  type HandlerCtx = Parameters<ReturnType<typeof handlerWith>>[0];
  const ctxFor = (tenant: string, invitationId: string): HandlerCtx =>
    ({
      jobId: randomUUID(),
      type: "invitation.deliver" as const,
      hasTenant: true,
      actorUserId: null,
      payload: { invitationId },
      inTenant: (fn: (tx: unknown) => Promise<unknown>) => withSystemTenant(app, tenant, "queue.invitation.deliver", fn as never),
    }) as unknown as HandlerCtx;
  const tokenFrom = (m: MailMessage | undefined): string => {
    const t = /\/invite\/([A-Za-z0-9_-]{43})/.exec(m?.text ?? "")?.[1];
    if (t === undefined) throw new Error("no token in message");
    return t;
  };
  const tenantFor = async (hash: string): Promise<string | null> =>
    (await adm.query("SELECT wms_probe.invitation_tenant_for_token($1) AS t", [hash])).rows[0].t;

  it("teslim: yeni belirteç yazılır (yalnızca özet), gönderim sırasında satır kilidi YOK, anahtar özetten türer; yeniden denemede yeni belirteç ve yeni anahtar, eskisi geçersiz", async () => {
    const fx = await mkTenant();
    const r = await inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" }, deps());
    const sent: MailMessage[] = [];
    let lockFreeDuringSend = false;
    const probing = createDeliverInvitationHandler({
      config: mailOn,
      mailer: {
        send: async (m) => {
          // Gönderim anında satır kilidi tutulmuyor: ayrı bağlantıdan NOWAIT kilit alınabilir.
          const other = new pg.Client({ connectionString: env.databaseUrlDirect });
          other.on("error", () => undefined);
          await other.connect();
          try {
            await other.query("BEGIN");
            await other.query("SELECT 1 FROM public.invitations WHERE id = $1 FOR UPDATE NOWAIT", [r.invitationId]);
            lockFreeDuringSend = true;
            await other.query("ROLLBACK");
          } finally {
            await other.end();
          }
          sent.push(m);
        },
      },
      logger,
      appBaseUrl: BASE,
    });
    await probing(ctxFor(fx.tenant, r.invitationId));
    expect(lockFreeDuringSend).toBe(true);
    const t1 = tokenFrom(sent[0]);
    expect((await invRow(r.invitationId)).token_hash).toBe(sha(t1));
    expect(sent[0]?.idempotencyKey).toBe(`invitation-${sha(t1)}`);
    expect(await tenantFor(sha(t1))).toBe(fx.tenant);
    await handlerWith(sent)(ctxFor(fx.tenant, r.invitationId));
    const t2 = tokenFrom(sent[1]);
    expect(t2).not.toBe(t1);
    expect(sent[1]?.idempotencyKey).toBe(`invitation-${sha(t2)}`);
    expect(sent[1]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
    expect(await tenantFor(sha(t1))).toBeNull(); // eski belirteç geçersiz
    expect(await tenantFor(sha(t2))).toBe(fx.tenant);
    const dump = await adm.query("SELECT row_to_json(i)::text AS j FROM public.invitations i WHERE id = $1", [r.invitationId]);
    expect(dump.rows[0].j).not.toContain(t2);
  });

  it("başarısız gönderim: iş hata fırlatır; yeniden deneme YENİ belirteç + YENİ anahtarla gider ve DB'deki özet son e-postadaki belirtece aittir (lost-ack)", async () => {
    const fx = await mkTenant();
    const r = await inviteMember({ db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" }, deps());
    const seen: MailMessage[] = [];
    // Sağlayıcı e-postayı aldı ama ack kayboldu: mesaj kaydedilir, istek hata ile biter.
    const lostAck = createDeliverInvitationHandler({
      config: mailOn,
      mailer: { send: (m) => (seen.push(m), Promise.reject(new Error("ack lost"))) },
      logger,
      appBaseUrl: BASE,
    });
    await expect(lostAck(ctxFor(fx.tenant, r.invitationId))).rejects.toThrow();
    await expect(lostAck(ctxFor(fx.tenant, r.invitationId))).rejects.toThrow();
    expect(seen).toHaveLength(2);
    const [first, second] = [tokenFrom(seen[0]), tokenFrom(seen[1])];
    expect(first).not.toBe(second);
    expect(seen[0]?.idempotencyKey).not.toBe(seen[1]?.idempotencyKey);
    expect(await tenantFor(sha(first))).toBeNull();
    expect(await tenantFor(sha(second))).toBe(fx.tenant); // alıcının elindeki SON e-postanın belirteci geçerli
    // Son e-postadaki belirteçle kabul tamamlanır.
    const email = (await adm.query("SELECT email_normalized AS e FROM public.invitations WHERE id = $1", [r.invitationId])).rows[0].e as string;
    const user = await mkUser(email, true);
    await acceptInvitation({ db: app, token: second, principal: { userId: user } }, acceptDeps());
    expect((await invRow(r.invitationId)).accepted_at).not.toBeNull();
  });

  it("iptal edilmiş / kabul edilmiş / SCREEN davet için gönderim yapılmaz (sessiz bitiş)", async () => {
    const fx = await mkTenant();
    const sent: MailMessage[] = [];
    for (const o of [{ revoked: true }, { accepted: true }, { via: "SCREEN" as const }]) {
      const inv = await mkInvite(fx, { email: rndEmail(), via: "EMAIL", ...o });
      await handlerWith(sent)(ctxFor(fx.tenant, inv.id));
    }
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// acceptInvitation — mevcut hesapla kabul
// ---------------------------------------------------------------------------------------------
describe("acceptInvitation (mevcut hesap)", () => {
  it("doğrulanmış ve e-postası birebir aynı hesap: üyelik + tek rol + accepted_at + audit; belirteç tek kullanımlık", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const user = await mkUser(email, true);
    const inv = await mkInvite(fx, { email, role: "COUNTER" });
    const r = await acceptInvitation({ db: app, token: inv.token, principal: { userId: user } }, acceptDeps());
    expect(r).toMatchObject({ tenantId: fx.tenant, tenantSlug: fx.slug, userId: user });
    const roles = await adm.query("SELECT role_key FROM public.membership_roles WHERE membership_id = $1", [r.membershipId]);
    expect(roles.rows.map((x) => x.role_key)).toEqual(["COUNTER"]);
    expect((await invRow(inv.id)).accepted_at).not.toBeNull();
    expect((await auditActions(fx.tenant, inv.id)).map((a) => a.action)).toEqual(["invitation.accepted"]);
    const again = await failure(acceptInvitation({ db: app, token: inv.token, principal: { userId: user } }, acceptDeps()));
    expect(again.code).toBe("NOT_FOUND");
  });

  it("doğrulanmamış hesap → FORBIDDEN (pre-hijack, M3); davet harcanmaz; başka e-postalı hesap → FORBIDDEN", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const unverified = await mkUser(email, false);
    const other = await mkUser(rndEmail(), true);
    const inv = await mkInvite(fx, { email });
    expect((await failure(acceptInvitation({ db: app, token: inv.token, principal: { userId: unverified } }, acceptDeps()))).code).toBe("FORBIDDEN");
    expect((await failure(acceptInvitation({ db: app, token: inv.token, principal: { userId: other } }, acceptDeps()))).code).toBe("FORBIDDEN");
    const row = await invRow(inv.id);
    expect(row.accepted_at).toBeNull();
    const m = await adm.query("SELECT count(*)::int AS n FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])", [fx.tenant, [unverified, other]]);
    expect(m.rows[0].n).toBe(0);
  });

  it("süresi dolmuş / iptal / kabul edilmiş / yanlış / biçimsiz belirteç: tek tip NOT_FOUND (aynı gövde)", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const user = await mkUser(email, true);
    const cases = [
      (await mkInvite(fx, { email: rndEmail(), expiresIn: "-1 minute" })).token,
      (await mkInvite(fx, { email: rndEmail(), revoked: true })).token,
      (await mkInvite(fx, { email: rndEmail(), accepted: true })).token,
      randomBytes(32).toString("base64url"),
      "short",
    ];
    const bodies: unknown[] = [];
    for (const token of cases) {
      const e = await failure(acceptInvitation({ db: app, token, principal: { userId: user } }, acceptDeps()));
      expect(e.code).toBe("NOT_FOUND");
      bodies.push(e.toBody());
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
  });

  it("başka e-postaya ait davet reddedilir; geçerli belirteç başka tenant'ın davetine dokunmaz", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const email = rndEmail();
    const user = await mkUser(email, true);
    const invA = await mkInvite(a, { email: rndEmail() }); // başka e-posta
    const invB = await mkInvite(b, { email });
    expect((await failure(acceptInvitation({ db: app, token: invA.token, principal: { userId: user } }, acceptDeps()))).code).toBe("FORBIDDEN");
    await acceptInvitation({ db: app, token: invB.token, principal: { userId: user } }, acceptDeps());
    expect((await invRow(invA.id)).accepted_at).toBeNull();
    expect((await invRow(invB.id)).accepted_at).not.toBeNull();
    const m = await adm.query("SELECT tenant_id FROM public.tenant_memberships WHERE user_id = $1", [user]);
    expect(m.rows.map((x) => x.tenant_id)).toEqual([b.tenant]);
  });

  it("REMOVED üyelik yeniden etkinleşir (tek rol, sahiplik yok); ACTIVE üye → VALIDATION_FAILED", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const user = await mkUser(email, true);
    const old = await mkMember(fx.tenant, user, "READ_ONLY", "REMOVED");
    const inv = await mkInvite(fx, { email, role: "PICKER" });
    const r = await acceptInvitation({ db: app, token: inv.token, principal: { userId: user } }, acceptDeps());
    expect(r.membershipId).toBe(old);
    const m = await adm.query("SELECT status, is_owner, removed_at, roles_version FROM public.tenant_memberships WHERE id = $1", [old]);
    expect(m.rows[0]).toMatchObject({ status: "ACTIVE", is_owner: false, removed_at: null, roles_version: 1 });
    const roles = await adm.query("SELECT role_key FROM public.membership_roles WHERE membership_id = $1", [old]);
    expect(roles.rows.map((x) => x.role_key)).toEqual(["PICKER"]);
  });

  it("ACTIVE üye olan kişi kabul ederse → VALIDATION_FAILED; rol değişmez", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const user = await mkUser(email, true);
    const membership = await mkMember(fx.tenant, user, "READ_ONLY");
    const inv = await mkInvite(fx, { email, role: "TENANT_ADMIN" });
    const e = await failure(acceptInvitation({ db: app, token: inv.token, principal: { userId: user } }, acceptDeps()));
    expect(e.code).toBe("VALIDATION_FAILED");
    const roles = await adm.query("SELECT role_key FROM public.membership_roles WHERE membership_id = $1", [membership]);
    expect(roles.rows.map((x) => x.role_key)).toEqual(["READ_ONLY"]);
    expect((await invRow(inv.id)).accepted_at).toBeNull();
  });

  it("demo kullanıcısı kabul edemez (M9)", async () => {
    const fx = await mkTenant();
    const email = rndEmail(DEMO_DOMAIN);
    const user = await mkUser(email, true);
    const inv = await mkInvite(fx, { email });
    expect((await failure(acceptInvitation({ db: app, token: inv.token, principal: { userId: user } }, acceptDeps()))).code).toBe("FORBIDDEN");
    expect((await invRow(inv.id)).accepted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// acceptInvitation — hesap yok (m7/m8): iki bağlantı, talep, telafi
// ---------------------------------------------------------------------------------------------
describe("acceptInvitation (hesap yok; claim akışı)", () => {
  const account = { name: "Davetli Kisi", password: PASSWORD };
  const userByEmail = async (email: string): Promise<{ id: string; email_verified: boolean }[]> =>
    (await adm.query("SELECT id, email_verified FROM public.users WHERE email = $1", [email])).rows;

  it("EMAIL teslimli davet: hesap email_verified=true açılır + üyelik aynı akışta; SCREEN teslimli: false", async () => {
    const fx = await mkTenant();
    const emailA = rndEmail();
    const emailB = rndEmail();
    const invA = await mkInvite(fx, { email: emailA, via: "EMAIL", role: "PICKER" });
    const invB = await mkInvite(fx, { email: emailB, via: "SCREEN", role: "COUNTER" });
    const a = await acceptInvitation({ db: app, token: invA.token, newAccount: account }, acceptDeps());
    const b = await acceptInvitation({ db: app, token: invB.token, newAccount: account }, acceptDeps());
    expect((await userByEmail(emailA))[0]).toEqual({ id: a.userId, email_verified: true });
    expect((await userByEmail(emailB))[0]).toEqual({ id: b.userId, email_verified: false });
    for (const [r, role] of [[a, "PICKER"], [b, "COUNTER"]] as const) {
      const roles = await adm.query("SELECT role_key FROM public.membership_roles WHERE membership_id = $1", [r.membershipId]);
      expect(roles.rows.map((x) => x.role_key)).toEqual([role]);
    }
    const claim = await invRow(invA.id);
    expect(claim.claim_id).toBeNull();
    expect(claim.accepted_at).not.toBeNull();
  });

  it("aynı e-postayla hesap zaten varsa (başka talep) → FORBIDDEN; yeni hesap/üyelik oluşmaz", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    await mkUser(email, true);
    const inv = await mkInvite(fx, { email });
    expect((await failure(acceptInvitation({ db: app, token: inv.token, newAccount: account }, acceptDeps()))).code).toBe("FORBIDDEN");
    expect((await userByEmail(email))).toHaveLength(1);
    expect((await invRow(inv.id)).accepted_at).toBeNull();
  });

  it("(2) sonrası yapay hata + talep süresinin dolması → aynı belirteçle yeniden kabul: tek hesap, tek üyelik, hesap kimliği değişmez", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const inv = await mkInvite(fx, { email, via: "EMAIL" });
    let firstUserId = "";
    const crashing = acceptDeps({
      createInvitedAccount: async (input) => {
        const r = await auth.createInvitedAccount(input);
        firstUserId = r.userId;
        throw new Error("synthetic crash after account creation");
      },
    });
    const e = await failure(acceptInvitation({ db: app, token: inv.token, newAccount: account }, crashing));
    expect(e.code).toBe("INTERNAL");
    expect(await userByEmail(email)).toHaveLength(1);
    expect((await invRow(inv.id)).claim_id).not.toBeNull();
    // Talep hâlâ geçerli: ikinci talep VERSION_CONFLICT (retryable).
    const busy = await failure(acceptInvitation({ db: app, token: inv.token, newAccount: account }, acceptDeps()));
    expect(busy.code).toBe("VERSION_CONFLICT");
    expect(busy.retryable).toBe(true);
    const claimBefore = (await invRow(inv.id)).claim_id;
    await adm.query("UPDATE public.invitations SET claim_expires_at = now() - interval '1 second' WHERE id = $1", [inv.id]);
    const done = await acceptInvitation({ db: app, token: inv.token, newAccount: account }, acceptDeps());
    expect(done.userId).toBe(firstUserId);
    expect(await userByEmail(email)).toHaveLength(1);
    const members = await adm.query("SELECT count(*)::int AS n FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [fx.tenant, firstUserId]);
    expect(members.rows[0].n).toBe(1);
    expect((await invRow(inv.id)).accepted_at).not.toBeNull();
    expect(claimBefore).not.toBeNull(); // süresi dolmuş talep yenilenirken claim_id korundu (aksi halde yeniden kullanım FORBIDDEN olurdu)
  });

  it("eşzamanlı iki kabul → biri VERSION_CONFLICT (retryable), diğeri tamamlanır; tek hesap + tek üyelik", async () => {
    const fx = await mkTenant();
    const email = rndEmail();
    const inv = await mkInvite(fx, { email, via: "EMAIL" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inStep2 = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = acceptDeps({
      createInvitedAccount: async (input) => {
        entered();
        await gate;
        return auth.createInvitedAccount(input);
      },
    });
    const first = acceptInvitation({ db: app, token: inv.token, newAccount: account }, slow);
    await inStep2; // birinci talep (1) adımını commit etti
    const second = await failure(acceptInvitation({ db: app, token: inv.token, newAccount: account }, acceptDeps()));
    expect(second.code).toBe("VERSION_CONFLICT");
    expect(second.retryable).toBe(true);
    release();
    const r = await first;
    expect(await userByEmail(email)).toHaveLength(1);
    const members = await adm.query("SELECT count(*)::int AS n FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [fx.tenant, r.userId]);
    expect(members.rows[0].n).toBe(1);
  });

  it("hesap yok akışında parola/ad olmadan ya da geçersizse → VALIDATION_FAILED ve talep YAZILMAZ (MINOR-1); demo adresli davet → FORBIDDEN", async () => {
    const fx = await mkTenant();
    const inv = await mkInvite(fx, { email: rndEmail() });
    expect((await failure(acceptInvitation({ db: app, token: inv.token }, acceptDeps()))).code).toBe("VALIDATION_FAILED");
    for (const bad of [{ name: "  ", password: PASSWORD }, { name: "Ad", password: "kisa" }, { name: "Ad", password: "x".repeat(129) }, { name: "a".repeat(201), password: PASSWORD }]) {
      expect((await failure(acceptInvitation({ db: app, token: inv.token, newAccount: bad }, acceptDeps()))).code).toBe("VALIDATION_FAILED");
    }
    expect((await invRow(inv.id)).claim_id).toBeNull();
    const demoInv = await mkInvite(fx, { email: rndEmail(DEMO_DOMAIN) });
    expect((await failure(acceptInvitation({ db: app, token: demoInv.token, newAccount: account }, acceptDeps()))).code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------------------------
// RLS / probe işlevi sınırları (Supervisor kararı 3)
// ---------------------------------------------------------------------------------------------
describe("withInvitationTenant sınırları", () => {
  it("wms_app yalnızca geçerli belirteç için tenant görür; geçersiz → NULL; wms_auth EXECUTE yok", async () => {
    const fx = await mkTenant();
    const inv = await mkInvite(fx, { email: rndEmail() });
    const call = (hash: string) => withTenant(createTenantContext(app, randomUUID()), async (tx) => (await tx.execute<{ t: string | null }>(`SELECT wms_probe.invitation_tenant_for_token('${hash}') AS t`))[0]?.t ?? null);
    expect(await call(sha(inv.token))).toBe(fx.tenant);
    expect(await call(sha("nope"))).toBeNull();
    const authC = new pg.Client({ connectionString: authUrl });
    authC.on("error", () => undefined);
    await authC.connect();
    try {
      await expect(authC.query("SELECT wms_probe.invitation_tenant_for_token($1)", [sha(inv.token)])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await authC.end();
    }
  });

  it("wms_app başka tenant bağlamından invitations'a yazamaz (RLS WITH CHECK)", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    await expect(
      withMembership({ client: app, userId: a.admin, tenantId: a.tenant }, (tx) =>
        tx.execute(
          `INSERT INTO public.invitations (tenant_id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
           VALUES ('${b.tenant}', 'x@example.test', 'PICKER', '${sha("x")}', 'SCREEN', now() + interval '1 hour', '${b.adminMembership}')`,
        ),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// MINOR-2: runTenantCommand içinde enqueue actorUserId bağlamı
// ---------------------------------------------------------------------------------------------
describe("runTenantCommand içinde enqueue (auth paket incelemesi MINOR-2)", () => {
  it("sahte actorUserId reddedilir; gerçek principal kabul edilir ve işe yazılır", async () => {
    const fx = await mkTenant();
    const base = { db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, permission: "users.manage" as const };
    const fake = randomUUID();
    const e = await failure(
      runTenantCommand(base, (tx) => queue.enqueue(tx, { type: "invitation.deliver", actorUserId: fake, payload: { invitationId: randomUUID() } })),
    );
    expect(e.code).toBe("INTERNAL");
    expect(e.cause).toMatchObject({ code: "VALIDATION_FAILED" });
    const id = randomUUID();
    const ok = await runTenantCommand(base, (tx) => queue.enqueue(tx, { type: "invitation.deliver", actorUserId: fx.admin, payload: { invitationId: id } }));
    expect(ok.jobId).not.toBeNull();
    expect((await jobsFor(id))[0]?.data.actorUserId).toBe(fx.admin);
    // actorUserId verilmezse bağlamdan türetilir.
    const id2 = randomUUID();
    await runTenantCommand(base, (tx) => queue.enqueue(tx, { type: "invitation.deliver", payload: { invitationId: id2 } }));
    expect((await jobsFor(id2))[0]?.data.actorUserId).toBe(fx.admin);
  });
});

// ---------------------------------------------------------------------------------------------
// action-guard ve safe-redirect (web)
// ---------------------------------------------------------------------------------------------
describe("action-guard", () => {
  const schema = JOB_PAYLOAD_SCHEMAS["invitation.deliver"];
  const ok = (): { invitationId: string } => ({ invitationId: randomUUID() });
  const logged: Record<string, unknown>[] = [];
  const mk = (over: Partial<GuardDeps> & { headers?: Record<string, string> } = {}) => {
    const { headers, ...rest } = over;
    return createActionGuard({
      getHeaders: () => Promise.resolve(new Headers(headers ?? { origin: BASE })),
      resolvePrincipal: () => Promise.resolve({ userId: randomUUID(), mfaVerified: true }),
      appUrl: BASE,
      log: (e) => void logged.push(e),
      newRequestId: () => "req-1",
      ...rest,
    });
  };

  it("Origin başlığı yok → FORBIDDEN; işleyici çalışmaz", async () => {
    let ran = false;
    const act = mk({ headers: {} })({ schema }, () => ((ran = true), Promise.resolve(1)));
    const r = await act(ok());
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN", requestId: "req-1" } });
    expect(ran).toBe(false);
  });

  it("yanlış Origin ve yapılandırılmamış BETTER_AUTH_URL → FORBIDDEN; doğru Origin → çalışır", async () => {
    const h = () => Promise.resolve(1);
    expect(await mk({ headers: { origin: "https://evil.example" } })({ schema }, h)(ok())).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await mk({ appUrl: undefined })({ schema }, h)(ok())).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await mk()({ schema }, h)(ok())).toEqual({ ok: true, data: 1 });
  });

  it("principal yok → UNAUTHENTICATED (requireAuth:false ise geçer); Zod hatası → VALIDATION_FAILED", async () => {
    const h = () => Promise.resolve("ok");
    expect(await mk({ resolvePrincipal: () => Promise.resolve(null) })({ schema }, h)(ok())).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await mk({ resolvePrincipal: () => Promise.resolve(null) })({ schema, requireAuth: false }, h)(ok())).toEqual({ ok: true, data: "ok" });
    expect(await mk()({ schema }, h)({ invitationId: "x" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await mk()({ schema }, h)({ ...ok(), extra: 1 })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("AppError → güvenli gövde (messageKey + requestId); beklenmeyen hata → INTERNAL, loglanır, yığın/SQL yanıtta yok", async () => {
    const forbidden = await mk()({ schema }, () => Promise.reject(new AppError("FORBIDDEN", { detail: "MFA_REQUIRED" })))(ok());
    expect(forbidden).toMatchObject({ ok: false, error: { code: "FORBIDDEN", messageKey: "errors.forbidden.mfa_required", retryable: false, requestId: "req-1" } });
    logged.length = 0;
    const secret = `S${randomBytes(8).toString("hex")}`;
    const boom = Object.assign(new Error(`select * from users where password='${secret}'`), { code: "42P01" });
    const r = await mk()({ schema }, () => Promise.reject(boom))(ok());
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL", messageKey: "errors.internal", requestId: "req-1" } });
    expect(JSON.stringify(r)).not.toMatch(/select|password|42P01|stack|\bat /i);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ requestId: "req-1", sqlstate: "42P01" });
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});

describe("safeNext (M10)", () => {
  it("yalnızca tek '/' ile başlayan göreli yol kabul edilir; diğer her şey '/'", () => {
    const ok = ["/", "/t/acme/members", "/t/acme?x=1#y", "/a%20b"];
    for (const p of ok) expect(safeNext(p), p).toBe(p);
    const bad = [
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "http://evil.example",
      "https://evil.example/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "%2f%2fevil.example",
      "/%2fevil.example",
      "/%2Fevil.example",
      "/%5cevil.example",
      "/%5Cevil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\u0000x",
      "/%09/evil.example",
      "evil.example",
      "",
      "/%",
      "/%E0%A4%A",
      null,
      undefined,
      42,
      `/${"a".repeat(3000)}`,
    ];
    for (const p of bad) expect(safeNext(p), String(p)).toBe("/");
  });
});

// ---------------------------------------------------------------------------------------------
// Web gönderen kuyruğu (apps/web/lib/queue.ts): wms_app + pgbouncer (transaction mode) üzerinden gerçek start() + enqueue
// ---------------------------------------------------------------------------------------------
describe("getSenderQueue (web)", () => {
  const savedUrl = process.env.DATABASE_URL;
  const restore = (): void => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  };
  const queueConns = async (db?: string): Promise<number> =>
    (await adm.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'wms-queue' AND ($1::text IS NULL OR datname = $1)", [db ?? null])).rows[0].n;

  it("eşzamanlı istekler tek örneği paylaşır; gerçek start() + inviteMember aynı tx'te enqueue eder (EMAIL, tek iş, yalnızca invitationId)", async () => {
    process.env.DATABASE_URL = env.databaseUrl;
    try {
      const [a, b] = await Promise.all([getSenderQueue(), getSenderQueue()]);
      expect(a).toBeDefined();
      expect(a).toBe(b);
      expect(await getSenderQueue()).toBe(a);
      const fx = await mkTenant();
      const r = await inviteMember(
        { db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" },
        { mailConfig: mailOn, queue: a as NonNullable<typeof a> },
      );
      expect(r.delivery).toBe("EMAIL");
      const jobs = await jobsFor(r.invitationId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data.payload).toEqual({ invitationId: r.invitationId });
    } finally {
      await closeSenderQueue();
      restore();
    }
  });

  it("start() başarısızsa (kuyruk şeması yok) undefined döner, havuz kapatılır (bağlantı sızıntısı yok), inviteMember SCREEN'e düşer; sonraki istek yeniden dener", async () => {
    const dbName = `t117_noqueue_${randomBytes(4).toString("hex")}`;
    await adm.query(`CREATE DATABASE ${dbName}`);
    try {
      // wms_app kimliği + doğrudan sunucu (pgbouncer yeni veritabanını bilmez): bağlantı KURULUR, şema yok → start() düşer.
      const u = new URL(env.databaseUrlDirect);
      const app_ = new URL(env.databaseUrl);
      u.username = app_.username;
      u.password = app_.password;
      u.pathname = `/${dbName}`;
      process.env.DATABASE_URL = u.toString();
      const before = await queueConns(dbName);
      expect(before).toBe(0);
      const [q1, q2] = await Promise.all([getSenderQueue(), getSenderQueue()]);
      expect(q1).toBeUndefined();
      expect(q2).toBeUndefined();
      // Havuz kapandı: bu veritabanında wms-queue bağlantısı kalmadı.
      const deadline = Date.now() + 5000;
      while ((await queueConns(dbName)) > before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(await queueConns(dbName)).toBe(0);
      // Çağıranın geri dönüşü: kuyruk yok → enqueue reddi → SCREEN + screenReason.
      const fx = await mkTenant();
      const r = await inviteMember(
        { db: app, principal: principalOf(fx.admin), tenantSlug: fx.slug, email: rndEmail(), roleKey: "PICKER" },
        { mailConfig: mailOn, queue: { enqueue: () => Promise.reject(new Error("job queue is not available")) } },
      );
      expect(r).toMatchObject({ delivery: "SCREEN", screenReason: "QUEUE_UNAVAILABLE" });
      // Başarısızlık önbelleğe alınmadı: yapılandırma düzelince aynı süreç başlatır.
      process.env.DATABASE_URL = env.databaseUrl;
      const ok = await getSenderQueue();
      expect(ok).toBeDefined();
    } finally {
      await closeSenderQueue();
      restore();
      await adm.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    }
  });
});
