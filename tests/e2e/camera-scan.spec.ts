// T-286: telefon kamerasıyla barkod okuma. İKİ yol ayrı ayrı sınanır:
//  (1) uygulama içi çözücü (BarcodeDetector YOK: iPhone/WebKit durumu): sahte kamera = EAN-13 görüntülü y4m videosu, WASM çözücü tembel yüklenir;
//  (2) yerleşik API yolu: Chromium Linux'ta BarcodeDetector bulunmadığından, gerçek kamera akışından (sahte aygıt) kare bekleyen bir BarcodeDetector sahtesi enjekte edilir;
//      bu yol çözücünün kendisini değil, SEÇİMİNİ ve katman/akış davranışını (satır içi ret, ses+titreşim, tek kabul) kanıtlar.
// Sahte kamera ayarı yalnızca bu dosyadadır (proje düzeyi test.use); playwright.config.ts'e girmez. Görüntüler `.artifacts/t286-shots/` altına yazılır.
// Kullanılan kod geçerli bir EAN-13'tür ve sistemde KAYITLI DEĞİLDİR: akış sunucudan "tanınmadı" yanıtı alır (uydurma veri yok, stok değişmez).
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { ean13CheckDigit, writeBarcodeY4m } from "./support/barcode-y4m.ts";

// Her yüklemede (işçi başına) rastgele geçerli EAN-13 (mağaza içi "2" öneki): fikstür barkodu arşivlenen ürüne bağlı kalsa da yeniden koşuda çakışmaz.
const BODY = "2" + String(randomInt(0, 1e11)).padStart(11, "0");
const CODE = BODY + ean13CheckDigit(BODY);
const BAD_CHECKSUM = BODY + ((ean13CheckDigit(BODY) + 1) % 10);
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

/**
 * getUserMedia sarmalayıcısı: `__hold` (Promise) kamera açılışını bekletir (açılış ekranı görüntüsü), `__deny` izin reddini taklit eder,
 * `__torchCap` akış izlerine sahte `torch` yeteneği ekler ve `applyConstraints({advanced:[{torch}]})` çağrılarını `__torchCalls`a yazar.
 */
