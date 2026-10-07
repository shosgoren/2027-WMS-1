// T-286 / T-287g: kamera okumasının biçim doğrulaması, çözücü seçimi (yerleşik / uygulama içi) ve tek uçuşlu okuma döngüsü.
// Tarayıcı olmadan (DecoderEnv enjekte) koşar; gerçek kamera akışı ve WASM çözümü e2e'dedir (tests/e2e/camera-scan.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCANNER_CONFIG } from "./scanner-config.ts";
import { classifyCameraError, createFrameDecoder, gs1CheckDigitValid, platformOf, startScanLoop, symbologyOf, validateCameraRead } from "./camera-source.ts";
import type { DecoderEnv, FrameDecoder, RawRead, RejectReason, WasmReader } from "./camera-source.ts";

describe("validateCameraRead (T-287g)", () => {
  it("geçerli EAN-13, EAN-8, UPC-A değerlerini aynen kabul eder", () => {
    expect(validateCameraRead({ text: "4006381333931", format: "EAN13" })).toEqual({ ok: true, value: "4006381333931", symbology: "ean13" });
    expect(validateCameraRead({ text: "96385074", format: "ean_8" })).toEqual({ ok: true, value: "96385074", symbology: "ean8" });
    expect(validateCameraRead({ text: "036000291452", format: "UPCA" })).toEqual({ ok: true, value: "036000291452", symbology: "upca" });
  });

  it("her iki yolun biçim adını (yerleşik ve zxing-wasm) aynı sembolojiye çevirir", () => {
    for (const [a, b, s] of [["ean_13", "EAN13", "ean13"], ["code_128", "Code128", "code128"], ["qr_code", "QRCode", "qrcode"], ["data_matrix", "DataMatrix", "datamatrix"], ["code_39", "Code39", "code39"], ["upc_a", "UPCA", "upca"]] as const) {
      expect(symbologyOf(a)).toBe(s);
      expect(symbologyOf(b)).toBe(s);
    }
  });

  const rejected: ReadonlyArray<[string, { text: string; format?: string }, RejectReason]> = [
    ["boş metin", { text: "", format: "Code128" }, "empty"],
    ["yalnızca boşluk", { text: "   ", format: "Code128" }, "empty"],
    ["kenarda boşluk", { text: " ABC-1", format: "Code128" }, "edge_space"],
    ["beklenmeyen sembol (PDF417)", { text: "ABC123", format: "PDF417" }, "unexpected_format"],
    ["bilinmeyen biçim adı", { text: "ABC123", format: "ITF" }, "unexpected_format"],
    ["EAN-13 sağlaması hatalı", { text: "4006381333932", format: "EAN13" }, "bad_checksum"],
    ["EAN-8 sağlaması hatalı", { text: "96385075", format: "EAN8" }, "bad_checksum"],
    ["EAN-13 kısa", { text: "400638133393", format: "EAN13" }, "bad_digits"],
    ["EAN-13 rakam dışı", { text: "40063813339A1", format: "EAN13" }, "bad_digits"],
    ["denetim karakteri", { text: "AB\u0000C", format: "Code128" }, "control_chars"],
    ["değiştirme karakteri (bozuk kodlama)", { text: "AB�C", format: "QRCode" }, "control_chars"],
    ["GS, Code39'da meşru değil", { text: "AB\u001dC", format: "Code39" }, "control_chars"],
    ["fazla uzun", { text: "A".repeat(SCANNER_CONFIG.maxLength + 1), format: "Code128" }, "too_long"],
  ];
  it.each(rejected)("reddeder: %s", (_n, read, reason) => {
    expect(validateCameraRead(read)).toEqual({ ok: false, reason });
  });

  it("GS1 ayracı (GS) yalnızca Code128/QR/DataMatrix'te kabul edilir ve değer değiştirilmez", () => {
    const v = "0104006381333931\u001d10LOT1";
    expect(validateCameraRead({ text: v, format: "Code128" })).toEqual({ ok: true, value: v, symbology: "code128" });
    expect(validateCameraRead({ text: v, format: "DataMatrix" }).ok).toBe(true);
  });

  it("biçim bildirmeyen okuyucuda yalnızca biçimden bağımsız denetimler uygulanır", () => {
    expect(validateCameraRead({ text: "869AB01" })).toEqual({ ok: true, value: "869AB01", symbology: null });
    expect(validateCameraRead({ text: "" })).toEqual({ ok: false, reason: "empty" });
  });

  it("GS1 mod-10 sağlaması", () => {
    expect(gs1CheckDigitValid("4006381333931")).toBe(true);
    expect(gs1CheckDigitValid("4006381333930")).toBe(false);
  });
});

