// T-286: telefon kamerasıyla barkod okuma. İKİ yol ayrı ayrı sınanır:
//  (1) uygulama içi çözücü (BarcodeDetector YOK: iPhone/WebKit durumu): sahte kamera = EAN-13 görüntülü y4m videosu, WASM çözücü tembel yüklenir;
//  (2) yerleşik API yolu: Chromium Linux'ta BarcodeDetector bulunmadığından, gerçek kamera akışından (sahte aygıt) kare bekleyen bir BarcodeDetector sahtesi enjekte edilir;
//      bu yol çözücünün kendisini değil, SEÇİMİNİ ve katman/akış davranışını (satır içi ret, ses+titreşim, tek kabul) kanıtlar.
// Sahte kamera ayarı yalnızca bu dosyadadır (proje düzeyi test.use); playwright.config.ts'e girmez. Görüntüler `.artifacts/t286-shots/` altına yazılır.
// Kullanılan kod geçerli bir EAN-13'tür ve sistemde KAYITLI DEĞİLDİR: akış sunucudan "tanınmadı" yanıtı alır (uydurma veri yok, stok değişmez).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { writeBarcodeY4m } from "./support/barcode-y4m.ts";

const CODE = "4006381333931";
const BAD_CHECKSUM = "4006381333932";
const ROOT = path.resolve(import.meta.dirname, "../..");
const SHOTS = process.env.T286_OUT ?? path.join(ROOT, ".artifacts/t286-shots");
const Y4M = writeBarcodeY4m(path.join(ROOT, ".artifacts/e2e/camera/ean13.y4m"), CODE);
const SIZES = [
  { name: "360x780", width: 360, height: 780 },
  { name: "390x844", width: 390, height: 844 },
  { name: "844x390", width: 844, height: 390 },
] as const;

