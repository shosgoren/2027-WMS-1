// T-289: açılış verisi içe aktarma — şablon indirme, hatalı dosyada satır satır önizleme, düzeltilmiş dosyayla içe aktarma (ürün + açılış stoku),
// aynı dosyayı ikinci kez yükleme (ek hareket yok), klavye yolu, yetkisiz kullanıcı. Demo tenant (demo yönetici: MFA kapalı, A-38) üzerinde koşar;
// her koşu benzersiz kod önekiyle yalnız KENDİ ürünlerini ve demo rafı A3-G03/A3-G04'e kendi stokunu ekler (demo tohumu bu ürünlere dokunmaz).
// Ekran görüntüleri ve ölçümler `.artifacts/t-289/` altına yazılır (git'e girmez); ölçütler `docs/tasks/T-289.md` "Ekran tasarım rubriği" ile aynıdır.
// Dosya içeriği sentetiktir (G-09); sayfa DOM sorguları dize ifadesidir (kök tsconfig'de DOM tipleri yok).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const OUT = path.resolve(import.meta.dirname, "../../.artifacts/t-289");
const PHONE_SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;
const DESKTOP_SIZES = [{ width: 1280, height: 800 }] as const;

interface Metrics {
  readonly overflowX: boolean;
  readonly smallTargets: readonly { n: string; w: number; h: number }[];
  readonly tightPairs: readonly string[];
  readonly filledButtons: number;
  readonly largestGapPx: number;
  readonly rawCodeText: readonly string[];
  readonly mainWidth: number;
  readonly clippedText: readonly string[];
}

/** Sayfa ölçümleri (rubrik İ-01, İ-03, İ-04, İ-09, İ-11, İ-12): dize ifadesi, tarayıcıda çalışır. */
const MEASURE = `(() => {
  const main = document.querySelector('main');
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const interactive = [...main.querySelectorAll('a[href],button,input,select,textarea,summary')].filter(vis);
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 30);
  const rect = (el) => el.getBoundingClientRect();
  const smallTargets = interactive.map((el) => ({ n: name(el), w: Math.round(rect(el).width), h: Math.round(rect(el).height) })).filter((x) => x.w < 47.5 || x.h < 47.5);
  const tightPairs = [];
  for (let i = 0; i < interactive.length; i++) for (let j = i + 1; j < interactive.length; j++) {
    const a = rect(interactive[i]); const b = rect(interactive[j]);
    const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right)); const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    if (Math.hypot(dx, dy) < 8 && !interactive[i].contains(interactive[j]) && !interactive[j].contains(interactive[i])) tightPairs.push(name(interactive[i]) + ' | ' + name(interactive[j]));
  }
  const filled = [...main.querySelectorAll('[data-variant="primary"]')].filter(vis).length;
  // En büyük içeriksiz dikey bant: metin düğümü, etkileşimli öğe ya da svg taşıyan öğelerin birleşik aralıkları arasındaki en geniş boşluk.
  const boxes = [];
  for (const el of main.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    const kind = el.matches('svg,img,progress,input,button,a[href],select,textarea');
    if (!own && !kind) continue;
    const r = rect(el); boxes.push([r.top + scrollY, r.bottom + scrollY]);
  }
  boxes.sort((x, y) => x[0] - y[0]);
  let gap = 0; let end = boxes.length ? boxes[0][1] : 0;
  for (const [s, e] of boxes) { if (s - end > gap) gap = s - end; if (e > end) end = e; }
  const text = main.innerText;
  const rawCodeText = (text.match(/[A-Z_]{6,}|Error:|SQLSTATE|undefined|null/g) || []);
  const clippedText = [...main.querySelectorAll('h1,h2,p,span,li,label')].filter(vis).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').map(name);
  return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, smallTargets, tightPairs, filledButtons: filled, largestGapPx: Math.round(gap), rawCodeText, mainWidth: Math.round(rect(main).width), clippedText };
})()`;

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate<Metrics>(MEASURE);
}

async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
}

const csv = (rows: string[]): { name: string; mimeType: string; buffer: Buffer } => ({ name: "dosya.csv", mimeType: "text/csv", buffer: Buffer.from(`﻿${rows.join("\r\n")}\r\n`, "utf8") });
const PRODUCT_HEADER = "kod;ad;temel birim;koli içi adet;adet barkodu;koli barkodu";
const STOCK_HEADER = "ürün kodu;raf kodu;miktar (adet)";

