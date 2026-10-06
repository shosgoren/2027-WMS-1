// Decimal miktar aritmetiği (T-208; I-09): float yok. Değerler dizgi (`"12.5"`) olarak taşınır; hesap `BigInt` ile
// ölçekli tamsayı üzerinde yapılır (yeni bağımlılık yok). Yuvarlama YOKTUR: ölçeği aşan sonuç reddedilir.
import { AppError } from "@wms/shared/errors";

/** Girdi dizgisi üst sınırı (işaret ve nokta dahil); aşırı uzun girdi BigInt maliyeti üretmesin. */
const MAX_INPUT_LENGTH = 40;
/** Dönüşüm katsayısı: `unit_conversions.to_base_factor` numeric(20,6) → en çok 6 ondalık, 14 tam hane. */
export const FACTOR_MAX_DECIMALS = 6;
const FACTOR_MAX_INT_DIGITS = 14;
const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Ölçekli tamsayı: değer = `units / 10^scale`. */
export interface ScaledDecimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Ayrıştırma hatası (iç); çağıran uygun `AppError`a çevirir. */
export class DecimalFormatError extends Error {
  override name = "DecimalFormatError";
}

export function parseDecimal(raw: string): ScaledDecimal {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_INPUT_LENGTH) {
    throw new DecimalFormatError("decimal: invalid length");
  }
  const m = DECIMAL_RE.exec(raw);
  if (m === null) throw new DecimalFormatError("decimal: invalid format");
  const frac = m[3] ?? "";
  const magnitude = BigInt(`${m[2] as string}${frac}`);
  return { units: m[1] === "-" ? -magnitude : magnitude, scale: frac.length };
}

function rescale(a: ScaledDecimal, scale: number): bigint {
  return a.units * 10n ** BigInt(scale - a.scale);
}

/** Kanonik dizgi: gereksiz sondaki sıfırlar atılır (`"1.50"` → `"1.5"`, `"-0"` → `"0"`). */
export function formatDecimal(d: ScaledDecimal): string {
  const negative = d.units < 0n;
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, "0");
  const intPart = d.scale === 0 ? digits : digits.slice(0, digits.length - d.scale);
  const fracPart = (d.scale === 0 ? "" : digits.slice(digits.length - d.scale)).replace(/0+$/, "");
  const body = fracPart === "" ? intPart : `${intPart}.${fracPart}`;
  return negative && body !== "0" ? `-${body}` : body;
}

export function addDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return formatDecimal({ units: rescale(x, scale) + rescale(y, scale), scale });
}

export function subDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return formatDecimal({ units: rescale(x, scale) - rescale(y, scale), scale });
}

/** Tam çarpım (yuvarlamasız). */
export function mulDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return formatDecimal({ units: x.units * y.units, scale: x.scale + y.scale });
}

/** −1 | 0 | 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const l = rescale(x, scale);
  const r = rescale(y, scale);
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Sondaki sıfırlar sayılmadan anlamlı ondalık hane sayısı. */
export function decimalPlaces(raw: string): number {
  return placesOfCanonical(formatDecimal(parseDecimal(raw)));
}

function placesOfCanonical(canonical: string): number {
  const dot = canonical.indexOf(".");
  return dot === -1 ? 0 : canonical.length - dot - 1;
}

function scaleError(): AppError {
  return new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
}

/** DB `numeric(20,6)`: en çok 14 tam hane. */
export const QUANTITY_MAX_INT_DIGITS = 14;

export type QuantitySign = "any" | "positive" | "nonNegative";

function intDigitsOfCanonical(canonical: string): number {
  return (canonical.replace("-", "").split(".")[0] as string).length;
}

/**
 * Miktar ürünün ondalık hassasiyetini (`quantity_scale`) aşmamalı (`QUANTITY_SCALE`); biçim hatası, işaret ihlali
 * (`sign` ZORUNLU: `any` | `positive` | `nonNegative`) ve 14 tam haneyi aşan değer `VALIDATION_FAILED`. Yuvarlama yapılmaz. Kanonik dizgiyi döndürür.
 */
export function assertQuantityScale(qty: string, scale: number, sign: QuantitySign): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new AppError("VALIDATION_FAILED");
  let parsed: ScaledDecimal;
  try {
    parsed = parseDecimal(qty);
  } catch (e) {
    if (e instanceof DecimalFormatError) throw new AppError("VALIDATION_FAILED");
    throw e;
  }
  if ((sign === "positive" && parsed.units <= 0n) || (sign === "nonNegative" && parsed.units < 0n)) {
    throw new AppError("VALIDATION_FAILED");
  }
  const canonical = formatDecimal(parsed);
  if (intDigitsOfCanonical(canonical) > QUANTITY_MAX_INT_DIGITS) throw new AppError("VALIDATION_FAILED");
  if (decimalPlaces(canonical) > scale) throw scaleError();
  return canonical;
}

/** `qty > 0`, biçim ve 14 tam hane denetimi (ölçek denetimi yok). Kanonik dizgiyi döndürür. */
export function assertPositive(qty: string): string {
  return assertQuantityScale(qty, 6, "positive");
}

/** Dönüşüm katsayısı: > 0, ≤ 6 ondalık, ≤ 14 tam hane; aksi `UNIT_CONVERSION_INVALID`. Kanonik dizgiyi döndürür. */
export function assertConversionFactor(factor: string): string {
  const invalid = (): AppError => new AppError("VALIDATION_FAILED", { detail: "UNIT_CONVERSION_INVALID" });
  let parsed: ScaledDecimal;
  try {
    parsed = parseDecimal(factor);
  } catch (e) {
    if (e instanceof DecimalFormatError) throw invalid();
    throw e;
  }
  if (parsed.units <= 0n) throw invalid();
  const canonical = formatDecimal(parsed);
  if (decimalPlaces(canonical) > FACTOR_MAX_DECIMALS) throw invalid();
  if (intDigitsOfCanonical(canonical) > FACTOR_MAX_INT_DIGITS) throw invalid();
  return canonical;
}

/**
 * Birim miktarını temel birime çevirir: `qty × factor`. Sonuç 14 tam haneyi aşarsa `VALIDATION_FAILED`; ürünün ölçeğini aşarsa yuvarlanmaz, `QUANTITY_SCALE`
 * ile reddedilir (ör. 0.5 koli × 5 = 2.5 adet, ölçek 0 → ret). Negatif `qty` varsayılan olarak `VALIDATION_FAILED`; işaretli dönüşüm için `allowNegative: true`. Kanonik dizgi döner.
 */
export function toBase(qty: string, factor: string, scale: number, options: { readonly allowNegative?: boolean } = {}): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new AppError("VALIDATION_FAILED");
  const f = parseDecimal(assertConversionFactor(factor));
  let q: ScaledDecimal;
  try {
    q = parseDecimal(qty);
  } catch (e) {
    if (e instanceof DecimalFormatError) throw new AppError("VALIDATION_FAILED");
    throw e;
  }
  // Negatif miktar yalnızca açık `allowNegative` ile (işaretli dönüşüm); varsayılan ret.
  if (q.units < 0n && options.allowNegative !== true) throw new AppError("VALIDATION_FAILED");
  const product = formatDecimal({ units: q.units * f.units, scale: q.scale + f.scale });
  if (intDigitsOfCanonical(product) > QUANTITY_MAX_INT_DIGITS) throw new AppError("VALIDATION_FAILED");
  if (placesOfCanonical(product) > scale) throw scaleError();
  return product;
}
