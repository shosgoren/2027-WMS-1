// GS1 öğe dizgisi ayrıştırıcı (T-208; 04 §Ürün "GS1 ayrıştırma test edilir"): saf işlev, DB/ağ yok.
//
// Desteklenen biçim: FNC1 ayraçlı (GS, U+001D) ve isteğe bağlı `]C1` (GS1-128) / `]d2` (GS1 DataMatrix) sembol
// tanımlayıcısı önekli öğe dizgisi (parantezli insan-okur biçimi DESTEKLENMEZ). Bilinen AI'lar:
//   (01) GTIN 14 hane sabit, kontrol hanesi doğrulanır · (10) lot, ≤20 · (17) SKT YYMMDD sabit 6 ·
//   (21) seri, ≤20 · (30) ve (37) adet, ≤8 rakam.
// Tanınmayan AI hata DEĞİLDİR: AI uzunluğu bilinmediğinden segmentin (sonraki GS'ye ya da sonuna kadar) kalanı ham
// olarak `unknown` öğesinde korunur; aynı segmentte ondan sonra gelen AI'lar bu nedenle ayrıştırılamaz (GS ayracı
// yoksa). GS1 AI uzunluk tablosu bilerek uydurulmaz (G-03); kapsam genişletme = yeni AI satırı eklemek.
//
// SKT yüzyılı: YY → 20YY (A-98 önerisi); DD=00 "ayın son günü" anlamına gelir ve o ayın son gününe çözülür.

export const GS = "\u001d";

export type Gs1FailureReason =
  | "EMPTY"
  | "NOT_GS1" // GS1 öğe dizgisi olarak başlamıyor (AI yok) ya da desteklenmeyen sembol tanımlayıcı
  | "MALFORMED" // sabit uzunluk/karakter kümesi/uzunluk ihlali, yinelenen AI
  | "INVALID_GTIN_CHECK_DIGIT"
  | "INVALID_DATE";

export type Gs1Element =
  | { readonly kind: "known"; readonly ai: "01" | "10" | "17" | "21" | "30" | "37"; readonly value: string }
  | { readonly kind: "unknown"; readonly raw: string };

export interface Gs1Parsed {
  readonly ok: true;
  /** Sıra korunur; tanınmayan segmentler `unknown` olarak yerinde durur. */
  readonly elements: readonly Gs1Element[];
  readonly gtin?: string;
  readonly lot?: string;
  /** (17) ham YYMMDD. */
  readonly expiryRaw?: string;
  /** (17) ISO tarih `YYYY-MM-DD` (tarih-only; saat dilimi yok). */
  readonly expiryDate?: string;
  readonly serial?: string;
  /** (30) ya da (37), rakam dizgisi (baştaki sıfırlar atılmış). İkisi de varsa (30) önceliklidir. */
  readonly quantity?: string;
}

export interface Gs1Failed {
  readonly ok: false;
  readonly reason: Gs1FailureReason;
}

export type Gs1Result = Gs1Parsed | Gs1Failed;

type KnownAi = "01" | "10" | "17" | "21" | "30" | "37";
const SPEC: Readonly<Record<KnownAi, { readonly fixed: number | null; readonly max: number; readonly digits: boolean }>> = {
  "01": { fixed: 14, max: 14, digits: true },
  "10": { fixed: null, max: 20, digits: false },
  "17": { fixed: 6, max: 6, digits: true },
  "21": { fixed: null, max: 20, digits: false },
  "30": { fixed: null, max: 8, digits: true },
  "37": { fixed: null, max: 8, digits: true },
};
// GS1 karakter kümesi 82 (ASCII: ! " % & ' ( ) * + , - . / 0-9 : ; < = > ? A-Z _ a-z).
const CSET82_RE = /^[\x21\x22\x25-\x3f\x41-\x5a\x5f\x61-\x7a]+$/;
const DIGITS_RE = /^[0-9]+$/;
const MAX_INPUT_LENGTH = 256;

function isKnownAi(ai: string): ai is KnownAi {
  return Object.prototype.hasOwnProperty.call(SPEC, ai);
}

