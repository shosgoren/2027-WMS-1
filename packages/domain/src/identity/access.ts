// Tenant erişiminin tek giriş yolu (T-113; ADR-016 §5-6, §11; A-38, A-45, A-51).
// Web, worker ve import aynı yolu kullanır: principal (düz veri) → slug'dan YALNIZCA üye olunan tenant → withMembership
// (güncel üyelik + rol izni, FOR SHARE) → MFA zorunluluğu (A-38) → fn(tx, membership).
// Domain kodu Next / Better Auth import etmez; kimlik `@wms/auth` tarafında doğrulanır, buraya düz veri gelir.
import { sql } from "drizzle-orm";
import { MembershipError, withMembership, withUser } from "@wms/db";
import type { Membership } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { hasPermission, type Permission } from "./permissions.ts";

// `@wms/db` genel yüzeyi ham istemci/tx tiplerini adlandırmaz; imzadan türetilir.
type WithMembershipParams = Parameters<typeof withMembership>[0];
export type AccessDbClient = WithMembershipParams["client"];
export type AccessTx = Parameters<Parameters<typeof withMembership>[1]>[0];
export type { Membership };

/** Oturumdan gelen kimlik (düz veri). `@wms/auth` `Principal` bu şekle atanabilir. */
export interface AccessPrincipal {
  readonly userId: string;
  /** Oturum düzeyi MFA (ADR-014 §12). */
  readonly mfaVerified: boolean;
}

export interface TenantAccessParams {
  readonly db: AccessDbClient;
  readonly principal: AccessPrincipal | null | undefined;
  readonly tenantSlug: string;
  readonly permission: Permission;
  /** Yakın zamanda kimlik doğrulama denetimi (çağıran `auth.requireRecentAuth`'u bağlar); reddederse (`reason === "REAUTH_REQUIRED"`) `RECENT_AUTH_REQUIRED`. Üyelik/izin/MFA denetiminden SONRA, transaction dışında çağrılır. */
  readonly recentAuth?: () => Promise<void>;
}

export type TenantAccessByIdParams = Omit<TenantAccessParams, "tenantSlug"> & { readonly tenantId: string };

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);

function sqlstateOf(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Hata eşlemesi (ADR-016 §11 m13): `40P01`/`40001` → `VERSION_CONFLICT` (`retryable`); `MembershipError` → 15 kodları.
 * Ham SQLSTATE/mesaj yanıta girmez (kök neden yalnızca `cause`). Tanınmayan hata `INTERNAL` olur; orijinal hata
 * `cause`'da korunur (yutulmaz, G-07) ve yanıt gövdesine girmez.
 */
export function mapAccessError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  if (e instanceof MembershipError) {
    if (e.code === "FORBIDDEN" || e.code === "TENANT_SUSPENDED" || e.code === "TENANT_CLOSING") {
      return new AppError(e.code);
    }
    return internalError(e);
  }
  const state = sqlstateOf(e);
  if (state !== undefined && RETRYABLE_SQLSTATES.has(state)) {
    const err = new AppError("VERSION_CONFLICT", { retryable: true });
    err.cause = e;
    return err;
  }
  return internalError(e);
}

function internalError(cause: unknown): AppError {
  const err = new AppError("INTERNAL");
  err.cause = cause;
  return err;
}

