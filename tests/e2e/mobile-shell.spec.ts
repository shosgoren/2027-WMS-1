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
    const soonRow = page.locator(".soon-toggle > summary");
    const soonBox = await soonRow.boundingBox();
    expect(soonBox, `${size.name}: Yakında satırı görünür`).not.toBeNull();
    expect((soonBox?.y ?? 0) + (soonBox?.height ?? 0), `${size.name}: Yakında satırı alt sekmenin üstünde`).toBeLessThanOrEqual(navTop + 0.5);
    expect(soonBox?.y ?? 0, `${size.name}: Yakında satırı üst çubuğun altında`).toBeGreaterThanOrEqual(barBottom);
    await expect(soonRow).toContainText("Yakında gelecekler (6)");
    await soonRow.click();
    const soonCards = tasks.locator('[data-state="soon"]');
    await expect(soonCards).toHaveCount(6);
    for (const name of ["Depoya mal geldi", "Depodan mal çıkacak", "Malı başka depoya taşıyacağım", "Rafı sayacağım", "Bir ürün nerede, kaç tane var?", "Yanlış bir şey yaptım"]) {
      const card = soonCards.filter({ hasText: name });
      await expect(card, `${size.name}: ${name}`).toHaveCount(1);
      await expect(card).toBeVisible();
      await expect(card).toContainText("Yakında");
    }
    await soonRow.click();
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
const OUT_T274 = process.env.T274_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-274");
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