/** GTIN-8/12/13/14 mod-10 kontrol hanesi (ağırlık 3,1 sağdan, kontrol hanesi hariç). */
export function isValidGtin(gtin: string): boolean {
  if (!/^[0-9]+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length)) return false;
  let sum = 0;
  for (let i = gtin.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(gtin[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(gtin[gtin.length - 1]);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveExpiry(yymmdd: string): string | null {
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const last = daysInMonth(year, month);
  if (day === 0) day = last;
  if (day > last) return null;
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

/** Sembol tanımlayıcı önekini (`]C1`, `]d2`) soyar; başka `]xx` öneki desteklenmez. */
function stripSymbology(raw: string): string | null {
  if (raw.startsWith("]")) {
    const id = raw.slice(0, 3);
    return id === "]C1" || id === "]d2" ? raw.slice(3) : null;
  }
  return raw;
}

export function parseGs1(raw: string): Gs1Result {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "EMPTY" };
  if (raw.length > MAX_INPUT_LENGTH) return { ok: false, reason: "MALFORMED" };
  const body = stripSymbology(raw);
  if (body === null || body.length === 0) return { ok: false, reason: body === null ? "NOT_GS1" : "EMPTY" };

  const elements: Gs1Element[] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (pos < body.length) {
    if (body[pos] === GS) {
      pos += 1; // ardışık/baştaki ayraç: boş segment atlanır
      continue;
    }
    const ai = body.slice(pos, pos + 2);
    if (!isKnownAi(ai)) {
      if (pos === 0 && !DIGITS_RE.test(ai)) return { ok: false, reason: "NOT_GS1" };
      let end = body.indexOf(GS, pos);
      if (end === -1) end = body.length;
      elements.push({ kind: "unknown", raw: body.slice(pos, end) });
      pos = end;
      continue;
    }
    if (seen.has(ai)) return { ok: false, reason: "MALFORMED" };
    seen.add(ai);
    const spec = SPEC[ai];
    const start = pos + 2;
    let end: number;
    if (spec.fixed !== null) {
      end = start + spec.fixed;
      if (end > body.length) return { ok: false, reason: "MALFORMED" };
    } else {
      end = body.indexOf(GS, start);
      if (end === -1) end = body.length;
    }
    const value = body.slice(start, end);
    if (value.length === 0 || value.length > spec.max) return { ok: false, reason: "MALFORMED" };
    if (spec.digits ? !DIGITS_RE.test(value) : !CSET82_RE.test(value)) return { ok: false, reason: "MALFORMED" };
    if (ai === "01" && !isValidGtin(value)) return { ok: false, reason: "INVALID_GTIN_CHECK_DIGIT" };
    if (ai === "17" && resolveExpiry(value) === null) return { ok: false, reason: "INVALID_DATE" };
    elements.push({ kind: "known", ai, value });
    pos = end;
  }
  if (elements.length === 0) return { ok: false, reason: "NOT_GS1" };

  const get = (ai: KnownAi): string | undefined => {
    for (const e of elements) if (e.kind === "known" && e.ai === ai) return e.value;
    return undefined;
  };
  const stripZeros = (s: string): string => s.replace(/^0+(?=\d)/, "");
  const gtin = get("01");
  const lot = get("10");
  const expiryRaw = get("17");
  const serial = get("21");
  const qtyRaw = get("30") ?? get("37");
  const expiryDate = expiryRaw === undefined ? undefined : (resolveExpiry(expiryRaw) ?? undefined);
  return {
    ok: true,
    elements,
    ...(gtin === undefined ? {} : { gtin }),
    ...(lot === undefined ? {} : { lot }),
    ...(expiryRaw === undefined ? {} : { expiryRaw }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(serial === undefined ? {} : { serial }),
    ...(qtyRaw === undefined ? {} : { quantity: stripZeros(qtyRaw) }),
  };
}

/**
 * GTIN-14'ün depoda saklanmış olabilecek kısa biçimleri (başında sıfır doldurulmuş GTIN-13/12/8). Yalnızca baştaki
 * sıfırlar atılarak ve kontrol hanesi tutarlı kalarak türetilir (kontrol hanesi sağdadır, sıfır dolgusu değiştirmez).
 */
export function gtinLookupForms(gtin14: string): string[] {
  const forms = [gtin14];
  for (const len of [13, 12, 8]) {
    const cut = gtin14.length - len;
    if (cut > 0 && /^0+$/.test(gtin14.slice(0, cut))) forms.push(gtin14.slice(cut));
  }
  return forms;
}
