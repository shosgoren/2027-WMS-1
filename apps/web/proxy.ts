// Next 16 `proxy.ts` (middleware'in yeni adı). T-127: istek başına nonce'lu CSP buradadır. Bu bir İYİMSER denetimdir: yalnızca oturum ÇEREZİNİN varlığına bakar,
// geçerliliğine bakmaz; GÜVENLİK SINIRI DEĞİLDİR. Yetki her zaman sunucuda `runTenantCommand`/`runTenantQuery` ile
// (ADR-014/016) verilir. T-129: `x-request-id` (yalnızca UUID biçimli gelen korunur, değilse yenisi; istek başlığına ve yanıta) ve
// maskeli erişim günlüğü (yol/sorguda davet ve sıfırlama belirteçleri maskelenir) buradadır.
// Yönlendirme hedefi YALNIZCA `safeNext` ile (T-117 M10): başka yönlendirme mantığı yok.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createConsoleLogger, maskString, requestIdFrom } from "@wms/shared/log";
import { safeNext } from "./lib/safe-redirect.ts";

const logger = createConsoleLogger("web");

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

/** Belirteç taşıyan sayfalar (yolda: `/invite/<t>`; sorguda: `/reset-password?token=`): dış kaynaklara Referer ile sızmaz. */
const TOKEN_PAGE = /^\/(?:invite|reset-password)(?:\/|$)/;

const PROTECTED = /^\/(?:t(?:\/|$)|onboarding(?:\/|$)|mfa$)/;

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  // Gelen `x-request-id` yalnızca UUID ise korunur (log/başlık enjeksiyonu yok); değilse yenisi. Sunucu bağlamına (istek
  // başlığı; `action-guard` aynı kimliği hata yanıtında kullanır) ve yanıta iletilir.
  const requestId = requestIdFrom(request.headers) ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-request-id", requestId);
  // Erişim günlüğü: yol + sorgu MASKELİ (davet/sıfırlama belirteci, `next=` içindeki dahil); başlık/çerez/IP yok.
  const rawPath = `${pathname}${search}`;
  const maskedPath = maskString(rawPath);
  logger.info("request", { requestId, method: request.method, path: maskedPath });
  // Belirteç yolda (`/invite/<t>`), sorguda (`/reset-password?token=`) ya da başka bir parametrenin içinde
  // (`/login?next=%2Finvite%2F<t>`) taşınabilir: maskeleme bir şeyi değiştirdiyse dış kaynaklara Referer ile sızmaz
  // (T-117 MINOR-5, T-117b MINOR-4).
  const tokenBearing = TOKEN_PAGE.test(pathname) || maskedPath !== rawPath;
  const next = (): NextResponse => {
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("x-request-id", requestId);
    if (tokenBearing) res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };

  if (!PROTECTED.test(pathname)) return next();

  // `/mfa` doğrulama adımında oturum henüz yoktur; yalnızca geçici 2FA çerezi vardır.
  const authenticated =
    hasCookie(request, SESSION_COOKIE) || (pathname === "/mfa" && hasCookie(request, TWO_FACTOR_COOKIE));
  if (authenticated) return next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", safeNext(`${pathname}${search}`));
  const res = NextResponse.redirect(login);
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("x-request-id", requestId);
  if (tokenBearing) res.headers.set("Referrer-Policy", "no-referrer");
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
