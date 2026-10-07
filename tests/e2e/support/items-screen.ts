// T-279: ekran ölçümü yardımcıları ve Ürünler ekranı denetimleri (T-254/T-270/T-274; mobile-shell.spec.ts ve empty-tenant.spec.ts ortak).
// Değerler/assertion'lar mobile-shell.spec.ts'ten TAŞINDI; ürünler ekranı denetimi iki kiracı durumuna ayrıldı (bkz. itemsScreenChecks).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

export const OUT_T274 = process.env.T274_OUT ?? path.resolve(import.meta.dirname, "../../../.artifacts/t-274");
export const T270_SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

export interface Metrics {
  readonly scrollHeight: number;
  readonly innerHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

export async function metrics(page: Page): Promise<Metrics> {
  // Dize ifadesi: kök tsconfig'de DOM tipleri yok (lib: ES2023); ifade tarayıcıda çalışır.
  return page.evaluate<Metrics>(
    "({ scrollHeight: document.scrollingElement.scrollHeight, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })",
  );
}

/** Görünür etkileşimli öğelerin (bağlantı, düğme, odaklanabilir kart) 48x48 altında kalanları. */
export async function smallTargets(page: Page, scope: string): Promise<string[]> {
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

/**
 * T-274 B-02 (DESIGN_REVIEW §7.3): içerik ya da etkileşimli öğe içermeyen en büyük dikey bant. Alan: ana içerik alanı (üst çubuk altı – alt sekme
 * üstü); `panel` verilirse (alt sayfa açık) yalnız o kutu (kararmış zemin sayılmaz). İçerik öğesi: etkileşimli öğe (kutusu), metin düğümü
 * (metnin kendi kutusu), svg simgesi. Kenarlıklı/boyalı kutular tek başına içerik sayılmaz.
 */
export async function expectBand(page: Page, where: string, panel: string | null): Promise<number> {
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
  expect(max, `${where}: en büyük boş dikey bant (B-02)`).toBeLessThanOrEqual(120);
  return max;
}

/** T-274 B-04: genişleyen denetimde görünür şevron: sağda, ≥ 48 px yükseklik; açılınca döner (aynı dönüş). */
export async function chevronInfo(page: Page, control: string): Promise<{ h: number; rightGap: number; rotated: boolean }> {
  return page.evaluate<{ h: number; rightGap: number; rotated: boolean }>(`(() => {
    const el = document.querySelector(${JSON.stringify(control)});
    const svg = el.querySelector(':scope > svg:last-of-type');
    const a = el.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return { h: a.height, rightGap: a.right - b.right, rotated: getComputedStyle(svg).transform !== 'none' || (getComputedStyle(svg).rotate !== 'none' && getComputedStyle(svg).rotate !== '0deg') };
  })()`);
}

// T-274: Ürünler ekranı telefonda sade (DESIGN_REVIEW §7, §7.3): TEK arama alanı (büyüteç, örnek metin, tek satır ipucu), "Durum" Gelişmiş altında
// (şevronlu), açıklama tek satır, "Yeni ürün" altta sabit tek dolu eylem, ürün yokken ÖĞRETEN boş durum + eylem gibi okunan kurulum satırı.
// Ürün bulma akışları z-easy-setup / zz-code-edit'te.
// T-279: demo tenant dolu açılır (T-223); bu yüzden iki kiracı durumu ayrı denetlenir. `empty: true` (empty-tenant.spec.ts: depo/ürün yok) = S-01 + B-03
// boş durum ölçütlerinin AYNEN eski halidir; `empty: false` (demo: depo, lokasyon, ürün var) = kurulum satırı/adımları yok + ürün listesi var.
export interface ItemsTenant {
  readonly slug: string;
  readonly empty: boolean;
}

export async function itemsScreenChecks(page: Page, tenant: ItemsTenant): Promise<void> {
  const base = `/t/${tenant.slug}`;
  mkdirSync(OUT_T274, { recursive: true });
  const tag = test.info().project.name;
  for (const size of T270_SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`${base}/items`);
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
    if (tenant.empty) {
      // S-01 + B-03: ürün yok, kurulum tamam değil: eylem gibi okunan satır + ÖĞRETEN sıralı liste; tek dolu denetim "Yeni ürün".
      const row = page.getByTestId("setup-row");
      await expect(row, `${where}: kurulum satırı (S-01)`).toHaveText("Önce depo ekle · 1. adım / 3");
      await expect(row).toHaveAttribute("href", `${base}/warehouses?new=1`);
      const rc = await row.evaluate<{ h: number; chevronRight: boolean }>((el: { getBoundingClientRect: () => { right: number; height: number }; querySelector: (s: string) => { getBoundingClientRect: () => { right: number } } | null }) => ({
        h: el.getBoundingClientRect().height,
        chevronRight: el.getBoundingClientRect().right - (el.querySelector("svg")?.getBoundingClientRect().right ?? 0) <= 16,
      }));
      expect(rc.h, `${where}: kurulum satırı yüksekliği`).toBeGreaterThanOrEqual(48);
      expect(rc.chevronRight, `${where}: kurulum satırında sağda şevron (S-01)`).toBe(true);
      const steps = page.getByTestId("setup-steps");
      await expect(steps.locator("ol > li"), `${where}: sıralı adımlar (B-03)`).toHaveCount(3);
      await expect(steps.locator("ol a[href]").first(), `${where}: ikincil metin bağlantısı (B-03)`).toBeVisible();
    } else {
      // Demo (dolu tenant): kurulum tamam → kurulum satırı ve öğreten adımlar YOK; ürün listesi görünür (eski boş-durum ölçütlerinin tersi, aynı kapı: isSetupComplete).
      await expect(page.getByTestId("setup-row"), `${where}: kurulum tamam, kurulum satırı yok (S-01)`).toHaveCount(0);
      await expect(page.getByTestId("setup-steps"), `${where}: kurulum tamam, öğreten adımlar yok (B-03)`).toHaveCount(0);
      const rows = page.getByRole("link", { name: /^Ayrıntıyı aç: / });
      expect(await rows.count(), `${where}: demo ürün satırları görünür`).toBeGreaterThanOrEqual(3);
      await expect(rows.first(), `${where}: ürün satırı görünür`).toBeVisible();
      expect((await rows.first().boundingBox())?.height ?? 0, `${where}: ürün satırı yüksekliği`).toBeGreaterThanOrEqual(48);
    }
    const filled = await page.evaluate<string[]>(`(() => {
      const cta = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yeni ürün');
      const accent = getComputedStyle(cta).backgroundColor;
      return [...document.querySelectorAll('a[href], button')].filter((e) => e.checkVisibility() && getComputedStyle(e).backgroundColor === accent).map((e) => e.textContent.trim());
    })()`);
    expect(filled, `${where}: tek dolu birincil eylem (B-03/N-01)`).toEqual(["Yeni ürün"]);
    // B-02: ürün yok durumunda en büyük boş bant ≤ 120 px.
    await expectBand(page, tenant.empty ? `${where}: ürün yok` : `${where}: ürün listesi`, null);
    // Sabit çubuğun altında içerik kalmaz.
    await page.locator(".tenant-body").evaluate((el: { scrollTop: number; scrollHeight: number }) => {
      el.scrollTop = el.scrollHeight;
    });
    const tail = await page.evaluate<{ contentBottom: number; ctaTop: number }>(`(() => {
      const c = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yeni ürün').getBoundingClientRect();
      const rows = ${tenant.empty ? "[document.querySelector('[data-testid=\"setup-steps\"]')]" : "[...document.querySelectorAll('.tenant-body li')]"};
      const last = rows[rows.length - 1].getBoundingClientRect();
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
  // S-01: satıra dokunmak doğrudan sıradaki adıma (depo ekleme) götürür (yalnız kurulumu tamamlanmamış kiracıda satır vardır).
  if (tenant.empty) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/items`);
    await page.getByTestId("setup-row").click();
    await expect(page).toHaveURL(new RegExp(`/t/${tenant.slug}/warehouses`));
  }
  await page.goto(base); // depo formu açık kalmasın (çıkış menüsü önde)
}
