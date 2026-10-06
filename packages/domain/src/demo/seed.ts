// Demo tenant yeniden tohumlama (T-123; A-43, ADR-016 §10, 1.-4. tur inceleme ekleri). Yalnızca local/staging.
//
// Sorumluluk ayrımı:
// - Tenant SATIRI: `ensureDemoTenant` (`packages/db/src/demo-tenant.ts`, migration rolü, `pnpm db:migrate` sonu). Burada oluşturulmaz.
// - Kimlik HESAPLARI (users/accounts, yalnızca `wms_auth` yazabilir): `DemoAccountPort` — domain Better Auth'u import
//   etmez (access.ts ile aynı ilke); gerçek bağdaştırıcı `packages/auth` tarafındadır (bkz. T-123 raporu Bulgu-1).
// - Üyelik/rol/ayar onarımı (burada): ilk sahip üyelik `withSystemTenant(.., 'demo.bootstrap', ..)` ile (DB tetikleyicisi
//   yalnızca bu gerekçe + is_demo=true'ya izin verir); sonraki tüm onarımlar demo sahibi kimliğiyle `withMembership`
//   (gerekçe `demo.reseed` audit `reason` alanında). `demoTenantId` iş yükünden/ortamdan ALINMAZ: `DEMO_TENANT_ID`.
// - Demo tenant'ta T-117b üyelik komutları kapalıdır (M9, `assertTenantNotDemo`); onarım bu yüzden bu dosyadaki dar,
//   demo'ya özgü yazımlardır (aynı kurallar: önce sahiplik devri, sonra çıkarma; son sahip hiçbir adımda sıfırlanmaz).
// - Parola yalnızca `DemoAccountPort.ensureAccount` argümanıdır: audit/log/hata mesajına girmez (G-09).
import { sql } from "drizzle-orm";
import {
  DEMO_TENANT_ID,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  MembershipError,
  appendAudit,
  demoModeEnabled,
  lockOwners,
  withMembership,
  withSystemTenant,
} from "@wms/db";
import { AppError } from "@wms/shared/errors";
import type { AccessDbClient, AccessTx } from "../identity/access.ts";
import { ROLE_KEYS, hasPermission, type RoleKey } from "../identity/permissions.ts";
import { getTemplate } from "../onboarding/templates.ts";
import { updateTenantSettings } from "../onboarding/workspace.ts";

export { DEMO_TENANT_ID, DEMO_TENANT_NAME, DEMO_TENANT_SLUG };

/** Gerçek alıcıya gönderim imkânsız alan adı (RFC 2606/6761 `.invalid`). T-112b/T-122 `DEMO_EMAIL_DOMAIN` olarak okur. */
export const DEMO_EMAIL_DOMAIN = "example.invalid";

/** Rol → demo e-postası. TEK KAYNAK (T-122 aynı sabiti kullanır). */
export const DEMO_ROLES = Object.freeze({
  TENANT_ADMIN: "demo.yonetici@example.invalid",
  WAREHOUSE_MANAGER: "demo.sef@example.invalid",
  PICKER: "demo.toplayici@example.invalid",
  COUNTER: "demo.sayim@example.invalid",
  READ_ONLY: "demo.izleyici@example.invalid",
} as const satisfies Record<RoleKey, string>);

/** Görünen ad (sentetik; G-09). */
export const DEMO_USER_NAMES = Object.freeze({
  TENANT_ADMIN: "Demo Yönetici",
  WAREHOUSE_MANAGER: "Demo Depo Şefi",
  PICKER: "Demo Toplayıcı",
  COUNTER: "Demo Sayımcı",
  READ_ONLY: "Demo İzleyici",
} as const satisfies Record<RoleKey, string>);

export const DEMO_TEMPLATE_KEY = "PACKAGING_SUPPLIES";
/** `withSystemTenant` gerekçesi: YALNIZCA bu sabit (DB tetikleyicisi başka gerekçeyle üyelik/rol yazımını reddeder). */
export const DEMO_BOOTSTRAP_REASON = "demo.bootstrap";
/** Audit `reason` alanı (onarım yazımları demo sahibi kimliğiyle yapılır; sistem gerekçesi değildir). */
export const DEMO_RESEED_REASON = "demo.reseed";

export const DEMO_PASSWORD_MIN_LENGTH = 12; // @wms/auth PASSWORD_MIN_LENGTH (A-41) ile aynı; domain auth import etmez
export const DEMO_PASSWORD_MAX_LENGTH = 128;

