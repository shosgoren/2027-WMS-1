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
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
