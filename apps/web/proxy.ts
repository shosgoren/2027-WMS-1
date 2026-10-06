// Next 16 `proxy.ts` (middleware'in yeni adı). Bu bir İYİMSER denetimdir: yalnızca oturum ÇEREZİNİN varlığına bakar,
// geçerliliğine bakmaz; GÜVENLİK SINIRI DEĞİLDİR. Yetki her zaman sunucuda `runTenantCommand`/`runTenantQuery` ile
// (ADR-014/016) verilir. `x-request-id` üretimi T-129'da buraya eklenir.
// Yönlendirme hedefi YALNIZCA `safeNext` ile (T-117 M10): başka yönlendirme mantığı yok.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeNext } from "./lib/safe-redirect.ts";

// Better Auth çerez adları: `[__Secure-]better-auth.<ad>` (https'te `__Secure-` öneki; ADR-014 §13).
const SESSION_COOKIE = /^(?:__Secure-)?better-auth\.session_token$/;
const TWO_FACTOR_COOKIE = /^(?:__Secure-)?better-auth\.two_factor$/;

function hasCookie(request: NextRequest, pattern: RegExp): boolean {
  return request.cookies.getAll().some((c) => pattern.test(c.name) && c.value !== "");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/invite" || pathname.startsWith("/invite/")) {
    // Davet belirteci yolda taşınır: dış kaynaklara Referer ile sızmaz (T-117 MINOR-5).
    const res = NextResponse.next();
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  // `/mfa` doğrulama adımında oturum henüz yoktur; yalnızca geçici 2FA çerezi vardır.
  const authenticated =
    hasCookie(request, SESSION_COOKIE) || (pathname === "/mfa" && hasCookie(request, TWO_FACTOR_COOKIE));
  if (authenticated) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", safeNext(`${pathname}${search}`));
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/t/:path*", "/onboarding/:path*", "/mfa", "/invite/:path*"],
};
