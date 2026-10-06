// Server Action ortak sarmalayıcısı (T-117; ADR-014 §8, ADR-016 §11; m4).
//
// Sıra: (1) `Origin` başlığı YOKSA veya `BETTER_AUTH_URL` kökeniyle eşleşmezse ret (FORBIDDEN); (2) principal çözümü;
// (3) Zod doğrulaması (VALIDATION_FAILED); (4) işleyici; (5) `AppError` → güvenli yanıt (i18n anahtarı + istek kimliği;
// yığın izi/SQL/SQLSTATE yok), beklenmeyen hata loglanır ve genel `INTERNAL` döner (G-07). Hız sınırı (T-127) `rateLimit`
// kancasına bağlanacak: bu kartta kanca tanımlıdır, varsayılan yoktur.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createDbClient } from "@wms/db";
import { AppError, type AppErrorBody } from "@wms/shared/errors";

/** Sarmalayıcının ihtiyaç duyduğu principal şekli (`@wms/auth` `Principal` atanabilir). */
export interface GuardPrincipal {
  readonly userId: string;
  readonly mfaVerified: boolean;
}

export interface ActionContext {
  readonly requestId: string;
  readonly principal: GuardPrincipal | null;
  /** Doğrulanmış uygulama kökeni (`BETTER_AUTH_URL`). */
  readonly origin: string;
}

export type SafeError = AppErrorBody["error"] & { readonly requestId: string };
export type ActionResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SafeError };

export interface GuardDeps {
  readonly getHeaders: () => Promise<Headers>;
  readonly resolvePrincipal: (headers: Headers) => Promise<GuardPrincipal | null>;
  /** `BETTER_AUTH_URL`; tanımsız/geçersizse hiçbir istek kabul edilmez (fail-closed). */
  readonly appUrl: string | undefined;
  readonly log: (entry: Readonly<Record<string, unknown>>) => void;
  readonly newRequestId: () => string;
  /** T-127 hız sınırı kancası: reddederse `AppError("RATE_LIMITED")` fırlatmalıdır. */
  readonly rateLimit?: (ctx: ActionContext, headers: Headers) => Promise<void>;
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
  return { ...err.toBody().error, requestId };
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
        const origin = originOf(deps.appUrl);
        const sent = headers.get("origin");
        if (origin === undefined || sent === null || sent !== origin) throw new AppError("FORBIDDEN");
        const principal = await deps.resolvePrincipal(headers);
        if ((options.requireAuth ?? true) && principal === null) throw new AppError("UNAUTHENTICATED");
        const ctx: ActionContext = { requestId, principal, origin };
        if (deps.rateLimit !== undefined) await deps.rateLimit(ctx, headers);
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

// ---------------------------------------------------------------------------------------------
// Üretim bağlamı (@wms/auth + ortam); Next istek başlıkları çağıran `actions.ts`'ten verilir (`headers` from "next/headers").
// Bu modül Next'e bağımlı değildir: kök typecheck/entegrasyon testleri `createActionGuard`'ı doğrudan kullanır.
// ---------------------------------------------------------------------------------------------

export function createProductionGuard(getHeaders: GuardDeps["getHeaders"]) {
  return createActionGuard({
    getHeaders,
    resolvePrincipal: async (headers) => {
      const { getAuthService } = await import("@wms/auth");
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

type AppDb = ReturnType<typeof createDbClient>;
let appDb: AppDb | undefined;

/** `wms_app` bağlantısı (DATABASE_URL; pooler transaction mode → `prepare: false`); ilk kullanımda kurulur. */
export function getAppDb(): AppDb {
  if (appDb === undefined) {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url.trim() === "") throw new Error("DATABASE_URL is not configured");
    appDb = createDbClient({ url, poolMax: 5, prepare: false });
  }
  return appDb;
}