const GUM_WRAP = `
  window.__hold = null; window.__deny = false; window.__torchCap = false; window.__torchCalls = [];
  const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (window.__hold) await window.__hold;
    if (window.__deny) throw Object.assign(new Error("izin yok"), { name: "NotAllowedError" });
    const stream = await realGum(c);
    if (window.__torchCap) {
      const t = stream.getVideoTracks()[0];
      const caps = t.getCapabilities ? t.getCapabilities.bind(t) : () => ({});
      t.getCapabilities = () => ({ ...caps(), torch: true });
      const apply = t.applyConstraints.bind(t);
      t.applyConstraints = (k) => {
        const adv = k && k.advanced && k.advanced.find((a) => "torch" in a);
        if (adv) { window.__torchCalls.push(adv.torch); return Promise.resolve(); }
        return apply(k);
      };
    }
    return stream;
  };
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
function expectRubric(m: Layout, label: string, opts: { alert: boolean; maxButtons?: number }): void {
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
  expect(m.statusOverlapPx2, `${label} K-06 durum satırı pencereyle çakışmaz`).toBe(0);
  expect(m.contrast, `${label} K-07 kontrast`).toBeGreaterThanOrEqual(4.5);
}

test("uygulama içi çözücü yolu: BarcodeDetector yok; WASM yalnızca tarama ekranında yüklenir, kod okunur ve akışa iletilir", async ({ page }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
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

  // Okundu ekranı: ürün çözülmediğinde okunan KOD gösterilir (üç boyutta ölçüm + görüntü; rubrik K-01…K-07).
  const overlay = page.getByTestId("camera-overlay");
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/t/demo/field/putaway");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Barkodu okut" }).click();
    await expect(overlay).toHaveAttribute("data-phase", "accepted", { timeout: 30_000 });
    await expect(page.getByTestId("camera-accepted-value")).toHaveText(CODE);
    expectRubric(await layout(page), `${size.name} okundu (kod)`, { alert: false });
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-okundu-kod.png`) });
  }
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
  await expect(page.getByTestId("camera-status")).toContainText("Okundu.");
  await expect(page.getByTestId("camera-accepted-value")).toHaveText(CODE); // kod çözülmediyse (ürün adı yok) okunan kod gösterilir
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
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS} ${GUM_WRAP} window.__deny = true;`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "failed");
  const status = page.getByTestId("camera-status");
  // Rehber, çalışan cihazın işletim sistemine özgüdür (Pixel 5 profili: Android; masaüstü: adres çubuğu).
  const platform = await page.evaluate<string>("/Android/i.test(navigator.userAgent) ? 'android' : 'other'");
  await expect(status).toContainText(platform === "android" ? "Ayarlar > Uygulamalar" : "kilit simgesi");
  await expect(status).toContainText("İzin kapalı");
  // Boş karanlık alan yerine sade yer tutucu: ikon + "Kamera kapalı".
  await expect(page.getByTestId("camera-off")).toContainText("Kamera kapalı");
  // Düğme önceliği: "Elle gir" birincil (dolu), "Tekrar dene" ikincil (çerçeveli, şeffaf).
  const bg = (name: string) => overlay.getByRole("button", { name }).evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).backgroundColor);
  expect(await bg("Elle gir")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await bg("Tekrar dene")).toBe("rgba(0, 0, 0, 0)");
  expect(await overlay.getByRole("button").allTextContents()).toEqual(["Elle gir", "Tekrar dene", "Vazgeç"]);
  const measures: Record<string, unknown> = {};
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const m = await layout(page);
    measures[`${size.name}-izin-yok`] = m;
    expectRubric(m, `${size.name} izin yok`, { alert: true });
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


/** Klavye kaması (el terminali) taklidi: STX + karakterler + Enter, tek tikte. */
async function keystrokeScan(page: Page, code: string): Promise<void> {
  await page.evaluate(`(() => { const send = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); send("\\u0002"); for (const ch of ${JSON.stringify(code)}) send(ch); send("Enter"); })()`);
}

test("el terminali tetiği (klavye kaması): kamera katmanı açıkken de kapalıyken de okutma kabul edilir, akış ilerler", async ({ page }, testInfo) => {
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS}`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  await keystrokeScan(page, "0000000000000"); // tanımsız raf: sunucu reddi → akış bu kodu aldı demektir
  await expect(page.getByTestId("last-scan-code")).toContainText("0000000000000");
  await expect(page.getByTestId("scan-alert")).toBeVisible();
  await expect(overlay).toBeVisible(); // katman klavye kaynağını engellemez ve kapanmaz
  // Katman KAPALIYKEN de aynı yol çalışır.
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await overlay.getByRole("button", { name: "Vazgeç" }).click();
  await expect(overlay).toHaveCount(0);
  await keystrokeScan(page, "1111111111116");
  await expect(page.getByTestId("last-scan-code")).toContainText("1111111111116");
  await expect(page.getByTestId("scan-alert")).toBeVisible();
});

