// T-131: demo akışı duman testi (masaüstü + mobil). Yerelde `global-setup.ts` yığını kurar; `E2E_BASE_URL` ile staging'e karşı da koşar.
// Beklenen davranışlar A-43 ve kod ile hizalıdır: `is_demo` tenant'ta davet KAPALI (inviteMember, M9), demo kullanıcıları
// üzerinde rol/çıkarma/devir/sıfırlama KAPALI. Karttaki "davet → bağlantı kutusu → member.invited" zinciri demo tenant'ta
// üretilemez; bu testte davetin reddi doğrulanır (rapor: "kart eki gerekli").
import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

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

/** Belirteç taşıyan yol parçaları (davet, parola sıfırlama vb.) ve uzun belirteç benzeri dizgiler maskelenir (G-09). */
const TOKEN_PATH = /\/(invite|reset-password|verify-email|magic-link)\/[^/?#\s"')]+/g;
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}/g;
function maskTokens(raw: string): string {
  return raw.replace(TOKEN_PATH, "/$1/[token]").replace(TOKEN_LIKE, "[redacted]");
}

/** Sorgu/parça atılır, yol belirteçleri maskelenir (G-09: URL'de belirteç olsa bile loga girmez). */
function stripUrl(raw: string): string {
  return maskTokens(raw.split("#")[0]?.split("?")[0] ?? raw);
}

/** Serbest metindeki (konsol, pageerror, CSP blockedURI) URL'ler `stripUrl`'den geçer; kalan metinde belirteçler maskelenir. */
function scrubText(raw: string): string {
  return maskTokens(raw.replace(/https?:\/\/[^\s"'<>)\\]+/g, (u) => stripUrl(u)));
}

/**
 * T-247 tanılama: konsol hataları, `pageerror` ve başarısız/4xx-5xx istekler (yalnızca URL + durum; başlık/çerez/gövde yok).
 * Başarısızlıkta `testInfo.attach` + `console.log` ile yazılır; assertion'lara dokunmaz.
 */
function collectDiagnostics(page: Page): () => Promise<unknown> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${scrubText(m.text()).slice(0, 500)} @ ${stripUrl(m.location().url)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(scrubText(String(e.message)).slice(0, 500)));
  page.on("requestfailed", (r) => failed.push(`FAILED ${r.method()} ${stripUrl(r.url())} ${scrubText(r.failure()?.errorText ?? "")}`));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${stripUrl(r.url())}`);
  });
  return async () => {
    let state: unknown = "sayfa kapalı";
    try {
      // Dize ifadesi (DOM tipleri yok). `hydrated`: React, düğmeye `__reactProps$` özelliğini yalnızca hidrasyondan sonra ekler.
      state = await page.evaluate(`(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent && x.textContent.includes("Üye davet et"));
        const scripts = [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src").split("?")[0]);
        const res = performance.getEntriesByType("resource").filter((e) => /\\/_next\\/static\\//.test(e.name)).map((e) => ({ n: e.name.split("?")[0].split("/").pop(), dur: Math.round(e.duration), size: e.transferSize, st: e.responseStatus }));
        return {
          url: location.pathname, readyState: document.readyState,
          inviteButton: b ? { hydrated: Object.keys(b).some((k) => k.startsWith("__reactProps")), disabled: b.disabled } : null,
          dialogs: document.querySelectorAll("dialog").length, dialogOpen: [...document.querySelectorAll("dialog")].map((d) => d.open),
          scriptTags: scripts.length, scriptsWithNonce: document.querySelectorAll("script[nonce]").length,
          buildHints: scripts.slice(0, 3), staticResources: res.length, staticResourcesBad: res.filter((r) => !r.st || r.st >= 400),
          csp: window.__csp || [],
        };
      })()`);
    } catch (e) {
      state = `durum okunamadı: ${String(e).slice(0, 200)}`;
    }
    return { consoleErrors, pageErrors, failed, state };
  };
}

async function reportDiagnostics(testInfo: TestInfo, flush: () => Promise<unknown>): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  // Son savunma: tüm çıktı (sayfa durumu, CSP blockedURI dahil) maskelenir.
  const payload: unknown = JSON.parse(scrubText(JSON.stringify(await flush())));
  const body = JSON.stringify(payload, null, 2);
  await testInfo.attach("t247-diagnostics.json", { body, contentType: "application/json" });
  console.log(`T247-DIAG ${testInfo.project.name} ${JSON.stringify(payload)}`);
}

test.describe("demo akışı", () => {
  let flush: () => Promise<unknown> = () => Promise.resolve(null);
  test.beforeEach(({ page }) => {
    flush = collectDiagnostics(page);
  });
  test.afterEach(async ({ page }, testInfo) => {
    if (!page.isClosed()) await reportDiagnostics(testInfo, flush);
  });

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

    // Kartlar: 4 etkin bağlantı (yönetici; "Depo ve raflar" T-207 ile EKLENDİ, mevcut kartlar değişmedi), 6 "Yakında" kartı (depo işleri) tıklanamaz; kilitli kart yok.
    const tasks = page.getByRole("list", { name: "İşler" });
    await expect(tasks.locator('a[data-state="active"]')).toHaveCount(4);
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(6);
    const warehousesCard = tasks.locator('a[data-state="active"]').filter({ hasText: "Depo ve raflar" });
    await expect(warehousesCard).toHaveCount(1);
    await expect(warehousesCard).toHaveAttribute("href", "/t/demo/warehouses");
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
    // Yalnızca "Depo ve raflar" etkin (okuma `stock.view`; yazma kilidi hedef sayfada), hedef rotası doğrulanır.
    await expect(tasks.locator('a[data-state="active"]')).toHaveCount(1);
    await expect(tasks.locator('a[data-state="active"]').first()).toContainText("Depo ve raflar");
    await expect(tasks.locator('a[data-state="active"]').first()).toHaveAttribute("href", "/t/demo/warehouses");
    await expect(tasks.locator('[data-state="soon"]')).toHaveCount(6);
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
