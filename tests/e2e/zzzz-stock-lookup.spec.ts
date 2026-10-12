// T-332b: "Bir ürün nerede, kaç tane var?" saha ekranı. Yalnızca OKUR (demo verisi: KRT-3020 iki rafta stoklu, BLN-100 bilerek stoksuz); fikstür yazmaz,
// bu yüzden yerelde ve uzakta (staging) aynı şekilde koşar. Telefon 390x844'te taşma ve 48 px hedef, sonra 1280'de taşma ölçülür.
// Tarama klavye kaması taklidiyle yapılır (kamera yolu camera-scan.spec.ts'te sınanır).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { enterDemoShared, isRemote } from "./support/demo-session.ts";

// Demo girişi istemci IP'si başına 10 giriş / 10 dk ile sınırlıdır (T-300). Ana projelerin (desktop/mobile) istemci adresleri tam koşuda
// sınıra dayanır; bu spec yerel vekilde kendi TEST-NET-2 adresini bildirir (sınır DEĞİŞMEZ; aynı desen: support/empty-tenant.ts). Uzakta yoktur.
if (!isRemote()) test.use({ extraHTTPHeaders: { "x-e2e-client-ip": "198.51.100.70" } });

const OUT = process.env.T332B_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-332b");

/** Klavye kaması taramasını taklit eder: STX + karakterler + Enter, tek tikte (tuşlar arası < 30 ms). */
async function scan(page: Page, code: string): Promise<void> {
  await page.evaluate(`(() => { const send = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); send("\\u0002"); for (const ch of ${JSON.stringify(code)}) send(ch); send("Enter"); })()`);
}

interface Metrics {
  scrollWidth: number;
  clientWidth: number;
  small: string[];
  primaries: number;
}
async function measure(page: Page): Promise<Metrics> {
  return page.evaluate<Metrics>(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const small = [];
    for (const el of document.querySelectorAll('a[href], button, summary, input, select, textarea')) {
      if (el.matches('a[href="#main"]') || !vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 47.5 || r.height < 47.5) small.push(((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      small,
      primaries: [...document.querySelectorAll('[data-variant="primary"]')].filter(vis).length,
    };
  })()`);
}

async function check(page: Page, name: string, touch: boolean): Promise<void> {
  const m = await measure(page);
  expect(m.scrollWidth, `${name}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
  if (touch) {
    expect(m.small, `${name}: 48 px altı hedef`).toEqual([]);
    expect(m.primaries, `${name}: tek birincil eylem`).toBe(1);
  }
}

test("stok sorgu: ürün okut → raf satırları; raf okut → ürünler; stoksuz ve bilinmeyen kod iletileri", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const shot = (name: string): Promise<Buffer> => page.screenshot({ path: path.join(OUT, `${testInfo.project.name}-${name}.png`) });
  await page.addInitScript("try { delete window.BarcodeDetector; } catch (e) { window.BarcodeDetector = undefined; }");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await enterDemoShared(page, "Yönetici");
  await expect(page).toHaveURL(/\/t\/demo$/);

  // Ana ekran döşemesinin bağlantısı T-331'dedir; sayfa doğrudan adresle açılır.
  await page.goto("/t/demo/field/lookup");
  await expect(page).toHaveURL(/\/t\/demo\/field\/lookup$/);
  await expect(page.getByRole("heading", { level: 1, name: "Stok sorgula" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Barkodu okut" })).toBeVisible();
  await check(page, "açılış", true);
  await shot("acilis");

  // Ürün okut → raf başına satır + toplam.
  await scan(page, "KRT-3020");
  await expect(page.getByTestId("lookup-heading")).toContainText("Karton kutu 30x20x15");
  const rows = page.getByTestId("stock-row");
  await expect(rows.filter({ hasText: "A1-G01" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "A1-G02" })).toHaveCount(1);
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("lookup-total").getByTestId("q-physical")).toHaveText(/^\d+(\.\d+)?$/);
  await expect(rows.first().getByTestId("q-available")).toHaveText(/^\d+(\.\d+)?$/);
  await check(page, "ürün sonucu", true);
  await shot("urun");
  await page.setViewportSize({ width: 1280, height: 800 });
  await check(page, "ürün sonucu 1280", false);
  await page.setViewportSize({ width: 390, height: 844 });

  // Raf okut → o raftaki ürünler.
  await scan(page, "A1-G01");
  await expect(page.getByTestId("lookup-heading")).toContainText("Raf:");
  await expect(page.getByTestId("lookup-heading")).toContainText("A1-G01");
  await expect(page.getByTestId("stock-row").filter({ hasText: "Karton kutu 30x20x15" })).toHaveCount(1);
  await check(page, "raf sonucu", true);
  await shot("raf");
  await page.setViewportSize({ width: 1280, height: 800 });
  await check(page, "raf sonucu 1280", false);
  await page.setViewportSize({ width: 390, height: 844 });

  // Boş sonuç: stoksuz ürün.
  await scan(page, "BLN-100");
  await expect(page.getByTestId("lookup-empty")).toContainText("hiçbir rafta stok görünmüyor");
  await expect(page.getByTestId("stock-row")).toHaveCount(0);
  await check(page, "stoksuz ürün", true);
  await shot("bos");

  // Bilinmeyen kod: sade ileti + sonraki eylem.
  await scan(page, `ZZ-YOK-${randomUUID().slice(0, 8).toUpperCase()}`);
  await expect(page.getByTestId("lookup-not-found")).toContainText("Bu kodla ürün ya da raf bulunamadı.");
  await expect(page.getByTestId("lookup-not-found")).toContainText("Kodu kontrol edip yeniden okut.");
  await check(page, "bulunamadı", true);
  await shot("bulunamadi");
});