test("kamera ile el terminali aynı anda: tek sunucu çağrısı, tek uyarı; geç kalan kamera kodu sessizce düşmez (bildirilir)", async ({ page }, testInfo) => {
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS}`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  await expect.poll(() => page.evaluate<number>("document.querySelector('[data-testid=camera-video]').videoWidth")).toBeGreaterThan(0);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  // Aynı turda: kamera kodu hazır (döngü sonraki karede okur) ve terminal tetiği ateşlenir; terminal önce akışa girer.
  await page.evaluate(`window.__code = ${JSON.stringify(CODE)}`);
  await keystrokeScan(page, "0000000000000");
  await expect(page.getByTestId("scan-alert")).toBeVisible();
  await expect(page.getByTestId("camera-dropped")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(posts.length, "iki kaynaktan tek akış çağrısı (çift işleme yok)").toBe(1);
  await expect(page.getByTestId("scan-alert")).toHaveCount(1);
  await expect(page.getByTestId("last-scan-code")).toContainText("0000000000000");
});

test("izin reddi: Tekrar dene izin hâlâ kapalıyken rehbere döner (tekrarlı ve çift tık), izin gelince kamerayı açar", async ({ page }, testInfo) => {
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS} ${GUM_WRAP} window.__deny = true;`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "failed");
  for (let i = 0; i < 3; i++) {
    await overlay.getByRole("button", { name: "Tekrar dene" }).click();
    await expect(overlay).toHaveAttribute("data-phase", "failed");
    await expect(overlay.getByRole("button", { name: "Tekrar dene" })).toBeVisible();
    await expect(overlay.getByRole("button", { name: "Elle gir" })).toBeVisible();
  }
  await overlay.getByRole("button", { name: "Tekrar dene" }).dblclick();
  await expect(overlay).toHaveAttribute("data-phase", "failed");
  await page.evaluate("window.__deny = false");
  await overlay.getByRole("button", { name: "Tekrar dene" }).click();
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  await expect.poll(() => page.evaluate<number>("document.querySelector('[data-testid=camera-video]').videoWidth")).toBeGreaterThan(0);
});

test("kamera açılış ekranı: çerçeve (nişangâh) ve 'Kamera açılıyor…' göstergesi", async ({ page }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS} ${GUM_WRAP}`);
  await login(page, testInfo);
  await page.goto("/t/demo/field/putaway");
  await page.waitForLoadState("networkidle");
  await page.evaluate("(() => { window.__hold = new Promise((r) => { window.__release = r; }); })()");
  await page.getByRole("button", { name: "Barkodu okut" }).click();
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "starting");
  await expect(page.getByTestId("camera-reticle")).toBeVisible();
  await expect(page.getByTestId("camera-opening")).toHaveText("Kamera açılıyor…");
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    expectRubric(await layout(page), `${size.name} açılış`, { alert: false });
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-aciliyor.png`) });
  }
  await page.evaluate("window.__release()");
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  await expect(page.getByTestId("camera-opening")).toHaveCount(0);
});

