// Code 128 kodlayıcı (T-312, ADR-022 §2): saf işlev, bağımlılıksız. Yalnızca ASCII 32..126 (kod seti B) ve ardışık rakam
// dizileri için kod seti C. Kod seti A (kontrol karakterleri) ve FNC1-4 kullanılmaz: etiket içeriği düz metindir.
// Çıktı: sembol değerleri (başlangıç + veri + kontrol + bitiş) ve modül genişlikleri (çubuk, boşluk, çubuk, …).
import { AppError } from "@wms/shared/errors";

/** Barkod içeriği ASCII 32..126 dışı karakter (örn. Türkçe harf) içerir. `VALIDATION_FAILED` + neden `LABEL_CHARSET`. */
export class LabelCharsetError extends AppError {
  readonly reason = "LABEL_CHARSET" as const;
  constructor() {
    super("VALIDATION_FAILED");
  }
}

export const START_B = 104;
export const START_C = 105;
export const CODE_B = 100; // C kümesinden B'ye geçiş
export const CODE_C = 99; // B kümesinden C'ye geçiş
export const STOP = 106;

// 0..105: altı öğe (çubuk, boşluk, ×3), toplam 11 modül; 106 (bitiş): yedi öğe, 13 modül. (Code 128 ISO/IEC 15417 tablosu.)
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

/** Sembol değerinin (0..106) öğe genişlikleri (modül). */
export function symbolWidths(value: number): readonly number[] {
  const p = PATTERNS[value];
  if (p === undefined) throw new RangeError("code128: geçersiz sembol değeri");
  return Array.from(p, Number);
}

export interface Code128Result {
  /** Başlangıç, veri, kontrol karakteri ve bitiş sembol değerleri. */
  readonly values: readonly number[];
  /** Kontrol karakteri (mod 103). */
  readonly checksum: number;
  /** Çubuk/boşluk modül genişlikleri; çubukla başlar, çubukla biter (bitiş deseni 7 öğe). */
  readonly widths: readonly number[];
  /** Toplam modül sayısı (sessiz bölge hariç). */
  readonly modules: number;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function digitRun(text: string, from: number): number {
  let n = 0;
  while (isDigit(text[from + n])) n++;
  return n;
}

/**
 * Kod seti seçimi (sembol sayısını azaltan standart sezgisel): metnin başında ya da sonunda ≥ 4, ortada ≥ 6 ardışık rakam C ile
 * kodlanır; tek sayıdaki rakam dizisinin ilk rakamı mevcut kümede (B) kalır, kalan çift sayı C'de kodlanır.
 * Tamamı tam 2 rakamdan oluşan metin C ile kodlanır.
 */
export function encodeCode128(text: string): Code128Result {
  if (typeof text !== "string" || text.length === 0) throw new AppError("VALIDATION_FAILED");
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) throw new LabelCharsetError();
  }
  const values: number[] = [];
  let set: "B" | "C" = "B";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const run = digitRun(text, i);
    const atStart = i === 0;
    const atEnd = i + run === len;
    const wantC = run >= 2 && ((atStart && atEnd && run === 2) || run >= (atStart || atEnd ? 4 : 6));
    if (set === "B" && wantC) {
      let lead = 0;
      if (run % 2 === 1) lead = 1; // tek rakam: önce B'de kodlanır
      if (atStart && values.length === 0) {
        if (lead === 1) {
          values.push(START_B, text.charCodeAt(i) - 32, CODE_C);
          i += 1;
        } else {
          values.push(START_C);
        }
      } else {
        if (lead === 1) {
          values.push(text.charCodeAt(i) - 32);
          i += 1;
        }
        values.push(CODE_C);
      }
      set = "C";
      continue;
    }
    if (set === "C") {
      if (run >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      set = "B";
      continue;
    }
    if (values.length === 0) values.push(START_B);
    values.push(text.charCodeAt(i) - 32);
    i += 1;
  }
  let sum = values[0] ?? 0;
  for (let k = 1; k < values.length; k++) sum += (values[k] ?? 0) * k;
  const checksum = sum % 103;
  values.push(checksum, STOP);
  const widths = values.flatMap((v) => symbolWidths(v));
  return { values, checksum, widths, modules: widths.reduce((a, b) => a + b, 0) };
}

/** Modül dizisi: `1` = çubuk, `0` = boşluk (doğrulama ve çizim yardımcısı). */
export function toModuleString(result: Code128Result): string {
  let out = "";
  result.widths.forEach((w, idx) => {
    out += (idx % 2 === 0 ? "1" : "0").repeat(w);
  });
  return out;
}
