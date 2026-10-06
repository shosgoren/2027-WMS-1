"use client";
// Better Auth istemcisi (yalnızca `better-auth/react`; lint profili başka alt yolu yasaklar). 2FA uçları eklenti
// istemcisi (`better-auth/client/plugins`) yerine `$fetch` ile çağrılır: yol ve gövde sunucu eklentisindeki
// `/two-factor/*` uçlarıyla birebirdir (dist/plugins/two-factor/index.d.mts). Tüm çağrılar aynı kökene gider.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export interface AuthCallError {
  readonly status: number;
  /** Sunucu hata kodu (örn. `RATE_LIMITED`, `INVALID_CODE`); yoksa `undefined`. */
  readonly code: string | undefined;
  /** `X-Retry-After` (saniye), hız sınırında. */
  readonly retryAfterSec: number | undefined;
}

export type AuthCallResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: AuthCallError };

/** `POST /api/auth/<path>`: ağ/sunucu hatası dahil her durumda yapılandırılmış sonuç döner (yutulan hata yok). */
export async function authPost<T>(path: string, body: Record<string, unknown>): Promise<AuthCallResult<T>> {
  let retryAfterSec: number | undefined;
  try {
    const res = await authClient.$fetch<T>(path, {
      method: "POST",
      body,
      onError(ctx) {
        const raw = Number(ctx.response.headers.get("x-retry-after"));
        if (Number.isFinite(raw) && raw > 0) retryAfterSec = Math.ceil(raw);
      },
    });
    if (res.error) {
      const code = (res.error as { code?: unknown }).code;
      return { ok: false, error: { status: res.error.status, code: typeof code === "string" ? code : undefined, retryAfterSec } };
    }
    return { ok: true, data: res.data as T };
  } catch {
    return { ok: false, error: { status: 0, code: undefined, retryAfterSec: undefined } };
  }
}