test("fener düğmesi görünürken: üç boyutta sığar; açıp kapatma gerçek çağrıya bağlıdır", async ({ page }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS} ${GUM_WRAP} window.__torchCap = true;`);
  await login(page, testInfo);
  await openCamera(page);
  const overlay = page.getByTestId("camera-overlay");
  await expect(overlay).toHaveAttribute("data-phase", "scanning");
  const torch = overlay.getByRole("button", { name: "Feneri aç" });
  await expect(torch).toBeVisible();
  const measures: Record<string, unknown> = {};
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const m = await layout(page);
    measures[`${size.name}-fener`] = m;
    expect(m.buttons, `${size.name}: Fener, Elle gir, Vazgeç`).toBe(3);
    expectRubric(m, `${size.name} fener`, { alert: false });
    await page.screenshot({ path: path.join(SHOTS, `${size.name}-fener.png`) });
  }
  await torch.click();
  await expect(overlay.getByRole("button", { name: "Feneri kapat" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate("window.__torchCalls")).toEqual([true]);
  await overlay.getByRole("button", { name: "Feneri kapat" }).click();
  await expect(overlay.getByRole("button", { name: "Feneri aç" })).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate("window.__torchCalls")).toEqual([true, false]);
  writeMeasures(measures, "fener", testInfo.project.name);
});

const IPHONE = { safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", chrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1" } as const;

test("iPhone ana ekrana ekleme ipucu: Safari'de alt çubuk, iPhone Chrome'da adres çubuğu (UA taklidi); Tamam kalıcı kapatır", async ({ page, browser }, testInfo) => {
  mkdirSync(SHOTS, { recursive: true });
  await login(page, testInfo); // oturum çerezleri `session`a düştü
  const use = testInfo.project.use;
  const cases = [
    { id: "safari", ua: IPHONE.safari, text: "Paylaş (alt çubuk) > Ana Ekrana Ekle", sizes: [SIZES[0], SIZES[1]] },
    { id: "chrome", ua: IPHONE.chrome, text: "Paylaş (adres çubuğu) > Ana Ekrana Ekle", sizes: [SIZES[1]] },
  ] as const;
  for (const c of cases) {
    const ctx = await browser.newContext({
      ...(use.baseURL === undefined ? {} : { baseURL: use.baseURL }),
      ignoreHTTPSErrors: true,
      locale: "tr-TR",
      userAgent: c.ua,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      ...(use.extraHTTPHeaders === undefined ? {} : { extraHTTPHeaders: use.extraHTTPHeaders }),
    });
    try {
      await ctx.addCookies(session ?? []);
      const p = await ctx.newPage();
      for (const size of c.sizes) {
        await p.setViewportSize({ width: size.width, height: size.height });
        await p.goto("/t/demo/field/putaway");
        await p.waitForLoadState("networkidle");
        const hint = p.getByTestId("install-hint");
        await expect(hint).toBeVisible();
        await expect(hint).toContainText(c.text);
        const m = await p.evaluate<{ sw: number; cw: number; small: string[] }>(`(() => { const h = document.querySelector('[data-testid="install-hint"]'); const small = []; for (const b of h.querySelectorAll('button')) { const r = b.getBoundingClientRect(); if (r.width < 47.5 || r.height < 47.5) small.push(r.width + 'x' + r.height); } return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, small }; })()`);
        expect(m.sw, `${c.id} ${size.name}: yatay taşma`).toBeLessThanOrEqual(m.cw);
        expect(m.small, `${c.id} ${size.name}: 48 px altı hedef`).toEqual([]);
        await hint.scrollIntoViewIfNeeded();
        await p.screenshot({ path: path.join(SHOTS, `${size.name}-iphone-${c.id}-ana-ekrana-ekle.png`) });
      }
      // Tamam kalıcı kapatır (yeniden açılışta görünmez).
      await p.getByTestId("install-hint").getByRole("button", { name: "Tamam" }).click();
      await expect(p.getByTestId("install-hint")).toHaveCount(0);
      await p.reload();
      await p.waitForLoadState("networkidle");
      await expect(p.getByTestId("install-hint")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  }
  // iPhone dışı cihazda ipucu görünmez (mevcut sayfa: masaüstü/Android profili).
  await page.goto("/t/demo/field/putaway");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("install-hint")).toHaveCount(0);
});

// ---- Ürün çözülmüşse okundu ekranı ürün adını gösterir (yerel fikstür: ürün + barkod + beklenen teslim) -------------------------------------------------
// Fikstür migration rolüyle `psql` üzerinden yerel compose DB'ye yazılır (zzz-receiving ile aynı kural: loopback, sterilize hata, sentetik veri) ve test sonunda arşivlenir/iptal edilir.
// Uzak hedefte (E2E_BASE_URL) böyle bir bağlantı yoktur: test o koşuda KAYITLI DEĞİLDİR (atlama değil; fikstür kavramı yok).
type Row = Record<string, string>;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const lit = (v: unknown): string => (v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
function psql<T = Row>(text: string, params: unknown[] = []): T[] {
  const url = process.env.DATABASE_URL_DIRECT;
  if (url === undefined || url === "") throw new Error("e2e: DATABASE_URL_DIRECT yok (globalSetup .env yükler)");
  const u = new URL(url);
  if (!LOOPBACK.has(u.hostname)) throw new Error("e2e: fikstür veritabanı loopback değil; yerel olmayan sunucuya yazılmaz");
  const env = { PATH: process.env.PATH, PGHOST: u.hostname.replace(/^\[|\]$/g, ""), PGPORT: u.port === "" ? "5432" : u.port, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  const sql = text.replace(/\$(\d+)/g, (_m, i: string) => lit(params[Number(i) - 1]));
  const select = /^\s*SELECT/i.test(sql);
  try {
    const out = execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"], { input: select ? `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t` : sql, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] });
    return select ? (JSON.parse(out.trim() || "[]") as T[]) : [];
  } catch (e) {
    throw new Error(`e2e: fikstür SQL başarısız (psql çıkış durumu ${(e as { status?: number | null }).status ?? "?"})`); // argv/ortam/URL/çıktı iletiye girmez (G-09)
  }
}

interface Fx {
  tenantId: string;
  warehouseId: string;
  createdWarehouse: boolean;
  unitId: string;
  itemId: string;
  locId: string;
  receiptId: string;
  itemName: string;
}
const fixtures: Fx[] = [];
test.afterAll(() => {
  // Fikstür SİLİNİR (arşivlenmez): bu dosya diğer spec'lerden ÖNCE koşar ve onların boş durum/arşiv listesi varsayımlarını (T-274) bozmamalı.
  // Stok hareketi yoktur (yalnızca okuma akışı); bağımlılık sırasıyla satır → başlık → barkod → ürün → lokasyon → birim.
  for (const f of fixtures.splice(0)) {
    // Önce ARŞİVLE (silme bir nedenle başarısız olsa bile etkin kayıt kalmaz: sonraki spec'ler bu lokasyonu/ürünü seçmez), sonra sil.
    psql("UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.locId]);
    psql("UPDATE public.items SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.itemId]);
    psql("UPDATE public.inbound_receipts SET status = 'CANCELLED', version = version + 1 WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.receiptId]);
    psql("DELETE FROM public.inbound_receipt_lines WHERE tenant_id = $1 AND receipt_id = $2", [f.tenantId, f.receiptId]);
    psql("DELETE FROM public.inbound_receipts WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.receiptId]);
    psql("DELETE FROM public.item_barcodes WHERE tenant_id = $1 AND item_id = $2", [f.tenantId, f.itemId]);
    psql("DELETE FROM public.items WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.itemId]);
    psql("DELETE FROM public.location_count_locks WHERE tenant_id = $1 AND location_id = $2", [f.tenantId, f.locId]);
    psql("DELETE FROM public.locations WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.locId]);
    psql("DELETE FROM public.units WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.unitId]);
    if (f.createdWarehouse) psql("DELETE FROM public.warehouses WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.warehouseId]);
  }
});

function seed(): Fx {
  const run = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  const tenantId = psql<{ id: string }>("SELECT id FROM public.tenants WHERE slug = 'demo'")[0]?.id;
  if (tenantId === undefined) throw new Error("e2e: demo tenant yok");
  const membershipId = psql<{ id: string }>("SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 ORDER BY joined_at LIMIT 1", [tenantId])[0]?.id;
  const existing = psql<{ id: string }>("SELECT id FROM public.warehouses WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY code LIMIT 1", [tenantId])[0]?.id;
  const fx: Fx = { tenantId, warehouseId: existing ?? randomUUID(), createdWarehouse: existing === undefined, unitId: randomUUID(), itemId: randomUUID(), locId: randomUUID(), receiptId: randomUUID(), itemName: `Kamera Vida ${run}` };
  fixtures.push(fx); // temizlik listesine HEMEN: kurulum yarıda kalsa da afterAll geri alır
  if (fx.createdWarehouse) psql("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E depo')", [tenantId, fx.warehouseId, `E2C${run}`]);
  psql("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E adet')", [tenantId, fx.unitId, `EC${run}`]);
  psql("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,$4,$5,'NONE',0)", [tenantId, fx.itemId, `E2C-${run}`, fx.itemName, fx.unitId]);
  psql("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3)", [tenantId, fx.itemId, CODE]);
  psql("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,$5,0,'RECEIVING')", [tenantId, fx.locId, fx.warehouseId, `E2CK${run}`, "E2E kabul"]);
  psql("INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by, status) VALUES ($1,$2,$3,$4,'E2E-CAM-1',(SELECT user_id FROM public.tenant_memberships WHERE id = $5),'OPEN')", [tenantId, fx.receiptId, fx.warehouseId, `KBL-CAM-${run}`, membershipId]);
  psql("INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) VALUES ($1, gen_random_uuid(), $2, 1, $3, $4, 1, 30)", [tenantId, fx.receiptId, fx.itemId, fx.unitId]);
  return fx;
}

if (!process.env.E2E_BASE_URL?.trim()) {
  test("okundu ekranı ürün çözülmüşse ürün ADINI gösterir (uygulama içi çözücü, gerçek sahte-kamera videosu)", async ({ page }, testInfo) => {
    mkdirSync(SHOTS, { recursive: true });
    const fx = seed();
    await page.addInitScript(`try { delete window.BarcodeDetector; } catch (e) { window.BarcodeDetector = undefined; } ${FEEDBACK_STUBS}`);
    await login(page, testInfo);
    const overlay = page.getByTestId("camera-overlay");
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/t/demo/field/receive?receipt=${fx.receiptId}`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Barkodu okut" }).click();
      await expect(overlay).toHaveAttribute("data-decoder", "wasm");
      // Ad, sunucu çözümünden sonra gelir; o ana kadar kod gösterilir.
      await expect(page.getByTestId("camera-accepted-value")).toHaveText(fx.itemName, { timeout: 30_000 });
      expectRubric(await layout(page), `${size.name} okundu (ürün adı)`, { alert: false });
      await page.screenshot({ path: path.join(SHOTS, `${size.name}-okundu-urun.png`) });
      await expect(overlay).toHaveCount(0);
      await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
    }
  });
}

