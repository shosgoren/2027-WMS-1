// T-279: boş tenant fikstürü istemcisi. Fikstür `tests/e2e/global-setup.ts` içinde (yerel koşuda) kurulur: boş çalışma alanı + DEMO OLMAYAN bir
// TENANT_ADMIN (gerçek davet kabulü + gerçek MFA kurulumu; MFA kuralı access.ts:92-96 aynen geçerli). Kimlik bilgileri YALNIZCA `process.env`'dedir
// (bellek; parola ve TOTP sırrı her koşuda rastgele, diske/loga/trace'e yazılmaz, G-09). Uzak koşuda (E2E_BASE_URL) fikstür YOKTUR: bu modülü
// kullanan spec dosyaları `playwright.config.ts` `testIgnore` ile dışlanır.
//
// G-09 yöntemi: (1) parola ve kod `locator.fill` ile DEĞİL `keyboard.type` ile yazılır (`fill` hata çağrı günlüğüne değeri basar);
// (2) parolayı/kodu yazan spec'ler `test.use({ trace: "off" })` kullanır (Playwright izi eylem parametrelerini ve DOM görüntülerini saklar);
// (3) kurulum (davet kabulü, MFA, TOTP sırrını ekrandan okuma) global-setup'ta, izsiz, ayrı bir tarayıcı bağlamında yapılır.
import { createHmac } from "node:crypto";
import { expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

export interface EmptyTenant {
  readonly slug: string;
  readonly email: string;
  readonly password: string;
  readonly totpSecret: string;
}

export function emptyTenant(): EmptyTenant {
  const slug = process.env.E2E_EMPTY_SLUG;
  const email = process.env.E2E_EMPTY_INVITEE_EMAIL;
  const password = process.env.E2E_EMPTY_PASSWORD;
  const totpSecret = process.env.E2E_EMPTY_TOTP_SECRET;
  if (!slug || !email || !password || !totpSecret) {
    throw new Error("e2e: boş tenant fikstürü yok (global-setup yerel yığında kurar; uzak koşuda bu spec dışlanır)");
  }
  return { slug, email, password, totpSecret };
}

/** Yerel TLS vekili için test istemci adresi (TEST-NET-2); uzak hedefte başlık eklenmez (playwright.config.ts localClient ile aynı koşul). */
export function localClient(ip: string): { extraHTTPHeaders?: Record<string, string> } {
  return process.env.E2E_BASE_URL?.trim() ? {} : { extraHTTPHeaders: { "x-e2e-client-ip": ip } };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("e2e: TOTP sırrı base32 değil");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 sn, 6 hane; sunucu varsayılanı: better-auth `createOTP` period 30, digits 6). Sunucu ±1 pencere kabul eder ve
 * kullanılmış kodu tekrar reddetmez (better-auth totp doğrulaması yalnızca `createOTP(...).verify` çağırır, tüketim kaydı yok); bu yüzden her çağrı
 * o anki pencerenin kodunu üretir ve pencere sınırı yarışı ±1 toleransla karşılanır: bekleme ya da zaman aşımı artırımı gerekmez.
 */
export function totpNow(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = (h[h.length - 1] ?? 0) & 0x0f;
  const bin = (((h[off] ?? 0) & 0x7f) << 24) | (((h[off + 1] ?? 0) & 0xff) << 16) | (((h[off + 2] ?? 0) & 0xff) << 8) | ((h[off + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Gizli değeri alana yazar: `fill` değil klavye (hata çağrı günlüğüne değer girmez; bkz. dosya başı). */
async function typeSecret(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).focus();
  await page.keyboard.type(value);
}

/** Normal e-posta/parola giriş formu + iki adım (TOTP) ekranı; girişten sonra kiracı ana ekranı. */
export async function loginEmptyTenant(page: Page): Promise<EmptyTenant> {
  const t = emptyTenant();
  await page.goto(`/login?next=${encodeURIComponent(`/t/${t.slug}`)}`);
  await page.getByLabel("E-posta").fill(t.email);
  await typeSecret(page, 'input[name="password"]', t.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/mfa\?/);
  await typeSecret(page, 'input[name="code"]', totpNow(t.totpSecret));
  await page.getByRole("button", { name: "Doğrula" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${t.slug}$`));
  return t;
}

export interface EnrollInput {
  readonly browser: Browser;
  readonly baseURL: string;
  /** Yalnızca yerel vekil için TEST-NET-2 istemci adresi (kendi hız sınırı kovası). */
  readonly clientIp: string;
  readonly inviteToken: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Davet kabulü + MFA kurulumu: uygulamanın gerçek ekranlarından (DB'ye doğrudan yazı yok, MFA kuralı değişmez). İzsiz bağlam (tracing
 * hiç başlatılmaz). TOTP sırrı yalnızca bellekte okunur ve döner; çağıran `process.env`'e koyar.
 */
export async function acceptInviteAndEnrollMfa(input: EnrollInput): Promise<{ totpSecret: string }> {
  const context = await input.browser.newContext({
    baseURL: input.baseURL,
    ignoreHTTPSErrors: true,
    locale: "tr-TR",
    extraHTTPHeaders: { "x-e2e-client-ip": input.clientIp },
  });
  try {
    const page = await context.newPage();
    // 1) Davet kabulü (hesap açma): ad + parola.
    await page.goto(`/invite/${input.inviteToken}`);
    await page.locator('input[name="name"]').fill(input.name);
    await typeSecret(page, 'input[name="password"]', input.password);
    await page.getByRole("button", { name: "Hesap oluştur ve kabul et" }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    // 2) Giriş → kiracı yönetici olduğu için MFA kurulum ekranına yönlenir (A-38).
    await page.getByLabel("E-posta").fill(input.email);
    await typeSecret(page, 'input[name="password"]', input.password);
    await page.getByRole("button", { name: "Giriş yap" }).click();
    await expect(page).toHaveURL(/\/mfa\?/);
    // 3) MFA kurulumu: parola onayı → anahtarı ekrandan oku → yedek kod onayı → ilk kod.
    await typeSecret(page, 'input[name="password"]', input.password);
    await page.getByRole("button", { name: "Kuruluma başla" }).click();
    const secret = ((await page.locator("code").first().textContent()) ?? "").trim();
    expect(secret, "TOTP anahtarı ekranda").toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByRole("checkbox").check();
    await typeSecret(page, 'input[name="code"]', totpNow(secret));
    await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
    await expect(page.getByText("İki adımlı doğrulama etkinleştirildi.")).toBeVisible();
    return { totpSecret: secret };
  } finally {
    await context.close();
  }
}
