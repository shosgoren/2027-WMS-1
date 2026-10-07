// T-246b: güven paleti ekran kanıtı (ADR-020). 375x812 ve 1280x800; Akış ve Kokpit; landing + demo girişi sonrası ana ekran.
// Piksel karşılaştırma yok: hesaplanan stil değerleri belirteçlerle eşlenir, ekran görüntüleri .artifacts/t-246b/ altına yazılır.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { enterDemoShared } from "./support/demo-session.ts";

const OUT = path.resolve(import.meta.dirname, "../../.artifacts/t-246b");
const SIZES = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;
const VIEWS = [
  { key: "flow", label: "Akış" },
  { key: "cockpit", label: "Kokpit" },
] as const;

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const m = await page.evaluate<{ scroll: number; client: number }>("({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })");
  expect(m.scroll, `${where}: scrollWidth(${m.scroll}) <= clientWidth(${m.client})`).toBeLessThanOrEqual(m.client);
}

/** Belirtecin (`--color-*`) hesaplanan rengi: geçici öğeye uygulanıp `rgb()` biçimine çözülür. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate<string>(
    `(() => { const e = document.createElement("i"); e.style.backgroundColor = "var(--color-${token})"; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; })()`,
  );
}

async function computed(page: Page, selector: string, prop: string): Promise<string> {
  // Dize ifadesi: kök tsconfig'de DOM tipleri yok; ifade tarayıcıda çalışır.
  return page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(prop)})`);
}

async function selectView(page: Page, label: string): Promise<void> {
  // T-254: telefon genişliğinde görünüm anahtarı menüdedir; önce menü açılır, aynı düğme kullanılır (beklenen davranış aynı).
  const menuButton = page.getByTestId("app-bar-menu");
  const inMenu = await menuButton.isVisible();
  if (inMenu) await menuButton.click();
  const button = page.getByRole("button", { name: label, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  if (inMenu) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
}

async function expectFocusRing(page: Page, locator: ReturnType<Page["locator"]>, where: string): Promise<void> {
  await page.keyboard.press("Tab"); // klavye etkileşimi: :focus-visible tetiklenir
  await locator.focus();
  const style = await page.evaluate<{ style: string; color: string }>(
    "(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, color: s.outlineColor }; })()",
  );
  expect(style.style, `${where}: outline-style`).toBe("solid");
  expect(style.color, `${where}: outline-color = --color-focus`).toBe(await tokenColor(page, "focus"));
}

for (const size of SIZES) {
  test.describe(`güven paleti ${size.width}px`, () => {
    test.use({ viewport: size });

    test("Akış ve Kokpit: landing ve demo girişi sonrası ana ekran", async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      const accents: Record<string, string> = {};

      // Landing (oturumsuz): her iki görünümde. Demo girişi hız sınırlı olduğundan ana ekran için tek giriş yapılır.
      for (const view of VIEWS) {
        await page.goto("/");
        await selectView(page, view.label);
        await expect(page.locator("html")).toHaveAttribute("data-view", view.key);

        // Birincil düğme `accent` zeminli, odak halkası `focus`.
        const primary = page.getByRole("link", { name: "Giriş yap" });
        await expect(primary).toBeVisible();
        const accent = await tokenColor(page, "accent");
        await expect(primary).toHaveCSS("background-color", accent);
        await expectFocusRing(page, primary, `${view.key} landing`);
        accents[view.key] = accent;
        await expectNoHorizontalOverflow(page, `${view.key} ${size.width} landing`);
        await page.screenshot({ path: path.join(OUT, `${view.key}-${size.width}-landing.png`), fullPage: true });
      }

      // Demo girişi → ana ekran; görünüm anahtarı ile Kokpit sonra Akış.
      await enterDemoShared(page, "Yönetici");
      await expect(page).toHaveURL(/\/t\/demo$/);
      const tasks = page.getByRole("list", { name: "İşler" });
      await expect(tasks).toBeVisible();

      for (const view of [...VIEWS].reverse()) {
        await selectView(page, view.label);
        await expect(page.locator("html")).toHaveAttribute("data-view", view.key);
        await expect(tasks).toBeVisible();

        // Kart ikonları Lucide (svg.lucide), dekoratif; üst bar logosu `accent` zeminli.
        const icons = tasks.locator("svg.lucide");
        expect(await icons.count(), "kart ikonları (svg.lucide)").toBeGreaterThanOrEqual(9);
        await expect(icons.first()).toHaveAttribute("aria-hidden", "true");
        expect(await computed(page, "header span.bg-accent", "background-color"), "logo kabı = accent").toBe(accents[view.key]);
        await expectFocusRing(page, tasks.getByRole("link").first(), `${view.key} ana ekran`);
        await expectNoHorizontalOverflow(page, `${view.key} ${size.width} ana ekran`);
        await page.screenshot({ path: path.join(OUT, `${view.key}-${size.width}-ana-ekran.png`), fullPage: true });
      }

      expect(accents.cockpit, "Kokpit vurgusu Akış'tan farklı").not.toBe(accents.flow);
    });
  });
}
