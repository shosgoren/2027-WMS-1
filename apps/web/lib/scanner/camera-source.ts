// Kamera okuma kaynağı (T-286, ADR-010): arka kamera akışı, çözücü seçimi (yerleşik BarcodeDetector ya da uygulama içi zxing-wasm),
// okunan değerin biçim doğrulaması (T-287g), tek uçuşlu okuma döngüsü ve ses/titreşim geri bildirimi.
// İstemci grafı (T-313): yalnızca `scanner-config.ts` içe aktarılır; sunucu paketi ve domain YOK. Çözücü tembel yüklenir (`import()`),
// tarama ekranı açılana kadar ne betik ne WASM indirilir. Stok/iş kuralı burada YOKTUR: bu dosya yalnızca "okunan metin" üretir;
// ürün/lokasyon çözümü ve kurallar sunucuda (domain) kalır.
import { SCANNER_CONFIG } from "./scanner-config.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Biçim doğrulaması
// ---------------------------------------------------------------------------------------------------------------------

/** Kabul edilen sembolojiler (A-29: raf/ürün etiketleri). Başkası (ör. PDF417, ITF) reddedilir. */
export const CAMERA_SYMBOLOGIES = ["ean13", "ean8", "upca", "code128", "code39", "qrcode", "datamatrix"] as const;
export type CameraSymbology = (typeof CAMERA_SYMBOLOGIES)[number];

/** Yerleşik `BarcodeDetector` biçim adları (spec) ve zxing-wasm çıktı adları ("EAN13", "Code128", "QRCode"…) tek anahtara indirgenir. */
const SYMBOLOGY_BY_KEY: Readonly<Record<string, CameraSymbology>> = {
  ean13: "ean13",
  ean8: "ean8",
  upca: "upca",
  code128: "code128",
  code39: "code39",
  qrcode: "qrcode",
  datamatrix: "datamatrix",
};
/** `BarcodeDetector` `formats` değerleri (yerleşik yol). */
export const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "code_128", "code_39", "qr_code", "data_matrix"] as const;
/** zxing-wasm `formats` değerleri (uygulama içi yol; ad kümesi kurulu tiplerden doğrulandı: `BARCODE_FORMATS`). */
export const WASM_FORMATS = ["EAN13", "EAN8", "UPCA", "Code128", "Code39", "QRCode", "DataMatrix"] as const;

