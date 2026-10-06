import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Yönlendirmesiz next-intl: istek yapılandırması i18n/request.ts (T-109).
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Tüm yanıtlara güvenlik başlıkları (T-010 security-reviewer MINOR). HSTS yalnızca HTTPS üzerinden
// tarayıcıda etkilidir (Fly `force_https`); çerçeveleme X-Frame-Options ile (CSP `frame-ancestors 'none'` proxy.ts'te; CSP tek yerde tanımlıdır, T-127).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Docker/Fly imajı için kendi kendine yeten sunucu (`.next/standalone`, T-010 / ADR-013).
  output: "standalone",
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: SECURITY_HEADERS }]);
  },
};

export default withNextIntl(nextConfig);