describe("cihaz ve hata sınıflaması", () => {
  it("platformOf: iPhone, iPad (masaüstü kılıklı), Android, diğer", () => {
    expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130")).toBe("ios");
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5)).toBe("ios");
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0)).toBe("other");
    expect(platformOf("Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130")).toBe("android");
  });
  it("classifyCameraError", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("none");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyCameraError(new Error("x"))).toBe("failed");
  });
});

function env(over: Partial<DecoderEnv>): DecoderEnv {
  return {
    nativeCtor: null,
    loadWasm: () => Promise.reject(new Error("wasm beklenmiyordu")),
    makeCanvas: () => ({ canvas: { width: 0, height: 0 }, draw: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) as unknown as ImageData }),
    ...over,
  };
}
const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

describe("createFrameDecoder: çözücü seçimi", () => {
  it("yerleşik API EAN-13 ve Code128'i destekliyorsa onu kullanır, WASM yüklenmez", async () => {
    const loadWasm = vi.fn(() => Promise.reject(new Error("yüklenmemeliydi")));
    class Native {
      static getSupportedFormats = () => Promise.resolve(["ean_13", "code_128", "qr_code"]);
      constructor(readonly o?: { formats?: string[] }) {
        seen.push(o?.formats ?? []);
      }
      detect = () => Promise.resolve([{ rawValue: "4006381333931", format: "ean_13" }]);
    }
    const seen: string[][] = [];
    const d = await createFrameDecoder(env({ nativeCtor: Native, loadWasm }));
    expect(d.kind).toBe("native");
    expect(loadWasm).not.toHaveBeenCalled();
    expect(seen[0]).toEqual(["ean_13", "code_128", "qr_code"]);
    expect(await d.decode(video)).toEqual({ text: "4006381333931", format: "ean_13" });
  });

  it("yerleşik API yoksa uygulama içi WASM çözücü kullanılır; kare büyük kenarı 960 px ile sınırlanır", async () => {
    const reads: ImageData[] = [];
    const reader: WasmReader = {
      read: (f) => {
        reads.push(f);
        return Promise.resolve([{ text: "4006381333931", format: "EAN13", isValid: true }]);
      },
    };
    const sizes: Array<[number, number]> = [];
    const d = await createFrameDecoder(
      env({
        loadWasm: () => Promise.resolve(reader),
        makeCanvas: () => ({ canvas: { width: 0, height: 0 }, draw: (_v, w, h) => (sizes.push([w, h]), { width: w, height: h, data: new Uint8ClampedArray(4) } as unknown as ImageData) }),
      }),
    );
    expect(d.kind).toBe("wasm");
    expect(await d.decode({ videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement)).toEqual({ text: "4006381333931", format: "EAN13" });
    expect(sizes).toEqual([[960, 540]]);
    expect(reads).toHaveLength(1);
  });

  it("WASM çözücüde geçersiz sonuç yok sayılır ve kare yokken (0×0) çözülmez", async () => {
    const read = vi.fn(() => Promise.resolve([{ text: "X", format: "Code128", isValid: false }]));
    const d = await createFrameDecoder(env({ loadWasm: () => Promise.resolve({ read }) }));
    expect(await d.decode({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await d.decode(video)).toBeNull();
  });

  it("yerleşik API gerekli biçimleri desteklemiyorsa ya da yapıcı hata verirse WASM'a düşer", async () => {
    const reader: WasmReader = { read: () => Promise.resolve([]) };
    class Weak {
      static getSupportedFormats = () => Promise.resolve(["qr_code"]);
    }
    class Broken {
      static getSupportedFormats = () => Promise.resolve(["ean_13", "code_128"]);
      constructor() {
        throw new Error("kurulamadı");
      }
    }
    expect((await createFrameDecoder(env({ nativeCtor: Weak as never, loadWasm: () => Promise.resolve(reader) }))).kind).toBe("wasm");
    expect((await createFrameDecoder(env({ nativeCtor: Broken as never, loadWasm: () => Promise.resolve(reader) }))).kind).toBe("wasm");
  });

  it("WASM yüklenemezse hata yutulmaz (tarama ekranı hatayı kullanıcıya bildirir)", async () => {
    await expect(createFrameDecoder(env({ loadWasm: () => Promise.reject(new Error("ağ")) }))).rejects.toThrow("ağ");
  });
});

describe("startScanLoop: tek uçuş, tek kabul, satır içi ret", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function decoderOf(next: () => Promise<RawRead | null>): FrameDecoder & { calls: number } {
    const d = {
      kind: "wasm" as const,
      calls: 0,
      decode: () => {
        d.calls++;
        return next();
      },
      dispose: () => undefined,
    };
    return d;
  }

  it("ilk kabulden sonra durur: aynı kod art arda iki kez gönderilmez", async () => {
    const accepted: string[] = [];
    const d = decoderOf(() => Promise.resolve({ text: "4006381333931", format: "EAN13" }));
    startScanLoop({ decoder: d, video, intervalMs: 250, onAccepted: (v) => accepted.push(v), onRejected: () => undefined });
    await vi.advanceTimersByTimeAsync(5000);
    expect(accepted).toEqual(["4006381333931"]);
    expect(d.calls).toBe(1);
  });

  it("çözme sürerken yeni kare başlamaz (tek uçuş)", async () => {
    let release: (r: RawRead | null) => void = () => undefined;
    const d = decoderOf(() => new Promise<RawRead | null>((res) => (release = res)));
    startScanLoop({ decoder: d, video, intervalMs: 100, onAccepted: () => undefined, onRejected: () => undefined });
    await vi.advanceTimersByTimeAsync(2000);
    expect(d.calls).toBe(1);
    release(null);
    await vi.advanceTimersByTimeAsync(150);
    expect(d.calls).toBe(2);
  });

  it("bozuk okuma reddedilir, döngü sürer, aynı bozuk okuma tekrar bildirilmez; sonra doğru okuma kabul edilir", async () => {
    const rejected: Array<[RejectReason, string]> = [];
    const accepted: string[] = [];
    let text = "4006381333932"; // sağlaması hatalı
    let clock = 0;
    const d = decoderOf(() => Promise.resolve({ text, format: "EAN13" }));
    startScanLoop({ decoder: d, video, intervalMs: 250, now: () => clock, onAccepted: (v) => accepted.push(v), onRejected: (r, t) => rejected.push([r, t]) });
    for (let i = 0; i < 4; i++) {
      clock += 250;
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(rejected).toEqual([["bad_checksum", "4006381333932"]]);
    expect(accepted).toEqual([]);
    clock += 2000; // bildirim penceresi geçti: yeniden bildirilir (ses/titreşim yeniden)
    await vi.advanceTimersByTimeAsync(250);
    expect(rejected).toHaveLength(2);
    text = "4006381333931";
    await vi.advanceTimersByTimeAsync(250);
    expect(accepted).toEqual(["4006381333931"]);
  });

  it("çözücü hata verirse döngü durmaz; durdurma işlevi döngüyü bitirir", async () => {
    let n = 0;
    const d = decoderOf(() => (++n < 3 ? Promise.reject(new Error("kare")) : Promise.resolve(null)));
    const stop = startScanLoop({ decoder: d, video, intervalMs: 50, onAccepted: () => undefined, onRejected: () => undefined });
    await vi.advanceTimersByTimeAsync(500);
    expect(d.calls).toBeGreaterThan(3);
    stop();
    const after = d.calls;
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.calls).toBe(after);
  });
});
