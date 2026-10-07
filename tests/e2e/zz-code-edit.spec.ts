// T-257: kod değiştirme arayüzü (ürün / depo / lokasyon) 375 px mobil görünümde. Akış: kayıt oluştur → "Kodu değiştir" penceresi
// (eski → yeni önizleme, "geçmiş hareketler etkilenmez" açıklaması) → değişti bildirimi + "Geri al" → sunucu reddi (CODE_TAKEN) neden +
// sonraki eylemle pencerede kalır → ürün için ESKİ kodla arama yeni karta yönlenir ve "Bu kod X olarak değişti" der.
// Ortak demo tenant'a yalnızca mobile projesinde yazar (bkz. aşağıdaki not), ama kayıtlar kendi rastgele kodlarını taşır ve test sonunda arşivlenir (kolay kurulum rehberi etkin kayıt
// sayar: z-easy-setup boş tenant varsayımı bozulmaz; arşivli kodlar DEPO-/URN- öneri sayacını etkilemez). Ekran görüntüleri
// `.artifacts/t-257/` altına yazılır (git'e girmez).
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const OUT = ".artifacts/t-257";
const rnd = (): string => randomBytes(3).toString("hex").toUpperCase();

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

async function touchTarget(locator: Locator, name: string): Promise<void> {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${name}: boundingBox`).not.toBeNull();
  expect(box?.height ?? 0, `${name}: yükseklik`).toBeGreaterThanOrEqual(47.5);
  expect(box?.width ?? 0, `${name}: genişlik`).toBeGreaterThanOrEqual(47.5);
}

async function inViewport(page: Page, locator: Locator, name: string): Promise<void> {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  expect(box && vp && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0 && box.x + box.width <= vp.width, `${name}: görünüm içinde`).toBe(true);
}

/** Pencere açıkken: kaymaz, düğmeler ≥48 px ve görünüm içinde, açıklama görünür; sonra yeni kodu yazar. */
async function measureDialog(page: Page, dialog: Locator, where: string, shot: string): Promise<void> {
  await expect(dialog.getByText(/Geçmiş hareketler etkilenmez/)).toBeVisible();
  await noPageScroll(page, where);
  await touchTarget(dialog.getByRole("button", { name: "Kodu değiştir" }).or(dialog.locator('button[type="submit"]')), `${where}: Kodu değiştir`);
  await inViewport(page, dialog.getByRole("button", { name: "Vazgeç" }), `${where}: Vazgeç`);
  await inViewport(page, dialog.locator('button[type="submit"]'), `${where}: gönder`);
  await touchTarget(dialog.locator('input[name="newCode"]'), `${where}: kod alanı`);
  await page.screenshot({ path: `${OUT}/${shot}.png` });
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
}

test("kod değiştir: depo, lokasyon, ürün; eski kodla arama yeni karta yönlenir (375 px)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = testInfo.project.name;
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // Ortak demo tenant'ı yalnızca SON proje (mobile) yazar (z-easy-setup ile aynı kural): ADET birimi gibi kalıcı kayıtlar, boş tenant
  // bekleyen z-easy-setup'ın mobile koşusunu bozar. Masaüstü koşusu yazmaz; yalnızca ilgili ekranların taşmadığını ölçer.
  if (tag !== "mobile") {
    for (const route of ["/t/demo/warehouses", "/t/demo/items"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await noHorizontalOverflow(page, `${route} (yazmayan koşu)`);
    }
    return;
  }

  const id = rnd();
  const whCode = `KEW-${id}`;
  const whNew = `KEW-${id}-B`;
  const itemCode = `KEI-${id}`;
  const itemNew = `KEI-${id}-B`;
  const itemName = `Kod deneme ${id}`;
  const locA = `KEL-${id}-A`;
  const locB = `KEL-${id}-B`;
  const locNew = `KEL-${id}-C`;
  let itemUrl: string | null = null;
  let whUrl: string | null = null;

  try {
    // --- Depo: oluştur, kodu değiştir, geri al ---
    await page.goto("/t/demo/warehouses?new=1");
    const create = page.getByRole("dialog");
    await expect(create.locator('input[name="code"]')).toHaveValue(/^DEPO-\d{2}$/); // öneri hazır, sonra özel kod yazılır
    await create.locator('input[name="name"]').fill(`KE Depo ${id}`);
    await create.locator('input[name="code"]').fill(whCode);
    await create.getByRole("button", { name: "Kaydet" }).click();
    await page.waitForLoadState("networkidle");
    await page.goto("/t/demo/warehouses");
    const card = page.getByTestId("warehouse-card").filter({ hasText: whCode });
    await expect(card).toHaveCount(1);
    whUrl = new URL((await card.getByRole("link", { name: "Aç" }).getAttribute("href")) ?? "", page.url()).pathname;

    const whEdit = card.getByRole("button", { name: `KE Depo ${id} için kodu değiştir` });
    await touchTarget(whEdit, "depo satırı: Kodu değiştir");
    await noHorizontalOverflow(page, "depo listesi");
    await whEdit.click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByText(`Şimdiki kod: ${whCode}`)).toBeVisible();
    await expect(dlg.locator('button[type="submit"]')).toBeDisabled(); // aynı kodla gönderilemez
    await dlg.locator('input[name="newCode"]').fill(whNew.toLowerCase());
    await expect(dlg.getByTestId("code-edit-preview")).toContainText(`${whCode} → ${whNew.toLowerCase()}`);
    await measureDialog(page, dlg, "depo penceresi 375", `${tag}-375-warehouse-dialog`);
    await dlg.locator('button[type="submit"]').click();
    await expect(page.getByText(`Kod değişti: ${whCode} → `)).toBeVisible();
    await expect(page.getByTestId("warehouse-card").filter({ hasText: whNew })).toHaveCount(1); // sunucu büyük harfe çevirdi (A-98)
    await page.getByRole("button", { name: /Geri al/ }).click();
    await expect(page.getByText("Kod eski haline döndü.")).toBeVisible();
    await expect(page.getByTestId("warehouse-card").filter({ hasText: whCode }).filter({ hasNotText: whNew })).toHaveCount(1);

    // --- Lokasyon: iki raf; ikincisini birincinin koduna çevirmek sunucuda reddedilir ---
    await page.goto(whUrl);
    for (const [code, name] of [[locA, "KE Raf A"], [locB, "KE Raf B"]] as const) {
      await page.getByRole("button", { name: "Lokasyon ekle" }).first().click();
      const d = page.getByRole("dialog");
      await expect(d.locator('input[name="code"]')).not.toHaveValue("");
      await d.locator('input[name="name"]').fill(name);
      await d.locator('input[name="code"]').fill(code);
      await d.getByRole("button", { name: "Kaydet" }).click();
      await expect(page.getByTestId("location-row").filter({ hasText: code })).toHaveCount(1);
    }
    const rowB = page.getByTestId("location-row").filter({ hasText: locB });
    await touchTarget(rowB.getByRole("button", { name: "KE Raf B için kodu değiştir" }), "lokasyon satırı: Kodu değiştir");
    await noHorizontalOverflow(page, "lokasyon ağacı");
    await rowB.getByRole("button", { name: "KE Raf B için kodu değiştir" }).click();
    dlg = page.getByRole("dialog");
    await dlg.locator('input[name="newCode"]').fill(locA);
    await dlg.locator('button[type="submit"]').click();
    // N-06: neden + sonraki eylem; pencere ve yazılan değer korunur.
    await expect(dlg.getByText(/Bu kod zaten kullanılıyor\. Farklı bir kod gir\./)).toBeVisible();
    await expect(dlg.locator('input[name="newCode"]')).toHaveValue(locA);
    await page.screenshot({ path: `${OUT}/${tag}-375-location-error.png` });
    await dlg.locator('input[name="newCode"]').fill(locNew);
    await measureDialog(page, dlg, "lokasyon penceresi 375", `${tag}-375-location-dialog`);
    await dlg.locator('button[type="submit"]').click();
    await expect(page.getByText(`Kod değişti: ${locB} → `)).toBeVisible();
    await expect(page.getByTestId("location-row").filter({ hasText: locNew })).toHaveCount(1);

    // --- Ürün: oluştur, kodu değiştir ---
    await page.goto("/t/demo/items?new=1");
    const ic = page.getByRole("dialog");
    await expect(ic.locator('input[name="code"]')).toHaveValue(/^URN-\d{4}$/);
    await ic.locator('input[name="name"]').fill(itemName);
    await ic.locator('input[name="code"]').fill(itemCode);
    await ic.getByRole("button", { name: "Kaydet" }).click();
    await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}$/);
    itemUrl = new URL(page.url()).pathname;
    const itemEdit = page.getByRole("button", { name: `${itemName} için kodu değiştir` });
    await touchTarget(itemEdit, "ürün kartı: Kodu değiştir");
    await noHorizontalOverflow(page, "ürün kartı");
    await itemEdit.click();
    dlg = page.getByRole("dialog");
    await dlg.locator('input[name="newCode"]').fill(itemNew);
    await measureDialog(page, dlg, "ürün penceresi 375", `${tag}-375-item-dialog`);
    await dlg.locator('button[type="submit"]').click();
    await expect(page.getByText(`Kod değişti: ${itemCode} → ${itemNew}.`)).toBeVisible();
    await expect(page.getByText(`Kod: ${itemNew}`)).toBeVisible();
    await touchTarget(page.getByRole("button", { name: /Geri al/ }), "ürün: Geri al");
    await noHorizontalOverflow(page, "ürün kartı (değişti)");
    await page.screenshot({ path: `${OUT}/${tag}-375-item-changed.png`, fullPage: true });

    // --- Eski kodla arama yeni karta yönlenir; "bu kod X olarak değişti" bilgisi görünür ---
    await page.goto("/t/demo/items");
    await page.getByRole("searchbox", { name: "Ürün ara" }).fill(itemCode);
    const option = page.getByRole("option").first();
    await expect(option).toContainText(itemName);
    await expect(option).toContainText(`Bu kod ${itemNew} olarak değişti`);
    await touchTarget(option, "arama önerisi");
    await noHorizontalOverflow(page, "eski kodla arama");
    await page.screenshot({ path: `${OUT}/${tag}-375-old-code-search.png` });
    await option.click();
    await expect(page).toHaveURL(new RegExp(`${itemUrl}$`));
    await expect(page.getByRole("heading", { level: 1, name: itemName })).toBeVisible();
    await expect(page.getByText(`Kod: ${itemNew}`)).toBeVisible();
  } finally {
    // Temizlik: kayıtlar arşivlenir (rehber ve öneri sayaçları değişmez). Hata yutulmaz ama asıl hatayı gölgelemez.
    if (itemUrl !== null) {
      await page.goto(itemUrl);
      await page.getByRole("button", { name: "Ürünü arşivle" }).or(page.getByRole("button", { name: "Arşivle" })).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Arşivle" }).click();
      await expect(page.getByText("Ürün arşivlendi.")).toBeVisible();
    }
    if (whUrl !== null) {
      await page.goto(whUrl);
      for (const code of [locA, locNew]) {
        const row = page.getByTestId("location-row").filter({ hasText: code });
        if ((await row.count()) === 0) continue;
        await row.getByRole("button", { name: "Arşivle" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Arşivle" }).click();
        await expect(page.getByText("Lokasyon arşivlendi.")).toBeVisible();
      }
      await page.goto("/t/demo/warehouses");
      const card = page.getByTestId("warehouse-card").filter({ hasText: whCode });
      if ((await card.count()) > 0) {
        await card.getByRole("button", { name: "Arşivle" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Arşivle" }).click();
        await expect(page.getByText("Depo arşivlendi.")).toBeVisible();
      }
    }
  }
});
