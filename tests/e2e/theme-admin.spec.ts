// T-246c: yönetim ekranları (ayarlar, üyeler + davet penceresi, denetim kaydı) güven paletinde (ADR-020).
// Demo yönetici girişi; 375x812 ve 1280x800; Akış ve Kokpit. Piksel karşılaştırma yok: hesaplanan stil + taşma + görünür metin.
// Görüntüler `.artifacts/t-246c/<görünüm>-<genişlik>-<ekran>.png` altına yazılır (git'e girmez).
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const SIZES = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;
const VIEWS = [
  { id: "flow", label: "Akış" },
  { id: "cockpit", label: "Kokpit" },
] as const;
const OUT = ".artifacts/t-246c";

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const m = await page.evaluate<{ scroll: number; client: number }>("({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })");
  expect(m.scroll, `${where}: scrollWidth(${m.scroll}) <= clientWidth(${m.client})`).toBeLessThanOrEqual(m.client);
}

/** Belirteci tarayıcıda çözer (`var(--color-*)` → hesaplanan renk); girdi stiliyle aynı biçimde karşılaştırılır. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate(
    `(() => { const p = document.createElement("span"); p.style.color = "var(${token})"; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`,
  );
}

// Kök tsconfig'de DOM tipleri yok (lib: ES2023); işlev tarayıcıda çalışır, burada yalnızca tür bildirimi.
declare const getComputedStyle: (el: unknown) => { getPropertyValue(prop: string): string };

async function computed(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

async function expectBorderStrong(page: Page, field: Locator, name: string): Promise<void> {
  await expect(field, name).toBeVisible();
  const strong = await tokenColor(page, "--color-border-strong");
  for (const side of ["top", "right", "bottom", "left"]) {
    expect(await computed(field, `border-${side}-color`), `${name}: border-${side}-color`).toBe(strong);
  }
}

async function expectFocusRing(page: Page, field: Locator, name: string): Promise<void> {
  // Klavye ile odak (focus-visible): önce gövdeye, ardından Tab ile alana gelinir.
  await field.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(field, `${name}: odakta`).toBeFocused();
  expect(await computed(field, "outline-color"), `${name}: outline-color`).toBe(await tokenColor(page, "--color-focus"));
  expect(await computed(field, "outline-style"), `${name}: outline-style`).toBe("solid");
}

// Tek test, tek demo girişi: demo girişi hız sınırlıdır (kombinasyon başına giriş "Çok fazla deneme" döndürür).
test("yönetim ekranları: Akış/Kokpit x 375/1280 px", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);

  for (const size of SIZES) {
    for (const view of VIEWS) {
      await test.step(`${view.label} ${size.width}px`, async () => {
        await page.setViewportSize(size);
        const shot = async (screen: string): Promise<void> => {
          await page.screenshot({ path: `${OUT}/${view.id}-${size.width}-${screen}.png`, fullPage: true });
        };

        // Görünüm anahtarı: seçili durum aria-pressed + metinle (renk tek taşıyıcı değil).
        await page.getByRole("button", { name: view.label, exact: true }).click();
        await expect(page.getByRole("button", { name: view.label, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("html")).toHaveAttribute("data-view", view.id);

          // Ayarlar.
          await page.goto("/t/demo/settings");
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-view", view.id);
          await expectBorderStrong(page, page.locator("#locale"), "ayarlar: dil seçimi");
          await expectBorderStrong(page, page.locator("#timeZone"), "ayarlar: saat dilimi");
          await expectFocusRing(page, page.locator("#locale"), "ayarlar: dil seçimi");
          await expectNoHorizontalOverflow(page, "ayarlar");
          await shot("settings");

          // Üyeler: sahip rozeti metni görünür; davet penceresi açık.
          await page.goto("/t/demo/members");
          await expect(page.getByRole("heading", { level: 1, name: "Üyeler" })).toBeVisible();
          await expect(page.getByTestId("member-card").getByText("Sahip", { exact: true }).first()).toBeVisible();
          await expectBorderStrong(page, page.getByRole("combobox").first(), "üyeler: rol seçimi");
          await expectNoHorizontalOverflow(page, "üyeler");
          await shot("members");
          const invite = page.getByRole("button", { name: "Üye davet et" });
          await expect(invite).toBeEnabled();
          await invite.click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          const email = dialog.getByLabel("E-posta");
          await expectBorderStrong(page, email, "davet: e-posta");
          await expectFocusRing(page, email, "davet: e-posta");
          await expectNoHorizontalOverflow(page, "davet penceresi");
          await shot("members-invite");
          await dialog.getByRole("button", { name: "Kapat" }).click();
          await expect(dialog).toBeHidden();

          // Denetim kaydı.
          await page.goto("/t/demo/audit");
          await expect(page.getByRole("heading", { level: 1, name: "Kim ne yaptı?" })).toBeVisible();
          await expectBorderStrong(page, page.locator("#from"), "denetim: başlangıç tarihi");
          await expectBorderStrong(page, page.locator("#action"), "denetim: eylem süzgeci");
          await expectFocusRing(page, page.locator("#action"), "denetim: eylem süzgeci");
          await expectNoHorizontalOverflow(page, "denetim kaydı");
          await shot("audit");

          // T-246d — Ürünler: arama alanı + durum seçimi + oluşturma penceresi.
          await page.goto("/t/demo/items");
          await expect(page.getByRole("heading", { level: 1, name: "Ürünler" })).toBeVisible();
          await expectBorderStrong(page, page.getByRole("searchbox", { name: "Ürün ara" }), "ürünler: arama");
          await expectBorderStrong(page, page.locator("#item-status"), "ürünler: durum seçimi");
          await expectFocusRing(page, page.locator("#item-status"), "ürünler: durum seçimi");
          await expectNoHorizontalOverflow(page, "ürünler");
          await shot("items");
          await page.getByRole("button", { name: "Yeni ürün" }).click();
          const itemDialog = page.getByRole("dialog");
          await expect(itemDialog).toBeVisible();
          await expectBorderStrong(page, itemDialog.locator('input[name="code"]'), "ürün oluştur: kod");
          await expectBorderStrong(page, itemDialog.locator("#create-base-unit"), "ürün oluştur: temel birim");
          await expectNoHorizontalOverflow(page, "ürün oluştur penceresi");
          await shot("items-create");
          await page.keyboard.press("Escape");
          await expect(itemDialog).toBeHidden();

          // T-246d — Depolar: oluşturma penceresi (girdi + seçim) ve varsa lokasyon ağacı.
          await page.goto("/t/demo/warehouses");
          await expect(page.getByRole("heading", { level: 1, name: "Depo ve raflar" })).toBeVisible();
          await expectNoHorizontalOverflow(page, "depolar");
          await shot("warehouses");
          await page.getByRole("button", { name: "Yeni depo" }).click();
          const whDialog = page.getByRole("dialog");
          await expect(whDialog).toBeVisible();
          await expectBorderStrong(page, whDialog.locator('input[name="code"]'), "depo oluştur: kod");
          await expectBorderStrong(page, whDialog.locator('input[name="name"]'), "depo oluştur: ad");
          await expectFocusRing(page, whDialog.locator('input[name="name"]'), "depo oluştur: ad");
          await expectNoHorizontalOverflow(page, "depo oluştur penceresi");
          await shot("warehouses-create");
          await page.keyboard.press("Escape");
          await expect(whDialog).toBeHidden();
          const openTree = page.getByRole("link", { name: "Lokasyonları aç" }).first();
          if (await openTree.count()) {
            await openTree.click();
            await expect(page.getByRole("button", { name: "Lokasyon ekle", exact: true })).toBeVisible();
            const toggle = page.getByRole("button", { name: /altını (aç|kapat)/ }).first();
            if (await toggle.count()) await expectBorderStrong(page, toggle, "lokasyon ağacı: aç/kapat düğmesi");
            await expectNoHorizontalOverflow(page, "lokasyon ağacı");
            await shot("location-tree");
            await page.getByRole("button", { name: "Lokasyon ekle", exact: true }).click();
            const locDialog = page.getByRole("dialog");
            await expectBorderStrong(page, locDialog.locator("#create-kind"), "lokasyon oluştur: tür");
            await expectNoHorizontalOverflow(page, "lokasyon oluştur penceresi");
            await page.keyboard.press("Escape");
            await expect(locDialog).toBeHidden();
          }
      });
    }
  }
});
