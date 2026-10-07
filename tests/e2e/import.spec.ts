// T-289: açılış verisi içe aktarma — şablon indirme, hatalı dosyada satır satır önizleme, düzeltilmiş dosyayla içe aktarma (ürün + açılış stoku),
// aynı dosyayı ikinci kez yükleme (ek hareket yok), klavye yolu, yetkisiz kullanıcı. Demo tenant (demo yönetici: MFA kapalı, A-38) üzerinde koşar;
// her koşu benzersiz kod önekiyle yalnız KENDİ ürünlerini ve demo rafı A3-G03/A3-G04'e kendi stokunu ekler (demo tohumu bu ürünlere dokunmaz).
// Ekran görüntüleri ve ölçümler `.artifacts/t-289/` altına yazılır (git'e girmez); ölçütler `docs/tasks/T-289.md` "Ekran tasarım rubriği" ile aynıdır.
// Dosya içeriği sentetiktir (G-09); sayfa DOM sorguları dize ifadesidir (kök tsconfig'de DOM tipleri yok).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  const interactive = [...main.querySelectorAll('a[href],button,input:not([type=file]),select,textarea,summary')].filter(vis);
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
const STOCK_HEADER = "ürün kodu;raf kodu;miktar";

/** Mobilde uygulama kabuğunun içerik alanı (`.tenant-body`) kendi içinde kayar: tam sayfa kanıt için pencere kaydırıcı taşmasının boyu kadar uzatılır (kabuk içeriği tümüyle görünür); masaüstünde sayfa gövdesi kayar (fullPage). */
async function shootFull(page: Page, size: { width: number; height: number }, file: string): Promise<void> {
  await page.setViewportSize(size);
  const extra = await page.evaluate<number>(`(() => { const b = document.querySelector('.tenant-body'); return b && getComputedStyle(b).overflowY === 'auto' ? b.scrollHeight - b.clientHeight : 0; })()`);
  if (extra > 0) {
    await page.setViewportSize({ width: size.width, height: size.height + extra + 4 });
    const left = await page.evaluate<number>(`(() => { const b = document.querySelector('.tenant-body'); return b.scrollHeight - b.clientHeight; })()`);
    expect(left, `${file}: kabuk içeriği tümüyle görünür`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }
  await page.setViewportSize(size);
}


/** Her boyutta ölçüm + iki görüntü: kullanıcının gördüğü görünüm ve tam sayfa (kabuk içeriği tümüyle). */
async function captureState(page: Page, project: string, sizes: readonly { width: number; height: number }[], metrics: Record<string, Metrics>, state: string, scrollTo?: string): Promise<void> {
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
    await shootFull(page, size, path.join(OUT, `${project}-${state}-${size.width}-full.png`));
  }
  await page.setViewportSize(sizes[0] as { width: number; height: number });
}

/** Yerel veritabanında SQL çalıştırır (`psql`; bağlantı dizgisi argv'de değil ortam değişkeninden okunur). Lint: `pg` sürücüsü e2e'de yasak. */
function runSql(script: string): void {
  if (!process.env.DATABASE_URL_DIRECT) throw new Error("e2e: DATABASE_URL_DIRECT yok (kısmi başarısızlık senaryosu yerel yığın ister)");
  execFileSync("sh", ["-c", 'psql "$DATABASE_URL_DIRECT" -X -q -v ON_ERROR_STOP=1'], { input: script, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
}

/** TEST-YALNIZ hata enjeksiyonu (üretim kodunda kanca yok): yerel veritabanında demo tenant için belge ONAYI ya da belirli kodlu ürün EKLEMESİ başarısız olur; iş bitince tetikleyici ve tablo kaldırılır. */
async function withInjection<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9:_-]+$/.test(what)) throw new Error("e2e: enjeksiyon anahtarı geçersiz");
  const cleanup = `DROP TRIGGER IF EXISTS t289_inject_docs ON public.documents; DROP TRIGGER IF EXISTS t289_inject_items ON public.items;
    DROP FUNCTION IF EXISTS public.t289_inject_fn(); DROP TABLE IF EXISTS public.t289_inject;`;
  runSql(`${cleanup}
    CREATE TABLE public.t289_inject (tenant_id uuid NOT NULL, what text NOT NULL, PRIMARY KEY (tenant_id, what));
    CREATE FUNCTION public.t289_inject_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF TG_TABLE_NAME = 'documents' THEN
          IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NEW.reason = 'import.opening_stock'
             AND EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'approve') THEN
            RAISE EXCEPTION 't289 injected approve failure' USING ERRCODE = 'XX000';
          END IF;
        ELSIF TG_TABLE_NAME = 'items' THEN
          IF EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'item:' || NEW.code) THEN
            RAISE EXCEPTION 't289 injected item failure' USING ERRCODE = 'XX000';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER t289_inject_docs BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn();
    CREATE TRIGGER t289_inject_items BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn();
    INSERT INTO public.t289_inject (tenant_id, what) SELECT id, '${what}' FROM public.tenants WHERE slug = 'demo';`);
  try {
    return await fn();
  } finally {
    runSql(cleanup);
  }
}

