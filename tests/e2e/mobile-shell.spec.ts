// T-254: cihaza uyumlu kabuk. Telefonda (iPhone 13 profili 390x664 ve 390x844, 360x740) ana ekran tek ekrandır: sayfa kaymaz,
// yatay taşma yok, üst çubuk <= 56 px, dokunma hedefleri >= 48 px, Akış/Kokpit ve Çıkış menüden erişilir. Masaüstünde (1280x800)
// eski kök üst bar korunur, telefon üst çubuğu ve alt sekme çubuğu görünmez. Piksel karşılaştırma yok: ölçülen yerleşim değerleri.
// Tek demo girişi (demo girişi hız sınırlıdır). Ekran görüntüleri `.artifacts/t-254/` altına yazılır (git'e girmez).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { T270_SIZES, chevronInfo, expectBand, itemsScreenChecks, metrics, smallTargets } from "./support/items-screen.ts";

const OUT = process.env.T254_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-254");
const PHONES = [
  { name: "iphone13", width: 390, height: 664 }, // Playwright "iPhone 13" cihaz profili (Safari araç çubukları dahil görünür alan)
  { name: "iphone13-tam", width: 390, height: 844 }, // standalone / tam ekran
  { name: "android-360", width: 360, height: 740 },
] as const;


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

    // T-270 (Supervisor kararı: kasıtlı şartname değişikliği): 5 etkin döşeme kaydırmadan görünür alanda, üst çubuk ile alt sekme
    // çubuğu arasında (kutu sınırı assertion'ları aynı). 6 "Yakında" iş ızgarada döşeme değil, tek satırlık düğmenin arkasındadır:
    // düğme görünür alanda; dokununca tam 6 iş adı + "Yakında" listelenir (toplam 11 iş erişilebilir).
    const barBottom = (await bar.boundingBox())?.y ?? 0;
    const navTop = (await page.getByTestId("bottom-nav").boundingBox())?.y ?? 0;
    const cards = tasks.locator('[data-state="active"]');
    expect(await cards.count()).toBe(5);
    for (let i = 0; i < 5; i++) {
      const box = await cards.nth(i).boundingBox();
      expect(box, `${size.name}: kart ${i}`).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0), `${size.name}: kart ${i} alt sekmenin üstünde`).toBeLessThanOrEqual(navTop + 0.5);
      expect(box?.y ?? 0, `${size.name}: kart ${i} üst çubuğun altında`).toBeGreaterThanOrEqual(barBottom);
      expect((box?.x ?? 0) + (box?.width ?? 0), `${size.name}: kart ${i} sağ kenar`).toBeLessThanOrEqual(size.width);
    }
    const soonRow = page.locator(".soon-toggle");
    const soonBox = await soonRow.boundingBox();
    expect(soonBox, `${size.name}: Yakında satırı görünür`).not.toBeNull();
    expect((soonBox?.y ?? 0) + (soonBox?.height ?? 0), `${size.name}: Yakında satırı alt sekmenin üstünde`).toBeLessThanOrEqual(navTop + 0.5);
    expect(soonBox?.y ?? 0, `${size.name}: Yakında satırı üst çubuğun altında`).toBeGreaterThanOrEqual(barBottom);
    await expect(soonRow).toContainText("Yakında gelecekler (6)");
    await soonRow.click();
    // T-274: açık liste alt sayfadır (diyalog); aynı 6 iş ve aynı içerik.
    const soonCards = page.getByRole("dialog").locator('[data-state="soon"]');
    await expect(soonCards).toHaveCount(6);
    for (const name of ["Depoya mal geldi", "Depodan mal çıkacak", "Malı başka depoya taşıyacağım", "Rafı sayacağım", "Bir ürün nerede, kaç tane var?", "Yanlış bir şey yaptım"]) {
      const card = soonCards.filter({ hasText: name });
      await expect(card, `${size.name}: ${name}`).toHaveCount(1);
      await expect(card).toBeVisible();
      await expect(card).toContainText("Yakında");
    }
    await page.getByRole("dialog").getByRole("button", { name: "İşlere dön" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(cards.first()).toBeVisible();

    // Dokunma hedefleri >= 48 px (üst çubuk, kartlar, alt sekmeler).
    expect(await smallTargets(page, "body"), `${size.name}: 48 px altı dokunma hedefi`).toEqual([]);
  }

  // Alt sekme çubuğu: 4 sekme, ana sayfa geçerli, Tara saha ekranına gider, Görevlerim görev listesine gider (T-270).
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/t/demo");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav.getByRole("link", { name: "Ana sayfa" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Tara" })).toHaveAttribute("href", "/t/demo/field");
  // T-270 (Supervisor kararı): "Görevlerim" artık gerçek ekrana (T-304) bağlı; tıklanamaz/Yakında durumu kalktı.
  await expect(nav.getByRole("link", { name: "Görevlerim" })).toHaveAttribute("href", "/t/demo/field/tasks");
  await expect(nav.getByRole("group", { name: "Görevlerim" })).toHaveCount(0);
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
const T270_ROLES = [
  { label: "Yönetici", shot: "admin" },
  { label: "Toplayıcı", shot: "picker" },
] as const;

