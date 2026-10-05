import { defineConfig } from "vitest/config";

// Yalnızca entegrasyon testleri (`*.int.test.ts`) — `pnpm test:int` (T-005a). KORUNAN DOSYA.
// globalSetup hedefe göre (WMS_INT_TARGET = compose | neon) veritabanını hazırlar; bkz.
// tests/integration/harness/global-setup.ts. Tam döküm `.artifacts/test-int/` altına yazılır.
export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", ".artifacts/**"],
    globalSetup: ["tests/integration/harness/global-setup.ts"],
    // Test dosyaları aynı veritabanını paylaşır; sıralı koşu sonuçları belirlenimci tutar.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // compose indirme (down -v) için.
    teardownTimeout: 120_000,
    includeTaskLocation: true,
    reporters: ["default", "json"],
    outputFile: { json: ".artifacts/test-int/report.json" },
  },
});