test.describe("açılış verisi içe aktarma (T-289)", () => {
  test("şablon, hatalı önizleme, içe aktarma, tekrar yükleme, klavye yolu", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    const project = testInfo.project.name;
    const sizes = project === "desktop" ? DESKTOP_SIZES : PHONE_SIZES;
    const p = `T289-${Date.now()}${project === "desktop" ? "D" : "M"}`;
    const metrics: Record<string, Metrics> = {};

    const capture = (state: string, scrollTo?: string): Promise<void> => captureState(page, project, sizes, metrics, state, scrollTo);

    await loginAdmin(page);
    // Ayarlar sayfasının ALTINDAKİ bağlantıyla gel (kabuk kaydırması korunur): başlık yine de görünür olmalı (İ-16).
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.goto("/t/demo/settings");
      await page.getByRole("link", { name: "Ürün ve stoku Excel'den içe aktar" }).click();
      await expect(page).toHaveURL(/\/t\/demo\/import$/);
      const h1 = page.getByRole("heading", { level: 1, name: "Ürün ve stok içe aktar" });
      await expect(h1).toBeVisible();
      const ok = await page.evaluate<boolean>(`(() => {
        const el = document.querySelector('h1'); const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
        return r.top >= 0 && r.bottom <= window.innerHeight && top !== null && (top === el || el.contains(top));
      })()`);
      expect(ok, `${size.width}x${size.height}: h1 görünür alanda ve üst çubuğun altında kalmadı`).toBe(true);
      if (project === "desktop") expect(await page.evaluate<number>("document.scrollingElement.scrollTop"), "masaüstünde başlığa kaydırma sayfayı/üst çubuğu kesmedi").toBe(0);
    }
    await page.setViewportSize(sizes[0]);

    // (a) Boş açılış: sıralı 5 adım, geçilmemiş adımların eylemi yok, dolu düğme yok, şablonlar ve dosya seçici var.
    const steps = page.locator("ol > li");
    await expect(steps).toHaveCount(5);
    await expect(page.getByRole("button", { name: "İçe aktar" })).toHaveCount(0);
    await expect(page.locator("label[for=import-file]")).toHaveText("Dosya seç");
    await expect(page.getByText("Henüz dosya seçmedin")).toBeVisible();
    await expect(page.locator("#import-file")).toHaveClass(/sr-only/);
    const labelBox = await page.locator("label[for=import-file]").boundingBox();
    expect(labelBox?.height ?? 0).toBeGreaterThanOrEqual(47.5);
    await capture("a-bos");

    // Şablonlar: UTF-8 BOM + yalnız başlık; yeniden yüklenince "satır yok" bildirilir, biçim hatası değil.
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
      // Boş şablon: kırmızı hata kartı değil, yönlendirici uyarı.
      await expect(page.getByTestId("import-issue")).toHaveCount(0);
      await expect(page.getByText("Şablona en az bir satır ekle, sonra dosyayı yeniden seç.")).toBeVisible();
      await expect(page.locator('[data-kind="warning"]').first()).toBeVisible();
      await expect(page.getByText(`Seçilen: ${name}`)).toBeVisible();
    }

    // (b) Hatalı ürün dosyası: her satır tek kart; satır + sütun + neden + nasıl düzeltilir; hata varken içe aktar pasif ve nedeni yanında yazıyor.
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
    await expect(page.getByTestId("import-summary-line")).toHaveText("5 ürün: 1 hazır, 4 hatalı");
    await expect(summary.getByText("Hatalı satır")).toBeVisible();
    await expect(summary.getByText("Stok satırı")).toHaveCount(0); // ürün dosyasında stok kutusu yok
    const apply = page.getByRole("button", { name: "İçe aktar" });
    await expect(apply).toBeDisabled();
    await expect(page.getByText("Önce 4 hatayı düzelt", { exact: false })).toBeVisible();
    await expect(summary.getByRole("button", { name: "Yeni dosya seç" })).toBeVisible();
    const disabledBg = await page.evaluate<string>(`getComputedStyle([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'İçe aktar')).backgroundColor`);
    const accentBg = await page.evaluate<string>(`(() => { const d = document.createElement('div'); d.className = 'bg-accent'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })()`);
    expect(disabledBg, "kapalı düğme dolu mavi değil").not.toBe(accentBg);
    await capture("b-hatali", "import-summary");

    // "Yeni dosya seç" tek satır (≤ 50 px) 3 telefon boyutunda ve masaüstünde.
    for (const size of sizes) {
      await page.setViewportSize(size);
      const bb = await summary.getByRole("button", { name: "Yeni dosya seç" }).boundingBox();
      expect(bb?.height ?? 0, `${size.width}: düğme tek satır`).toBeLessThanOrEqual(50);
    }
    await page.setViewportSize(sizes[0]);

    // Önizleme özeti, görünür alana kaydırılınca tam görünür (İ-05).
    for (const size of sizes) {
      await page.setViewportSize(size);
      await summary.scrollIntoViewIfNeeded();
      const box = await summary.boundingBox();
      expect(box && box.y >= 0 && box.y + box.height <= size.height, `özet ${size.width}x${size.height} görünüm içinde`).toBe(true);
    }
    await page.setViewportSize(sizes[0]);

    // "Yeni dosya seç" düğmesi dosya seçiciyi açar.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), summary.getByRole("button", { name: "Yeni dosya seç" }).click()]);
    await chooser.setFiles(csv([PRODUCT_HEADER, `${p}-9;Geçici;;;;`]));
    await expect(page.getByText("Seçilen: dosya.csv")).toBeVisible();

    // 60 hatalı satır: yalnız ilk 50 hata gösterilir ve bu açıkça yazılır (sessiz kesme yok).
    await page.locator("#import-file").setInputFiles(csv([PRODUCT_HEADER, ...Array.from({ length: 60 }, (_, i) => `${p}-x${i};;;;;`)]));
    await expect(page.getByText("İlk 50 hata gösteriliyor, toplam 60 hata var.")).toBeVisible();

    // Uzun hata listesi: aynı satırın hataları tek kartta; ilk 10 kart + "Tümünü göster".
    const many = [PRODUCT_HEADER, ...Array.from({ length: 12 }, (_, i) => `${p}-${i + 1};;PALET;;;`)];
    await page.locator("#import-file").setInputFiles(csv(many));
    await expect(issues).toHaveCount(10);
    await expect(issues.first().getByTestId("issue-item")).toHaveCount(2); // ad boş + bilinmeyen birim: tek kartta
    const toggle = page.getByTestId("issues-toggle");
    await expect(toggle).toHaveText("Tümünü göster (12 satır)");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await capture("b2a-uzun-kapali", "issues-toggle");
    await toggle.click();
    await expect(issues).toHaveCount(12);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await capture("b2-uzun-liste", "issues-toggle");

    // (c) Düzeltilmiş ürün dosyası → temiz önizleme → içe aktar → sonuç.
    const products = csv([PRODUCT_HEADER, `${p}-1;Vida M6;;12;${p}B1;${p}K1`, `${p}-2;Somun M6;adet;;${p}B2;`, `${p}-3;Pul;;24;;${p}K3`]);
    await page.locator("#import-file").setInputFiles(products);
    await expect(summary).toContainText("Hata yok. İçe aktarabilirsin.");
    await expect(summary).toContainText("3 yeni ürün eklenecek, 0 ürün zaten var. 2 koli tanımı, 4 barkod.");
    await expect(page.getByTestId("import-summary-line")).toHaveText("3 ürün: 3 hazır, 0 hatalı");
    await expect(apply).toBeEnabled();
    await capture("c-temiz", "import-summary");

    // Klavye yolu (K-17): şablon düğmesinden Tab ile dosya seçiciye, sonra "İçe aktar"a; odak halkası etikette görünür.
    await page.getByRole("button", { name: "Açılış stoku şablonu" }).focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate<string>("document.activeElement.id"), "Tab dosya girdisine geldi").toBe("import-file");
    const ring = await page.evaluate<string>(`(() => { const l = document.querySelector('label[for=import-file]'); const s = getComputedStyle(l); return s.outlineStyle + ' ' + s.outlineWidth; })()`);
    expect(ring, "etikette odak halkası görünür").not.toMatch(/^none/);
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate<boolean>(`document.activeElement && document.activeElement.textContent.trim() === 'İçe aktar'`);
    }
    expect(reached, "Tab ile İçe aktar düğmesine ulaşıldı").toBe(true);
    await page.keyboard.press("Enter");

    const result = page.getByTestId("import-result");
    await expect(result).toContainText("Tamam. 3 ürün eklendi.");
    await expect(result).not.toContainText("güncellendi"); // 0 olan sayı yazılmaz
    await expect(summary).not.toContainText("Hata yok. İçe aktarabilirsin.");
    await expect(page.getByTestId("import-step4-status")).toHaveText("Tamamlandı");
    await expect(page.getByTestId("import-counts")).toHaveCount(1); // "zaten vardı" yok: yalnız boş liste (ikinci "tamam" sayısı yok)
    await expect(page.getByTestId("import-counts").locator("li")).toHaveCount(0);
    await expect(result).toContainText("Şimdi açılış stoku dosyasını yükleyebilirsin.");
    await expect(page.getByRole("link", { name: "Ürünlere git" })).toBeVisible();
    await capture("d-sonuc-urun", "import-result");

    // Aynı ürün dosyası ikinci kez: hiçbir ürün yeniden oluşturulmaz.
    await result.getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(products);
    await expect(summary).toContainText("0 yeni ürün eklenecek, 3 ürün zaten var.");
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. Yeni kayıt yok.");
    await expect(page.getByTestId("import-counts")).toContainText("3 satır zaten vardı");
    await capture("d2-sonuc-zaten", "import-result");

    // Açılış stoku: bilinmeyen raf ve kesirli adet önizlemede yakalanır.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(csv([STOCK_HEADER, `${p}-1;A3-G04;1.250,0`, `${p}-2;YOK-RAF;2,5`]));
    await expect(issues).toHaveCount(1); // satır 3'ün iki hatası tek kartta
    await expect(issues.first().getByTestId("issue-item")).toHaveCount(2);
    await expect(page.getByTestId("issue-reason").nth(0)).toContainText("diye bir raf yok");
    await expect(page.getByTestId("issue-reason").nth(1)).toContainText("Adet kesirli olamaz");
    await expect(page.getByTestId("import-summary-line")).toHaveText("2 stok satırı: 1 hazır, 1 hatalı");
    await expect(summary.getByText("Stok satırı", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "İçe aktar" })).toBeDisabled();
    await capture("e-stok-hatali", "import-summary");

    const stock = csv([STOCK_HEADER, `${p}-1;A3-G04;1.250,0`, `${p}-2;a3-g03;40`, `${p}-3;A3-G04;7`]);
    await page.locator("#import-file").setInputFiles(stock);
    await expect(summary).toContainText("Açılış stoku dosyası");
    await expect(summary).toContainText("toplam 1297 adet");
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 3 stok satırı eklendi.");
    await expect(page.getByRole("link", { name: "Ürünlerde stoğu gör" })).toBeVisible();
    await capture("f-sonuc-stok", "import-result");

    // Aynı stok dosyası ikinci kez: satırlar "daha önce işlenmiş" diye atlanır, ek hareket yok.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(stock);
    await expect(summary).toContainText("Yazılacak yeni satır yok. 3 satır daha önce işlenmiş, atlanacak.");
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. Yeni kayıt yok.");
    await expect(page.getByTestId("import-counts")).toContainText("3 satır zaten vardı");
    await expect(page.getByTestId("import-result")).not.toContainText("stok satırı eklendi");

    // Aynı rafta farklı miktar (düzeltme girişimi): açılış stoku yalnız boş raflar içindir → satır hatası.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    await page.locator("#import-file").setInputFiles(csv([STOCK_HEADER, `${p}-1;A3-G04;1300`]));
    await expect(page.getByTestId("issue-reason")).toContainText("zaten stokta");
    await expect(page.getByRole("button", { name: "İçe aktar" })).toBeDisabled();

    // Ürünler listesinde içe aktarılan ürün görünür.
    await page.goto(`/t/demo/items?q=${p}-1`);
    await expect(page.getByText(`${p}-1`).first()).toBeVisible();

    writeFileSync(path.join(OUT, `metrics-${project}.json`), JSON.stringify({ project, sizes, metrics }, null, 2));
  });

  test("yarım kalan içe aktarma: hatalı/denenmedi sayıları, 20'den sonra 've N satır daha', yeniden yükleyince tamamlanır", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    const project = testInfo.project.name;
    const sizes = project === "desktop" ? DESKTOP_SIZES : PHONE_SIZES;
    const p = `T289-${Date.now()}${project === "desktop" ? "D" : "M"}P`;
    const metrics: Record<string, Metrics> = {};
    const capture = (state: string, scrollTo?: string): Promise<void> => captureState(page, project, sizes, metrics, state, scrollTo);
    await loginAdmin(page);
    await page.goto("/t/demo/import");
    const upload = async (rows: string[]): Promise<void> => {
      await page.locator("#import-file").setInputFiles(csv(rows));
      await expect(page.getByTestId("import-summary")).toBeVisible();
    };

    // 1) Ürün: ikinci satırda ürün kaydı başarısız (test-yalnız tetikleyici) → 1 eklendi, 1 hatalı, 1 denenmedi.
    const products = [PRODUCT_HEADER, `${p}-1;Bir;;;;`, `${p}-2;İki;;;;`, `${p}-3;Üç;;;;`];
    await withInjection(`item:${p}-2`, async () => {
      await upload(products);
      await page.getByRole("button", { name: "İçe aktar" }).click();
      const result = page.getByTestId("import-result");
      await expect(result).toContainText("İşlem yarım kaldı. 1 satır eklendi.");
      await expect(page.getByTestId("import-step4-status")).toHaveText("Yarım kaldı");
      await expect(page.getByTestId("import-counts")).toContainText("1 satır hatalı");
      await expect(page.getByTestId("import-counts")).toContainText("1 satır denenmedi");
      await expect(page.getByTestId("import-failed-rows")).toContainText(`Satır 3 (${p}-2)`);
      await expect(page.getByTestId("import-result")).not.toContainText("INTERNAL");
      await capture("g-yarim-urun", "import-result");
    });
    // Sorun giderildi: aynı dosya yeniden yüklenir, kalanlar tamamlanır; tamamlanan satır "zaten vardı".
    await page.getByTestId("import-result").getByRole("button", { name: "Dosyayı yeniden seç" }).click();
    await upload(products);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 2 ürün eklendi.");
    await expect(page.getByTestId("import-counts")).toContainText("1 satır zaten vardı");
    await capture("h-devam-urun", "import-result");

    // 2) Stok: 25 satırlık belge onayda başarısız → 25 hatalı satır, 20'si listelenir ve "ve 5 satır daha hatalı" yazar.
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    const many = Array.from({ length: 25 }, (_, i) => `${p}-m${i}`);
    await upload([PRODUCT_HEADER, ...many.map((c) => `${c};Ürün;;;;`)]);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 25 ürün eklendi.");
    await page.getByTestId("import-result").getByRole("button", { name: "Başka dosya yükle" }).click();
    const stockRows = [STOCK_HEADER, ...many.map((c) => `${c};A3-G04;5`)];
    await withInjection("approve", async () => {
      await upload(stockRows);
      await page.getByRole("button", { name: "İçe aktar" }).click();
      const result = page.getByTestId("import-result");
      await expect(result).toContainText("İşlem yarım kaldı.");
      await expect(page.getByTestId("import-counts")).toContainText("25 satır hatalı");
      await expect(page.getByTestId("import-failed-rows").locator("li")).toHaveCount(21); // 20 satır + "ve 5 satır daha hatalı."
      await expect(page.getByTestId("import-failed-more")).toHaveText("ve 5 satır daha hatalı.");
      await capture("i-yarim-stok", "import-result");
    });
    // Aynı dosya: yarım kalan belge sürdürülür, 25 satır eklenir.
    await page.getByTestId("import-result").getByRole("button", { name: "Dosyayı yeniden seç" }).click();
    await upload(stockRows);
    await page.getByRole("button", { name: "İçe aktar" }).click();
    await expect(page.getByTestId("import-result")).toContainText("Tamam. 25 stok satırı eklendi.");
    writeFileSync(path.join(OUT, `metrics-${project}-yarim.json`), JSON.stringify({ project, sizes, metrics }, null, 2));
  });

  test("yetkisiz kullanıcı (salt okunur): neden + sonraki eylem, form yok", async ({ page }, testInfo) => {
    mkdirSync(OUT, { recursive: true });
    const sizes = testInfo.project.name === "desktop" ? DESKTOP_SIZES : PHONE_SIZES;
    await page.goto("/");
    await page.getByRole("button", { name: "Salt okunur olarak gir" }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    await page.goto("/t/demo/import");
    await expect(page.getByRole("heading", { level: 1, name: "Ürün ve stok içe aktar" })).toBeVisible();
    await expect(page.getByText("Bu ekranı kullanmak için ürün ve ayar yetkisi gerekir.")).toBeVisible();
    await expect(page.getByText("Çalışma alanı yöneticine sor.")).toBeVisible();
    await expect(page.locator("#import-file")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Geri dön" })).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      const m = await measure(page);
      expect(m.overflowX).toBe(false);
      expect(m.smallTargets).toEqual([]);
      await page.screenshot({ path: path.join(OUT, `${testInfo.project.name}-yetkisiz-${size.width}.png`) });
    }
  });
});
