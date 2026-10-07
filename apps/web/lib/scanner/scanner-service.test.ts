// @AC-35 (birim kolu): önek/sonek, eşik, Türkçe düzen vektörleri, GS1 yer tutucu, insan yazımı, elle giriş.
// Cihaz kolu T-320'dedir.
import { describe, expect, it } from "vitest";
import { createKeystrokeSource } from "./keystroke-source.ts";
import type { KeyEventLike, KeyTargetLike } from "./keystroke-source.ts";
import { SCANNER_CONFIG } from "./scanner-config.ts";
import { ScannerService, parseScannedGs1 } from "./scanner-service.ts";
import type { ScanSource } from "./scanner-service.ts";

const P = SCANNER_CONFIG.prefix;

function setup() {
  const listeners = new Set<(e: KeyEventLike) => void>();
  const target: KeyTargetLike = {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  let clock = 0;
  const prevented: string[] = [];
  const service = new ScannerService();
  service.registerSource(createKeystrokeSource({ target, now: () => clock }));
  const got: Array<[string, ScanSource]> = [];
  const unsub = service.onScan((v, s) => got.push([v, s]));
  const press = (key: string, gap: number): void => {
    clock += gap;
    for (const l of listeners) l({ key, preventDefault: () => void prevented.push(key) });
  };
  /** Önek + karakterler + sonek; her tuş arası `gap` ms. */
  const scan = (text: string, gap = 5): void => {
    press(P, gap);
    for (const ch of [...text]) press(ch, gap);
    press("Enter", gap);
  };
  return { service, got, press, scan, listeners, unsub, prevented };
}

describe("ScannerService keystroke", () => {
  it("önek+sonek arası eşik altında okunan değeri keystroke olarak iletir", () => {
    const s = setup();
    s.scan("ABC-123");
    expect(s.got).toEqual([["ABC-123", "keystroke"]]);
  });

  it("eşik sınırında (30 ms) kabul, üstünde (31 ms) tarama sayılmaz", () => {
    const s = setup();
    s.scan("A1", 30);
    expect(s.got).toHaveLength(1);
    s.scan("B2", 31);
    expect(s.got).toHaveLength(1);
  });

  it("karakter arasında eşik aşılırsa tampon atılır; sonraki tarama yine okunur", () => {
    const s = setup();
    s.press(P, 5);
    s.press("A", 5);
    s.press("B", 200);
    s.press("Enter", 5);
    expect(s.got).toEqual([]);
    s.scan("OK1");
    expect(s.got).toEqual([["OK1", "keystroke"]]);
  });

  it("insan yazımı (önek yok, yavaş ya da hızlı) onScan çağırmaz ve olayı engellemez", () => {
    const s = setup();
    for (const ch of "ABC123") s.press(ch, 120);
    s.press("Enter", 120);
    for (const ch of "FAST") s.press(ch, 1);
    s.press("Enter", 1);
    expect(s.got).toEqual([]);
    expect(s.prevented).toEqual([]);
  });

  it.each(["İ", "ı", "ş", "i", "-", "/", "."])("Türkçe düzen karakteri %s birebir", (ch) => {
    const s = setup();
    s.scan(`A${ch}B`);
    expect(s.got).toEqual([[`A${ch}B`, "keystroke"]]);
  });

  it("Shift tuşu olayları tamponu bozmaz (büyük harf İ)", () => {
    const s = setup();
    s.press(P, 5);
    s.press("Shift", 5);
    s.press("İ", 5);
    s.press("Enter", 5);
    expect(s.got).toEqual([["İ", "keystroke"]]);
  });

  it("odak kaybı (blur) tamponu silmez: dinleyici global kalır", () => {
    const s = setup();
    s.press(P, 5);
    s.press("X", 5);
    // Odak değişimi keydown dışında bir olaydır; kaynak yalnızca keydown dinler.
    expect(s.listeners.size).toBe(1);
    s.press("Y", 5);
    s.press("Enter", 5);
    expect(s.got).toEqual([["XY", "keystroke"]]);
  });

  it("GS1 yer tutucusu ~ GS'ye çevrilir; AI (01)/(10)/(17)/(21) ayrışır", () => {
    const s = setup();
    s.scan("0104012345678901~10LOT42~17271231~21SN-9");
    expect(s.got).toHaveLength(1);
    const [value] = s.got[0] ?? [""];
    expect(value).toBe("0104012345678901\u001d10LOT42\u001d17271231\u001d21SN-9");
    const r = parseScannedGs1(value);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.gtin).toBe("04012345678901");
      expect(r.lot).toBe("LOT42");
      expect(r.expiryRaw).toBe("271231");
      expect(r.expiryDate).toBe("2027-12-31");
      expect(r.elements.map((e) => (e.kind === "known" ? e.ai : "?"))).toEqual(["01", "10", "17", "21"]);
    }
  });

  it("elle giriş source=manual ile gelir; boş değer iletilmez", () => {
    const s = setup();
    s.service.submitManual("  ELLE-1 ");
    s.service.submitManual("   ");
    expect(s.got).toEqual([["ELLE-1", "manual"]]);
  });

  it("tek etkin dinleyici: yeni abonelik eskisini bırakır; eski unsubscribe yenisini kapatmaz", () => {
    const s = setup();
    const second: string[] = [];
    s.service.onScan((v) => second.push(v));
    s.scan("A1");
    expect(s.got).toEqual([]);
    expect(second).toEqual(["A1"]);
    s.unsub();
    s.scan("B2");
    expect(second).toEqual(["A1", "B2"]);
  });

  it("dinleyici kalmayınca kaynak durur (global dinleyici bırakılır)", () => {
    const s = setup();
    expect(s.listeners.size).toBe(1);
    s.unsub();
    expect(s.listeners.size).toBe(0);
  });
});