test.describe("açılış verisi içe aktarma (T-289)", () => {
  test("şablon, hatalı önizleme, içe aktarma, tekrar yükleme, klavye yolu", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const project = testInfo.project.name;
    const sizes = project === "desktop" ? DESKTOP_SIZES : PHONE_SIZES;
    const p = `T289-${Date.now()}${project === "desktop" ? "D" : "M"}`;
    const metrics: Record<string, Metrics> = {};
    const home = page.viewportSize() ?? sizes[0];

    /** Her boyutta ölçüm + iki ekran görüntüsü (kullanıcının gördüğü görünüm ve tam sayfa); sonunda ilk boyuta dönülür. */
    async function capture(state: string, scrollTo?: string): Promise<void> {
      for (const size of sizes) {
        await page.setViewportSize(size);
        if (scrollTo !== undefined) await page.getByTestId(scrollTo).scrollIntoViewIfNeeded();
        const key = `${state}-${size.width}`;
        const m = await measure(page);
        metrics[key] = m;
        expect(m.overflowX, `${key}: yatay taşma`).toBe(false);
        expect(m.smallTargets, `${key}: küçük dokunma hedefi`).toEqual([]);
        expect(m.tightPairs, `${key}: sıkışık komşu hedefler`).toEqual([]);
        expect(m.filledButtons, `${key}: dolu birincil düğme`).toBeLessThanOrEqual(1);
        expect(m.rawCodeText, `${key}: ham teknik metin`).toEqual([]);
        expect(m.clippedText, `${key}: kesilen metin`).toEqual([]);
        await page.screenshot({ path: path.join(OUT, `${project}-${state}-${size.width}-view.png`) });
        await page.screenshot({ path: path.join(OUT, `${project}-${state}-${size.width}-full.png`), fullPage: true });
      }
      await page.setViewportSize(sizes[0]);
    }

    await loginAdmin(page);
    await page.goto("/t/demo/settings");
    await page.getByRole("link", { name: "Ürün ve stoku Excel'den içe aktar" }).click();
    await expect(page).toHaveURL(/\/t\/demo\/import$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ürün ve stok içe aktar" })).toBeVisible();

    // (a) Boş açılış: sıralı 5 adım, geçilmemiş adımların eylemi yok, dolu düğme yok, şablonlar ve dosya alanı var.
    const steps = page.locator("ol > li");
    await expect(steps).toHaveCount(5);
    await expect(page.getByRole("button", { name: "İçe aktar" })).toHaveCount(0);
    await expect(page.getByLabel("Doldurduğun CSV dosyası")).toBeVisible();
    await capture("a-bos");

    // Şablonlar: UTF-8 BOM + yalnız başlık; ekrandaki sütun açıklamasıyla aynı; yeniden yüklenince "satır yok" bildirilir, biçim hatası değil.
    for (const [button, header, name] of [
      ["Ürünler şablonu", PRODUCT_HEADER, "urunler-sablon.csv"],
      ["Açılış stoku şablonu", STOCK_HEADER, "acilis-stoku-sablon.csv"],
    ] as const) {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: button }).click()]);
      expect(dl.suggestedFilename()).toBe(name);
      const stream = await dl.createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      const bytes = Buffer.concat(chunks);
      expect([...bytes.subarray(0, 3)], `${name}: BOM`).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.subarray(3).toString("utf8")).toBe(`${header}\r\n`);
      await page.locator("#import-file").setInputFiles({ name, mimeType: "text/csv", buffer: bytes });
      await expect(page.getByTestId("import-issue")).toHaveCount(1);
      await expect(page.getByTestId("issue-reason")).toContainText("Dosyada veri satırı yok");
    }

    // (b) Hatalı ürün dosyası: her hata satır + sütun + neden + nasıl düzeltilir; hata varken içe aktar kapalı ve nedeni yanında yazıyor.
    await page.locator("#import-file").setInputFiles(
      csv([
        PRODUCT_HEADER,
        `${p}-1;Vida M6;;12;${p}B1;${p}K1`,
        ";Kodu yok;;;;",
        `${p}-3;Kesirli koli;;12,5;;`,
        `${p}-1;Aynı kod;;;;`,
        `${p}-5;Bilinmeyen birim;PALET;;;`,
      ]),
    );
    const issues = page.getByTestId("import-issue");
    await expect(issues).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const item = issues.nth(i);
      await expect(item.getByTestId("issue-row")).toHaveText(/^Satır \d+$/);
      await expect(item.getByTestId("issue-column")).not.toBeEmpty();
      await expect(item.getByTestId("issue-reason")).not.toBeEmpty();
      await expect(item.getByTestId("issue-fix")).toContainText("Nasıl düzeltilir:");
    }
    await expect(issues.nth(0).getByTestId("issue-row")).toHaveText("Satır 3");
    await expect(issues.nth(1).getByTestId("issue-column")).toHaveText("Koli içi adet");
    await expect(issues.nth(1).getByTestId("issue-reason")).toContainText("kesirli olamaz");
    const summary = page.getByTestId("import-summary");
    await expect(summary).toContainText("Ürünler dosyası");
    await expect(summary.getByText("Hatalı satır")).toBeVisible();
    await expect(page.getByRole("button", { name: "İçe aktar" })).toBeDisabled();
    await expect(page.getByText("Önce 4 hatayı düzelt", { exact: false })).toBeVisible();
    await capture("b-hatali", "import-summary");

    // Önizleme özeti, özet görünür alana kaydırılınca tam görünür (rubrik İ-05).
    for (const size of sizes) {
      await page.setViewportSize(size);
      await summary.scrollIntoViewIfNeeded();
      const box = await summary.boundingBox();
      expect(box && box.y >= 0 && box.y + box.height <= size.height, `özet ${size.width}x${size.height} görünüm içinde`).toBe(true);
    }
    await page.setViewportSize(sizes[0]);

    // (c) Düzeltilmiş ürün dosyası → temiz önizleme → içe aktar → sonuç.
    const products = csv([PRODUCT_HEADER, `${p}-1;Vida M6;;12;${p}B1;${p}K1`, `${p}-2;Somun M6;adet;;${p}B2;`, `${p}-3;Pul;;24;;${p}K3`]);
    await page.locator("#import-file").setInputFiles(products);
    await expect(summary).toContainText("Hata yok. İçe aktarabilirsin.");
    await expect(summary).toContainText("3 yeni ürün eklenecek, 0 ürün zaten var. 2 koli tanımı, 4 barkod.");
    const apply = page.getByRole("button", { name: "İçe aktar" });
    await expect(apply).toBeEnabled();
    await capture("c-temiz", "import-summary");

    // Klavye yolu (K-17): dosya alanından yalnız Tab ile "İçe aktar"a ulaşılır; odak halkası görünür.
    await page.locator("#import-file").focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate<boolean>(`document.activeElement && document.activeElement.textContent.trim() === 'İçe aktar'`);
    }
    expect(reached, "Tab ile İçe aktar düğmesine ulaşıldı").toBe(true);
    const outline = await page.evaluate<string>(`getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth`);
    expect(outline, "odak halkası görünür").not.toMatch(/^none/);
    await page.keyboard.press("Enter");

    const result = page.getByTestId("import-result");
    await expect(result).toContainText("Tamam. 3 ürün eklendi, 0 ürün güncellendi, 0 ürün zaten vardı.");
    await expect(result).toContainText("Şimdi açılış stoku dosyasını yükleyebilirsin.");
    await expect(page.getByRole("link", { name: "Ürünlere git" })).toBeVisible();
    await capture("d-sonuc-urun", "import-result");

    // Aynı ürün dosyası ikinci kez: hiçbir ürün yeniden oluşturulmaz.
    await result.getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(products);
    await expect(summary).toContainText("0 yeni ürün eklenecek, 3 ürün zaten var.");
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 0 ürün eklendi, 0 ürün güncellendi, 3 ürün zaten vardı.");

    // Açılış stoku: bilinmeyen raf ve kesirli adet önizlemede yakalanır.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(csv([STOCK_HEADER, `${p}-1;A3-G04;1.250,0`, `${p}-2;YOK-RAF;2,5`]));
    await expect(page.getByTestId("import-issue")).toHaveCount(2);
    await expect(page.getByTestId("issue-reason").nth(0)).toContainText("diye bir raf yok");
    await expect(page.getByTestId("issue-reason").nth(1)).toContainText("Adet kesirli olamaz");
    await expect(page.getByRole("button", { name: "İçe aktar" })).toBeDisabled();
    await capture("e-stok-hatali", "import-summary");

    const stock = csv([STOCK_HEADER, `${p}-1;A3-G04;1.250,0`, `${p}-2;a3-g03;40`, `${p}-3;A3-G04;7`]);
    await page.locator("#import-file").setInputFiles(stock);
    await expect(summary).toContainText("Açılış stoku dosyası");
    await expect(summary).toContainText("toplam 1297 adet");
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 3 stok satırı eklendi, 0 satır daha önce eklenmişti.");
    await capture("f-sonuc-stok", "import-result");

    // Aynı stok dosyası ikinci kez: ek hareket yok (sonuç "daha önce eklenmişti").
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(stock);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 0 stok satırı eklendi, 3 satır daha önce eklenmişti.");

    // Ürünler listesinde içe aktarılan ürün görünür.
    await page.goto(`/t/demo/items?q=${p}-1`);
    await expect(page.getByText(`${p}-1`).first()).toBeVisible();

    writeFileSync(path.join(OUT, `metrics-${project}.json`), JSON.stringify({ project, sizes, home, metrics }, null, 2));
  });

  test("yetkisiz kullanıcı (salt okunur): neden + sonraki eylem, form yok", async ({ page }, testInfo) => {
    mkdirSync(OUT, { recursive: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Salt okunur olarak gir" }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    await page.goto("/t/demo/import");
    await expect(page.getByRole("heading", { level: 1, name: "Ürün ve stok içe aktar" })).toBeVisible();
    await expect(page.getByText("Bu ekranı kullanmak için ürün ve ayar yetkisi gerekir.")).toBeVisible();
    await expect(page.getByText("Çalışma alanı yöneticine sor.")).toBeVisible();
    await expect(page.locator("#import-file")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Geri dön" })).toBeVisible();
    const m = await measure(page);
    expect(m.overflowX).toBe(false);
    expect(m.smallTargets).toEqual([]);
    await page.screenshot({ path: path.join(OUT, `${testInfo.project.name}-yetkisiz.png`) });
  });
});
