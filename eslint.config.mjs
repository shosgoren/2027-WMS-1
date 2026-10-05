// Kök ESLint yapılandırması (flat config). Tüm repo bu dosyayla lint edilir.
import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Next.js eklentisi `apps/web`in devDependency'sidir; oradan çözülür.
const requireFromWeb = createRequire(new URL("./apps/web/package.json", import.meta.url));
/** @type {typeof import("@next/eslint-plugin-next").default} */
const nextPlugin = requireFromWeb("@next/eslint-plugin-next");

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/.next/",
    "**/dist/",
    ".artifacts/",
    "docs/_master/",
    // `next dev|build|typegen` her koşuda yeniden üretir (Next önerisi: commit edilmez).
    "apps/web/next-env.d.ts",
  ]),
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    rules: {
      // 15 §Kod: `any` yalnızca gerekçeli → satır içi
      // `eslint-disable-next-line @typescript-eslint/no-explicit-any -- <gerekçe>`.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Next.js kuralları yalnızca web uygulamasında.
    files: ["apps/web/**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"]],
    settings: { next: { rootDir: "apps/web/" } },
  },
  {
    // T-005b (AC-28 lint kısmı; 02 §Pooler uyumluluğu, ADR-003): ham DB istemcisi tenant
    // modüllerinden import edilemez. Tenant verisine tek yol `@wms/db` → `withTenant(ctx, tx => …)`.
    // `packages/db/**` (istemcinin kendisi) ve `tests/integration/**` (fikstür) bu bloğun dışındadır.
    // Not: flat config'te aynı kural sonraki bir blokta yeniden tanımlanırsa seçenekler BİRLEŞMEZ,
    // değiştirilir; yeni kısıtlar bu bloğa eklenmelidir.
    files: ["apps/**/*.{js,mjs,cjs,ts,mts,cts,tsx}", "packages/**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    ignores: ["packages/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@wms/db/internal",
              message: "Ham DB istemcisi/TenantContext oluşturucusu yalnızca packages/db içindir; tenant erişimi `withTenant` (@wms/db) ile yapılır (T-005b, I-02).",
            },
            {
              name: "postgres",
              message: "PostgreSQL sürücüsü yalnızca packages/db içinde kullanılır; `withTenant` (@wms/db) kullanın (T-005b, I-02).",
            },
            {
              name: "pg",
              message: "PostgreSQL sürücüsü yalnızca packages/db içinde kullanılır; `withTenant` (@wms/db) kullanın (T-005b, I-02).",
            },
            {
              name: "@neondatabase/serverless",
              message: "PostgreSQL sürücüsü yalnızca packages/db içinde kullanılır; `withTenant` (@wms/db) kullanın (T-005b, I-02).",
            },
            {
              name: "drizzle-orm/postgres-js",
              message: "Drizzle sürücü bağdaştırıcısı yalnızca packages/db içinde kullanılır; `withTenant` (@wms/db) kullanın (T-005b, I-02).",
            },
          ],
          patterns: [
            {
              group: [
                "@wms/db/internal/**",
                "postgres/**",
                "pg/**",
                "drizzle-orm/postgres-js/**",
                "drizzle-orm/node-postgres",
                "drizzle-orm/node-postgres/**",
                "drizzle-orm/neon-*",
                "drizzle-orm/neon-*/**",
                "**/packages/db/src/**",
                "**/db/src/client*",
              ],
              message: "Ham DB istemcisi/sürücüsü yalnızca packages/db içindir; tenant erişimi `withTenant` (@wms/db) ile yapılır (T-005b, I-02).",
            },
          ],
        },
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
