import { defineConfig } from "vitest/config";

// Yalnızca unit testler. Entegrasyon testleri (`*.int.test.ts`, `tests/integration/**`)
// `pnpm test:int` ile ayrı koşar (T-005a).
export default defineConfig({
  test: {
    include: ["**/*.test.{ts,tsx,mjs}"],
    exclude: [
      "**/*.int.test.ts",
      "tests/integration/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
    ],
    includeTaskLocation: true,
  },
});
