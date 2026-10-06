// Playwright yapılandırması (T-131). Çıktılar `.artifacts/e2e/` altına (git'e girmez).
// - `E2E_BASE_URL` verilirse (ör. staging) yalnızca o adrese karşı koşar; yerel yığın kurulmaz.
// - Verilmezse `tests/e2e/global-setup.ts` yerel yığını (compose DB + migration + worker `demo.reseed` + web + TLS) kurar.
//   Yığın webServer ile DEĞİL globalSetup ile kurulur: demo girişi `WMS_ENV=staging` ister ve staging kipi `https`
//   zorlar (packages/auth readAuthEnv); bu yüzden web önünde yerel TLS ters vekili de çalışmalıdır.
// - Karantina/atlama yok (G-11): `forbidOnly`, yeniden deneme yok (kararsız adım bekleme koşuluyla düzeltilir).
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? "3100");
const baseURL = process.env.E2E_BASE_URL?.trim() || `https://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: ".artifacts/e2e/test-results",
  reporter: [["list"], ["html", { outputFolder: ".artifacts/e2e/report", open: "never" }]],
  forbidOnly: true,
  retries: 0,
  // Tek işçi: ortak demo verisi ve yerel ters vekil; iki proje (masaüstü, mobil) sırayla koşar.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    // Yerel TLS ters vekili kendinden imzalıdır; staging'in sertifikası geçerlidir ve bu bayrakla zayıflamaz.
    ignoreHTTPSErrors: true,
    locale: "tr-TR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // Pixel 5 = 393x727, dokunmatik, mobil Chromium.
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