/** T-274 H-03/H-04: gerekçe kartı listeye alttan bitişik; saat ikonu boyutu kaydedilir. */
async function expectNoteCard(page: Page, note: string, rowSel: string, where: string, clockSizes: number[] | null): Promise<void> {
  const m = await page.evaluate<{ h: number; b: number; firstTop: number; icon: number }>(`(() => {
    const n = document.querySelector(${JSON.stringify(note)}).getBoundingClientRect();
    const rows = [...document.querySelectorAll(${JSON.stringify(`.task-grid > ${rowSel}`)})].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    const svg = document.querySelector(${JSON.stringify(`${note} svg`)}).getBoundingClientRect();
    return { h: n.height, b: n.bottom, firstTop: Math.min(...rows.map((r) => r.top)), icon: svg.width };
  })()`);
  // H-01 (≤ 160 px) Supervisor kararıyla kaldırıldı: T-270 `emptyRatio ≤ 0,15` önceliklidir; gerekçe kartı boşluğu doldurur (DESIGN_REVIEW §7).
  expect(m.firstTop - m.b, `${where}: gerekçe kartı listeye bitişik (H-04)`).toBeLessThanOrEqual(16);
  if (clockSizes !== null) clockSizes.push(m.icon);
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
    const soonRow = page.locator(".soon-toggle > summary");
    const lockedRow = page.locator(".locked-toggle > summary");

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

      // Üst düğmeler: kapalı, görünür alanda; toplayıcıda yetkisiz işler tek satırda (varsayılan kapalı).
      await expect(soonRow).toContainText("Yakında gelecekler (6)");
      if (isAdmin) await expect(lockedRow).toHaveCount(0);
      else {
        await expect(lockedRow).toContainText("Yetkin olmayan işler (3)");
        await expect(tasks.locator('[data-state="locked"]').first()).toBeHidden();
        await expect(page.locator(".locked-note")).toBeHidden();
      }

      // Dokunma hedefleri ve taşma.
      expect(await smallTargets(page, "body"), `${where}: 48 px altı dokunma hedefi`).toEqual([]);
      const m = await metrics(page);
      expect(m.scrollWidth, `${where}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollHeight, `${where}: sayfa gövdesi kaymaz`).toBeLessThanOrEqual(m.innerHeight);
      await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}.png`) });

      // "Yakında" açık: tam 6 iş, alttan yukarı dolu (boş alan <= %15), kapatma düğmesi başparmağa yakın (alt sekmenin hemen üstü).
      await soonRow.click();
      await expect(soonRow).toContainText("İşlere dön");
      const cards = tasks.locator('[data-state="soon"]');
      await expect(cards).toHaveCount(6);
      for (const card of await cards.all()) {
        await expect(card).toBeVisible();
        await expect(card).toContainText("Yakında");
      }
      await expect(tasks.locator('a[data-state="active"]').first()).toBeHidden();
      const O = await homeLayout(page, ".task-grid > .soon-item > [data-state]");
      expect(O.tiles.length, `${where}: açık listede görünür iş`).toBe(6);
      expect(O.emptyRatio, `${where}: Yakında açıkken boş alan oranı`).toBeLessThanOrEqual(0.15);
      const closeBox = await soonRow.boundingBox();
      expect(O.navTop - ((closeBox?.y ?? 0) + (closeBox?.height ?? 0)), `${where}: kapatma düğmesi alt sekmeye yakın`).toBeLessThanOrEqual(16);
      expect(closeBox?.height ?? 0, `${where}: kapatma düğmesi dokunma yüksekliği`).toBeGreaterThanOrEqual(48);
      for (const t of O.tiles) {
        expect(t.h, `${where}: açık liste satır yüksekliği`).toBeGreaterThanOrEqual(56);
        expect(t.h, `${where}: açık liste satır yüksekliği (kompakt)`).toBeLessThanOrEqual(72);
      }
      const rowFlat = await page.evaluate<string[]>(`[...document.querySelectorAll('.soon-item > [data-state]')].map((e) => getComputedStyle(e).boxShadow)`);
      for (const sh of rowFlat) expect(sh, `${where}: Yakında satırı gölgesiz`).toBe("none");
      await expect(page.locator(".soon-note")).toContainText("Bu iş depo kurulumundan sonra açılacak.");
      await expectNoteCard(page, ".soon-note", ".soon-item", where, clockSizes);
      const titles = await page.evaluate<number[]>(`[...document.querySelectorAll('.soon-item .tile-title')].map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)))`);
      for (const lines of titles) expect(lines, `${where}: Yakında başlığı en çok 2 satır`).toBeLessThanOrEqual(2);
      expect(await smallTargets(page, "body"), `${where}: Yakında listesi 48 px altı hedef`).toEqual([]);
      await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}-yakinda-acik.png`) });
      await soonRow.click();
      await expect(tasks.locator('a[data-state="active"]').first()).toBeVisible();

      // Toplayıcı: yetkisiz işler listesi bir kez gerekçe cümlesi + 3 kompakt iş; kapatma düğmesinde kilit ikonu yok; boş alan <= %15.
      if (!isAdmin) {
        await lockedRow.click();
        await expect(page.locator(".locked-note")).toHaveText("Bu iş için yetkin yok. Sorumluna sorabilirsin.");
        await expectNoteCard(page, ".locked-note", ".locked-item", where, null);
        const lockedCards = tasks.locator('[data-state="locked"]');
        await expect(lockedCards).toHaveCount(3);
        for (const name of ["Ekibimi yönet", "Ayarlar", "Kim ne yaptı?"]) await expect(lockedCards.filter({ hasText: name })).toBeVisible();
        await expect(page.locator(".locked-toggle .row-lock")).toBeHidden();
        const LO = await homeLayout(page, ".task-grid > .locked-item > [data-state]");
        expect(LO.tiles.length, `${where}: açık yetkisiz listede görünür iş`).toBe(3);
        expect(LO.emptyRatio, `${where}: yetkisiz liste açıkken boş alan oranı`).toBeLessThanOrEqual(0.15);
        for (const t of LO.tiles) {
          expect(t.h, `${where}: yetkisiz satır yüksekliği`).toBeGreaterThanOrEqual(56);
          expect(t.h, `${where}: yetkisiz satır yüksekliği (kompakt)`).toBeLessThanOrEqual(72);
        }
        const lockedFlat = await page.evaluate<string[]>(`[...document.querySelectorAll('.locked-item > [data-state]')].map((e) => getComputedStyle(e).boxShadow)`);
        for (const sh of lockedFlat) expect(sh, `${where}: yetkisiz satır gölgesiz`).toBe("none");
        await page.screenshot({ path: path.join(OUT_T270, `final-${tag}-${role.shot}-${size.width}-yetkisiz-acik.png`) });
        await lockedRow.click();
        await expect(lockedCards.first()).toBeHidden();
      }
    }

    if (isAdmin) await itemsScreenChecks(page);

    await page.getByTestId("app-bar-menu").click();
    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
  // H-03: saat ikonu 360/390/430'da tutarlı (rol başına 3 ölçüm; hepsi birbirine ≤ 1 px).
  expect(clockSizes.length, "saat ikonu ölçümleri").toBe(T270_ROLES.length * T270_SIZES.length);
  expect(Math.max(...clockSizes) - Math.min(...clockSizes), `saat ikonu boyutu tutarlı (${clockSizes.join("/")})`).toBeLessThanOrEqual(1);
});

// T-274: Ürünler ekranı telefonda sade: TEK arama alanı (kod/ad/barkod), "Durum" ve "Ara" yok (Gelişmiş altında), açıklama tek satır,
// "Yeni ürün" altta sabit, ilk görünüm kaydırmasız, yatay taşma yok. Ürün bulma akışları z-easy-setup / zz-code-edit'te.
async function itemsScreenChecks(page: Page): Promise<void> {
  mkdirSync(OUT_T274, { recursive: true });
  const tag = test.info().project.name;
  for (const size of T270_SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/t/demo/items");
    await expect(page.getByRole("heading", { level: 1, name: "Ürünler" })).toBeVisible();
    const where = `ürünler ${size.width}x${size.height}`;
    const form = page.getByRole("search", { name: "Ürün ara" });
    // I-01: görünür giriş/seçim/gönder denetimi (Gelişmiş kapalı).
    const controls = await form.evaluate<number>((el: { querySelectorAll: (s: string) => ArrayLike<{ checkVisibility: () => boolean }> }) =>
      Array.from(el.querySelectorAll("input, select, textarea, button[type=submit]")).filter((e) => e.checkVisibility()).length,
    );
    expect(controls, `${where}: görünür arama denetimi (I-01)`).toBe(1);
    await expect(page.getByRole("button", { name: "Ara", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Barkodla ürün bul")).toHaveCount(0);
    await expect(page.getByLabel("Durum")).toBeHidden();
    const geo = await page.evaluate<{ barB: number; navT: number; sB: number; sT: number; cB: number; cT: number; introLines: number }>(`(() => {
      const r = (el) => el.getBoundingClientRect();
      const bar = r(document.querySelector('[data-testid="app-bar"]')), nav = r(document.querySelector('[data-testid="bottom-nav"]'));
      const s = r(document.querySelector('input[type="search"]'));
      const c = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yeni ürün');
      const cb = r(c);
      const intro = document.querySelector('h1').nextElementSibling;
      return { barB: bar.bottom, navT: nav.top, sB: s.bottom, sT: s.top, cB: cb.bottom, cT: cb.top, introLines: Math.round(r(intro).height / parseFloat(getComputedStyle(intro).lineHeight)) };
    })()`);
    expect(geo.sT, `${where}: arama alanı üst çubuğun altında`).toBeGreaterThanOrEqual(geo.barB);
    expect(geo.sB, `${where}: arama alanı görünür alanda (I-02)`).toBeLessThanOrEqual(geo.navT);
    expect(geo.cB, `${where}: Yeni ürün görünür alanda (I-02)`).toBeLessThanOrEqual(geo.navT);
    expect(geo.navT - geo.cB, `${where}: Yeni ürün alt sekmeye yakın (I-03)`).toBeLessThanOrEqual(16);
    expect(geo.cB - geo.cT, `${where}: Yeni ürün yüksekliği`).toBeGreaterThanOrEqual(48);
    expect(geo.introLines, `${where}: açıklama tek satır (I-04)`).toBe(1);
    expect(await smallTargets(page, "body"), `${where}: 48 px altı hedef (I-05)`).toEqual([]);
    const m = await metrics(page);
    expect(m.scrollWidth, `${where}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
    expect(m.scrollHeight, `${where}: sayfa gövdesi kaymaz`).toBeLessThanOrEqual(m.innerHeight);
    await page.screenshot({ path: path.join(OUT_T274, `final-${tag}-items-${size.width}.png`) });
    // Gelişmiş: Durum seçimi burada, değişince sonuç adresi güncellenir (ayrı "Ara" düğmesi yok).
    await page.getByText("Gelişmiş", { exact: true }).click();
    await page.getByLabel("Durum").selectOption("ARCHIVED");
    await expect(page).toHaveURL(/status=ARCHIVED/);
    await expect(page.getByLabel("Durum")).toHaveValue("ARCHIVED");
    await page.screenshot({ path: path.join(OUT_T274, `final-${tag}-items-${size.width}-gelismis.png`) });
  }
}
