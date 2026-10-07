// T-250: kolay kurulum — boş tenant'ta rehberle depo + raf + ürün (3 adım), kod önerisi, toplu raf önizleme/çakışma, yazdıkça arama,
// ScanField ile ürün seçimi. 375x812 (ana akış) ve form açıkken 390x844 / 360x740'ta sayfa gövdesi kaymaz (el terminali kuralı).
// Demo tenant yeni kurulumda boştur: ilk proje koşusu tam rehber akışını yürütür; aynı veritabanında sonraki koşu (diğer proje) rehberin
// tamamlandığını doğrular ve arama/ölçüm adımlarını yineler. Ekran görüntüleri `.artifacts/t-250/` altına yazılır (git'e girmez).
// DOSYA ADI `z-`: bu test ortak demo tenant'a depo/raf/ürün YAZAR; Playwright dosyaları alfabetik koşar, böylece diğer ekran testleri
// (theme-admin vb.) boş demo tenant'la çalışmaya devam eder. Yerelde yeniden koşmak için veritabanı sıfırlanmalıdır (`down -v`).
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const OUT = ".artifacts/t-250";
const BARCODE = "8690000000019";
const ITEM_NAME = "Deneme bardağı";
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

async function noPageScroll(page: Page, where: string): Promise<void> {
  const m = await page.evaluate<{ sh: number; ih: number; sw: number; cw: number }>(
    "({ sh: document.scrollingElement.scrollHeight, ih: window.innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })",
  );
  expect(m.sh, `${where}: scrollHeight(${m.sh}) <= innerHeight(${m.ih})`).toBeLessThanOrEqual(m.ih);
  expect(m.sw, `${where}: scrollWidth(${m.sw}) <= clientWidth(${m.cw})`).toBeLessThanOrEqual(m.cw);
}

async function noHorizontalOverflow(page: Page, where: string): Promise<void> {
  const m = await page.evaluate<{ sw: number; cw: number }>("({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })");
  expect(m.sw, `${where}: scrollWidth(${m.sw}) <= clientWidth(${m.cw})`).toBeLessThanOrEqual(m.cw);
}

/** Öğe kendi içinde kayabiliyor (içerik yüksekliği görünür yüksekliği aşıyor). */
async function scrollsInside(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const e = el as unknown as { scrollHeight: number; clientHeight: number };
    return e.scrollHeight > e.clientHeight;
  });
}