export type DemoSeedEnv = Readonly<Record<string, string | undefined>>;

export type DemoSeedConfig =
  | { readonly enabled: false; readonly reason: "ENV_NOT_ALLOWED" | "DEMO_MODE_OFF" | "PASSWORD_MISSING" | "PASSWORD_INVALID" }
  | { readonly enabled: true; readonly password: string };

/**
 * Fail-closed ortam koruması: `WMS_ENV` ∈ {local, staging} VE `DEMO_MODE=1` VE geçerli `DEMO_PASSWORD`. `WMS_ENV`
 * tanımsız/başka (prod dahil) → kapalı. Dönen `reason` loglanabilir; parola hiçbir koşulda yansıtılmaz.
 */
export function loadDemoSeedConfig(env: DemoSeedEnv): DemoSeedConfig {
  const wmsEnv = env.WMS_ENV?.trim();
  if (wmsEnv !== "local" && wmsEnv !== "staging") return { enabled: false, reason: "ENV_NOT_ALLOWED" };
  if (!demoModeEnabled(env)) return { enabled: false, reason: "DEMO_MODE_OFF" };
  const password = env.DEMO_PASSWORD;
  if (password === undefined || password === "") return { enabled: false, reason: "PASSWORD_MISSING" };
  if (password.length < DEMO_PASSWORD_MIN_LENGTH || password.length > DEMO_PASSWORD_MAX_LENGTH) {
    return { enabled: false, reason: "PASSWORD_INVALID" };
  }
  return { enabled: true, password };
}

/**
 * Kimlik hesabı bağdaştırıcısı (gerçek: `packages/auth`, `wms_auth`). Davranış sözleşmesi: e-posta yoksa hesabı parola
 * hesabıyla oluşturur; varsa parolayı `password`'e EŞİTLER (zaten eşitse yazmaz: `passwordUpdated=false`). Başarısızlık
 * fırlatır (yutulmaz). `password` loglanmaz.
 */
export interface DemoAccountPort {
  ensureAccount(input: {
    readonly email: string;
    readonly name: string;
    readonly password: string;
  }): Promise<{ readonly userId: string; readonly created: boolean; readonly passwordUpdated: boolean }>;
}

export type DemoUserIds = Readonly<Record<RoleKey, string>>;

function fail(code: "FORBIDDEN" | "NOT_FOUND" | "INTERNAL", cause: string): AppError {
  const err = new AppError(code);
  err.cause = new Error(cause);
  return err;
}

// ---------------------------------------------------------------------------------------------
// 1. İlk sahip üyelik: demo.bootstrap
// ---------------------------------------------------------------------------------------------

export interface BootstrapResult {
  /** `true`: bu çağrı üyelik/rol satırı yazdı (ve tek `demo.bootstrap` audit satırı ekledi). */
  readonly written: boolean;
}

/** İş yolu: tenant kimliği YALNIZCA `DEMO_TENANT_ID` (dışarıdan verilemez; MINOR-3). */
export function bootstrapDemoOwner(db: AccessDbClient, input: { readonly ownerUserId: string }): Promise<BootstrapResult> {
  return bootstrapOwnerInTenant(db, input.ownerUserId, DEMO_TENANT_ID);
}

/**
 * Demo tenant'ta demo yöneticisinin ACTIVE `TENANT_ADMIN` üyeliği ve (ACTIVE sahip yoksa) sahipliği yoksa kurar.
 * `withSystemTenant(.., 'demo.bootstrap', ..)`: tenant satırı okunur; `slug='demo' AND is_demo=true` değilse HATA (fail-closed).
 * Yazımlar `ON CONFLICT DO NOTHING` (eşzamanlı iki çağrıda tek üyelik/rol/audit); sahip ve yönetici üyeliği zaten varsa
 * HİÇBİR ŞEY yazılmaz. `bootstrapOwnerInTenant` YALNIZCA testler içindir (`is_demo=false` kimliği denemesi); iş kodu `bootstrapDemoOwner` çağırır.
 */
