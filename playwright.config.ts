// Playwright yapılandırması (T-131). Çıktılar `.artifacts/e2e/` altına (git'e girmez).
// - `E2E_BASE_URL` verilirse (ör. staging) yalnızca o adrese karşı koşar; yerel yığın kurulmaz.
// - Verilmezse `tests/e2e/global-setup.ts` yerel yığını (compose DB + migration + worker `demo.reseed` + web + TLS) kurar.
//   Yığın webServer ile DEĞİL globalSetup ile kurulur: demo girişi `WMS_ENV=staging` ister ve staging kipi `https`
//   zorlar (packages/auth readAuthEnv); bu yüzden web önünde yerel TLS ters vekili de çalışmalıdır.
// - Karantina/atlama yok (G-11): `forbidOnly`, yeniden deneme yok (kararsız adım bekleme koşuluyla düzeltilir).
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? "3100");
const remoteBaseURL = process.env.E2E_BASE_URL?.trim();
const baseURL = remoteBaseURL || `https://localhost:${port}`;

// T-278: masaüstü ve mobil ayrı cihazlardır; yerel TLS vekili (global-setup, Fly kenarı taklidi) her projeye ayrı
// istemci adresi (TEST-NET-2) verir → ayrı hız sınırı kovaları. Hız sınırı kuralı değişmez. Uzak hedefte başlık
// eklenmez (Fly kenarı `Fly-Client-IP`'i kendisi koyar; uygulama bu başlığı okumaz).
function localClient(ip: string): { extraHTTPHeaders?: Record<string, string> } {
  return remoteBaseURL ? {} : { extraHTTPHeaders: { "x-e2e-client-ip": ip } };
}

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
    // Yalnızca yerel TLS ters vekili (kendinden imzalı) için; uzak hedefte (staging) sertifika doğrulaması açık kalır.
    ignoreHTTPSErrors: !remoteBaseURL,
    locale: "tr-TR",
    // Uzak hedefte trace kapalı: trace demo oturum çerezini ve ağ trafiğini içerir, artifact olarak saklanır.
    trace: remoteBaseURL ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, ...localClient("198.51.100.1") } },
    // Pixel 5 = 393x727, dokunmatik, mobil Chromium.
    { name: "mobile", use: { ...devices["Pixel 5"], ...localClient("198.51.100.2") } },
  ],
});
