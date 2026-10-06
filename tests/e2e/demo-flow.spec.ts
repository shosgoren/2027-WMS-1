// T-131: demo akışı duman testi (masaüstü + mobil). Yerelde `global-setup.ts` yığını kurar; `E2E_BASE_URL` ile staging'e karşı da koşar.
// Beklenen davranışlar A-43 ve kod ile hizalıdır: `is_demo` tenant'ta davet KAPALI (inviteMember, M9), demo kullanıcıları
// üzerinde rol/çıkarma/devir/sıfırlama KAPALI. Karttaki "davet → bağlantı kutusu → member.invited" zinciri demo tenant'ta
// üretilemez; bu testte davetin reddi doğrulanır (rapor: "kart eki gerekli").
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const DEMO_BANNER = "Demo ortamı — gerçek kişisel veri girmeyin";

/** Sayfada yatay taşma yok. */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  // Dize ifadesi: kök tsconfig'de DOM tipleri yok (lib: ES2023); ifade tarayıcıda çalışır.
  const m = await page.evaluate<{ scroll: number; client: number }>("({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })");
  expect(m.scroll, `${where}: scrollWidth(${m.scroll}) <= clientWidth(${m.client})`).toBeLessThanOrEqual(m.client);
}

/** Dokunma hedefi en az 48x48 CSS px (alt piksel toleransı 0.5). */
async function expectTouchTarget(page: Page, locator: ReturnType<Page["locator"]>, name: string): Promise<void> {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name}: boundingBox`).not.toBeNull();
  expect(box?.height ?? 0, `${name}: yükseklik`).toBeGreaterThanOrEqual(47.5);
  expect(box?.width ?? 0, `${name}: genişlik`).toBeGreaterThanOrEqual(47.5);
}

/** CSP ihlali olaylarını sayfa ömrü boyunca toplar (konsol regex'i değil; securitypolicyviolation). */
async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(`
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp.push(e.violatedDirective + " " + e.blockedURI);
    });
  `);
}

async function expectNoCspViolations(page: Page, where: string): Promise<void> {
  const v = await page.evaluate<string[]>("window.__csp ?? []");
  expect(v, `${where}: CSP ihlali`).toEqual([]);
}

test.describe("demo akışı", () => {
  test("yönetici: landing → demo girişi → ana ekran → üyeler → davet reddi → denetim kaydı → çıkış", async ({ page }) => {
    await collectCspViolations(page);

    // Landing: demo bandı + rol düğmeleri; mobilde taşma yok, dokunma hedefleri >= 48 px.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Etkin WMS" })).toBeVisible();
    await expect(page.getByText(DEMO_BANNER)).toBeVisible();
    const enter = page.getByRole("button", { name: "Yönetici olarak gir" });
    await expectTouchTarget(page, enter, "landing: Yönetici olarak gir");
    await expectTouchTarget(page, page.getByRole("link", { name: "Giriş yap" }), "landing: Giriş yap");
    await expectNoHorizontalOverflow(page, "landing");

    // Demo girişi → /t/demo.
    await enter.click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ne yapmak istiyorsun?" })).toBeVisible();

    // Kartlar: 3 etkin bağlantı (yönetici), 6 "Yakında" kartı (depo işleri) tıklanamaz; kilitli kart yok.
    const tasks = page.getByRole("list", { name: "İşler" });
    await expect(tasks.locator('a[data-state="active"]')).toHaveCount(3);
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(6);
    await expect(tasks.locator('[data-state="locked"]')).toHaveCount(0);
    await expect(tasks.locator('[data-state="soon"]').first()).toContainText("Yakında");
    await expect(tasks.locator('a[data-state="soon"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "ana ekran");
    await expectNoCspViolations(page, "ana ekran");
    await expectTouchTarget(page, page.getByRole("button", { name: "Çıkış yap" }), "başlık: Çıkış yap");

    // Üyeler.
    await tasks.getByRole("link", { name: /Ekibimi yönet/ }).click();
    await expect(page).toHaveURL(/\/t\/demo\/members$/);
    await expect(page.getByRole("heading", { level: 1, name: "Üyeler" })).toBeVisible();
    await expect(page.getByTestId("member-card")).toHaveCount(5);
    // Demo kullanıcıları üzerinde işlemler kapalı + açıklama.
    await expect(page.getByText("Demo hesabında bu işlem kapalı.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Çıkar" }).first()).toBeDisabled();
    const invite = page.getByRole("button", { name: "Üye davet et" });
    await expectTouchTarget(page, invite, "üyeler: Üye davet et");
    await expect(invite).toBeEnabled();
    await expectNoHorizontalOverflow(page, "üyeler");
    await expectNoCspViolations(page, "üyeler");

    // Davet: demo tenant'ta tamamen kapalı (M9) — hata bildirimi görünür, bağlantı kutusu ÇIKMAZ.
    await invite.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("E-posta").fill(`e2e-${Date.now()}@smoke.example.invalid`);
    await dialog.getByRole("button", { name: "Davet gönder" }).click();
    await expect(dialog.getByText("Bu işlem yapılamadı.")).toBeVisible();
    await expect(dialog.getByText(/Hata kodu: FORBIDDEN/)).toBeVisible();
    await expect(page.getByTestId("link-box")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "davet penceresi");
    await dialog.getByRole("button", { name: "Kapat" }).click();
    await expect(dialog).toBeHidden();

    // Yenilemede bağlantı yok, bekleyen davet yok.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Üyeler" })).toBeVisible();
    await expect(page.getByTestId("link-box")).toHaveCount(0);
    await expect(page.getByTestId("pending-card")).toHaveCount(0);

    // Denetim kaydı: sayfa açılır, davet eylemi kaydedilmemiştir.
    await page.goto("/t/demo");
    await page.getByRole("list", { name: "İşler" }).getByRole("link", { name: /Kim ne yaptı\?/ }).click();
    await expect(page).toHaveURL(/\/t\/demo\/audit$/);
    await expect(page.getByRole("heading", { level: 1, name: "Kim ne yaptı?" })).toBeVisible();
    // Süzgeç seçeneği de aynı metni taşır; yalnızca kayıt satırları (tablo hücresi / mobil liste öğesi) sayılır.
    await expect(page.locator("td, li span").filter({ hasText: "Üye davet edildi" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "denetim kaydı");

    // Çıkış → /login; korumalı sayfa /login'e döner.
    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Giriş yap" })).toBeVisible();
    await page.goto("/t/demo/members");
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await expect(page.getByRole("heading", { name: "Giriş yap" })).toBeVisible();
  });

  test("salt okunur demo kullanıcısı: üye eylemleri kilitli + açıklama", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Salt okunur olarak gir" }).click();
    await expect(page).toHaveURL(/\/t\/demo$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ne yapmak istiyorsun?" })).toBeVisible();

    // Yönetim, ayar ve denetim kartları kilitli (bağlantı değil) + gerekçe.
    const tasks = page.getByRole("list", { name: "İşler" });
    await expect(tasks.locator('[data-state="locked"]')).toHaveCount(3);
    await expect(tasks.locator('a[data-state="active"]')).toHaveCount(0);
    await expect(tasks.locator('[data-state="locked"]').first()).toContainText("Bu iş için yetkin yok. Sorumluna sorabilirsin.");
    await expectNoHorizontalOverflow(page, "salt okunur ana ekran");

    // Üyeler sayfası doğrudan adresle: liste görünür, davet ve işlemler kilitli + açıklama.
    await page.goto("/t/demo/members");
    await expect(page.getByRole("heading", { level: 1, name: "Üyeler" })).toBeVisible();
    await expect(page.getByTestId("member-card")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Üye davet et" })).toBeDisabled();
    await expect(page.locator("#invite-locked")).toHaveText("Bu iş için yetkin yok. Sorumluna sorabilirsin.");
    await expect(page.getByRole("button", { name: "Çıkar" }).first()).toBeDisabled();
    await expect(page.getByText("Bekleyen davetleri yalnızca üye yönetimi yetkisi olanlar görebilir.")).toBeVisible();
    await expectNoHorizontalOverflow(page, "salt okunur üyeler");

    // Denetim kaydı yetkisi yok.
    await page.goto("/t/demo/audit");
    await expect(page.getByText("Denetim kaydını görmek için yetkin yok.")).toBeVisible();

    await page.getByRole("button", { name: "Çıkış yap" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
