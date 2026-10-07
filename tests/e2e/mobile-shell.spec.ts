// T-254: cihaza uyumlu kabuk. Telefonda (iPhone 13 profili 390x664 ve 390x844, 360x740) ana ekran tek ekrandır: sayfa kaymaz,
// yatay taşma yok, üst çubuk <= 56 px, dokunma hedefleri >= 48 px, Akış/Kokpit ve Çıkış menüden erişilir. Masaüstünde (1280x800)
// eski kök üst bar korunur, telefon üst çubuğu ve alt sekme çubuğu görünmez. Piksel karşılaştırma yok: ölçülen yerleşim değerleri.
// Tek demo girişi (demo girişi hız sınırlıdır). Ekran görüntüleri `.artifacts/t-254/` altına yazılır (git'e girmez).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const OUT = process.env.T254_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-254");
const PHONES = [
  { name: "iphone13", width: 390, height: 664 }, // Playwright "iPhone 13" cihaz profili (Safari araç çubukları dahil görünür alan)
  { name: "iphone13-tam", width: 390, height: 844 }, // standalone / tam ekran
  { name: "android-360", width: 360, height: 740 },
  { name: "android-430", width: 430, height: 932 }, // T-313: 6 etkin iş (2 sütun) için büyük telefon da kaydırmasız sınanır
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
    await expect(tasks.locator('[data-state="active"]')).toHaveCount(6);
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(5);
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

    // T-270 (Supervisor kararı: kasıtlı şartname değişikliği): 6 etkin döşeme (T-313: "Depoya mal geldi" etkinleşti) kaydırmadan görünür alanda, üst çubuk ile alt sekme
    // çubuğu arasında (kutu sınırı assertion'ları aynı). 6 "Yakında" iş ızgarada döşeme değil, tek satırlık düğmenin arkasındadır:
    // düğme görünür alanda; dokununca tam 6 iş adı + "Yakında" listelenir (toplam 11 iş erişilebilir).
    const barBottom = (await bar.boundingBox())?.y ?? 0;
    const navTop = (await page.getByTestId("bottom-nav").boundingBox())?.y ?? 0;
    const cards = tasks.locator('[data-state="active"]');
    expect(await cards.count()).toBe(6);
    for (let i = 0; i < 6; i++) {
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
    await expect(soonRow).toContainText("Yakında gelecekler (5)");
    await soonRow.click();
    // T-274: açık liste alt sayfadır (diyalog); aynı 6 iş ve aynı içerik.
    const soonCards = page.getByRole("dialog").locator('[data-state="soon"]');
    await expect(soonCards).toHaveCount(5);
    for (const name of ["Depodan mal çıkacak", "Malı başka depoya taşıyacağım", "Rafı sayacağım", "Bir ürün nerede, kaç tane var?", "Yanlış bir şey yaptım"]) {
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
    for (const sel of ['.locked-note', '.soon-note', '.my-tasks-row', '.now-card[data-state="rows"]']) { const n = document.querySelector(sel); if (n && visible(n)) parts.push(box(n)); }
    const topY = bar.b, bottom = nav.y;
    const spans = parts.map((p) => [Math.max(p.y, topY), Math.min(p.b, bottom)]).sort((a, b) => a[0] - b[0]);
    let covered = 0, cur = null;
    for (const [s, e] of spans) { if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e); else { if (cur) covered += cur[1] - cur[0]; cur = [s, e]; } }
    if (cur) covered += cur[1] - cur[0];
    const all = [...tiles, ...(top && visible(top) ? [box(top)] : [])];
    return { tiles: tiles.map((t) => ({ href: t.href, x: t.x, y: t.y, w: t.w, h: t.h })), navTop: nav.y, areaTop: topY, emptyRatio: (bottom - topY - covered) / (bottom - topY), lastBottom: Math.max(...all.map((p) => p.b)) };
  })()`);
}

/**
 * T-274 B-02 (DESIGN_REVIEW §7.3): içerik ya da etkileşimli öğe içermeyen en büyük dikey bant. Alan: ana içerik alanı (üst çubuk altı – alt sekme
 * üstü); `panel` verilirse (alt sayfa açık) yalnız o kutu (kararmış zemin sayılmaz). İçerik öğesi: etkileşimli öğe (kutusu), metin düğümü
 * (metnin kendi kutusu), svg simgesi. Kenarlıklı/boyalı kutular tek başına içerik sayılmaz.
 */
async function expectBand(page: Page, where: string, panel: string | null, assertBand = true): Promise<number> {
  const max = await page.evaluate<number>(`(() => {
    const r = (el) => el.getBoundingClientRect();
    const bar = r(document.querySelector('[data-testid="app-bar"]')), nav = r(document.querySelector('[data-testid="bottom-nav"]'));
    const root = ${panel === null ? "document.body" : `document.querySelector(${JSON.stringify(panel)})`};
    const area = ${panel === null ? "{ top: bar.bottom, bottom: nav.top }" : `(() => { const b = r(root); return { top: b.top, bottom: b.bottom }; })()`};
    const spans = [];
    const add = (b) => { if (b.width > 0 && b.height > 0) spans.push([Math.max(b.top, area.top), Math.min(b.bottom, area.bottom)]); };
    const isVisible = (el) => el.checkVisibility && el.checkVisibility();
    for (const el of root.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      if (el.matches('a[href], button, summary, input, select, textarea, [tabindex="0"]')) { add(r(el)); continue; }
      if (el.tagName.toLowerCase() === 'svg') { add(r(el)); continue; }
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim() !== '') { const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) add(q); }
      }
    }
    const iv = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let cursor = area.top, best = 0;
    for (const [a, b] of iv) { best = Math.max(best, a - cursor); cursor = Math.max(cursor, b); }
    best = Math.max(best, area.bottom - cursor);
    return best;
  })()`);
  // T-280 (DESIGN_REVIEW §7.4.1): "bekleyen iş yok" durumunda 2 sütun ana ekranda boşluk dürüstçe ÖLÇÜLÜR ve kaydedilir, assert edilmez (assertBand=false).
  if (assertBand) expect(max, `${where}: en büyük boş dikey bant (B-02)`).toBeLessThanOrEqual(120);
  return max;
}

/** T-274 B-04: genişleyen denetimde görünür şevron: sağda, ≥ 48 px yükseklik; açılınca döner (aynı dönüş). */
async function chevronInfo(page: Page, control: string): Promise<{ h: number; rightGap: number; rotated: boolean }> {
  return page.evaluate<{ h: number; rightGap: number; rotated: boolean }>(`(() => {
    const el = document.querySelector(${JSON.stringify(control)});
    const svg = el.querySelector(':scope > svg:last-of-type');
    const a = el.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return { h: a.height, rightGap: a.right - b.right, rotated: getComputedStyle(svg).transform !== 'none' || (getComputedStyle(svg).rotate !== 'none' && getComputedStyle(svg).rotate !== '0deg') };
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
  const zeroState: Array<Record<string, unknown>> = [];
  for (const role of T270_ROLES) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: `${role.label} olarak gir` }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    const tasks = page.getByRole("list", { name: "İşler" });
    const isAdmin = role.shot === "admin";
    const activeCount = isAdmin ? 6 : 3; // toplayıcı: Depoya mal geldi (stock.post, T-313) + Depo ve raflar + Ürünlerim izinli; 3 yönetim işi yetkisiz
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
      // T-313 (DESIGN_REVIEW §7.4): ≤5 izinli iş tek sütun, ≥6 eşit 2 sütun; tek sayıda iş varsa en üstteki son döşeme tam genişlik (yetim değil).
      // İki kipte de aynı güçte: eşit boyut (±2 px), 88-140 px, alt yaslı ≤ 16 px, boş alan ≤ %15, ilk iş en alt satırda.
      const twoCol = activeCount >= 6;
      const perRow = new Map<number, number>();
      for (const t of L.tiles) perRow.set(Math.round(t.y), (perRow.get(Math.round(t.y)) ?? 0) + 1);
      const orphanRows = twoCol ? [...perRow.entries()].filter(([, n]) => n === 1).map(([y]) => y) : [];
      expect(new Set(L.tiles.filter((t) => !orphanRows.includes(Math.round(t.y))).map((t) => Math.round(t.x))).size, `${where}: sütun sayısı`).toBe(twoCol ? 2 : 1);
      if (twoCol) {
        expect(orphanRows.length, `${where}: tek döşemeli satır sayısı (tek sayıda iş → 1, çift → 0)`).toBe(L.tiles.length % 2);
        for (const y of orphanRows) {
          const o = L.tiles.find((t) => Math.round(t.y) === y);
          const regularW = Math.max(...L.tiles.filter((t) => Math.round(t.y) !== y).map((t) => t.w));
          expect(o?.w ?? 0, `${where}: tek döşeme tam genişlik`).toBeGreaterThan(regularW * 1.9);
          expect(y, `${where}: tek döşeme en üst satırda`).toBe(Math.min(...L.tiles.map((t) => Math.round(t.y))));
        }
      }
      const regular = L.tiles.filter((t) => !orphanRows.includes(Math.round(t.y)));
      const ws = regular.map((t) => t.w);
      const hs = L.tiles.map((t) => t.h);
      expect(Math.max(...ws) - Math.min(...ws), `${where}: genişlik farkı`).toBeLessThanOrEqual(2);
      expect(Math.max(...hs) - Math.min(...hs), `${where}: yükseklik farkı`).toBeLessThanOrEqual(2);
      expect(Math.min(...hs), `${where}: en küçük döşeme yüksekliği`).toBeGreaterThanOrEqual(88);
      // D-04 SIKI (DESIGN_REVIEW §7.4.1, T-280): her iki kipte döşeme ≤ 140 px, İSTİSNA YOK. 2 sütunda ayrıca: ikon boyutu tüm döşemelerde eşit ve sabit (3 rem),
      // açıklama TEK satır ve KESİLMEMİŞ (scrollWidth ≤ clientWidth), D-04b: döşeme içi dikey boşluk ≤ 24 px (iç yükseklik = yükseklik − kenarlık 2×2 − dolgu 2×12).
      expect(Math.max(...hs), `${where}: en büyük döşeme yüksekliği (≤ 140, istisna yok)`).toBeLessThanOrEqual(140);
      if (twoCol) {
        const inside = await page.evaluate<Array<{ h: number; blank: number; badge: number; descLines: number; descCut: boolean; titleLines: number; label: string }>>(`[...document.querySelectorAll('.task-grid > .task-item > [data-state]')].filter((t) => t.getBoundingClientRect().height > 0).map((t) => {
          const r = (e) => e.getBoundingClientRect();
          const h = r(t).height;
          const blocks = [...t.querySelectorAll('.tile-badge, .tile-title, .tile-desc')].map((e) => r(e).height);
          const desc = t.querySelector('.tile-desc'), title = t.querySelector('.tile-title'), badge = t.querySelector('.tile-badge');
          const lines = (e) => Math.round(r(e).height / parseFloat(getComputedStyle(e).lineHeight));
          return { h, blank: h - 4 - 24 - blocks.reduce((a, b) => a + b, 0), badge: Math.round(r(badge).width * 10) / 10, descLines: desc ? lines(desc) : 0, descCut: desc ? desc.scrollWidth > desc.clientWidth + 0.5 : true, titleLines: lines(title), label: title.textContent || '' };
        })`);
        expect(new Set(inside.map((x) => x.badge)).size, `${where}: ikon boyutu tüm döşemelerde eşit`).toBe(1);
        expect(inside[0]?.badge, `${where}: ikon boyutu sabit (48 px)`).toBe(48);
        for (const tile of inside) {
          expect(tile.descLines, `${where}: ${tile.label} açıklaması tek satır`).toBe(1);
          expect(tile.descCut, `${where}: ${tile.label} açıklaması kesilmemiş`).toBe(false);
          expect(tile.titleLines, `${where}: ${tile.label} başlığı ≤ 2 satır (D-09)`).toBeLessThanOrEqual(2);
          expect(tile.blank, `${where}: ${tile.label} döşeme içi dikey boşluk (D-04b, ${Math.round(tile.h)} px döşeme)`).toBeLessThanOrEqual(24);
          expect(tile.blank, `${where}: ${tile.label} içerik döşemeye sığıyor (taşma yok)`).toBeGreaterThanOrEqual(-1);
        }
      }

      // Başparmak bölgesi: ızgara alt sekmeye yaslı (<= 16 px), boş dikey alan <= %15, ilk iş en alt satırda.
      // T-280: 2 sütunda "bekleyen iş yok" durumunda (Şimdi kartı gerçek veri satırı içermez) emptyRatio ve B-02 ÖLÇÜLÜR + kaydedilir, assert edilmez.
      const gridBottom = Math.max(...L.tiles.map((t) => t.y + t.h));
      expect(L.navTop - gridBottom, `${where}: ızgara alt kenarı ile alt sekme arası`).toBeLessThanOrEqual(16);
      const nowState = twoCol ? await page.getByTestId("now-card").getAttribute("data-state") : null;
      const honestEmpty = twoCol && nowState !== "rows";
      if (twoCol) expect(nowState, `${where}: Şimdi kartı çizilir (stock.post)`).not.toBeNull();
      if (nowState === "empty") await expect(page.getByTestId("now-empty"), `${where}: bekleyen iş yok satırı`).toHaveText("Bekleyen iş yok");
      if (honestEmpty) zeroState.push({ where, emptyRatio: Math.round(L.emptyRatio * 1000) / 1000, nowState });
      else expect(L.emptyRatio, `${where}: boş dikey alan oranı`).toBeLessThanOrEqual(0.15);
      expect(L.tiles[0]?.y, `${where}: ilk (en öncelikli) döşeme en alt satırda`).toBe(Math.max(...L.tiles.map((t) => t.y)));

      // Sıra: saha işleri (depo, ürün) yönetim işlerinden önce; ilk döşeme saha işi.
      const hrefs = L.tiles.map((t) => t.href);
      const idx = (suffix: string) => hrefs.findIndex((h) => h.endsWith(suffix));
      const field = [idx("/warehouses"), idx("/items")].filter((i) => i >= 0);
      const admin = [idx("/audit"), idx("/members"), idx("/settings")].filter((i) => i >= 0);
      expect(field.length, `${where}: saha işleri görünür`).toBe(2);
      if (admin.length > 0) expect(Math.max(...field), `${where}: saha işleri yönetimden önce`).toBeLessThan(Math.min(...admin));
      expect(hrefs[0], `${where}: ilk döşeme saha işi`).toMatch(/\/(warehouses|items|field\/receive)$/); // T-313: "Depoya mal geldi" (saha işi, TASKS sırasında ilk) etkinleşti; niyet aynı: ilk döşeme saha işi

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
      await expect(soonRow).toContainText("Yakında gelecekler (5)");
      if (isAdmin) await expect(lockedRow).toHaveCount(0);
      else {
        await expect(lockedRow).toContainText("Yetkin olmayan işler (3)");
        await expect(tasks.locator('[data-state="locked"]').first()).toBeHidden();
      }
      await expect(page.getByRole("dialog")).toBeHidden();
      // B-02 (kapalı ana ekran): en büyük boş dikey bant ≤ 120 px; B-04: şevron sağda, ≥ 48 px, kapalıyken dönmemiş.
      const band = await expectBand(page, `${where}: kapalı ana ekran`, null, !honestEmpty);
      if (honestEmpty) zeroState.push({ where, band });
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
      const soonIcon = await expectSheet(page, `${where}: Yakında`, 5);
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

    if (isAdmin) await itemsScreenChecks(page);

    await page.getByTestId("app-bar-menu").click();
    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
  // T-280: "bekleyen iş yok" durumunda ölçülen (assert edilmeyen) boşluk değerleri raporlanır.
  writeFileSync(path.join(OUT_T270, `metrics-home-zero-state-${tag}.json`), JSON.stringify(zeroState, null, 2));
  // H-03: saat ikonu 360/390/430'da tutarlı (rol başına 3 ölçüm; hepsi birbirine ≤ 1 px).
  expect(clockSizes.length, "saat ikonu ölçümleri").toBe(T270_ROLES.length * T270_SIZES.length);
  expect(Math.max(...clockSizes) - Math.min(...clockSizes), `saat ikonu boyutu tutarlı (${clockSizes.join("/")})`).toBeLessThanOrEqual(1);
});