export function symbologyOf(format: string): CameraSymbology | null {
  return SYMBOLOGY_BY_KEY[format.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null;
}

export type RejectReason = "empty" | "edge_space" | "too_long" | "control_chars" | "unexpected_format" | "bad_digits" | "bad_checksum";
export type CameraVerdict = { readonly ok: true; readonly value: string; readonly symbology: CameraSymbology | null } | { readonly ok: false; readonly reason: RejectReason };

/** GS1 mod-10 sağlama: son hane kontrol hanesidir. */
export function gs1CheckDigitValid(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

const DIGIT_LENGTH: Readonly<Partial<Record<CameraSymbology, number>>> = { ean13: 13, ean8: 8, upca: 12 };
// GS1 grup ayracı (GS, U+001D) yalnızca GS1 taşıyabilen sembolojilerde meşrudur.
const GS = SCANNER_CONFIG.gs1Separator;
const GS_OK: ReadonlySet<CameraSymbology> = new Set(["code128", "qrcode", "datamatrix"]);

/**
 * Kameradan gelen okumayı doğrular; boş, bozuk, beklenmeyen sembolojili ya da sağlaması tutmayan okuma reddedilir (kullanıcıya satır içi bildirilir).
 * `format` yoksa (biçim bildirmeyen okuyucu) yalnızca biçimden bağımsız denetimler (boş/uzun/denetim karakteri/kenar boşluğu) uygulanır.
 * Değer ASLA değiştirilmez (kırpma/dönüştürme yok): ürün/lokasyon eşlemesi sunucudadır.
 */
export function validateCameraRead(read: { readonly text: string; readonly format?: string | undefined }): CameraVerdict {
  const text = read.text;
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (text !== text.trim()) return { ok: false, reason: "edge_space" };
  if (text.length > SCANNER_CONFIG.maxLength) return { ok: false, reason: "too_long" };
  let symbology: CameraSymbology | null = null;
  if (read.format !== undefined && read.format !== "") {
    symbology = symbologyOf(read.format);
    if (symbology === null) return { ok: false, reason: "unexpected_format" };
  }
  const gsAllowed = symbology !== null && GS_OK.has(symbology);
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    if (c === 0xfffd || (control && !(gsAllowed && ch === GS))) return { ok: false, reason: "control_chars" };
  }
  const len = symbology === null ? undefined : DIGIT_LENGTH[symbology];
  if (len !== undefined) {
    if (text.length !== len || !/^\d+$/.test(text)) return { ok: false, reason: "bad_digits" };
    if (!gs1CheckDigitValid(text)) return { ok: false, reason: "bad_checksum" };
  }
  return { ok: true, value: text, symbology };
}

// ---------------------------------------------------------------------------------------------------------------------
// Çözücü (yerleşik API ya da uygulama içi WASM)
// ---------------------------------------------------------------------------------------------------------------------

export interface RawRead {
  readonly text: string;
  readonly format?: string | undefined;
}
export interface FrameDecoder {
  readonly kind: "native" | "wasm";
  /** Bir kare çözer; okuma yoksa `null`. Hata fırlatabilir (çağıran yutmaz: döngü sayar). */
  decode(video: HTMLVideoElement): Promise<RawRead | null>;
  dispose(): void;
}

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<readonly { rawValue: string; format?: string }[]>;
}
interface NativeCtor {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}
/** Uygulama içi okuyucu (zxing-wasm `readBarcodes` yüzeyinin kullandığımız kısmı). */
export interface WasmReader {
  read(frame: ImageData): Promise<readonly { text: string; format: string; isValid: boolean }[]>;
}
export interface DecoderEnv {
  readonly nativeCtor: NativeCtor | null;
  readonly loadWasm: () => Promise<WasmReader>;
  readonly makeCanvas: () => { canvas: { width: number; height: number }; draw(video: HTMLVideoElement, w: number, h: number): ImageData };
}

/** Çözümlenecek karenin en uzun kenarı (px): telefon 1080p akışını küçültür, çözme süresini sınırlar. */
const MAX_FRAME_SIDE = 960;

export function browserDecoderEnv(): DecoderEnv {
  return {
    nativeCtor: typeof window === "undefined" ? null : ((window as unknown as { BarcodeDetector?: NativeCtor }).BarcodeDetector ?? null),
    loadWasm: loadZxingReader,
    makeCanvas: () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      return {
        canvas,
        draw(video, w, h) {
          if (ctx === null) throw new Error("camera: 2d canvas yok");
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          return ctx.getImageData(0, 0, w, h);
        },
      };
    },
  };
}

/**
 * zxing-wasm'ı tembel yükler. VARSAYILAN `locateFile` WASM'ı üçüncü taraf CDN'den (jsDelivr) indirir; CSP'yi (`connect-src 'self'`) ve tedarik zincirini
 * bozacağından KULLANILMAZ: WASM paketten, bundler varlığı olarak kendi kaynağımızdan sunulur.
 */
async function loadZxingReader(): Promise<WasmReader> {
  const mod = await import("zxing-wasm/reader");
  const wasmUrl = new URL("zxing-wasm/reader/zxing_reader.wasm", import.meta.url).href;
  await mod.prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  return {
    async read(frame) {
      const out = await mod.readBarcodes(frame, { formats: [...WASM_FORMATS], tryHarder: true, maxNumberOfSymbols: 1 });
      return out.map((r) => ({ text: r.text, format: r.format, isValid: r.isValid }));
    },
  };
}

