// T-289: açılış verisi içe aktarma — şablon indirme, hatalı dosyada satır satır önizleme, düzeltilmiş dosyayla içe aktarma (ürün + açılış stoku),
// aynı dosyayı ikinci kez yükleme (ek hareket yok), klavye yolu, yetkisiz kullanıcı. Demo tenant (demo yönetici: MFA kapalı, A-38) üzerinde koşar;
// her koşu benzersiz kod önekiyle yalnız KENDİ ürünlerini ve demo rafı A3-G03/A3-G04'e kendi stokunu ekler (demo tohumu bu ürünlere dokunmaz).
// Ekran görüntüleri ve ölçümler `.artifacts/t-289/` altına yazılır (git'e girmez); ölçütler `docs/tasks/T-289.md` "Ekran tasarım rubriği" ile aynıdır.
// Dosya içeriği sentetiktir (G-09); sayfa DOM sorguları dize ifadesidir (kök tsconfig'de DOM tipleri yok).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { localClient } from "./support/empty-tenant.ts";
import { DESKTOP_SIZES, OUT, PHONE_SIZES, PRODUCT_HEADER, STOCK_HEADER, captureState, csv, loginAdmin, measure, type Metrics } from "./support/import-screen.ts";

// Demo girişi IP başına 10/10 dk sınırlıdır (auth signIn kuralı): bu dosya tüm paketin kovasını tüketmesin diye kendi istemci adresini kullanır (yalnız yerel vekil okur).
test.use({ ...localClient("198.51.100.40") });

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