// T-274: Ürünler ekranı telefonda sade (DESIGN_REVIEW §7, §7.3): TEK arama alanı (büyüteç, örnek metin, tek satır ipucu), "Durum" Gelişmiş altında
// (şevronlu), açıklama tek satır, "Yeni ürün" altta sabit tek dolu eylem, ürün yokken ÖĞRETEN boş durum + eylem gibi okunan kurulum satırı.
// Ürün bulma akışları z-easy-setup / zz-code-edit'te.
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
    // B-05: büyüteç solda, ipucu tek satır (barkod yalnız ipucunda bir kez), örnek metin yalnız gerçek örnekler.
    const box = page.getByRole("searchbox", { name: "Ürün ara" });
    await expect(box, `${where}: örnek metin (B-05)`).toHaveAttribute("placeholder", "Örn. URN-0001 ya da Koli 40x30");
    const sb = await page.evaluate<{ iconInside: boolean; iconLeft: number; hintLines: number; hint: string }>(`(() => {
      const input = document.querySelector('form[role="search"] input[type="search"]');
      const ir = input.getBoundingClientRect();
      const svg = input.parentElement.querySelector('svg').getBoundingClientRect();
      const hint = input.closest('div.relative').previousElementSibling;
      return { iconInside: svg.left >= ir.left && svg.right <= ir.right && svg.top >= ir.top && svg.bottom <= ir.bottom, iconLeft: svg.left - ir.left, hintLines: Math.round(hint.getBoundingClientRect().height / parseFloat(getComputedStyle(hint).lineHeight)), hint: hint.textContent };
    })()`);
    expect(sb.iconInside && sb.iconLeft <= 24, `${where}: büyüteç alanın solunda (B-05)`).toBe(true);
    expect(sb.hintLines, `${where}: ipucu tek satır (B-05)`).toBe(1);
    expect(sb.hint.match(/barkod/gi)?.length, `${where}: barkod ipucunda bir kez (B-05)`).toBe(1);
    expect(sb.hint).toContain("barkodu okutabilirsin");
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
    // S-01 + B-03: ürün yok, kurulum tamam değil: eylem gibi okunan satır + ÖĞRETEN sıralı liste; tek dolu denetim "Yeni ürün".
    const row = page.getByTestId("setup-row");
    await expect(row, `${where}: kurulum satırı (S-01)`).toHaveText("Önce depo ekle · 1. adım / 3");
    await expect(row).toHaveAttribute("href", "/t/demo/warehouses?new=1");
    const rc = await row.evaluate<{ h: number; chevronRight: boolean }>((el: { getBoundingClientRect: () => { right: number; height: number }; querySelector: (s: string) => { getBoundingClientRect: () => { right: number } } | null }) => ({
      h: el.getBoundingClientRect().height,
      chevronRight: el.getBoundingClientRect().right - (el.querySelector("svg")?.getBoundingClientRect().right ?? 0) <= 16,
    }));
    expect(rc.h, `${where}: kurulum satırı yüksekliği`).toBeGreaterThanOrEqual(48);
    expect(rc.chevronRight, `${where}: kurulum satırında sağda şevron (S-01)`).toBe(true);
    const steps = page.getByTestId("setup-steps");
    await expect(steps.locator("ol > li"), `${where}: sıralı adımlar (B-03)`).toHaveCount(3);
    await expect(steps.locator("ol a[href]").first(), `${where}: ikincil metin bağlantısı (B-03)`).toBeVisible();
    const filled = await page.evaluate<string[]>(`(() => {
      const cta = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yeni ürün');
      const accent = getComputedStyle(cta).backgroundColor;
      return [...document.querySelectorAll('a[href], button')].filter((e) => e.checkVisibility() && getComputedStyle(e).backgroundColor === accent).map((e) => e.textContent.trim());
    })()`);
    expect(filled, `${where}: tek dolu birincil eylem (B-03/N-01)`).toEqual(["Yeni ürün"]);
    // B-02: ürün yok durumunda en büyük boş bant ≤ 120 px.
    await expectBand(page, `${where}: ürün yok`, null);
    // Sabit çubuğun altında içerik kalmaz.
    await page.locator(".tenant-body").evaluate((el: { scrollTop: number; scrollHeight: number }) => {
      el.scrollTop = el.scrollHeight;
    });
    const tail = await page.evaluate<{ contentBottom: number; ctaTop: number }>(`(() => {
      const c = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yeni ürün').getBoundingClientRect();
      const last = document.querySelector('[data-testid="setup-steps"]').getBoundingClientRect();
      return { contentBottom: last.bottom, ctaTop: c.top };
    })()`);
    expect(tail.contentBottom, `${where}: içerik sabit çubuğun altında kalmaz`).toBeLessThanOrEqual(tail.ctaTop + 1);
    await page.locator(".tenant-body").evaluate((el: { scrollTop: number }) => {
      el.scrollTop = 0;
    });
    expect(await smallTargets(page, "body"), `${where}: 48 px altı hedef (I-05)`).toEqual([]);
    const m = await metrics(page);
    expect(m.scrollWidth, `${where}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
    expect(m.scrollHeight, `${where}: sayfa gövdesi kaymaz`).toBeLessThanOrEqual(m.innerHeight);
    await page.screenshot({ path: path.join(OUT_T274, `final-${tag}-items-${size.width}.png`) });
    // B-04: Gelişmiş şevronlu, açılınca döner. Durum burada; değişince sonuç adresi güncellenir (ayrı "Ara" düğmesi yok).
    const adv = await chevronInfo(page, "form[role=search] details summary");
    expect(adv.h, `${where}: Gelişmiş yüksekliği (B-04)`).toBeGreaterThanOrEqual(48);
    expect(adv.rightGap, `${where}: Gelişmiş şevronu sağda (B-04)`).toBeLessThanOrEqual(16);
    expect(adv.rotated).toBe(false);
    await page.getByText("Gelişmiş", { exact: true }).click();
    await expect.poll(async () => (await chevronInfo(page, "form[role=search] details summary")).rotated, { message: `${where}: şevron açılınca döner (B-04)` }).toBe(true);
    await page.getByLabel("Durum").selectOption("ARCHIVED");
    await expect(page).toHaveURL(/status=ARCHIVED/);
    await expect(page.getByLabel("Durum")).toHaveValue("ARCHIVED");
    // T-01: yalnız filtre ile arama sonuçsuz: filtreye özgü ileti; "Aramayı temizle" arama alanıyla sol kenarda hizalı.
    await expect(page.getByText("Bu filtreye uyan ürün yok")).toBeVisible();
    const clear = page.getByRole("link", { name: "Aramayı temizle" });
    const lx = (await clear.boundingBox())?.x ?? -99;
    const fx = (await box.boundingBox())?.x ?? 99;
    expect(Math.abs(lx - fx), `${where}: "Aramayı temizle" sol kenarı hizalı (T-01)`).toBeLessThanOrEqual(2);
    await page.screenshot({ path: path.join(OUT_T274, `final-${tag}-items-${size.width}-gelismis.png`) });
  }
  // S-01: satıra dokunmak doğrudan sıradaki adıma (depo ekleme) götürür.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/t/demo/items");
  await page.getByTestId("setup-row").click();
  await expect(page).toHaveURL(/\/t\/demo\/warehouses/);
  await page.goto("/t/demo"); // depo formu açık kalmasın (çıkış menüsü önde)
}
