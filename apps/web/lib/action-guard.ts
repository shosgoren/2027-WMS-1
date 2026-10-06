// Server Action ortak sarmalayıcısı (T-117; ADR-014 §8, ADR-016 §11; m4).
//
// Sıra: (1) `Origin` başlığı YOKSA veya `BETTER_AUTH_URL` kökeniyle eşleşmezse ret (FORBIDDEN); (2) principal çözümü;
// (3) Zod doğrulaması (VALIDATION_FAILED); (4) işleyici; (5) `AppError` → güvenli yanıt (i18n anahtarı + istek kimliği;
// yığın izi/SQL/SQLSTATE yok), beklenmeyen hata loglanır ve genel `INTERNAL` döner (G-07). Hız sınırı (T-127): IP (principal
// çözümünden ÖNCE, DB'ye yük bindirmesin), kullanıcı ve tenant (`ctx.limitTenant`, üyelik çözüldükten sonra doğrulanmış kimlikle); aşım `RATE_LIMITED`.
// `routeGuard` aynı denetimleri `/api/t/**` route handler'ları için yapar (POST'ta `Origin` yoksa FORBIDDEN, m4).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runTenantQuery, type TenantAccessParams } from "@wms/domain/identity/access";
import { AppError, type AppErrorBody } from "@wms/shared/errors";
import { RateLimitedError, clientIp, createProductionLimiter, type RateLimiter } from "./rate-limit.ts";

/** Sarmalayıcının ihtiyaç duyduğu principal şekli (`@wms/auth` `Principal` atanabilir). */
export interface GuardPrincipal {
  readonly userId: string;
  readonly mfaVerified: boolean;
}

declare const verifiedTenantBrand: unique symbol;
/** Üyelik/izin çözümünden (`runTenantQuery`) çıkmış tenant kimliği; yalnızca `limitVerifiedTenant` üretir. */
export type VerifiedTenantId = string & { readonly [verifiedTenantBrand]: true };

export interface ActionContext {
  readonly requestId: string;
  readonly principal: GuardPrincipal | null;
  /** Doğrulanmış uygulama kökeni (`BETTER_AUTH_URL`). */
  readonly origin: string;
  /**
   * Tenant başına yazma sınırını tüketir. YALNIZCA üyelik/izin çözüldükten SONRA, DOĞRULANMIŞ tenant kimliğiyle çağrılır
   * (istemci slug'ı ile asla: üye olmayan kullanıcı başka tenant'ın kovasını tüketemez, MAJOR-1).
   */
  readonly limitTenant: (verifiedTenantId: VerifiedTenantId) => Promise<void>;
}

export type SafeError = AppErrorBody["error"] & { readonly requestId: string; readonly retryAfterSeconds?: number };
export type ActionResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SafeError };

export interface GuardDeps {
  readonly getHeaders: () => Promise<Headers>;
  readonly resolvePrincipal: (headers: Headers) => Promise<GuardPrincipal | null>;
  /** `BETTER_AUTH_URL`; tanımsız/geçersizse hiçbir istek kabul edilmez (fail-closed). */
  readonly appUrl: string | undefined;
  readonly log: (entry: Readonly<Record<string, unknown>>) => void;
  readonly newRequestId: () => string;
  /** T-127 hız sınırı (IP/kullanıcı/tenant). Tanımsızsa sınır uygulanmaz (yalnızca birim testleri). */
  readonly limiter?: RateLimiter;
  /** Yerelde `Fly-Client-IP` yokken kullanılacak soket adresi (M6). */
  readonly socketIp?: (headers: Headers) => string | undefined;
  /** Varsayılan: `isProductionEnv()` (Fly-Client-IP/soket yoksa üretimde fail-closed). */
  readonly production?: boolean;
}

export interface ActionOptions<S extends z.ZodType> {
  readonly schema: S;
  /** Varsayılan `true`: principal yoksa `UNAUTHENTICATED`. Davet kabulü gibi anonim eylemler `false`. */
  readonly requireAuth?: boolean;
}

