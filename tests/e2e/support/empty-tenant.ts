// T-279: boş tenant fikstürü istemcisi. Fikstür `tests/e2e/global-setup.ts` içinde (yerel koşuda) kurulur: demo OLMAYAN bir hesap, uygulamanın
// kendi yoluyla (kayıt ucu + kurulum sihirbazı, M9 koruması etkin) boş bir çalışma alanı açar ve MFA'yı gerçek ekrandan kurar; çalışma alanının sahibi
// TENANT_ADMIN'dir. MFA kuralı (access.ts:92-96) aynen geçerlidir. Kimlik bilgileri YALNIZCA `process.env`'dedir (bellek; parola ve TOTP sırrı her
// koşuda rastgele, diske/loga/rapora/trace'e yazılmaz, G-09). Uzak koşuda (E2E_BASE_URL) fikstür YOKTUR: bu modülü kullanan spec dosyaları
// `playwright.config.ts` `testIgnore` ile dışlanır.
//
// G-09 yöntemi: Playwright her API çağrısını (fill/type/press) değeriyle adım başlığına, rapora, çağrı günlüğüne ve trace'e yazar. Bu yüzden gizli
// değer HİÇBİR Playwright çağrısına parametre olmaz: sayfaya `exposeFunction` ile yalnızca bir işlev adı verilir, sayfa içi sabit bir betik değeri
// o işlevden alıp alana yazar (değer yalnızca sayfa <-> süreç arasında, API parametresi olmadan akar). Hata iletilerine gizli değer girmez.
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
  const email = process.env.E2E_EMPTY_EMAIL;
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

export interface SecretSource {
  readonly password: string;
  /** MFA kurulumundan sonra bilinir. */
  totpSecret?: string;
}

/** Sayfaya gizli değer kaynağını bağlar (sayfa başına bir kez; gezinmelerde kalır). Değerler Playwright API parametresi değildir. */
async function bindSecrets(page: Page, src: SecretSource): Promise<void> {
  await page.exposeFunction("__e2eSecret", (kind: string): string => {
    if (kind === "password") return src.password;
    if (kind === "totp" && src.totpSecret !== undefined) return totpNow(src.totpSecret);
    throw new Error("e2e: bilinmeyen gizli değer türü");
  });
}

/** Alana, bağlı kaynaktan gelen gizli değeri yazar (React'in `input` olayı dahil). Betik sabittir; yalnızca seçici ve tür adı geçer. */
async function fillSecret(page: Page, selector: string, kind: "password" | "totp"): Promise<void> {
  await page.locator(selector).waitFor();
  await page.evaluate(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const value = await window.__e2eSecret(${JSON.stringify(kind)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

/** Normal e-posta/parola giriş formu + iki adım (TOTP) ekranı; girişten sonra kiracı ana ekranı. */
export async function loginEmptyTenant(page: Page): Promise<EmptyTenant> {
  const t = emptyTenant();
  await bindSecrets(page, { password: t.password, totpSecret: t.totpSecret });
  await page.goto(`/login?next=${encodeURIComponent(`/t/${t.slug}`)}`);
  await page.getByLabel("E-posta").fill(t.email);
  await fillSecret(page, 'input[name="password"]', "password");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/mfa\?/);
  await fillSecret(page, 'input[name="code"]', "totp");
  await page.getByRole("button", { name: "Doğrula" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${t.slug}$`));
  return t;
}

export interface ProvisionInput {
  readonly browser: Browser;
  /** Kayıt açık (WMS_ENV=ci, SIGNUP_ENABLED=true) ikinci web örneğinin https kökü (tek aşım: workspaceCreationAllowed ortam kapısı). */
  readonly origin: string;
  /** Yalnızca yerel vekil için TEST-NET-2 istemci adresi (kendi hız sınırı kovası). */
  readonly clientIp: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly workspaceName: string;
}

/**
 * Hesap + çalışma alanı + MFA: uygulamanın kendi yolundan (kayıt ucu, kurulum sihirbazı, MFA kurulum ekranı). DB'ye doğrudan yazı yok; M9 ve
 * MFA kuralları değişmez. Tracing hiç başlatılmaz (global-setup); gizli değerler Playwright API parametresi olmaz (dosya başı). TOTP sırrı
 * yalnızca bellekte okunur ve döner; çağıran `process.env`'e koyar.
 */
export async function provisionEmptyTenant(input: ProvisionInput): Promise<{ slug: string; totpSecret: string }> {
  const context = await input.browser.newContext({
    baseURL: input.origin,
    ignoreHTTPSErrors: true,
    locale: "tr-TR",
    extraHTTPHeaders: { "x-e2e-client-ip": input.clientIp },
  });
  try {
    const page = await context.newPage();
    const src: SecretSource = { password: input.password };
    await bindSecrets(page, src);
    // 1) Hesap: Better Auth kayıt ucu (yalnızca local/ci'da açık, A-50). Gövde sayfa içinden gider: değer API parametresi olmaz.
    await page.goto("/login");
    const signedUp = await page.evaluate<number>(`(async () => {
      const password = await window.__e2eSecret("password");
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: ${JSON.stringify(input.name)}, email: ${JSON.stringify(input.email)}, password }),
      });
      return res.status;
    })()`);
    expect(signedUp, "kayıt ucu durum kodu").toBe(200);
    // 2) Çalışma alanı: kurulum sihirbazı (createWorkspace; M9 etkin, demo olmayan e-posta).
    await page.goto("/onboarding");
    await page.getByLabel("Çalışma alanı adı").fill(input.workspaceName);
    await page.getByRole("button", { name: "Devam" }).click();
    await page.getByRole("button", { name: "Oluştur" }).click();
    // TENANT_ADMIN MFA ister: kiracı düzeni kurulum ekranına yönlendirir (A-38).
    await expect(page).toHaveURL(/\/mfa\?next=/);
    const slug = /^\/t\/([^/]+)\//.exec(new URL(new URL(page.url()).searchParams.get("next") ?? "", page.url()).pathname)?.[1] ?? "";
    expect(slug !== "", "çalışma alanı adresi").toBe(true);
    // 3) MFA kurulumu: parola onayı → anahtarı ekrandan oku → yedek kod onayı → ilk kod.
    await fillSecret(page, 'input[name="password"]', "password");
    await page.getByRole("button", { name: "Kuruluma başla" }).click();
    const secret = ((await page.locator("code").first().textContent()) ?? "").trim();
    expect(/^[A-Z2-7]{16,}$/.test(secret), "TOTP anahtarı ekranda").toBe(true); // ileti sırrı içermez
    src.totpSecret = secret;
    await page.getByRole("checkbox").check();
    await fillSecret(page, 'input[name="code"]', "totp");
    await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
    await expect(page.getByText("İki adımlı doğrulama etkinleştirildi.")).toBeVisible();
    return { slug, totpSecret: secret };
  } finally {
    await context.close();
  }
}