interface HomeLayout {
  readonly tiles: ReadonlyArray<{ readonly href: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }>;
  readonly navTop: number;
  readonly areaTop: number;
  readonly emptyRatio: number;
  readonly lastBottom: number;
}

/** Görünür döşeme/satır kutuları ve boş dikey alan oranı (selam + üst düğmeler + görünür öğelerin birleşimi dışında kalan alan). */
async function homeLayout(page: Page, itemSelector: string): Promise<HomeLayout> {
  return page.evaluate<HomeLayout>(`(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.y + b.height }; };
    const visible = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const bar = box(document.querySelector('[data-testid="app-bar"]'));
    const nav = box(document.querySelector('[data-testid="bottom-nav"]'));
    const tiles = [...document.querySelectorAll(${JSON.stringify(itemSelector)})].filter(visible).map((el) => ({ href: el.getAttribute('href') || '', ...box(el) }));
    const parts = [box(document.querySelector('main header')), ...tiles];
    const top = document.querySelector('.top-rows');
    if (top && visible(top)) parts.push(box(top));
    for (const sel of ['.locked-note', '.soon-note', '.my-tasks-row']) { const n = document.querySelector(sel); if (n && visible(n)) parts.push(box(n)); }
    const topY = bar.b, bottom = nav.y;
    const spans = parts.map((p) => [Math.max(p.y, topY), Math.min(p.b, bottom)]).sort((a, b) => a[0] - b[0]);
    let covered = 0, cur = null;
    for (const [s, e] of spans) { if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e); else { if (cur) covered += cur[1] - cur[0]; cur = [s, e]; } }
    if (cur) covered += cur[1] - cur[0];
    const all = [...tiles, ...(top && visible(top) ? [box(top)] : [])];
    return { tiles: tiles.map((t) => ({ href: t.href, x: t.x, y: t.y, w: t.w, h: t.h })), navTop: nav.y, areaTop: topY, emptyRatio: (bottom - topY - covered) / (bottom - topY), lastBottom: Math.max(...all.map((p) => p.b)) };
  })()`);
}