function originOf(appUrl: string | undefined): string | undefined {
  if (appUrl === undefined || appUrl.trim() === "") return undefined;
  try {
    const o = new URL(appUrl).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

/** Kök neden zincirinden yalnızca sınıf adı ve SQLSTATE (mesaj/parametre loga girmez, G-09). */
function describe(e: unknown): { error: string; sqlstate?: string; cause?: string } {
  const name = e instanceof Error ? e.name : typeof e;
  let state: string | undefined;
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      state = code;
      break;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.name : undefined;
  return { error: name, ...(state === undefined ? {} : { sqlstate: state }), ...(cause === undefined ? {} : { cause }) };
}

function safeBody(err: AppError, requestId: string): SafeError {
  return { ...err.toBody().error, requestId, ...(err instanceof RateLimitedError ? { retryAfterSeconds: err.retryAfterSeconds } : {}) };
}

/** Köken denetimi: `Origin` yoksa veya uygulama kökeniyle eşleşmezse FORBIDDEN (fail-closed). Doğrulanmış kökeni döndürür. */
function assertOrigin(deps: GuardDeps, headers: Headers): string {
  const origin = originOf(deps.appUrl);
  const sent = headers.get("origin");
  if (origin === undefined || sent === null || sent !== origin) throw new AppError("FORBIDDEN");
  return origin;
}

async function limit(deps: GuardDeps, kind: "ip" | "user" | "tenant", subject: string): Promise<void> {
  if (deps.limiter !== undefined) await deps.limiter.check(kind, subject);
}

function ipOf(deps: GuardDeps, headers: Headers): string {
  try {
    return clientIp(headers, {
      socketIp: deps.socketIp?.(headers),
      ...(deps.production === undefined ? {} : { production: deps.production }),
    });
  } catch (e) {
    // Yapılandırılmış günlük: yalnızca neden (IP/başlık değeri yok, G-09). Fly edge dışı erişim ya da yanlış yapılandırma işareti.
    if (e instanceof AppError) deps.log({ level: "error", msg: "request rejected", reason: "client-ip-unresolved", code: e.code });
    throw e;
  }
}

export function createActionGuard(deps: GuardDeps) {
  return function guardedAction<S extends z.ZodType, R>(
    options: ActionOptions<S>,
    handler: (input: z.infer<S>, ctx: ActionContext) => Promise<R>,
  ): (raw: unknown) => Promise<ActionResult<R>> {
    return async (raw) => {
      const requestId = deps.newRequestId();
      try {
        const headers = await deps.getHeaders();
        const origin = assertOrigin(deps, headers);
        await limit(deps, "ip", ipOf(deps, headers));
        const principal = await deps.resolvePrincipal(headers);
        if ((options.requireAuth ?? true) && principal === null) throw new AppError("UNAUTHENTICATED");
        if (principal !== null) await limit(deps, "user", principal.userId);
        const ctx: ActionContext = { requestId, principal, origin, limitTenant: (id) => limit(deps, "tenant", id) };
        const parsed = options.schema.safeParse(raw);
        if (!parsed.success) throw new AppError("VALIDATION_FAILED");
        return { ok: true, data: await handler(parsed.data as z.infer<S>, ctx) };
      } catch (e) {
        if (e instanceof AppError) {
          if (e.code === "INTERNAL") deps.log({ level: "error", msg: "action failed", requestId, ...describe(e) });
          return { ok: false, error: safeBody(e, requestId) };
        }
        deps.log({ level: "error", msg: "action failed", requestId, ...describe(e) });
        return { ok: false, error: safeBody(new AppError("INTERNAL"), requestId) };
      }
    };
  };
}

/**
 * Tenant sayacı (MAJOR-1): önce üyelik + izin çözülür (üye olmayan/yetkisiz çağıran burada reddedilir ve HİÇ tenant sayacı
 * tüketmez), sonra DOĞRULANMIŞ tenant kimliğiyle tüketilir; istemci slug'ı sayaç anahtarı değildir.
 */
export async function limitVerifiedTenant(access: TenantAccessParams, ctx: Pick<ActionContext, "limitTenant">): Promise<void> {
  const tenantId = await runTenantQuery(access, (_tx, membership) => Promise.resolve(membership.tenantId as VerifiedTenantId));
  await ctx.limitTenant(tenantId);
}

export interface RouteContext {
  readonly requestId: string;
  readonly principal: GuardPrincipal | null;
  /** Bkz. `ActionContext.limitTenant`. */
  readonly limitTenant: (verifiedTenantId: VerifiedTenantId) => Promise<void>;
}

function jsonResponse(err: AppError, requestId: string): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (err instanceof RateLimitedError) headers.set("retry-after", String(err.retryAfterSeconds));
  return new Response(JSON.stringify({ error: safeBody(err, requestId) }), { status: err.httpStatus, headers });
}

/**
 * `/api/t/**` route handler sarmalayıcısı: actionGuard ile aynı köken/hız sınırı/hata maskeleme kuralları.
 * Yalnızca durum değiştiren yöntemlerde (POST/PUT/PATCH/DELETE) `Origin` zorunludur; GET/HEAD yalnızca IP/kullanıcı sınırına
 * tabidir. Aşımda `Retry-After` başlığı eklenir.
 */
export function createRouteGuard(deps: GuardDeps) {
  return function routeGuard(
    options: { readonly requireAuth?: boolean },
    handler: (request: Request, ctx: RouteContext) => Promise<Response>,
  ): (request: Request) => Promise<Response> {
    return async (request) => {
      const requestId = deps.newRequestId();
      try {
        const headers = request.headers;
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) assertOrigin(deps, headers);
        await limit(deps, "ip", ipOf(deps, headers));
        const principal = await deps.resolvePrincipal(headers);
        if ((options.requireAuth ?? true) && principal === null) throw new AppError("UNAUTHENTICATED");
        if (principal !== null) await limit(deps, "user", principal.userId);
        return await handler(request, { requestId, principal, limitTenant: (id) => limit(deps, "tenant", id) });
      } catch (e) {
        if (e instanceof AppError) {
          if (e.code === "INTERNAL") deps.log({ level: "error", msg: "route failed", requestId, ...describe(e) });
          return jsonResponse(e, requestId);
        }
        deps.log({ level: "error", msg: "route failed", requestId, ...describe(e) });
        return jsonResponse(new AppError("INTERNAL"), requestId);
      }
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Üretim bağlamı (@wms/auth + ortam; veritabanı yalnızca `@wms/db` `getAppDb()` ile); Next istek başlıkları çağıran `actions.ts`'ten verilir (`headers` from "next/headers").
// Bu modül Next'e bağımlı değildir: kök typecheck/entegrasyon testleri `createActionGuard`'ı doğrudan kullanır.
// ---------------------------------------------------------------------------------------------

export function createProductionGuard(getHeaders: GuardDeps["getHeaders"], limiter: RateLimiter = createProductionLimiter()) {
  return createActionGuard({
    getHeaders,
    limiter,
    resolvePrincipal: async (headers) => {
      const { getAuthService } = await import("./auth-service.ts");
      const p = await getAuthService().getPrincipal(headers);
      return p === null ? null : { userId: p.userId, mfaVerified: p.mfaVerified };
    },
    get appUrl() {
      return process.env.BETTER_AUTH_URL; // her istekte okunur (derleme anında değil)
    },
    log: (entry) => {
      console.error(JSON.stringify(entry));
    },
    newRequestId: randomUUID,
  });
}