test.use({
  permissions: ["camera"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${Y4M}`] },
});

/** Ses/titreşim çağrılarını sayan sahteler (gerçek cihaz yok); sayaçlar `window.__fb` altındadır. */
const FEEDBACK_STUBS = `
  window.__fb = { vibrate: [], tones: 0 };
  navigator.vibrate = (p) => { window.__fb.vibrate.push(p); return true; };
  window.AudioContext = class { constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() { window.__fb.tones++; return { frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: {}, connect() {} }; } };
`;

/** Yerleşik API sahtesi: yalnızca video GERÇEKTEN kare ürettiğinde (videoWidth > 0) `window.__code` değerini döndürür. */
const NATIVE_STUB = `
  window.__code = "";
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ["ean_13", "ean_8", "upc_a", "code_128", "code_39", "qr_code", "data_matrix"]; }
    async detect(video) { return window.__code !== "" && video.videoWidth > 0 && video.readyState >= 2 ? [{ rawValue: window.__code, format: "ean_13" }] : []; }
  };
`;

// Demo girişi hız sınırlıdır (10 deneme/10 dk/istemci adresi) ve diğer spec dosyaları proje kovasını sonuna kadar kullanır: bu dosyanın tek girişi proje kovasını
// TÜKETMEZ; yalnızca giriş adımı boyunca ayrı bir TEST-NET-2 adresi (yerel TLS vekilinin okuduğu başlık) gönderilir, sonra proje başlığı geri konur. Oturum çerezleri sonraki testlerde yeniden kullanılır.
const LOGIN_IP = "198.51.100.60";
let session: Parameters<BrowserContext["addCookies"]>[0] | null = null;

async function login(page: Page, testInfo: TestInfo): Promise<void> {
  if (session !== null) {
    await page.context().addCookies(session);
    await page.goto("/t/demo");
    await expect(page).toHaveURL(/\/t\/demo$/);
    return;
  }
  const project = testInfo.project.use.extraHTTPHeaders ?? {};
  const local = "x-e2e-client-ip" in project; // uzak hedefte başlık yoktur ve eklenmez
  if (local) await page.setExtraHTTPHeaders({ ...project, "x-e2e-client-ip": LOGIN_IP });
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
  if (local) await page.setExtraHTTPHeaders(project);
  session = await page.context().cookies();
}

async function openCamera(page: Page): Promise<void> {
  await page.goto("/t/demo/field/putaway");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Barkodu okut" }).click();
  await expect(page.getByTestId("camera-overlay")).toBeVisible();
}

interface Layout {
  scrollWidth: number;
  clientWidth: number;
  overlayScrollHeight: number;
  innerHeight: number;
  small: string[];
  buttons: number;
  buttonClipped: string[];
  buttonWrapped: string[];
  viewportShare: { height: number; width: number };
  statusFontPx: number;
  statusLines: number;
  statusRole: string | null;
  statusOverlapPx2: number;
  contrast: number;
}

/** K-01…K-07 ölçümleri (rubrik: docs/tasks/T-286.md). Her değer tarayıcıda hesaplanır; ölçü için eklenmiş öğe yoktur. */
async function layout(page: Page): Promise<Layout> {
  return page.evaluate<Layout>(`(() => {
    const ov = document.querySelector('[data-testid="camera-overlay"]');
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const small = []; const clipped = []; const wrapped = []; let buttons = 0;
    for (const el of ov.querySelectorAll('a[href], button, input, select, textarea')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (el.tagName === 'BUTTON') { buttons++; if (el.scrollWidth > el.clientWidth + 0.5) clipped.push(el.textContent.trim()); const rg = document.createRange(); rg.selectNodeContents(el); const tops = new Set([...rg.getClientRects()].map((q) => Math.round(q.top / 4))); if (tops.size > 1) wrapped.push(el.textContent.trim()); }
      if (r.width < 47.5 || r.height < 47.5) small.push((el.textContent || el.tagName).trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    const o = ov.getBoundingClientRect();
    const v = ov.querySelector('[data-testid="camera-viewport"]').getBoundingClientRect();
    const s = ov.querySelector('[data-testid="camera-status"]');
    const sr = s.getBoundingClientRect(); const cs = getComputedStyle(s);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const px = (c) => { const k = document.createElement('canvas'); k.width = k.height = 1; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
    const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let bg = null; for (let e = s; e; e = e.parentElement) { const c = px(getComputedStyle(e).backgroundColor); if (c[3] === 255) { bg = c; break; } }
    const fg = px(cs.color); const l1 = lum(fg), l2 = lum(bg); const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const ix = Math.max(0, Math.min(sr.right, v.right) - Math.max(sr.left, v.left)); const iy = Math.max(0, Math.min(sr.bottom, v.bottom) - Math.max(sr.top, v.top));
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, overlayScrollHeight: ov.scrollHeight, innerHeight: window.innerHeight,
      small, buttons, buttonClipped: clipped, buttonWrapped: wrapped, viewportShare: { height: v.height / o.height, width: v.width / o.width },
      statusFontPx: parseFloat(cs.fontSize), statusLines: Math.round((sr.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh), statusRole: s.getAttribute('role'), statusOverlapPx2: ix * iy, contrast };
  })()`);
}

/** Rubrik eşikleri (docs/tasks/T-286.md K-01…K-07); `video` false iken (izin yok) pencere içeriği rehberdir. */
function expectRubric(m: Layout, label: string, opts: { alert: boolean; maxButtons?: number; guidanceInViewport?: boolean }): void {
  expect(m.scrollWidth, `${label} K-01 yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.overlayScrollHeight, `${label} K-01 dikey sığma`).toBeLessThanOrEqual(m.innerHeight);
  expect(m.small, `${label} K-02 48 px altı hedef`).toEqual([]);
  expect(m.viewportShare.height >= 0.4 || m.viewportShare.width >= 0.4, `${label} K-03 pencere payı ${JSON.stringify(m.viewportShare)}`).toBe(true);
  expect(m.buttons, `${label} K-04 düğme sayısı`).toBeLessThanOrEqual(opts.maxButtons ?? 4);
  expect(m.buttonClipped, `${label} K-04 kesilen düğme etiketi`).toEqual([]);
  expect(m.buttonWrapped, `${label} K-04 tek satır olmayan düğme etiketi`).toEqual([]);
  expect(m.statusFontPx, `${label} K-05 yazı boyu`).toBeGreaterThanOrEqual(18);
  expect(m.statusLines, `${label} K-05 satır sayısı`).toBeLessThanOrEqual(3);
  expect(m.statusRole, `${label} K-05 rol`).toBe(opts.alert ? "alert" : "status");
  // K-06 (yanlış okuma satır içidir): izin yokken görüntü akışı yoktur; rehber metni pencerenin kendi içeriğidir (kasıtlı), bu durumda çakışma ölçütü uygulanmaz.
  if (opts.guidanceInViewport !== true) expect(m.statusOverlapPx2, `${label} K-06 durum satırı pencereyle çakışmaz`).toBe(0);
  expect(m.contrast, `${label} K-07 kontrast`).toBeGreaterThanOrEqual(4.5);
}

test("uygulama içi çözücü yolu: BarcodeDetector yok; WASM yalnızca tarama ekranında yüklenir, kod okunur ve akışa iletilir", async ({ page }, testInfo) => {
  await page.addInitScript(`try { delete window.BarcodeDetector; } catch (e) { window.BarcodeDetector = undefined; } ${FEEDBACK_STUBS}`);
  await login(page, testInfo);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/t/demo/field/putaway");
  await page.waitForLoadState("networkidle");
  // Tembel yükleme: tarama ekranı açıkken bile kamera düğmesine basılana kadar ne WASM ne çözücü parçası indirilir.
  expect(requests.filter((u) => /\.wasm(\?|$)/.test(u)), "kamera açılmadan WASM istenmez").toEqual([]);

  await page.getByRole("button", { name: "Barkodu okut" }).click();
  await expect(page.getByTestId("camera-overlay")).toBeVisible();
  // Çözücü WASM: aynı kaynaktan (CDN yok) indirilir ve kare çözülür; ilk kabul sonrası katman kapanır, kod akışın tarama kaydına düşer.
  await expect(page.getByTestId("camera-overlay")).toHaveAttribute("data-decoder", "wasm");
  await expect(page.getByTestId("last-scan-code")).toContainText(CODE, { timeout: 30_000 });
  const wasm = requests.filter((u) => /\.wasm(\?|$)/.test(u));
  expect(wasm.length, "WASM kamera açılınca istendi").toBeGreaterThan(0);
  const origin = new URL(page.url()).origin;
  expect(wasm.every((u) => u.startsWith(origin)), `WASM kendi kaynağımızdan: ${wasm.join(",")}`).toBe(true);
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:")), "üçüncü taraf istek yok (jsDelivr vb.)").toEqual([]);
  await expect(page.getByTestId("camera-overlay")).toHaveCount(0);
  // Okuma doğru geri bildirim aldı (sahte ses/titreşim sayacı): iyi okuma = 1 titreşim + 1 ton.
  const fb = await page.evaluate<{ vibrate: unknown[]; tones: number }>("window.__fb");
  expect(fb.vibrate).toContainEqual(60);
  expect(fb.tones).toBeGreaterThanOrEqual(1);
  // Sunucu kuralı değişmedi: kayıtsız raf kodu sunucuda reddedilir (kod + sonraki eylem tam ekran uyarıda), UI kuralı yeniden yazmaz.
  await expect(page.getByTestId("scan-alert")).toBeVisible();
  await expect(page.getByTestId("error-code")).toHaveCount(1);
});

test("yerleşik API yolu: seçilir, WASM yüklenmez; yanlış okuma satır içi kalır (ses+titreşim); doğru okuma tek kez iletilir", async ({ page }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS}`);
  await login(page, testInfo);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-decoder", "native");
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  expect(requests.filter((u) => /\.wasm(\?|$)/.test(u)), "yerleşik yolda WASM yüklenmez").toEqual([]);
  // Gerçek (sahte aygıt) akışı oynuyor.
  await expect.poll(() => page.evaluate<number>("document.querySelector('[data-testid=camera-video]').videoWidth")).toBeGreaterThan(0);

  const measures: Record<string, unknown> = {};
  let first = true;
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.evaluate(`window.__code = ""`);
    if (!first) {
      // Her boyut temiz bir arama durumuyla başlar: katmanı kapat–aç.
      await overlay.getByRole("button", { name: "Vazgeç" }).click();
      await page.getByRole("button", { name: "Barkodu okut" }).click();
    }
    first = false;
    await expect(overlay).toHaveAttribute("data-phase", "scanning");
    const scanning = await layout(page);
    measures[`${size.name}-arama`] = scanning;
    expectRubric(scanning, `${size.name} arama`, { alert: false });
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-arama.png`) });

    // Yanlış okuma (sağlaması hatalı EAN-13): SATIR İÇİ ret; katman ve kamera açık, tam ekran uyarı YOK.
    const before = await page.evaluate<{ vibrate: unknown[]; tones: number }>("window.__fb");
    await page.evaluate(`window.__code = ${JSON.stringify(BAD_CHECKSUM)}`);
    await expect(overlay).toHaveAttribute("data-phase", "rejected");
    await expect(page.getByTestId("camera-status")).toContainText("Barkod yanlış okundu");
    await expect(page.getByTestId("scan-alert")).toHaveCount(0);
    const after = await page.evaluate<{ vibrate: unknown[]; tones: number }>("window.__fb");
    expect(after.vibrate.length, `${size.name}: ret titreşimi`).toBe(before.vibrate.length + 1);
    expect(after.vibrate.at(-1), `${size.name}: kötü okuma titreşim deseni`).toEqual([200, 80, 200]);
    expect(after.tones, `${size.name}: ret sesi (iki ton)`).toBe(before.tones + 2);
    const rejected = await layout(page);
    measures[`${size.name}-yanlis-okuma`] = rejected;
    expectRubric(rejected, `${size.name} yanlış okuma`, { alert: true });
    // Kamera akışı açık kaldı ve ret ekranda KALIR (zaman aşımıyla silinmez).
    expect(await page.evaluate<boolean>("(() => { const v = document.querySelector('[data-testid=camera-video]'); return !v.paused && v.videoWidth > 0; })()")).toBe(true);
    await page.waitForTimeout(1800);
    await expect(overlay).toHaveAttribute("data-phase", "rejected");
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-yanlis-okuma.png`) });
  }
  // K-04 "Elle gir" her durumda görünür.
  await expect(overlay.getByRole("button", { name: "Elle gir" })).toBeVisible();

  // Doğru okuma: yeşil onay görünür, katman kapanır, kod TEK kez akışa gider (sunucu çağrısı sayısı = 1).
  const before = await page.evaluate<{ vibrate: unknown[]; tones: number }>("window.__fb");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(`window.__code = ${JSON.stringify(CODE)}`);
  await expect(overlay).toHaveAttribute("data-phase", "accepted");
  await expect(page.getByTestId("camera-status")).toHaveText("Okundu.");
  await page.screenshot({ path: path.join(SHOTS, "390x844-okundu.png") });
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("last-scan-code")).toContainText(CODE);
  const after = await page.evaluate<{ vibrate: unknown[]; tones: number }>("window.__fb");
  // Okuma anında tek kısa titreşim (60) ve tek ton; ardından sunucu reddi mevcut tam ekran uyarının kendi titreşimini ekleyebilir (sıra: önce okuma).
  expect(after.vibrate[before.vibrate.length]).toBe(60);
  expect(after.vibrate.slice(before.vibrate.length).filter((v) => v === 60)).toHaveLength(1);
  expect(after.tones).toBe(before.tones + 1);
  await expect(page.getByTestId("scan-alert")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(posts.length, "kod sunucuya tek kez gitti (çift okuma yok)").toBe(1);
  writeMeasures(measures, "okuma", testInfo.project.name);
});

test("kamera izni yok: cihaza özgü rehber, Tekrar dene ve Elle gir yolu; kamera açılamasa da iş sürer", async ({ page }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS}
    window.__deny = true;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => window.__deny ? Promise.reject(Object.assign(new Error("izin yok"), { name: "NotAllowedError" })) : real(c);`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "failed");
  const status = page.getByTestId("camera-status");
  // Rehber, çalışan cihazın işletim sistemine özgüdür (Pixel 5 profili: Android; masaüstü: adres çubuğu).
  const platform = await page.evaluate<string>("/Android/i.test(navigator.userAgent) ? 'android' : 'other'");
  await expect(status).toContainText(platform === "android" ? "Ayarlar > Uygulamalar" : "kilit simgesi");
  await expect(status).toContainText("Kamera kapalı");
  const measures: Record<string, unknown> = {};
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const m = await layout(page);
    measures[`${size.name}-izin-yok`] = m;
    expectRubric(m, `${size.name} izin yok`, { alert: true, guidanceInViewport: true });
    await expect(overlay.getByRole("button", { name: "Elle gir" })).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Tekrar dene" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-izin-yok.png`) });
  }
  // İzin verildi: Tekrar dene kamerayı açar.
  await page.evaluate("window.__deny = false");
  await overlay.getByRole("button", { name: "Tekrar dene" }).click();
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  // Elle gir: katman kapanır, elle giriş alanı açılır.
  await overlay.getByRole("button", { name: "Elle gir" }).click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("scan-panel").getByRole("textbox")).toBeVisible();
  writeMeasures(measures, "izin", testInfo.project.name);
});

function writeMeasures(data: Record<string, unknown>, tag: string, project: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, `olcumler-${tag}-${project}.json`), JSON.stringify(data, null, 2));
}
