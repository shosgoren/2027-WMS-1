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

// T-270: telefon ana ekranı düzeni. Ölçülen yerleşim değerleri (piksel karşılaştırma yok): eşit döşeme, başparmak bölgesi,
// boş alan oranı, role göre sıra ve "Yakında" listesi. Rol başına ayrı demo girişi (yönetici + toplayıcı). Ekran görüntüleri
// `.artifacts/t-270/final-*.png` (git'e girmez).
const OUT_T270 = process.env.T270_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-270");
const T270_SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;
const T270_ROLES = [
  { label: "Yönetici", shot: "admin" },
  { label: "Toplayıcı", shot: "picker" },
] as const;

interface HomeLayout {
  readonly tiles: ReadonlyArray<{ readonly href: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }>;
  readonly navTop: number;
  readonly areaTop: number;
  readonly emptyRatio: number;
}

async function homeLayout(page: Page): Promise<HomeLayout> {
  return page.evaluate<HomeLayout>(`(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.y + b.height }; };
    const bar = box(document.querySelector('[data-testid="app-bar"]'));
    const nav = box(document.querySelector('[data-testid="bottom-nav"]'));
    const tiles = [...document.querySelectorAll('.task-grid > .task-item > [data-state]')].map((el) => ({ href: el.getAttribute('href') || '', ...box(el) }));
    const parts = [box(document.querySelector('main header')), ...tiles];
    const toggle = document.querySelector('.soon-toggle');
    if (toggle) parts.push(box(toggle));
    const top = bar.b, bottom = nav.y;
    const spans = parts.map((p) => [Math.max(p.y, top), Math.min(p.b, bottom)]).sort((a, b) => a[0] - b[0]);
    let covered = 0, cur = null;
    for (const [s, e] of spans) { if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e); else { if (cur) covered += cur[1] - cur[0]; cur = [s, e]; } }
    if (cur) covered += cur[1] - cur[0];
    return { tiles: tiles.map((t) => ({ href: t.href, x: t.x, y: t.y, w: t.w, h: t.h })), navTop: nav.y, areaTop: top, emptyRatio: (bottom - top - covered) / (bottom - top) };
  })()`);
}

test("ana ekran düzeni (T-270): eşit döşemeler, başparmak bölgesi, boş alan, saha işi önce, Yakında listesi", async ({ page }) => {
  mkdirSync(OUT_T270, { recursive: true });
  const tag = test.info().project.name;
  for (const role of T270_ROLES) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: `${role.label} olarak gir` }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    const tasks = page.getByRole("list", { name: "İşler" });

    for (const size of T270_SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/t/demo");
      await expect(tasks).toBeVisible();
      const L = await homeLayout(page);
      const where = `${role.shot} ${size.width}x${size.height}`;
      expect(L.tiles.length, `${where}: görünür döşeme sayısı (etkin + kilitli)`).toBe(5);

      // Eşit ızgara: tüm genişlik ve yükseklikler ±2 px; yükseklik 88-140 px.
      const ws = L.tiles.map((t) => t.w);
      const hs = L.tiles.map((t) => t.h);
      expect(Math.max(...ws) - Math.min(...ws), `${where}: genişlik farkı`).toBeLessThanOrEqual(2);
      expect(Math.max(...hs) - Math.min(...hs), `${where}: yükseklik farkı`).toBeLessThanOrEqual(2);
      expect(Math.min(...hs), `${where}: en küçük döşeme yüksekliği`).toBeGreaterThanOrEqual(88);
      expect(Math.max(...hs), `${where}: en büyük döşeme yüksekliği`).toBeLessThanOrEqual(140);

      // Başparmak bölgesi: ızgara alt sekmeye yaslı (<= 16 px), boş dikey alan <= %15, ilk iş en alt satırda.
      const gridBottom = Math.max(...L.tiles.map((t) => t.y + t.h));
      expect(L.navTop - gridBottom, `${where}: ızgara alt kenarı ile alt sekme arası`).toBeLessThanOrEqual(16);
      expect(L.emptyRatio, `${where}: boş dikey alan oranı`).toBeLessThanOrEqual(0.15);
      const lowest = Math.max(...L.tiles.map((t) => t.y));
      expect(L.tiles[0]?.y, `${where}: ilk (en öncelikli) döşeme en alt satırda`).toBe(lowest);

      // Sıra: saha işleri (depo, ürün) yönetim işlerinden (denetim, ekip, ayarlar) önce — rol fark etmez.
      const hrefs = L.tiles.map((t) => t.href);
      const idx = (suffix: string) => hrefs.findIndex((h) => h.endsWith(suffix));
      const field = [idx("/warehouses"), idx("/items")].filter((i) => i >= 0);
      const admin = [idx("/audit"), idx("/members"), idx("/settings")].filter((i) => i >= 0);
      expect(Math.max(...field), `${where}: saha işleri yönetimden önce`).toBeLessThan(admin.length > 0 ? Math.min(...admin) : 99);
      expect(hrefs[0], `${where}: ilk döşeme saha işi`).toMatch(/\/(warehouses|items)$/);

      // Dokunma hedefleri ve taşma.
      expect(await smallTargets(page, "body"), `${where}: 48 px altı dokunma hedefi`).toEqual([]);
      const m = await metrics(page);
      expect(m.scrollWidth, `${where}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollHeight, `${where}: sayfa gövdesi kaymaz`).toBeLessThanOrEqual(m.innerHeight);
      await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}.png`) });
    }

    // "Yakında" döşeme değildir: varsayılan kapalı tek satır; açılınca 6 iş listelenir, "İşlere dön" ile kapanır.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/t/demo");
    const toggle = page.locator(".soon-toggle > summary");
    await expect(toggle).toContainText("Yakında gelecekler (6)");
    expect(await height(toggle), `${role.shot}: Yakında satırı dokunma yüksekliği`).toBeGreaterThanOrEqual(48);
    await expect(tasks.locator('[data-state="soon"]').first()).toBeHidden();
    await toggle.click();
    await expect(toggle).toContainText("İşlere dön");
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(6);
    for (const card of await tasks.locator('[data-state="soon"]').all()) {
      await expect(card).toBeVisible();
      await expect(card).toContainText("Yakında");
    }
    await expect(tasks.locator('a[data-state="active"]').first()).toBeHidden();
    expect(await smallTargets(page, "body"), `${role.shot}: Yakında listesi 48 px altı hedef`).toEqual([]);
    await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-yakinda-390.png`) });
    await toggle.click();
    await expect(tasks.locator('a[data-state="active"]').first()).toBeVisible();

    await page.getByTestId("app-bar-menu").click();
    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
});