/** T-274 B-01: alt sayfa açıkken yapı ölçümleri; saat/kilit simgesi boyutu döner (H-03). */
async function expectSheet(page: Page, where: string, rows: number): Promise<number> {
  const dialog = page.getByRole("dialog");
  await expect(dialog, `${where}: alt sayfa açık`).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const g = await page.evaluate<{ top: number; bottom: number; vh: number; fits: boolean; closeGap: number; closeH: number; closeLast: boolean; rows: number; icon: number; inset: number }>(`(() => {
    const d = document.querySelector('[data-testid="more-sheet"]');
    const panel = d.firstElementChild, pr = panel.getBoundingClientRect();
    const btn = [...panel.querySelectorAll('button')].pop(), br = btn.getBoundingClientRect();
    const icon = panel.querySelector('[data-testid="sheet-header"] svg').getBoundingClientRect();
    return { top: pr.top, bottom: pr.bottom, vh: window.innerHeight, fits: panel.scrollHeight <= panel.clientHeight + 1, closeGap: pr.bottom - br.bottom, closeH: br.height,
      closeLast: panel.lastElementChild === btn, rows: panel.querySelectorAll('[data-state]').length, icon: icon.width, inset: window.innerHeight - pr.bottom };
  })()`);
  expect(g.bottom - g.top, `${where}: yükseklik ≤ %85 (B-01)`).toBeLessThanOrEqual(g.vh * 0.85 + 1);
  expect(g.fits, `${where}: içeriğine uyar (kaymaz)`).toBe(true);
  expect(g.inset, `${where}: alt sayfa ekranın altında`).toBeLessThanOrEqual(1);
  expect(g.closeLast, `${where}: kapatma düğmesi en altta`).toBe(true);
  expect(g.closeGap, `${where}: kapatma düğmesi sayfanın ≤ 16 px içinde`).toBeLessThanOrEqual(16);
  expect(g.closeH, `${where}: kapatma düğmesi dokunma yüksekliği`).toBeGreaterThanOrEqual(48);
  expect(g.rows, `${where}: satır sayısı`).toBe(rows);
  await expectBand(page, `${where}: alt sayfa içi`, '[data-testid="more-sheet"] > div');
  // Açılışta odak başlık satırındadır (ilk satırda değil).
  expect(await page.evaluate<boolean>(`document.activeElement?.closest('[data-testid="sheet-header"]') !== null && document.activeElement?.closest('[data-state]') === null`), `${where}: odak başlıkta`).toBe(true);
  // Odak tuzağı: Tab döngüsü alt sayfadan çıkmaz.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate<boolean>(`document.querySelector('[data-testid="more-sheet"]').contains(document.activeElement)`), `${where}: odak alt sayfada (Tab ${i + 1})`).toBe(true);
  }
  return g.icon;
}

/** T-274 B-01: üç kapanış yolu (Esc + odak dönüşü, arka plana dokunma, aşağı kaydırma); alt sayfa her seferinde yeniden açılır. */
async function expectSheetCloses(page: Page, where: string, opener: Locator, width: number): Promise<void> {
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Escape");
  await expect(dialog, `${where}: Esc kapatır`).toBeHidden();
  await expect(opener, `${where}: odak açan düğmeye döner`).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(width / 2, 70); // kararmış arka plan (alt sayfanın çok üstü)
  await expect(dialog, `${where}: arka plana dokunma kapatır`).toBeHidden();
  await opener.click();
  await expect(dialog).toBeVisible();
  const h = await page.getByTestId("sheet-header").boundingBox();
  expect(h, `${where}: tutamaç`).not.toBeNull();
  const x = (h?.x ?? 0) + (h?.width ?? 0) / 2, y = (h?.y ?? 0) + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 4 });
  await page.mouse.move(x, y + 120, { steps: 6 });
  await page.mouse.up();
  await expect(dialog, `${where}: aşağı kaydırma kapatır`).toBeHidden();
}

