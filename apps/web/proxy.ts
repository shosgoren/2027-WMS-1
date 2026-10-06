// Next 16 `proxy.ts` (middleware'in yeni adı). T-127: istek başına nonce'lu CSP buradadır. Bu bir İYİMSER denetimdir: yalnızca oturum ÇEREZİNİN varlığına bakar,
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

/**
 * CSP TEK yerde (burada) tanımlanır; istek başına nonce. `strict-dynamic`: nonce'lu betiğin yüklediği betikler güvenilir
 * (Next kendi betiklerine nonce'u istek başlığındaki CSP'den okuyarak ekler). `style-src 'unsafe-inline'` gerekçesi: React/Next
 * ve bileşenler satır içi `style` öznitelikleri üretir (öznitelikler nonce alamaz); Tailwind v4 derleme zamanı CSS'tir.
 * Betikte `unsafe-inline` YOKTUR. `unsafe-eval` yalnızca geliştirmede (React hata yığını/HMR).
 */
export function buildCsp(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function newNonce(): string {
  return btoa(crypto.randomUUID());
}

const PROTECTED = /^\/(?:t(?:\/|$)|onboarding(?:\/|$)|mfa$)/;

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const next = (): NextResponse => {
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  if (pathname === "/invite" || pathname.startsWith("/invite/")) {
    // Davet belirteci yolda taşınır: dış kaynaklara Referer ile sızmaz (T-117 MINOR-5).
    const res = next();
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  if (!PROTECTED.test(pathname)) return next();

  // `/mfa` doğrulama adımında oturum henüz yoktur; yalnızca geçici 2FA çerezi vardır.
  const authenticated =
    hasCookie(request, SESSION_COOKIE) || (pathname === "/mfa" && hasCookie(request, TWO_FACTOR_COOKIE));
  if (authenticated) return next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", safeNext(`${pathname}${search}`));
  const res = NextResponse.redirect(login);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Tüm sayfa/uç noktalar (CSP için); statik varlıklar ve ön-getirme istekleri hariç (Next belgesi deseni).
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
