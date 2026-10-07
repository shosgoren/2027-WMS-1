// T-300: uzak koşuda (E2E_BASE_URL) demo girişi hız sınırı ve oturum yeniden kullanımı.
//
// Sorun: demo girişi istemci IP'si başına 10 giriş / 10 dk ile sınırlıdır (packages/auth RATE_LIMIT_RULES.signIn; pencere her kabul edilen
// istekle kayar). GitHub runner'ında tek IP vardır ve uzak koşuda yerel TLS vekili (T-278 başlığı) yoktur. Çözüm (sınır DEĞİŞMEZ, G-11):
//   1. global-setup yönetici için BİR KEZ gerçek ekrandan girer; oturum `storageState` olarak `.artifacts/session/` altına yazılır.
//      Bu dizin iş akışının yüklediği `.artifacts/e2e/` DIŞINDADIR (G-09: oturum çerezi artifact'a girmez); trace uzakta kapalıdır.
//   2. Çıkış yapmayan spec'ler `enterDemoShared` ile bu oturumu çerez olarak benimser (giriş yapmaz).
//   3. Çıkış yapan / girişi sınayan spec'ler `enterDemoReal` ile gerçek giriş yapar; her giriş bir deftere yazılır ve sınıra
//      dayanılmışsa pencerenin dolması beklenir (istemci tarafı uyum; sunucu kuralı gevşetilmez).
// Yerel koşuda (E2E_BASE_URL yok) iki yardımcı da eski davranışın aynısıdır: landing'deki düğmeye tıklar; defter/oturum dosyası yoktur.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type Browser, type Page, expect, test } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
/** Artifact'a YÜKLENMEYEN dizin (iş akışı yalnızca `.artifacts/e2e/` yükler). */
export const SESSION_DIR = path.join(ROOT, ".artifacts/session");
const LEDGER = path.join(SESSION_DIR, "logins.log");
const STATE_FILE = path.join(SESSION_DIR, "admin.json");

/** Ayna: packages/auth/src/index.ts `RATE_LIMIT_RULES.signIn` (window 10 dk, max 10). Sunucu kuralı bu dosyadan DEĞİŞMEZ. */
const SIGN_IN_MAX = 10;
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const SAFETY_MS = 5_000;

export function isRemote(): boolean {
  return Boolean(process.env.E2E_BASE_URL?.trim());
}

export type DemoRoleLabel = "Yönetici" | "Salt okunur" | "Toplayıcı";

/** Defterdeki zaman damgalarından, şimdi yapılacak girişin ne kadar bekleyeceğini hesaplar (saf işlev; birim testlenebilir). */
export function waitMsForNextLogin(stamps: readonly number[], now: number, max = SIGN_IN_MAX, windowMs = SIGN_IN_WINDOW_MS): number {
  const sorted = [...stamps].sort((a, b) => a - b);
  // Sunucu sayacı, son kabul edilen istekten `windowMs` geçince sıfırlanır: ardışık (aralığı < pencere) girişler tek koşudur.
  let run = 0;
  let prev: number | undefined;
  for (const s of sorted) {
    run = prev === undefined || s - prev < windowMs ? run + 1 : 1;
    prev = s;
  }
  if (prev === undefined || now - prev >= windowMs) return 0;
  if (run < max) return 0;
  return prev + windowMs - now + SAFETY_MS;
}

function readLedger(): number[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function recordLogin(): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  appendFileSync(LEDGER, `${Date.now()}\n`, { mode: 0o600 });
}

async function waitForLoginSlot(): Promise<void> {
  const wait = waitMsForNextLogin(readLedger(), Date.now());
  if (wait <= 0) return;
  // Test içindeyse zaman aşımı beklemeyle uzatılır (test başına 60 sn sınırı beklemeyi kesmesin).
  try {
    test.setTimeout(test.info().timeout + wait);
  } catch {
    // test dışında (global-setup): zaman aşımı yok
  }
  console.log(`T300-WAIT demo giriş kotası dolu: ${Math.ceil(wait / 1000)} sn bekleniyor (istemci başına ${SIGN_IN_MAX} giriş / ${SIGN_IN_WINDOW_MS / 60000} dk)`);
  await new Promise((r) => setTimeout(r, wait));
}

/**
 * Gerçek giriş: landing'deki "<rol> olarak gir" düğmesine tıklar (sayfa landing'de olmalıdır). Uzak koşuda önce kota beklenir ve giriş deftere yazılır.
 * Çıkış yapan testler ve girişi sınayan test (demo-flow) bunu kullanır.
 */
export async function enterDemoReal(page: Page, label: DemoRoleLabel): Promise<void> {
  const button = page.getByRole("button", { name: `${label} olarak gir` });
  if (isRemote()) {
    await waitForLoginSlot();
    recordLogin();
  }
  await button.click();
}

/**
 * Çıkış yapmayan spec'ler için: uzakta global-setup'ın yönetici oturumunu çerez olarak benimser ve ana ekrana gider (yeni giriş yok);
 * yerelde eski davranış (landing'deki düğmeye tıklama). Yalnızca yönetici oturumu saklanır: salt okunur/toplayıcı yalnızca çıkış yapan testlerde kullanılır.
 */
export async function enterDemoShared(page: Page, label: "Yönetici"): Promise<void> {
  if (!isRemote()) {
    await page.getByRole("button", { name: `${label} olarak gir` }).click();
    return;
  }
  if (!existsSync(STATE_FILE)) throw new Error("e2e: paylaşılan demo oturumu yok (global-setup yönetici girişini yapmadı)");
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { cookies: Parameters<ReturnType<Page["context"]>["addCookies"]>[0] };
  await page.context().addCookies(state.cookies);
  await page.goto("/t/demo");
}

/** global-setup (yalnız uzak): yönetici için bir kez gerçek ekrandan giriş; oturumu `.artifacts/session/admin.json` (0600) dosyasına yazar. */
export async function mintSharedSession(browser: Browser, baseURL: string): Promise<void> {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  rmSync(STATE_FILE, { force: true });
  const context = await browser.newContext({ baseURL, locale: "tr-TR" });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await waitForLoginSlot();
    recordLogin();
    await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
    await expect(page).toHaveURL(/\/t\/demo$/, { timeout: 30_000 });
    await context.storageState({ path: STATE_FILE });
    chmodSync(STATE_FILE, 0o600);
  } finally {
    await context.close();
  }
}