async function nativeFormats(ctor: NativeCtor): Promise<string[]> {
  if (typeof ctor.getSupportedFormats !== "function") return [...NATIVE_FORMATS];
  const supported = new Set(await ctor.getSupportedFormats());
  return NATIVE_FORMATS.filter((f) => supported.has(f));
}

/**
 * Çözücü seçimi: yerleşik `BarcodeDetector` EAN-13 ve Code128'i destekliyorsa o; yoksa (iPhone/WebKit, masaüstü Chromium) uygulama içi WASM.
 * Yerleşik yol kurulamazsa (yapıcı hata verirse) WASM'a düşülür.
 */
export async function createFrameDecoder(env: DecoderEnv = browserDecoderEnv()): Promise<FrameDecoder> {
  if (env.nativeCtor !== null) {
    try {
      const formats = await nativeFormats(env.nativeCtor);
      if (formats.includes("ean_13") && formats.includes("code_128")) {
        const detector = new env.nativeCtor({ formats });
        return {
          kind: "native",
          async decode(video) {
            const found = await detector.detect(video);
            const first = found.find((f) => f.rawValue !== "");
            return first === undefined ? null : { text: first.rawValue, format: first.format };
          },
          dispose() {},
        };
      }
    } catch {
      // Yerleşik API kurulamadı: uygulama içi çözücüye düş.
    }
  }
  const reader = await env.loadWasm();
  const surface = env.makeCanvas();
  return {
    kind: "wasm",
    async decode(video) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) return null; // henüz kare yok
      const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(vw, vh));
      const frame = surface.draw(video, Math.max(1, Math.round(vw * scale)), Math.max(1, Math.round(vh * scale)));
      const hit = (await reader.read(frame)).find((r) => r.isValid && r.text !== "");
      return hit === undefined ? null : { text: hit.text, format: hit.format };
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Okuma döngüsü: tek uçuş, tek kabul
// ---------------------------------------------------------------------------------------------------------------------

export interface ScanLoopOptions {
  readonly decoder: FrameDecoder;
  readonly video: HTMLVideoElement;
  readonly intervalMs?: number;
  /** Aynı reddedilen okuma bu süre (ms) içinde yeniden bildirilmez (geri bildirim yağmuru olmasın). */
  readonly repeatRejectMs?: number;
  readonly now?: () => number;
  readonly onAccepted: (value: string, symbology: CameraSymbology | null) => void;
  readonly onRejected: (reason: RejectReason, text: string) => void;
}

/**
 * Döngü bir kare çözerken yenisi başlamaz (tek uçuş) ve ilk kabulden sonra DURUR: aynı kod ikinci kez gönderilemez (T-280 çift okuma koruması, tek mekanizma).
 * Reddedilen okuma döngüyü durdurmaz; bir sonraki doğru okumaya kadar kamera açık kalır. Döndürülen işlev döngüyü durdurur.
 */
export function startScanLoop(opts: ScanLoopOptions): () => void {
  const interval = opts.intervalMs ?? 250;
  const repeatMs = opts.repeatRejectMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRejected: { key: string; at: number } | null = null;
  const tick = (): void => {
    timer = null;
    if (stopped) return;
    opts.decoder
      .decode(opts.video)
      .then((read) => {
        if (stopped || read === null) return;
        const verdict = validateCameraRead(read);
        if (verdict.ok) {
          stopped = true; // kabulden sonra tek bildirim
          opts.onAccepted(verdict.value, verdict.symbology);
          return;
        }
        const key = `${verdict.reason}|${read.text}`;
        const t = now();
        if (lastRejected !== null && lastRejected.key === key && t - lastRejected.at < repeatMs) return; // aynı bozuk okuma sürüyor: yeniden bildirme
        lastRejected = { key, at: t };
        opts.onRejected(verdict.reason, read.text);
      })
      .catch(() => undefined) // kare çözülemedi: sonraki kare denenir (kalıcı hata kamera/çözücü kurulumunda bildirilir)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, interval);
      });
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Kamera akışı
// ---------------------------------------------------------------------------------------------------------------------

