// T-254: cihaza uyumlu kabuk. Telefonda (iPhone 13 profili 390x664 ve 390x844, 360x740) ana ekran tek ekrandır: sayfa kaymaz,
// yatay taşma yok, üst çubuk <= 56 px, dokunma hedefleri >= 48 px, Akış/Kokpit ve Çıkış menüden erişilir. Masaüstünde (1280x800)
// eski kök üst bar korunur, telefon üst çubuğu ve alt sekme çubuğu görünmez. Piksel karşılaştırma yok: ölçülen yerleşim değerleri.
// Tek demo girişi (demo girişi hız sınırlıdır). Ekran görüntüleri `.artifacts/t-254/` altına yazılır (git'e girmez).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const OUT = process.env.T254_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-254");
const PHONES = [
  { name: "iphone13", width: 390, height: 664 }, // Playwright "iPhone 13" cihaz profili (Safari araç çubukları dahil görünür alan)
  { name: "iphone13-tam", width: 390, height: 844 }, // standalone / tam ekran
  { name: "android-360", width: 360, height: 740 },
] as const;

interface Metrics {
  readonly scrollHeight: number;
  readonly innerHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

async function metrics(page: Page): Promise<Metrics> {
  // Dize ifadesi: kök tsconfig'de DOM tipleri yok (lib: ES2023); ifade tarayıcıda çalışır.
  return page.evaluate<Metrics>(
    "({ scrollHeight: document.scrollingElement.scrollHeight, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })",
  );
}

/** Görünür etkileşimli öğelerin (bağlantı, düğme, odaklanabilir kart) 48x48 altında kalanları. */
async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body;
    const out = [];
    for (const el of root.querySelectorAll('a[href], button, summary, [tabindex="0"], input, select, textarea')) {
      if (el.matches('a[href="#main"]')) continue; // yalnızca odaklanınca görünen atlama bağlantısı
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 47.5 || r.height < 47.5) out.push((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
    return out;
  })()`);
}

async function height(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "boundingBox").not.toBeNull();
  return box?.height ?? 0;
}

test("telefon kabuğu: ana ekran tek ekran, menü, alt sekme; masaüstü korunur", async ({ page }, testInfo) => {
  mkdirSync(OUT, { recursive: true });
  const rows: string[] = [];
  const tag = testInfo.project.name;

  await page.setViewportSize({ width: PHONES[0].width, height: PHONES[0].height });
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
  await expect(page.getByRole("heading", { level: 1, name: "Ne yapmak istiyorsun?" })).toBeVisible();

  for (const size of PHONES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/t/demo");
    const tasks = page.getByRole("list", { name: "İşler" });
    await expect(tasks.locator('[data-state="active"]')).toHaveCount(5);
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(6);
    await page.screenshot({ path: path.join(OUT, `${tag}-${size.name}-ana-ekran.png`) });

    // Kaydırmasız: sayfa yüksekliği = görünür yükseklik, yatay taşma yok.
    const m = await metrics(page);
    rows.push(`${size.name} ${size.width}x${size.height}: scrollHeight=${m.scrollHeight} innerHeight=${m.innerHeight} scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}`);
    expect(m.scrollHeight, `${size.name}: scrollHeight(${m.scrollHeight}) <= innerHeight(${m.innerHeight})`).toBeLessThanOrEqual(m.innerHeight);
    expect(m.scrollWidth, `${size.name}: scrollWidth(${m.scrollWidth}) <= clientWidth(${m.clientWidth})`).toBeLessThanOrEqual(m.clientWidth);

    // Üst çubuk <= 56 px; eski büyük başlık yok; alt sekme çubuğu var.
    const bar = page.getByTestId("app-bar");
    await expect(bar).toBeVisible();
    expect(await height(bar), `${size.name}: üst çubuk yüksekliği`).toBeLessThanOrEqual(56);
    await expect(page.getByTestId("app-bar-name")).toHaveText("Demo Ambalaj A.Ş.");
    await expect(page.getByRole("button", { name: "Çıkış yap" })).toHaveCount(0); // menüde (kapalı)
    await expect(page.getByTestId("bottom-nav")).toBeVisible();

    // Tüm kartlar (5 etkin + 6 "Yakında") kaydırmadan görünür alanda, üst çubuk ile alt sekme çubuğu arasında.
    const barBottom = (await bar.boundingBox())?.y ?? 0;
    const navTop = (await page.getByTestId("bottom-nav").boundingBox())?.y ?? 0;
    const cards = tasks.locator("[data-state]");
    expect(await cards.count()).toBe(11);
    for (let i = 0; i < 11; i++) {
      const box = await cards.nth(i).boundingBox();
      expect(box, `${size.name}: kart ${i}`).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0), `${size.name}: kart ${i} alt sekmenin üstünde`).toBeLessThanOrEqual(navTop + 0.5);
      expect(box?.y ?? 0, `${size.name}: kart ${i} üst çubuğun altında`).toBeGreaterThanOrEqual(barBottom);
      expect((box?.x ?? 0) + (box?.width ?? 0), `${size.name}: kart ${i} sağ kenar`).toBeLessThanOrEqual(size.width);
    }

    // Dokunma hedefleri >= 48 px (üst çubuk, kartlar, alt sekmeler).
    expect(await smallTargets(page, "body"), `${size.name}: 48 px altı dokunma hedefi`).toEqual([]);
  }

  // Alt sekme çubuğu: 4 sekme, ana sayfa geçerli, Tara saha ekranına gider, Görevlerim tıklanamaz.
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/t/demo");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav.getByRole("link", { name: "Ana sayfa" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Tara" })).toHaveAttribute("href", "/t/demo/field");
  await expect(nav.getByRole("link", { name: "Görevlerim" })).toHaveCount(0);
  await expect(nav.getByRole("group", { name: "Görevlerim" })).toHaveAttribute("aria-disabled", "true");
  await expect(nav.getByRole("button", { name: "Menü" })).toBeVisible();

  // Menü: Akış/Kokpit, çalışma alanı, "Giriş yapan", Yardım ve Çıkış erişilebilir; hedefler >= 48 px.
  await page.getByTestId("app-bar-menu").click();
  const menu = page.getByRole("dialog", { name: "Menü" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Giriş yapan: Demo Yönetici")).toBeVisible();
  await expect(menu.getByRole("link", { name: /Demo Ambalaj/ })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("link", { name: "Yardım çağır" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Akış", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await smallTargets(page, '[data-testid="app-menu"]'), "menü: 48 px altı dokunma hedefi").toEqual([]);
  await page.screenshot({ path: path.join(OUT, `${tag}-iphone13-menu.png`) });
  const mm = await metrics(page);
  expect(mm.scrollWidth, "menü açıkken yatay taşma yok").toBeLessThanOrEqual(mm.clientWidth);

  // Kokpit menüden seçilir ve kalıcıdır.
  await menu.getByRole("button", { name: "Kokpit", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-view", "cockpit");
  // Menü açık kalır (seçili durum görünür); sunucu eylemi sonrası sayfa yenilenir.
  await expect(menu.getByRole("button", { name: "Kokpit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: path.join(OUT, `${tag}-iphone13-kokpit.png`) });
  await menu.getByRole("button", { name: "Akış", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-view", "flow");

  // İç ekran: Escape menüyü kapatır; üyeler ekranında gövde kaymaz, yalnız içerik alanı kayar, yatay taşma yok.
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.goto("/t/demo/members");
  await expect(page.getByRole("heading", { level: 1, name: "Üyeler" })).toBeVisible();
  const inner = await metrics(page);
  expect(inner.scrollHeight, "üyeler: sayfa gövdesi kaymaz").toBeLessThanOrEqual(inner.innerHeight);
  expect(inner.scrollWidth, "üyeler: yatay taşma yok").toBeLessThanOrEqual(inner.clientWidth);
  await page.screenshot({ path: path.join(OUT, `${tag}-iphone13-uyeler.png`) });
  await page.goto("/t/demo");

  // Sunucu/ağ hatası: çıkış başarısızsa neden + sonraki eylem menüde görünür; sonra gerçek çıkış.
  await page.getByTestId("app-bar-menu").click();
  await page.route("**/sign-out", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await menu.getByRole("button", { name: "Çıkış yap" }).click();
  await expect(menu.getByRole("alert")).toContainText("Çıkış yapılamadı. Bağlantını kontrol edip yeniden dene.");
  await page.unroute("**/sign-out");

  // Masaüstü (1280x800): telefon öğeleri yok, eski üst bar + çalışma alanı satırı görünür.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/t/demo");
  await expect(page.getByTestId("app-bar")).toBeHidden();
  await expect(page.getByTestId("bottom-nav")).toBeHidden();
  await expect(page.getByTestId("tenant-bar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Çıkış yap" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Ne yapmak istiyorsun?" })).toBeVisible();
  await expect(page.getByText("Yapmak istediğin işe dokun.")).toBeVisible();
  await page.screenshot({ path: path.join(OUT, `${tag}-masaustu-ana-ekran.png`) });

  // Gerçek çıkış (telefon menüsünden).
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/t/demo");
  await page.getByTestId("app-bar-menu").click();
  await menu.getByRole("button", { name: "Çıkış yap" }).click();
  await expect(page).toHaveURL(/\/login$/);

  console.log(`T254-METRICS ${tag}\n${rows.join("\n")}`);
});