export async function bootstrapOwnerInTenant(db: AccessDbClient, ownerUserId: string, tenantId: string): Promise<BootstrapResult> {
  try {
    return await withSystemTenant(db, tenantId, DEMO_BOOTSTRAP_REASON, async (tx): Promise<BootstrapResult> => {
      const tenantRows = await tx.execute<{ slug: string; is_demo: boolean }>(
        sql`SELECT slug, is_demo FROM public.tenants WHERE id = ${tenantId}::uuid`,
      );
      const t = tenantRows[0];
      if (t === undefined || t.slug !== DEMO_TENANT_SLUG || t.is_demo !== true) {
        throw fail("FORBIDDEN", "demo.bootstrap: tenant is not the demo tenant (slug='demo' AND is_demo=true required)");
      }

      const state = async () => {
        const owners = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM public.tenant_memberships
               WHERE tenant_id = ${tenantId}::uuid AND is_owner AND status = 'ACTIVE'`,
        );
        const own = await tx.execute<{ id: string; status: string; is_owner: boolean; has_admin: boolean }>(
          sql`SELECT m.id, m.status, m.is_owner,
                     EXISTS (SELECT 1 FROM public.membership_roles r
                              WHERE r.tenant_id = m.tenant_id AND r.membership_id = m.id AND r.role_key = 'TENANT_ADMIN') AS has_admin
                FROM public.tenant_memberships m
               WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${ownerUserId}::uuid
                 FOR UPDATE`,
        );
        return { ownerCount: owners[0]?.n ?? 0, own: own[0] };
      };

      let s = await state();
      const ready = (x: typeof s) => x.ownerCount > 0 && x.own?.status === "ACTIVE" && x.own.has_admin;
      if (ready(s)) return { written: false };

      let written = false;
      let grantedOwner = false;
      let versionBumped = false;
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner)
            VALUES (${tenantId}::uuid, ${ownerUserId}::uuid, 'ACTIVE', ${s.ownerCount === 0})
            ON CONFLICT (tenant_id, user_id) DO NOTHING
            RETURNING id`,
      );
      let membershipId = inserted[0]?.id;
      if (membershipId !== undefined) {
        written = true;
        grantedOwner = s.ownerCount === 0;
      } else {
        // Yarışı kaybettik ya da üyelik zaten vardı (REMOVED / sahip değil): güncel durumu yeniden oku.
        s = await state();
        if (s.own === undefined) throw fail("INTERNAL", "demo.bootstrap: membership row vanished after conflict");
        membershipId = s.own.id;
        if (s.own.status !== "ACTIVE" || (s.ownerCount === 0 && !s.own.is_owner)) {
          grantedOwner = s.ownerCount === 0;
          await tx.execute(
            sql`UPDATE public.tenant_memberships
                   SET status = 'ACTIVE', removed_at = NULL,
                       is_owner = (is_owner AND status = 'ACTIVE') OR ${grantedOwner}::boolean,
                       roles_version = roles_version + 1
                 WHERE tenant_id = ${tenantId}::uuid AND id = ${membershipId}::uuid`,
          );
          written = true;
          versionBumped = true; // UPDATE roles_version'ı zaten artırdı
        }
      }
      const role = await tx.execute<{ id: string }>(
        sql`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key)
            VALUES (${tenantId}::uuid, ${membershipId}::uuid, 'TENANT_ADMIN')
            ON CONFLICT (tenant_id, membership_id, role_key) DO NOTHING
            RETURNING id`,
      );
      if (role.length > 0) {
        written = true;
        // Var olan ACTIVE üyeliğe rol eklendi: M4 gereği roles_version artar (yeni satırda 0 kalır).
        if (inserted.length === 0 && !versionBumped) {
          await tx.execute(
            sql`UPDATE public.tenant_memberships SET roles_version = roles_version + 1
                 WHERE tenant_id = ${tenantId}::uuid AND id = ${membershipId}::uuid`,
          );
        }
      }
      if (!written) return { written: false };
      await appendAudit(tx, {
        action: "member.role_changed",
        actorUserId: null,
        entityType: "membership",
        entityId: membershipId,
        reason: DEMO_BOOTSTRAP_REASON,
        changeSummary: { from_role: null, to_role: "TENANT_ADMIN", is_owner: grantedOwner },
      });
      return { written: true };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof MembershipError && e.code === "FORBIDDEN") {
      // withSystemTenant: tenant satırı yok/aktif değil. Demo tenant'ı worker oluşturmaz (ensureDemoTenant).
      const err = new AppError("NOT_FOUND");
      err.cause = e;
      throw err;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Üyelik/rol onarımı (demo sahibi kimliğiyle)
// ---------------------------------------------------------------------------------------------

interface MembershipRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly status: string;
  readonly isOwner: boolean;
  readonly roles: readonly string[];
}

async function loadMemberships(tx: AccessTx, tenantId: string): Promise<MembershipRow[]> {
  const rows = await tx.execute<{ id: string; user_id: string; email: string; status: string; is_owner: boolean }>(
    sql`SELECT m.id, m.user_id, u.email, m.status, m.is_owner
          FROM public.tenant_memberships m
          JOIN public.users u ON u.id = m.user_id
         WHERE m.tenant_id = ${tenantId}::uuid
         ORDER BY m.id
           FOR UPDATE OF m`,
  );
  const roleRows = await tx.execute<{ membership_id: string; role_key: string }>(
    sql`SELECT membership_id, role_key FROM public.membership_roles
         WHERE tenant_id = ${tenantId}::uuid ORDER BY membership_id, role_key`,
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email.toLowerCase(),
    status: r.status,
    isOwner: r.is_owner,
    roles: roleRows.filter((x) => x.membership_id === r.id).map((x) => x.role_key),
  }));
}

async function bump(tx: AccessTx, tenantId: string, membershipId: string, set?: ReturnType<typeof sql>): Promise<void> {
  await tx.execute(
    sql`UPDATE public.tenant_memberships SET ${set === undefined ? sql`` : sql`${set}, `}roles_version = roles_version + 1
         WHERE tenant_id = ${tenantId}::uuid AND id = ${membershipId}::uuid`,
  );
}

async function setRole(tx: AccessTx, tenantId: string, membershipId: string, role: RoleKey): Promise<void> {
  await tx.execute(sql`DELETE FROM public.membership_roles WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${membershipId}::uuid`);
  await tx.execute(
    sql`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES (${tenantId}::uuid, ${membershipId}::uuid, ${role})`,
  );
}

export interface MembershipRepairResult {
  readonly created: number;
  readonly reactivated: number;
  readonly rolesFixed: number;
  readonly ownershipChanged: boolean;
  readonly removed: number;
}

/**
 * Demo üyeliklerini beklenen duruma getirir (idempotent; değişiklik yoksa hiçbir satır/audit yazılmaz). Kimlik: demo
 * yöneticisi (`users.manage`; ACTIVE olmalı — yoksa önce `bootstrapDemoOwner`). Sıra (1. tur m8): sahiplik demo
 * yöneticisine devredilir → demo dışı üyelikler REMOVED → rol/üyelik düzeltmeleri. Son sahip hiçbir adımda sıfırlanmaz.
 */
export async function repairDemoMemberships(db: AccessDbClient, users: DemoUserIds): Promise<MembershipRepairResult> {
  const adminId = users.TENANT_ADMIN;
  const expectedByUser = new Map<string, RoleKey>(ROLE_KEYS.map((role) => [users[role], role]));
  const demoEmails = new Set<string>(Object.values(DEMO_ROLES));
  return withMembership(
    { client: db, userId: adminId, tenantId: DEMO_TENANT_ID, permission: (roles) => hasPermission(roles, "users.manage") },
    async (tx, actor) => {
      const tenantRows = await tx.execute<{ slug: string; is_demo: boolean }>(
        sql`SELECT slug, is_demo FROM public.tenants WHERE id = ${DEMO_TENANT_ID}::uuid`,
      );
      if (tenantRows[0]?.slug !== DEMO_TENANT_SLUG || tenantRows[0].is_demo !== true) {
        throw fail("FORBIDDEN", "demo.reseed: tenant is not the demo tenant");
      }
      await lockOwners(tx, DEMO_TENANT_ID); // kimliğe göre sıralı kilit (diğer komutlarla aynı sıra)
      const rows = await loadMemberships(tx, DEMO_TENANT_ID);
      const audit = (action: "member.role_changed" | "member.removed" | "ownership.transferred", id: string, summary: Record<string, unknown>) =>
        appendAudit(tx, {
          action,
          actorUserId: actor.userId,
          entityType: "membership",
          entityId: id,
          reason: DEMO_RESEED_REASON,
          changeSummary: summary,
        });
      let created = 0;
      let reactivated = 0;
      let rolesFixed = 0;
      let removed = 0;

      // (1) Sahiplik: demo yöneticisi tek sahip. Önce yönetici sahip olur, sonra diğer sahipler düşürülür.
      const adminRow = rows.find((r) => r.userId === adminId);
      if (adminRow === undefined || adminRow.status !== "ACTIVE") throw fail("INTERNAL", "demo.reseed: demo admin membership is not ACTIVE");
      const otherOwners = rows.filter((r) => r.isOwner && r.status === "ACTIVE" && r.userId !== adminId);
      const promote = !adminRow.isOwner;
      if (promote) await bump(tx, DEMO_TENANT_ID, adminRow.id, sql`is_owner = true`);
      for (const o of otherOwners) await bump(tx, DEMO_TENANT_ID, o.id, sql`is_owner = false`);
      const ownershipChanged = promote || otherOwners.length > 0;
      if (ownershipChanged) {
        await audit("ownership.transferred", adminRow.id, { to_membership: adminRow.id, from_memberships: otherOwners.map((o) => o.id) });
      }

      // (2) Demo dışı (beklenen demo adresleri dışındaki) ACTIVE üyelikler REMOVED.
      for (const r of rows) {
        if (r.status !== "ACTIVE" || demoEmails.has(r.email)) continue;
        await bump(tx, DEMO_TENANT_ID, r.id, sql`status = 'REMOVED', is_owner = false, removed_at = now()`);
        await audit("member.removed", r.id, { was_owner: r.isOwner, roles: [...r.roles] });
        removed++;
      }

      // (3) Beklenen demo üyelikleri: yoksa oluştur, REMOVED ise geri al, rolü tek beklenen rol yap.
      for (const [userId, role] of expectedByUser) {
        const row = rows.find((r) => r.userId === userId);
        if (row === undefined) {
          const ins = await tx.execute<{ id: string }>(
            sql`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner)
                VALUES (${DEMO_TENANT_ID}::uuid, ${userId}::uuid, 'ACTIVE', false)
                ON CONFLICT (tenant_id, user_id) DO NOTHING
                RETURNING id`,
          );
          const id = ins[0]?.id;
          if (id === undefined) throw fail("INTERNAL", "demo.reseed: concurrent membership insert");
          await setRole(tx, DEMO_TENANT_ID, id, role);
          await audit("member.role_changed", id, { from_role: null, to_role: role, created: true });
          created++;
          continue;
        }
        const wasRemoved = row.status !== "ACTIVE";
        const roleOk = row.roles.length === 1 && row.roles[0] === role;
        if (wasRemoved) {
          await bump(tx, DEMO_TENANT_ID, row.id, sql`status = 'ACTIVE', removed_at = NULL, is_owner = false`);
          reactivated++;
        }
        if (!roleOk) {
          await setRole(tx, DEMO_TENANT_ID, row.id, role);
          if (!wasRemoved) await bump(tx, DEMO_TENANT_ID, row.id); // M4: roles_version artar
          rolesFixed++;
        }
        if (wasRemoved || !roleOk) {
          await audit("member.role_changed", row.id, {
            from_role: row.roles.length === 0 ? null : row.roles.join(","),
            to_role: role,
            reactivated: wasRemoved,
          });
        }
      }
      return { created, reactivated, rolesFixed, ownershipChanged, removed };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Ayar onarımı (ad, dil, saat dilimi: updateTenantSettings; şablon/terminoloji/onboarding: burada)
// ---------------------------------------------------------------------------------------------

export interface SettingsRepairResult {
  readonly nameOrLocaleChanged: boolean;
  readonly templateChanged: boolean;
}

type DemoSettingsRow = {
  sector_template_key: string | null;
  sector_template_version: number | null;
  terminology: unknown;
  onboarding_status: string;
  onboarding_steps: unknown;
};

function asJson(v: unknown): unknown {
  return typeof v === "string" ? (JSON.parse(v) as unknown) : v;
}

/** Anahtar sırasından bağımsız, sığ olmayan eşitlik için kanonik dize (yalnızca düz nesne/dizi/ilkel). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function repairDemoSettings(db: AccessDbClient, adminUserId: string): Promise<SettingsRepairResult> {
  const template = getTemplate(DEMO_TEMPLATE_KEY);
  if (template === undefined) throw fail("INTERNAL", "demo.reseed: demo sector template is not registered");
  const principal = { userId: adminUserId, mfaVerified: false }; // demo tenant'ta MFA zorunluluğu kapalı (A-38)
  const { changed } = await updateTenantSettings(db, DEMO_TENANT_SLUG, principal, {
    name: DEMO_TENANT_NAME,
    locale: template.locale,
    timeZone: template.timeZone,
  }, { reason: DEMO_RESEED_REASON });
  const expectedSteps = template.steps.map((key) => ({ key, status: "DONE" }));
  const templateChanged = await withMembership(
    { client: db, userId: adminUserId, tenantId: DEMO_TENANT_ID, permission: (roles) => hasPermission(roles, "settings.manage") },
    async (tx, actor) => {
      const rows = await tx.execute<DemoSettingsRow>(
        sql`SELECT sector_template_key, sector_template_version, terminology, onboarding_status, onboarding_steps
              FROM public.tenant_settings WHERE tenant_id = ${DEMO_TENANT_ID}::uuid FOR UPDATE`,
      );
      const row = rows[0];
      if (row === undefined) throw new AppError("NOT_FOUND");
      const steps = asJson(row.onboarding_steps);
      const stepsDone =
        Array.isArray(steps) &&
        canonical(steps.map((s: { key?: unknown; status?: unknown }) => ({ key: s.key, status: s.status }))) === canonical(expectedSteps);
      const same =
        row.sector_template_key === template.key &&
        row.sector_template_version === template.version &&
        canonical(asJson(row.terminology)) === canonical(template.terminology) &&
        row.onboarding_status === "COMPLETED" &&
        stepsDone;
      if (same) return false;
      await tx.execute(
        sql`UPDATE public.tenant_settings
               SET sector_template_key = ${template.key}, sector_template_version = ${template.version},
                   terminology = ${JSON.stringify(template.terminology)}::jsonb, onboarding_status = 'COMPLETED',
                   onboarding_steps = ${JSON.stringify(expectedSteps)}::jsonb
             WHERE tenant_id = ${DEMO_TENANT_ID}::uuid`,
      );
      await appendAudit(tx, {
        action: "tenant.settings_changed",
        actorUserId: actor.userId,
        entityType: "tenant",
        entityId: DEMO_TENANT_ID,
        reason: DEMO_RESEED_REASON,
        changeSummary: {
          template: { from: row.sector_template_key, to: template.key },
          templateVersion: { from: row.sector_template_version, to: template.version },
        },
      });
      return true;
    },
  );
  return { nameOrLocaleChanged: changed, templateChanged };
}

// ---------------------------------------------------------------------------------------------
// 4. Bileşik: hesaplar → bootstrap → üyelik → ayar
// ---------------------------------------------------------------------------------------------

export interface ReseedDemoDeps {
  readonly db: AccessDbClient;
  readonly accounts: DemoAccountPort;
  /** `loadDemoSeedConfig` sonucu `enabled` iken gelen parola. */
  readonly password: string;
}

export interface ReseedDemoResult {
  readonly accountsCreated: number;
  readonly passwordsUpdated: number;
  readonly bootstrapped: boolean;
  readonly memberships: MembershipRepairResult;
  readonly settings: SettingsRepairResult;
}

export async function reseedDemo(deps: ReseedDemoDeps): Promise<ReseedDemoResult> {
  const { db, accounts, password } = deps;
  if (password.length < DEMO_PASSWORD_MIN_LENGTH || password.length > DEMO_PASSWORD_MAX_LENGTH) {
    throw new AppError("VALIDATION_FAILED");
  }
  const ids: Partial<Record<RoleKey, string>> = {};
  let accountsCreated = 0;
  let passwordsUpdated = 0;
  for (const role of ROLE_KEYS) {
    const r = await accounts.ensureAccount({ email: DEMO_ROLES[role], name: DEMO_USER_NAMES[role], password });
    ids[role] = r.userId;
    if (r.created) accountsCreated++;
    if (r.passwordUpdated) passwordsUpdated++;
  }
  const users = ids as DemoUserIds;
  const boot = await bootstrapDemoOwner(db, { ownerUserId: users.TENANT_ADMIN });
  const memberships = await repairDemoMemberships(db, users);
  const settings = await repairDemoSettings(db, users.TENANT_ADMIN);
  return { accountsCreated, passwordsUpdated, bootstrapped: boot.written, memberships, settings };
}

// ---------------------------------------------------------------------------------------------
// 5. Zamanlama yardımcısı (günlük 03:00 UTC)
// ---------------------------------------------------------------------------------------------

/** `now`'dan SONRAKİ ilk `hourUtc`:00:00 UTC anı (tam o an ise ertesi gün). */
export function nextDailyRunUtc(now: Date, hourUtc = 3): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