async function touchTarget(locator: Locator, name: string): Promise<void> {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name}: boundingBox`).not.toBeNull();
  expect(box?.height ?? 0, `${name}: yükseklik`).toBeGreaterThanOrEqual(47.5);
  expect(box?.width ?? 0, `${name}: genişlik`).toBeGreaterThanOrEqual(47.5);
}

/** Öğe görünüm penceresinin içinde (eylem çubuğu altta sabit, kaydırmadan erişilir). */
async function inViewport(page: Page, locator: Locator, name: string): Promise<void> {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  expect(box && vp && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width, `${name}: görünüm içinde`).toBe(true);
}


/** El terminali kuralı: form açıkken sayfa gövdesi kaymaz (3 ekran boyutu). `treeHref` yoksa (henüz raf yok) oluşturucu atlanır. */
async function measureForms(page: Page, tag: string, treeHref: string | null): Promise<void> {
  for (const vp of VIEWPORTS) {
    await test.step(`form açıkken kaymaz ${vp.width}x${vp.height}`, async () => {
      await page.setViewportSize(vp);
      const where = `${vp.width}x${vp.height}`;
      await page.goto("/t/demo/warehouses?new=1");
      const wh = page.getByRole("dialog");
      await expect(wh.locator('input[name="code"]')).toHaveValue(/^DEPO-\d{2}$/);
      await noPageScroll(page, `depo formu ${where}`);
      await inViewport(page, wh.getByRole("button", { name: "Kaydet" }), `depo Kaydet ${where}`);
      await page.keyboard.press("Escape");

      await page.goto("/t/demo/items?new=1");
      const it = page.getByRole("dialog");
      await expect(it.locator('input[name="code"]')).toHaveValue(/^URN-\d{4}$/);
      await it.getByText("Gelişmiş ayarlar").click(); // en uzun hâl
      await noPageScroll(page, `ürün formu ${where}`);
      await inViewport(page, it.getByRole("button", { name: "Kaydet" }), `ürün Kaydet ${where}`);
      await page.keyboard.press("Escape");

      if (treeHref === null) return;
      await page.goto(`${treeHref}?bulk=1`);
      const bk = page.getByRole("dialog");
      await expect(page.getByTestId("bulk-summary")).toBeVisible();
      await noPageScroll(page, `toplu oluşturucu ${where}`);
      await inViewport(page, bk.getByRole("button", { name: "Vazgeç" }), `oluşturucu Vazgeç ${where}`);
      await page.screenshot({ path: `${OUT}/${tag}-${vp.width}x${vp.height}-bulk-open.png` });
      await page.keyboard.press("Escape");
    });
  }
}

test("kolay kurulum: rehberle depo + raf + ürün, öneri, önizleme, arama (mobil)", async ({ page }, testInfo) => {
  const tag = testInfo.project.name;
  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: `${OUT}/${tag}-375-${name}.png`, fullPage: true });
  };
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);

  await page.goto("/t/demo/warehouses");
  await expect(page.getByRole("heading", { level: 1, name: "Depo ve raflar" })).toBeVisible();
  const guide = page.getByTestId("setup-guide");
  const fresh = await page
    .locator('[data-step="warehouse"][data-done="false"]')
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  // Ortak demo tenant'ı yalnızca SON proje (mobile) yazar: diğer ekran testleri (theme-admin) önceki projelerde boş tenant görür.
  const writes = tag === "mobile";
  if (fresh && !writes) {
    // Yazmayan koşu: rehber boş tenant'ta doğru görünür, büyük düğme formu hazır kodla açar; hiçbir şey kaydedilmez.
    await expect(guide).toBeVisible();
    await noHorizontalOverflow(page, "rehber (boş)");
    const next = page.getByTestId("setup-next");
    await touchTarget(next, "rehber: büyük düğme");
    await next.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('input[name="code"]')).toHaveValue("DEPO-01");
    await expect(dialog.locator('input[name="name"]')).toHaveValue("Ana depo");
    await touchTarget(dialog.getByRole("button", { name: "Kaydet" }), "depo formu: Kaydet");
    await page.keyboard.press("Escape");
    await measureForms(page, tag, null);
    return;
  }
  if (fresh) {
    // --- Adım 1: Depo ekle (rehberin tek büyük düğmesi) ---
    await expect(guide).toBeVisible();
    await expect(page.locator('[data-step="locations"][data-done="false"]')).toBeVisible();
    await expect(page.locator('[data-step="items"][data-done="false"]')).toBeVisible();
    await noHorizontalOverflow(page, "rehber (boş)"); // liste sayfası dikey kayabilir; yatay taşma yok
    await shot("guide-empty");
    const next = page.getByTestId("setup-next");
    await touchTarget(next, "rehber: büyük düğme");
    await next.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="code"]')).toHaveValue("DEPO-01"); // kod hazır gelir
    await expect(dialog.locator('input[name="name"]')).toHaveValue("Ana depo"); // akıllı varsayılan ad
    await noPageScroll(page, "depo formu");
    await inViewport(page, dialog.getByRole("button", { name: "Kaydet" }), "depo formu: Kaydet");
    await touchTarget(dialog.getByRole("button", { name: "Kaydet" }), "depo formu: Kaydet");
    await shot("warehouse-form");
    await dialog.getByRole("button", { name: "Kaydet" }).click();

    // --- Adım 2: Rafları oluştur (ilk depodan sonra doğrudan oluşturucu) ---
    await expect(page).toHaveURL(/\/warehouses\/[0-9a-f-]{36}/);
    const bulk = page.getByRole("dialog");
    await expect(bulk.getByRole("heading", { name: "Rafları oluştur" })).toBeVisible();
    await expect(page.getByTestId("bulk-summary")).toHaveText("50 lokasyon oluşacak: A-01-01 … A-10-05");
    await noPageScroll(page, "toplu raf oluşturucu");
    await inViewport(page, bulk.getByRole("button", { name: "50 lokasyonu oluştur" }), "oluşturucu: eylem düğmesi");
    // Önizleme listesi sayfayı değil yalnızca kendi içinde kayar.
    const list = page.getByTestId("bulk-preview-list");
    expect(await scrollsInside(list)).toBe(true);
    await shot("bulk-preview");
    await bulk.getByRole("button", { name: "50 lokasyonu oluştur" }).click();

    // --- Adım 3: Ürün ekle (raflardan sonra ürün formu açılır) ---
    await expect(page).toHaveURL(/\/t\/demo\/items/);
    const item = page.getByRole("dialog");
    await expect(item.locator('input[name="code"]')).toHaveValue("URN-0001");
    await expect(item.locator("#create-base-unit")).toContainText("ADET");
    await expect(item.locator("#create-base-unit")).toBeDisabled(); // birim yok: ADET ilk ürünle kendiliğinden oluşur
    await expect(item.locator("details")).not.toHaveAttribute("open", ""); // gelişmiş ayarlar kapalı
    // T-274 S-01: ürün adımında kurulum satırı "Sıradaki: ilk ürünü ekle" ve "Yeni ürün" ile AYNI eylemi (bu formu) açar; ikinci dolu düğme yok.
    await page.keyboard.press("Escape");
    await expect(item).toBeHidden();
    const rowNext = page.getByTestId("setup-row");
    await expect(rowNext).toHaveText("Sıradaki: ilk ürünü ekle");
    await rowNext.click();
    await expect(page.getByRole("dialog").locator('input[name="code"]')).toHaveValue("URN-0001");
    await item.locator('input[name="name"]').fill(ITEM_NAME);
    await noPageScroll(page, "ürün formu");
    await shot("item-form");
    await item.getByRole("button", { name: "Kaydet" }).click();
    await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
    await page.locator('input[name="barcode"]').fill(BARCODE);
    await page.getByRole("button", { name: "Barkodu ekle" }).click();
    await expect(page.getByText("Barkod eklendi.")).toBeVisible();

    // Rehber tamamlandı: depo listesinde görünmez.
    await page.goto("/t/demo/warehouses");
    await expect(page.getByTestId("warehouse-card")).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    await expect(guide).toHaveCount(0);
  } else {
    // Aynı veritabanında ikinci koşu: kurulum tamam, rehber yok.
    await expect(page.getByTestId("warehouse-card").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(guide).toHaveCount(0);
  }

  // --- Yazdıkça ürün arama + ScanField ---
  await page.goto("/t/demo/items");
  const search = page.getByRole("searchbox", { name: "Ürün ara" });
  await search.fill("Deneme");
  const option = page.getByRole("option").first();
  await expect(option).toContainText(ITEM_NAME);
  await touchTarget(option, "öneri satırı");
  await noHorizontalOverflow(page, "ürün arama önerisi");
  await shot("item-typeahead");
  await option.click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);

  await page.goto("/t/demo/items");
  // T-274: barkod ayrı alana değil, tek arama alanına yazılır/okutulur; yazdıkça gelen tek sonuç ürünü seçer.
  await expect(page.getByLabel("Barkodla ürün bul")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Ürün ara" }).fill(BARCODE);
  const byBarcode = page.getByRole("option").first();
  await expect(byBarcode).toContainText(ITEM_NAME);
  await byBarcode.click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/); // barkod doğrudan ürünü seçer
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Barkod okuyucu (klavye modu) değerin sonuna Enter gönderir: tek eşleşme doğrudan ürünü açar.
  await page.goto("/t/demo/items");
  const wedge = page.getByRole("searchbox", { name: "Ürün ara" });
  await wedge.fill(BARCODE);
  await wedge.press("Enter");
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);

  // --- Çakışma: aynı aralık yeniden önizlenir, çakışanlar listelenir, oluşturma kapalı ---
  await page.goto("/t/demo/warehouses");
  const treeHref = await page.getByRole("link", { name: "Lokasyonları aç" }).first().getAttribute("href");
  expect(treeHref).not.toBeNull();
  await page.goto(`${treeHref}?bulk=1`);
  const dlg = page.getByRole("dialog");
  await expect(page.getByTestId("bulk-conflicts")).toBeVisible();
  await expect(dlg.getByText(/50 kod zaten var; oluşturulmaz/)).toBeVisible();
  await expect(dlg.getByRole("button", { name: /lokasyonu oluştur/ })).toBeDisabled();
  await shot("bulk-conflict");
  // Üst lokasyon seçici (gelişmiş): yazarken öneri.
  await dlg.getByText("Gelişmiş ayarlar").click();
  await dlg.getByRole("searchbox", { name: /Üst lokasyon/ }).fill("A-02");
  const loc = dlg.getByRole("option").first();
  await expect(loc).toContainText("A-02-01");
  await touchTarget(loc, "lokasyon önerisi");
  await loc.click();
  await expect(dlg.getByText(/Seçildi: A-02-01/)).toBeVisible();

  await measureForms(page, tag, treeHref);
});