async function resolveTenantId(db: AccessDbClient, userId: string, slug: string): Promise<string> {
  if (typeof slug !== "string" || slug === "") throw new AppError("NOT_FOUND");
  const rows = await withUser(db, userId, (tx) =>
    tx.execute<{ id: string }>(
      sql`SELECT t.id FROM public.tenants t
            JOIN public.tenant_memberships m ON m.tenant_id = t.id
           WHERE t.slug = ${slug} AND m.user_id = ${userId}::uuid AND m.status = 'ACTIVE'`,
    ),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new AppError("NOT_FOUND"); // üye değil: varlık sızdırılmaz
  return id;
}

/** A-38: TENANT_ADMIN için MFA zorunlu (oturum düzeyi); `is_demo` tenant'ta kapalı. Okuma ve yazmada aynı. */
async function enforceMfa(tx: AccessTx, membership: Membership, principal: AccessPrincipal, tenantId: string): Promise<void> {
  if (membership.roles.includes("TENANT_ADMIN") && !principal.mfaVerified) {
    const rows = await tx.execute<{ is_demo: boolean }>(sql`SELECT is_demo FROM public.tenants WHERE id = ${tenantId}::uuid`);
    if (rows[0]?.is_demo !== true) throw new AppError("FORBIDDEN", { detail: "MFA_REQUIRED" });
  }
}

/**
 * Yapısal kontrol (domain `@wms/auth` import etmez): yalnızca gerçek yeniden doğrulama reddi (`reason ===
 * "REAUTH_REQUIRED"`) `RECENT_AUTH_REQUIRED` olur; ayrıntısız UNAUTHENTICATED olduğu gibi `UNAUTHENTICATED` kalır;
 * diğer hatalar (altyapı) `mapAccessError` ile `INTERNAL` olur.
 */
function mapRecentAuthError(e: unknown): unknown {
  const o = e as { code?: unknown; reason?: unknown } | null;
  if (o?.reason === "REAUTH_REQUIRED") return new AppError("UNAUTHENTICATED", { detail: "RECENT_AUTH_REQUIRED" });
  if (o?.code === "UNAUTHENTICATED") return new AppError("UNAUTHENTICATED");
  return e;
}

async function runOnce<T>(
  params: TenantAccessByIdParams,
  fn: (tx: AccessTx, membership: Membership) => Promise<T>,
): Promise<T> {
  const { db, principal, tenantId, permission, recentAuth } = params;
  if (principal === null || principal === undefined) throw new AppError("UNAUTHENTICATED");
  const membershipParams = (): WithMembershipParams => ({
    client: db,
    userId: principal.userId,
    tenantId,
    permission: (roles) => hasPermission(roles, permission),
  });
  if (recentAuth !== undefined) {
    // Sıra: (1) üyelik + izin + MFA (kısa transaction, hiçbir şey yazmaz) → (2) recentAuth (transaction DIŞINDA:
    // tx içinde dış/`wms_auth` çağrısı yok, kilit tutulmaz) → (3) komut, üyelik/izin YENİDEN doğrulanarak çalışır.
    // Böylece FORBIDDEN/TENANT_* önceliklidir ve yetkisiz çağrı gereksiz kimlik sorgusu üretmez; 3. adım yetkiyi
    // güncel durumla yeniden denetlediğinden 1. ile 3. arasındaki değişiklik (çıkarma, askıya alma) yakalanır.
    await withMembership(membershipParams(), (tx, membership) => enforceMfa(tx, membership, principal, tenantId));
    try {
      await recentAuth();
    } catch (e) {
      throw mapRecentAuthError(e);
    }
  }
  return withMembership(membershipParams(), async (tx, membership) => {
    await enforceMfa(tx, membership, principal, tenantId);
    return fn(tx, membership);
  });
}

async function run<T>(
  params: TenantAccessParams,
  fn: (tx: AccessTx, membership: Membership) => Promise<T>,
  attempts: number,
): Promise<T> {
  const { tenantSlug, ...rest } = params;
  const principal = params.principal;
  if (principal === null || principal === undefined) throw new AppError("UNAUTHENTICATED");
  for (let attempt = 1; ; attempt++) {
    try {
      const tenantId = await resolveTenantId(params.db, principal.userId, tenantSlug);
      return await runOnce({ ...rest, tenantId }, fn);
    } catch (e) {
      const mapped = mapAccessError(e);
      if (mapped instanceof AppError && mapped.retryable && attempt < attempts) continue;
      throw mapped;
    }
  }
}

async function runById<T>(
  params: TenantAccessByIdParams,
  fn: (tx: AccessTx, membership: Membership) => Promise<T>,
  attempts: number,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runOnce(params, fn);
    } catch (e) {
      const mapped = mapAccessError(e);
      if (mapped instanceof AppError && mapped.retryable && attempt < attempts) continue;
      throw mapped;
    }
  }
}

/** Yazan komutlar: yeniden DENEMEZ (idempotency çağıranın işidir); deadlock/serileştirme → `VERSION_CONFLICT` `retryable`. */
export function runTenantCommand<T>(params: TenantAccessParams, fn: (tx: AccessTx, membership: Membership) => Promise<T>): Promise<T> {
  return run(params, fn, 1);
}

/** Okumalar: aynı yol; `retryable` hatada bir kez yeniden dener. */
export function runTenantQuery<T>(params: TenantAccessParams, fn: (tx: AccessTx, membership: Membership) => Promise<T>): Promise<T> {
  return run(params, fn, 2);
}

/** Tenant kimliği zaten çözülmüş çağıranlar (worker işleri, slug çözümü ile işlem arasında üyelik düşmesi) için. */
export function runTenantCommandById<T>(params: TenantAccessByIdParams, fn: (tx: AccessTx, membership: Membership) => Promise<T>): Promise<T> {
  return runById(params, fn, 1);
}

export function runTenantQueryById<T>(params: TenantAccessByIdParams, fn: (tx: AccessTx, membership: Membership) => Promise<T>): Promise<T> {
  return runById(params, fn, 2);
}
