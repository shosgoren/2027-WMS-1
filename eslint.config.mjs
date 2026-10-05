// Kök ESLint yapılandırması (flat config). Tüm repo bu dosyayla lint edilir.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/.next/",
    "**/dist/",
    ".artifacts/",
    "docs/_master/",
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
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