export type CameraFailure = "insecure" | "denied" | "none" | "busy" | "failed";
export type Platform = "ios" | "android" | "other";

export function platformOf(userAgent: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(userAgent)) return "android";
  // iPadOS Safari masaüstü gibi görünür (Macintosh + dokunmatik).
  if (/iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
  return "other";
}

export function classifyCameraError(e: unknown): CameraFailure {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "InsecureContext") return "insecure";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "none";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "failed";
}

export interface CameraSession {
  readonly stream: MediaStream;
  /** Fener (torch) bu cihazda/akışta destekleniyor mu: yalnızca izlek yeteneği bildirirse. */
  readonly torchSupported: boolean;
  /** Feneri açar/kapatır; başarısızsa `false` döner (durum uydurulmaz). */
  setTorch(on: boolean): Promise<boolean>;
  stop(): void;
}

/** Arka kamerayı açar (HTTPS zorunlu: `isSecureContext`). Sürekli otomatik odak ve 720p ideal istenir; desteklenmeyen kısıt sessizce yok sayılır. */
export async function openCamera(): Promise<CameraSession> {
  if (typeof window === "undefined" || !window.isSecureContext) throw Object.assign(new Error("camera: güvenli bağlam (HTTPS) yok"), { name: "InsecureContext" });
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (md === undefined || typeof md.getUserMedia !== "function") throw Object.assign(new Error("camera: mediaDevices yok"), { name: "NotFoundError" });
  const stream = await md.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean; focusMode?: string[] };
  // Sürekli odak yalnızca destekleniyorsa istenir (iOS bazı sürümlerde yeteneği bildirmez; zorlanmaz).
  if (track !== undefined && caps.focusMode?.includes("continuous") === true) {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
  }
  const torchSupported = caps.torch === true;
  return {
    stream,
    torchSupported,
    async setTorch(on) {
      if (!torchSupported || track === undefined) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ses ve titreşim (T-263 ile aynı dil: iyi = kısa tek bip + kısa titreşim; kötü = alçak çift bip + uzun titreşim)
// ---------------------------------------------------------------------------------------------------------------------

export type FeedbackKind = "ok" | "bad";
export interface FeedbackResult {
  readonly vibrated: boolean;
  readonly sounded: boolean;
}
const VIBRATE: Record<FeedbackKind, number | number[]> = { ok: 60, bad: [200, 80, 200] };
// [frekans Hz, başlangıç s, süre s]
const TONES: Record<FeedbackKind, ReadonlyArray<readonly [number, number, number]>> = {
  ok: [[1200, 0, 0.12]],
  bad: [
    [220, 0, 0.18],
    [220, 0.26, 0.18],
  ],
};
type AudioCtor = new () => AudioContext;
let audio: AudioContext | null = null;

/**
 * Geri bildirim: destek yoksa (iOS Safari `vibrate`, ses kilitli) ilgili kanal atlanır ve `false` döner; sahte "titreşti" bildirilmez (G-07).
 * Ses bağlamı kullanıcı dokunuşuyla açılan tarama ekranında oluşturulur (iOS otomatik oynatma kuralı).
 */
export function cameraFeedback(kind: FeedbackKind): FeedbackResult {
  let vibrated = false;
  let sounded = false;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") vibrated = navigator.vibrate(VIBRATE[kind]);
  } catch {
    vibrated = false;
  }
  try {
    const Ctor = typeof window === "undefined" ? undefined : ((window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }).AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext);
    if (Ctor !== undefined) {
      audio ??= new Ctor();
      const ctx = audio;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      for (const [freq, at, dur] of TONES[kind]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.2;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + dur);
      }
      sounded = true;
    }
  } catch {
    sounded = false;
  }
  return { vibrated, sounded };
}