function writeMeasures(data: Record<string, unknown>, tag: string, project: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, `olcumler-${tag}-${project}.json`), JSON.stringify(data, null, 2));
}

test("okuma kapalıyken (uyarı açık) gelen klavye kaması taraması bildirilir ve başlığı örtmez; normal klavye girişi etkilenmez", async ({ page }, testInfo) => {
  await page.addInitScript(`${NATIVE_STUB} ${FEEDBACK_STUBS}`);
  await login(page, testInfo);
  await openCamera(page);
  await expect(page.getByTestId("camera-overlay")).toHaveAttribute("data-phase", "scanning");
  await keystrokeScan(page, "0000000000000"); // sunucu reddi → tam ekran uyarı → okuma kapalı
  const alert = page.getByTestId("scan-alert");
  await expect(alert).toBeVisible();
  // Normal (önek yok) hızlı yazım: yakalanmaz, bildirim çıkmaz, olay engellenmez.
  const prevented = await page.evaluate<boolean>(`(() => { let p = false; const l = (e) => { if (e.defaultPrevented) p = true; }; document.addEventListener("keydown", l); for (const k of "12 34") document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); document.removeEventListener("keydown", l); return p; })()`);
  expect(prevented, "önek yokken keydown engellenmez").toBe(false);
  await expect(page.getByTestId("camera-dropped")).toHaveCount(0);
  // Kapalıyken STX önekli tarama: sessiz düşmez.
  await keystrokeScan(page, "1111111111116");
  const notice = page.getByTestId("camera-dropped");
  await expect(notice).toBeVisible();
  const n = await notice.boundingBox();
  const h = await page.locator("#scan-alert-title").boundingBox();
  expect(n !== null && h !== null && n.y + n.height <= h.y, "bildirim ana uyarı başlığını örtmez").toBe(true);
  await notice.getByRole("button").click();
  await expect(notice).toHaveCount(0);
});