test("ana ekran düzeni (T-270): eşit döşemeler, başparmak bölgesi, boş alan, saha işi önce, Yakında ve yetkisiz işler listeleri", async ({ page }) => {
  mkdirSync(OUT_T270, { recursive: true });
  const tag = test.info().project.name;
  const clockSizes: number[] = [];
  for (const role of T270_ROLES) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: `${role.label} olarak gir` }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    const tasks = page.getByRole("list", { name: "İşler" });
    const isAdmin = role.shot === "admin";
    const activeCount = isAdmin ? 5 : 2; // toplayıcı: yalnız Depo ve raflar + Ürünlerim izinli; 3 yönetim işi yetkisiz
    const soonRow = page.locator(".soon-toggle");
    const lockedRow = page.locator(".locked-toggle");

    for (const size of T270_SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/t/demo");
      await expect(tasks).toBeVisible();
      const L = await homeLayout(page, ".task-grid > .task-item > [data-state]");
      const where = `${role.shot} ${size.width}x${size.height}`;
      expect(L.tiles.length, `${where}: görünür döşeme sayısı (izinli işler)`).toBe(activeCount);

      // Eşit ızgara: tüm genişlik ve yükseklikler ±2 px; yükseklik 88-140 px (her rol).
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
      expect(L.tiles[0]?.y, `${where}: ilk (en öncelikli) döşeme en alt satırda`).toBe(Math.max(...L.tiles.map((t) => t.y)));

      // Sıra: saha işleri (depo, ürün) yönetim işlerinden önce; ilk döşeme saha işi.
      const hrefs = L.tiles.map((t) => t.href);
      const idx = (suffix: string) => hrefs.findIndex((h) => h.endsWith(suffix));
      const field = [idx("/warehouses"), idx("/items")].filter((i) => i >= 0);
      const admin = [idx("/audit"), idx("/members"), idx("/settings")].filter((i) => i >= 0);
      expect(field.length, `${where}: saha işleri görünür`).toBe(2);
      if (admin.length > 0) expect(Math.max(...field), `${where}: saha işleri yönetimden önce`).toBeLessThan(Math.min(...admin));
      expect(hrefs[0], `${where}: ilk döşeme saha işi`).toMatch(/\/(warehouses|items)$/);

      // Kategori rengi yalnız ikon dairesinde: döşeme zemini beyaz (yüzey), ikon dairesi zemini döşemeden farklı.
      const tints = await page.evaluate<string[]>(`[...document.querySelectorAll('.task-grid > .task-item > [data-state] .tile-badge')].map((b) => getComputedStyle(b.closest('[data-state]')).backgroundColor + '|' + getComputedStyle(b).backgroundColor)`);
      for (const t of tints) {
        const [tileBg, circleBg] = t.split("|");
        expect(circleBg, `${where}: ikon dairesi döşemeden farklı renkte`).not.toBe(tileBg);
      }

      // Üst düğme etiketleri kesilmez (…).
      const cut = await page.evaluate<string[]>(`[...document.querySelectorAll('.top-rows .when-closed')].filter((e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth).map((e) => e.textContent)`);
      expect(cut, `${where}: kesilen üst düğme etiketi`).toEqual([]);

      // "Görevlerim" özeti yalnız saha rolünde: gerçek sayı + tek dokunuşla görev listesi, ya da sakin boş durum satırı.
      if (isAdmin) await expect(page.locator(".my-tasks-row")).toBeHidden();
      else {
        const card = page.getByTestId("my-tasks-card");
        if ((await card.count()) > 0) {
          await expect(card).toHaveAttribute("href", "/t/demo/field/tasks");
          await expect(card).toContainText(/Sana atanmış \d+\+? iş/);
        } else {
          // T-274: boş durum kartı artık sonraki adımı da taşır; ileti metni aynı güçte (tam eşitlik) doğrulanır, kart ≤ 120 px ve bağlantı gerçek.
          const empty = page.getByTestId("my-tasks-empty");
          await expect(empty.locator("p")).toHaveText("Şu an sana atanmış iş yok.");
          await expect(empty.getByRole("link", { name: "Tara ile başla" })).toHaveAttribute("href", "/t/demo/field");
          expect((await empty.boundingBox())?.height ?? 999, `${where}: boş durum kartı yüksekliği (H-02)`).toBeLessThanOrEqual(120);
        }
        expect(await smallTargets(page, ".my-tasks-row"), `${where}: Görevlerim özeti dokunma hedefi`).toEqual([]);
      }

      // Üst düğmeler: kapalı, görünür alanda; toplayıcıda yetkisiz işler tek satırda (varsayılan kapalı); alt sayfa kapalı.
      await expect(soonRow).toContainText("Yakında gelecekler (6)");
      if (isAdmin) await expect(lockedRow).toHaveCount(0);
      else {
        await expect(lockedRow).toContainText("Yetkin olmayan işler (3)");
        await expect(tasks.locator('[data-state="locked"]').first()).toBeHidden();
      }
      await expect(page.getByRole("dialog")).toBeHidden();
      // B-02 (kapalı ana ekran): en büyük boş dikey bant ≤ 120 px; B-04: şevron sağda, ≥ 48 px, kapalıyken dönmemiş.
      await expectBand(page, `${where}: kapalı ana ekran`, null);
      const sc = await chevronInfo(page, ".soon-toggle");
      expect(sc.h, `${where}: Yakında düğmesi yüksekliği (B-04)`).toBeGreaterThanOrEqual(48);
      expect(sc.rightGap, `${where}: şevron sağda (B-04)`).toBeLessThanOrEqual(16);
      expect(sc.rotated, `${where}: şevron kapalıyken dönmemiş`).toBe(false);

      // Dokunma hedefleri ve taşma.
      expect(await smallTargets(page, "body"), `${where}: 48 px altı dokunma hedefi`).toEqual([]);
      const m = await metrics(page);
      expect(m.scrollWidth, `${where}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollHeight, `${where}: sayfa gövdesi kaymaz`).toBeLessThanOrEqual(m.innerHeight);
      await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}.png`) });

      // "Yakında" açık (B-01/B-02): kararmış ana ekran üzerinde alt sayfa; 6 iş, tek kompakt başlık satırı, kapatma altta.
      await soonRow.click();
      await expect(soonRow).toHaveAttribute("aria-expanded", "true");
      const soonIcon = await expectSheet(page, `${where}: Yakında`, 6);
      clockSizes.push(soonIcon);
      expect((await chevronInfo(page, ".soon-toggle")).rotated, `${where}: şevron açılınca döner (B-04)`).toBe(true);
      const dlg = page.getByRole("dialog");
      for (const card of await dlg.locator('[data-state="soon"]').all()) {
        await expect(card).toBeVisible();
        await expect(card).toContainText("Yakında");
      }
      await expect(dlg.getByTestId("sheet-header")).toContainText("Bu işler depo kurulumundan sonra açılacak."); // çoğul (T-01)
      for (const t of await dlg.locator('[data-state="soon"]').all()) {
        const hh = (await t.boundingBox())?.height ?? 0;
        expect(hh, `${where}: alt sayfa satır yüksekliği`).toBeGreaterThanOrEqual(56);
        expect(hh, `${where}: alt sayfa satır yüksekliği (kompakt)`).toBeLessThanOrEqual(72);
      }
      const rowFlat = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="more-sheet"] [data-state]')].map((e) => getComputedStyle(e).boxShadow)`);
      for (const sh of rowFlat) expect(sh, `${where}: Yakında satırı gölgesiz`).toBe("none");
      const titles = await page.evaluate<number[]>(`[...document.querySelectorAll('[data-testid="more-sheet"] .tile-title')].map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)))`);
      for (const lines of titles) expect(lines, `${where}: Yakında başlığı en çok 2 satır`).toBeLessThanOrEqual(2);
      expect(await smallTargets(page, '[data-testid="more-sheet"]'), `${where}: Yakında alt sayfası 48 px altı hedef`).toEqual([]);
      await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}-yakinda-acik.png`) });
      await expectSheetCloses(page, `${where}: Yakında`, soonRow, size.width);
      await expect(tasks.locator('a[data-state="active"]').first()).toBeVisible();

      // Toplayıcı: yetkisiz işler alt sayfası: tek başlık satırı + 3 kompakt iş; kapatma altta.
      if (!isAdmin) {
        await lockedRow.click();
        await expectSheet(page, `${where}: yetkisiz`, 3);
        const ldlg = page.getByRole("dialog");
        await expect(ldlg.getByTestId("sheet-header")).toHaveText("Bu işler için yetkin yok. Sorumluna sorabilirsin.");
        const lockedCards = ldlg.locator('[data-state="locked"]');
        await expect(lockedCards).toHaveCount(3);
        for (const name of ["Ekibimi yönet", "Ayarlar", "Kim ne yaptı?"]) await expect(lockedCards.filter({ hasText: name })).toBeVisible();
        for (const t of await lockedCards.all()) {
          const hh = (await t.boundingBox())?.height ?? 0;
          expect(hh, `${where}: yetkisiz satır yüksekliği`).toBeGreaterThanOrEqual(56);
          expect(hh, `${where}: yetkisiz satır yüksekliği (kompakt)`).toBeLessThanOrEqual(72);
        }
        const lockedFlat = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="more-sheet"] [data-state]')].map((e) => getComputedStyle(e).boxShadow)`);
        for (const sh of lockedFlat) expect(sh, `${where}: yetkisiz satır gölgesiz`).toBe("none");
        await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}-yetkisiz-acik.png`) });
        await expectSheetCloses(page, `${where}: yetkisiz`, lockedRow, size.width);
      }
    }

    if (isAdmin) await itemsScreenChecks(page, { slug: "demo", empty: false });

    await page.getByTestId("app-bar-menu").click();
    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
  // H-03: saat ikonu 360/390/430'da tutarlı (rol başına 3 ölçüm; hepsi birbirine ≤ 1 px).
  expect(clockSizes.length, "saat ikonu ölçümleri").toBe(T270_ROLES.length * T270_SIZES.length);
  expect(Math.max(...clockSizes) - Math.min(...clockSizes), `saat ikonu boyutu tutarlı (${clockSizes.join("/")})`).toBeLessThanOrEqual(1);
});

