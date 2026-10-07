// Açılış verisi içe aktarma: SAF ayrıştırma ve doğrulama (T-289). Veritabanı, saat, rastgelelik yok; sistem durumu çağıranın verdiği
// `ProductContext`/`StockContext` anlık görüntüsüdür. Hiçbir şey yazılmaz; çıktı satır başına sorun listesidir (kod + parametre;
// kullanıcıya dönük sade metin UI'da i18n ile üretilir, domain dilden bağımsız kalır).
//
// Biçim: CSV (Excel "CSV UTF-8"); ayırıcı `;` ya da `,` otomatik; BOM; Türkçe ondalık virgül; başlık satırı Türkçe sütun adları.
// Koli kuralları (T-287 K-1…K-3): koli adedi katsayıdır (tam sayı ≥ 2; kesirli koli reddedilir, K-3); koli barkodunun adedi
// yalnız bu katsayıdan gelir (barkoda ayrı adet yazılmaz, K-1). Miktarlar tam sayı (A-33; ürün ölçeği 0), kesir yalnız ürün ölçeği izin verirse.
import { parseGs1 } from "../catalog/gs1.ts";

/**
 * A-289-1: dosya üst sınırları. Sınır GERÇEK bayttır (UTF-8). Next sunucu eylemi gövde sınırı 1 MB (ayarlanmaz); metin JSON içinde gider ve satır sonları/tırnaklar
 * kaçışla en çok ~1,1x büyür, bu yüzden 384 KiB (≈ 5.000 satır × ~80 bayt) güvenli pay bırakır. Aşan dosya bölünür.
 */
export const IMPORT_MAX_BYTES = 384 * 1024;
export const IMPORT_MAX_ROWS = 5000;
/** Parça boyutu: bir sunucu çağrısında işlenen satır (ürün) / bir stok belgesindeki satır sayısı (A-07 belge sınırı 2.000'in çok altında). */
export const IMPORT_CHUNK_SIZE = 200;
/** A-289-2: koli içi adet üst sınırı (yazım hatasına karşı; 1.000.000 adetlik koli gerçekçi değildir). */
export const PACK_QTY_MAX = 1_000_000n;
export const PACK_UNIT_CODE = "KOLI";
export const PACK_UNIT_NAME = "Koli";
export const DEFAULT_BASE_UNIT_CODE = "ADET";

export type ImportKind = "PRODUCTS" | "STOCK";

export const PRODUCT_HEADERS = ["kod", "ad", "temel birim", "koli içi adet", "adet barkodu", "koli barkodu"] as const;
export const STOCK_HEADERS = ["ürün kodu", "raf kodu", "miktar"] as const;

/** İndirilebilir şablon (BOM + başlık; örnek satır YOK: unutulan örnek satır içe aktarılırdı). `;` Türkçe Excel'in varsayılan ayırıcısıdır. */
export function templateCsv(kind: ImportKind): string {
  const headers = kind === "PRODUCTS" ? PRODUCT_HEADERS : STOCK_HEADERS;
  return `﻿${headers.map((h) => (kind === "STOCK" && h === "miktar" ? "miktar (adet)" : h)).join(";")}\r\n`;
}

// --- sorunlar ---------------------------------------------------------------------------------------------------------

export type IssueCode =
  | "FILE_EMPTY"
  | "FILE_TOO_LARGE"
  | "FILE_ENCODING"
  | "TOO_MANY_ROWS"
  | "CSV_UNTERMINATED_QUOTE"
  | "FORMAT_UNKNOWN"
  | "COLUMN_MISSING"
  | "COLUMN_DUPLICATE"
  | "NO_ROWS"
  | "ROW_TOO_MANY_CELLS"
  | "CODE_MISSING"
  | "CODE_INVALID"
  | "CODE_DUPLICATE_FILE"
  | "NAME_MISSING"
  | "NAME_INVALID"
  | "UNIT_UNKNOWN"
  | "ITEM_UNIT_MISMATCH"
  | "ITEM_ARCHIVED"
  | "ITEM_UNKNOWN"
  | "ITEM_TRACKED"
  | "PACK_QTY_INVALID"
  | "PACK_QTY_FRACTIONAL"
  | "PACK_QTY_TOO_SMALL"
  | "PACK_QTY_TOO_LARGE"
  | "PACK_QTY_CONFLICT"
  | "PACK_BASE_UNIT"
  | "PACK_BARCODE_NEEDS_QTY"
  | "BARCODE_INVALID"
  | "BARCODE_SAME_ROW"
  | "BARCODE_DUPLICATE_FILE"
  | "BARCODE_TAKEN"
  | "SHELF_MISSING"
  | "SHELF_UNKNOWN"
  | "SHELF_ARCHIVED"
  | "SHELF_AMBIGUOUS"
  | "SHELF_KIND"
  | "QTY_MISSING"
  | "QTY_INVALID"
  | "QTY_NEGATIVE"
  | "QTY_ZERO"
  | "QTY_AMBIGUOUS"
  | "QTY_FRACTIONAL"
  | "QTY_TOO_LARGE"
  | "PAIR_DUPLICATE_FILE"
  | "PAIR_HAS_STOCK"
  | "CELL_TOO_LONG"
  | "TOO_MANY_COLUMNS";

export type ImportColumn = "kod" | "ad" | "temel birim" | "koli içi adet" | "adet barkodu" | "koli barkodu" | "ürün kodu" | "raf kodu" | "miktar" | "dosya";

export interface ImportIssue {
  /** Excel satır numarası (başlık = 1); dosya düzeyi sorunlarda 0. */
  readonly row: number;
  readonly column: ImportColumn;
  readonly code: IssueCode;
  /** Sorunu açıklayan değerler (ör. ilk geçtiği satır, sistemdeki kod); kullanıcı verisi olan dizgiler kısaltılmıştır. */
  readonly params: Readonly<Record<string, string | number>>;
}

function issue(row: number, column: ImportColumn, code: IssueCode, params: Readonly<Record<string, string | number>> = {}): ImportIssue {
  return { row, column, code, params };
}

const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

// --- CSV ---------------------------------------------------------------------------------------------------------------

/** A-289-5: ayrıştırma SIRASINDA hücre/sütun üst sınırları (kötü niyetli ya da bozuk dosya bellek ve süreyi şişiremesin). */
export const HEADER_CELL_MAX = 200;
export const DATA_CELL_MAX = 1000;
export const MAX_COLUMNS = 40;
const MAX_LIMIT_ISSUES = 200;

export interface CsvLimitIssue {
  readonly row: number;
  readonly code: "CELL_TOO_LONG" | "TOO_MANY_COLUMNS";
}
export type CsvResult =
  | { readonly ok: true; readonly records: readonly (readonly string[])[]; readonly delimiter: ";" | ","; readonly limitIssues: readonly CsvLimitIssue[] }
  | { readonly ok: false; readonly code: "CSV_UNTERMINATED_QUOTE" | "FILE_EMPTY" };

/** İlk kayıttaki (tırnak dışı) `;` ve `,` sayısına göre ayırıcı; eşitlikte `;` (Türkçe Excel). Tek geçiş, doğrusal. */
function detectDelimiter(text: string): ";" | "," {
  let semi = 0;
  let comma = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c === ";") semi++;
    else if (!quoted && c === ",") comma++;
  }
  return comma > semi ? "," : ";";
}

const isBlankChar = (c: string): boolean => c === " " || c === "\t" || c === "\u00a0" || c === "\ufeff";

/**
 * RFC 4180 benzeri: tırnaklı alan, `""` kaçışı, tırnak içinde satır sonu; CRLF/LF/CR; BOM atılır. Tamamen boş kayıtlar korunur (satır numarası
 * kaymasın). DOĞRUSAL: her karakter bir kez işlenir; hücre `limit + 1` karakterden fazla saklanmaz (aşım `limitIssues`'a yazılır), sütun sayısı
 * `MAX_COLUMNS` ile sınırlıdır (fazlası atılır). Başlık satırı (ilk kayıt) 200, veri satırı 1000 karakter hücre sınırı taşır.
 */
export function parseCsv(input: string): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === "") return { ok: false, code: "FILE_EMPTY" };
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  const limitIssues: CsvLimitIssue[] = [];
  let row: string[] = [];
  let field = "";
  let fieldLen = 0;
  let blank = true; // alan şimdiye dek yalnız boşluk (tırnak açılışı için)
  let quoted = false;
  let fieldWasQuoted = false;
  let atRecordStart = true;
  let rowFlag: CsvLimitIssue["code"] | null = null;
  const cellMax = (): number => (records.length === 0 ? HEADER_CELL_MAX : DATA_CELL_MAX);
  const append = (c: string): void => {
    fieldLen++;
    if (fieldLen <= cellMax() + 1) field += c;
    else rowFlag ??= "CELL_TOO_LONG";
  };
  const endField = (): void => {
    if (fieldLen > cellMax()) rowFlag ??= "CELL_TOO_LONG";
    if (row.length < MAX_COLUMNS) row.push(fieldWasQuoted ? field : field.trim());
    else rowFlag ??= "TOO_MANY_COLUMNS";
    field = "";
    fieldLen = 0;
    blank = true;
    fieldWasQuoted = false;
  };
  const endRecord = (): void => {
    if (rowFlag !== null && limitIssues.length < MAX_LIMIT_ISSUES) limitIssues.push({ row: records.length + 1, code: rowFlag });
    rowFlag = null;
    records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    atRecordStart = false;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else quoted = false;
      } else append(c);
      continue;
    }
    if (c === '"' && blank) {
      quoted = true;
      fieldWasQuoted = true;
      field = "";
      fieldLen = 0;
    } else if (c === delimiter) endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endField();
      endRecord();
      atRecordStart = true;
    } else {
      if (blank && !isBlankChar(c)) blank = false;
      append(c);
    }
  }
  if (quoted) return { ok: false, code: "CSV_UNTERMINATED_QUOTE" };
  if (!atRecordStart) {
    endField();
    endRecord();
  }
  return { ok: true, records, delimiter, limitIssues };
}

/** Türkçe harfleri ve noktalamayı katlar: "Ürün Kodu", "urun_kodu", "ÜRÜN KODU" aynı anahtar olur. Parantez içi (ör. "(adet)") atılır; DOĞRUSAL tarayıcı (regex yok). */
export function foldHeader(raw: string): string {
  // Kapanmayan "(" metnin geri kalanını yutmaz: yalnız kapanan çiftler atılır; en yakın ")" bir kez aranır (indexOf, her "(" için en çok bir ileri tarama,
  // kapanış yoksa sonraki "(" için tekrar taranmasın diye bu bilgi bir kez saklanır).
  let out = "";
  let i = 0;
  let noCloseAfter = false;
  while (i < raw.length) {
    const c = raw[i] as string;
    if (c === "(" && !noCloseAfter) {
      const close = raw.indexOf(")", i + 1);
      if (close === -1) noCloseAfter = true;
      else {
        out += " ";
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// --- başlık eşleme ---------------------------------------------------------------------------------------------------

const PRODUCT_ALIASES: Readonly<Record<string, (typeof PRODUCT_HEADERS)[number]>> = {
  kod: "kod",
  "urun kodu": "kod",
  ad: "ad",
  "urun adi": "ad",
  isim: "ad",
  "temel birim": "temel birim",
  birim: "temel birim",
  "koli ici adet": "koli içi adet",
  "koli adedi": "koli içi adet",
  "adet barkodu": "adet barkodu",
  "koli barkodu": "koli barkodu",
};
const STOCK_ALIASES: Readonly<Record<string, (typeof STOCK_HEADERS)[number]>> = {
  "urun kodu": "ürün kodu",
  kod: "ürün kodu",
  "raf kodu": "raf kodu",
  raf: "raf kodu",
  miktar: "miktar",
  adet: "miktar",
};
const PRODUCT_REQUIRED = ["kod", "ad"] as const;

export type Records = readonly (readonly string[])[];

/** Başlıktan dosya türü: `raf kodu` sütunu varsa açılış stoku; `ad` varsa ürünler. */
export function detectKind(header: readonly string[]): ImportKind | null {
  const keys = new Set(header.map(foldHeader));
  if (["raf kodu", "raf", "miktar"].some((k) => keys.has(k))) return "STOCK";
  if (["ad", "urun adi", "isim", "temel birim", "birim", "koli ici adet", "adet barkodu", "koli barkodu"].some((k) => keys.has(k))) return "PRODUCTS";
  return null;
}

function mapColumns<K extends string>(header: readonly string[], aliases: Readonly<Record<string, K>>, required: readonly K[], rowIssues: ImportIssue[]): Map<K, number> {
  const map = new Map<K, number>();
  header.forEach((h, i) => {
    const key = aliases[foldHeader(h)];
    if (key === undefined) return;
    if (map.has(key)) rowIssues.push(issue(1, key as ImportColumn, "COLUMN_DUPLICATE"));
    else map.set(key, i);
  });
  for (const r of required) if (!map.has(r)) rowIssues.push(issue(1, r as ImportColumn, "COLUMN_MISSING"));
  return map;
}

// --- Türkçe ondalık ---------------------------------------------------------------------------------------------------

export type DecimalResult =
  | { readonly ok: true; readonly int: string; readonly frac: string; readonly text: string }
  | { readonly ok: false; readonly reason: "EMPTY" | "INVALID" | "NEGATIVE" | "AMBIGUOUS" | "TOO_LARGE" };

/**
 * Türkçe sayı: `12`, `12,5`, `1.250,5`, `1.250.000`, `0.25`. Belirsiz `1.250` (binlik mi ondalık mı?) SESSİZCE yorumlanmaz: reddedilir (`AMBIGUOUS`).
 * Üstel gösterim (`1E+03`), işaret, boşluk içi rakam, `1,250.5` (İngilizce biçim) `INVALID`. En çok 14 tam + 6 ondalık hane (numeric(20,6)).
 */
export function parseTrDecimal(raw: string): DecimalResult {
  const v = raw.replace(/[\s  ]/g, "");
  if (v === "") return { ok: false, reason: "EMPTY" };
  if (v.startsWith("-")) return { ok: false, reason: "NEGATIVE" };
  if (!/^[0-9.,]+$/.test(v)) return { ok: false, reason: "INVALID" };
  let int: string;
  let frac = "";
  const hasDot = v.includes(".");
  const hasComma = v.includes(",");
  if (hasDot && hasComma) {
    const m = /^(\d{1,3}(?:\.\d{3})*),(\d+)$/.exec(v);
    if (m === null) return { ok: false, reason: "INVALID" };
    int = (m[1] as string).replace(/\./g, "");
    frac = m[2] as string;
  } else if (hasComma) {
    const m = /^(\d+),(\d+)$/.exec(v);
    if (m === null) return { ok: false, reason: "INVALID" };
    int = m[1] as string;
    frac = m[2] as string;
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(v)) int = v.replace(/\./g, "");
    else if (/^\d{1,3}\.\d{3}$/.test(v)) return { ok: false, reason: "AMBIGUOUS" };
    else {
      const m = /^(\d+)\.(\d+)$/.exec(v);
      if (m === null) return { ok: false, reason: "INVALID" };
      int = m[1] as string;
      frac = m[2] as string;
    }
  } else {
    if (!/^\d+$/.test(v)) return { ok: false, reason: "INVALID" };
    int = v;
  }
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (int.length > 14 || frac.length > 6) return { ok: false, reason: "TOO_LARGE" };
  return { ok: true, int, frac, text: frac === "" ? int : `${int}.${frac}` };
}

// --- bağlam (sistem anlık görüntüsü) ------------------------------------------------------------------------------------

export type UnitInfo = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
};
export interface ItemInfoCtx {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly baseUnitId: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly quantityScale: number;
  readonly trackingMode: string;
}
export interface BarcodeInfoCtx {
  readonly itemCode: string;
  /** `null` = temel birim (barkodda birim yok). */
  readonly unitId: string | null;
}
export interface ShelfInfo {
  readonly id: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly code: string;
  readonly kind: string;
  readonly status: "ACTIVE" | "ARCHIVED";
}
export interface ProductContext {
  readonly units: readonly UnitInfo[];
  readonly items: ReadonlyMap<string, ItemInfoCtx>;
  /** Barkod → sistemdeki kayıtlar. */
  readonly barcodes: ReadonlyMap<string, readonly BarcodeInfoCtx[]>;
  /** Ürün kodu → birim kimliği → katsayı (kanonik dizgi). */
  readonly conversions: ReadonlyMap<string, ReadonlyMap<string, string>>;
}
/** (ürün, raf) çiftinin mevcut durumu: `hasStock` = defterde hareket ya da bakiye > 0; `applied` = bu çifte önceki içe aktarmayla yazılmış (kanonik) miktarlar. */
export interface PairState {
  readonly hasStock: boolean;
  readonly applied: ReadonlySet<string>;
}
export interface StockContext {
  /** Anahtar `${itemId}|${locationId}`; verilmezse çiftlerde stok yok sayılır (yalnız saf birim testleri). */
  readonly pairs?: ReadonlyMap<string, PairState>;
  readonly items: ReadonlyMap<string, ItemInfoCtx>;
  /** Raf kodu (büyük/küçük harf duyarsız anahtar) → aynı kodlu raflar (birden çok depoda olabilir). */
  readonly shelves: ReadonlyMap<string, readonly ShelfInfo[]>;
}

export const shelfKey = (code: string): string => code.trim().toLocaleUpperCase("tr");
const unitKey = (s: string): string => s.trim().toLocaleUpperCase("tr");

// --- ürünler ---------------------------------------------------------------------------------------------------------

export interface ProductPlan {
  readonly row: number;
  readonly code: string;
  readonly name: string;
  readonly baseUnitCode: string;
  /** Koli içi adet (kanonik tam sayı dizgisi) ya da `null`. */
  readonly packQty: string | null;
  readonly unitBarcode: string | null;
  readonly packBarcode: string | null;
  /** Sistemde yok → oluşturulacak; var ve uyumlu → yalnız eksik bilgiler tamamlanır. */
  readonly exists: boolean;
}

export interface PreviewResult<P> {
  readonly kind: ImportKind;
  readonly plans: readonly P[];
  readonly issues: readonly ImportIssue[];
  /** Başlık sonrası dosyadaki dolu satır sayısı. */
  readonly rowCount: number;
  /** Yalnız açılış stoku: tek tek geçerli satırlar (başka satırlarda hata olsa da); çift durumu sorgusu için. */
  readonly candidates?: readonly P[];
  /** Dosyadaki farklı ürün kodu sayısı (hatalı satırlar dahil; yalnız özet için). */
  readonly distinctItems: number;
}

function cell(r: readonly string[], map: ReadonlyMap<string, number>, key: string): string {
  const i = map.get(key);
  return i === undefined ? "" : (r[i] ?? "");
}

function isBlankRecord(r: readonly string[]): boolean {
  return r.every((v) => v === "");
}

function barcodeProblem(v: string): boolean {
  // `addBarcode` ile aynı reddedilenler: GS ayracı, kontrol karakteri, 128 üstü; geçerli GTIN içeren GS1 dizgisi kaydedilmez.
  if (v.length > 128 || /[\u0000-\u001f\u007f]/.test(v)) return true;
  const gs1 = parseGs1(v);
  return gs1.ok && gs1.gtin !== undefined;
}

export function validateProducts(records: Records, ctx: ProductContext): PreviewResult<ProductPlan> {
  const issues: ImportIssue[] = [];
  const header = records[0] ?? [];
  const cols = mapColumns(header, PRODUCT_ALIASES, PRODUCT_REQUIRED, issues);
  const body = records.slice(1);
  const rowCount = body.filter((r) => !isBlankRecord(r)).length;
  if (issues.length > 0) return { kind: "PRODUCTS", plans: [], issues, rowCount, distinctItems: 0 };
  if (rowCount === 0) return { kind: "PRODUCTS", plans: [], issues: [issue(0, "dosya", "NO_ROWS")], rowCount, distinctItems: 0 };
  if (rowCount > IMPORT_MAX_ROWS) return { kind: "PRODUCTS", plans: [], issues: [issue(0, "dosya", "TOO_MANY_ROWS", { max: IMPORT_MAX_ROWS, count: rowCount })], rowCount, distinctItems: 0 };

  const unitByKey = new Map<string, UnitInfo>();
  for (const u of ctx.units) {
    unitByKey.set(unitKey(u.code), u);
    if (!unitByKey.has(unitKey(u.name))) unitByKey.set(unitKey(u.name), u);
  }
  const unitById = new Map(ctx.units.map((u) => [u.id, u] as const));
  const packUnit = unitByKey.get(PACK_UNIT_CODE);
  const firstCodeRow = new Map<string, number>();
  // Dosya içi barkod sahipliği: barkod → [satır, sütun, ürün kodu, birim anahtarı ("B"=temel, "P"=koli)].
  const fileBarcodes = new Map<string, { row: number; column: ImportColumn; code: string; unit: "B" | "P" }>();
  const plans: ProductPlan[] = [];

  body.forEach((r, idx) => {
    if (isBlankRecord(r)) return;
    const row = idx + 2;
    const before = issues.length;
    if (r.length > header.length && r.slice(header.length).some((v) => v !== "")) issues.push(issue(row, "dosya", "ROW_TOO_MANY_CELLS", { cells: r.length, columns: header.length }));

    const code = cell(r, cols, "kod");
    const name = cell(r, cols, "ad");
    if (code === "") issues.push(issue(row, "kod", "CODE_MISSING"));
    else if (code.length > 64 || /[\u0000-\u001f\u007f]/.test(code)) issues.push(issue(row, "kod", "CODE_INVALID", { max: 64 }));
    else {
      const first = firstCodeRow.get(code);
      if (first !== undefined) issues.push(issue(row, "kod", "CODE_DUPLICATE_FILE", { code: clip(code), firstRow: first }));
      else firstCodeRow.set(code, row);
    }
    if (name === "") issues.push(issue(row, "ad", "NAME_MISSING"));
    else if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) issues.push(issue(row, "ad", "NAME_INVALID", { max: 200 }));

    // Temel birim: boşsa ADET (N-04 akıllı varsayılan); verilmişse sistemde ETKİN olmalı.
    const unitRaw = cell(r, cols, "temel birim");
    const unit = unitByKey.get(unitKey(unitRaw === "" ? DEFAULT_BASE_UNIT_CODE : unitRaw));
    if (unit === undefined || unit.status !== "ACTIVE") issues.push(issue(row, "temel birim", "UNIT_UNKNOWN", { unit: clip(unitRaw === "" ? DEFAULT_BASE_UNIT_CODE : unitRaw) }));

    const existing = code === "" ? undefined : ctx.items.get(code);
    if (existing !== undefined && unit !== undefined) {
      if (existing.status !== "ACTIVE") issues.push(issue(row, "kod", "ITEM_ARCHIVED", { code: clip(code) }));
      else if (existing.baseUnitId !== unit.id) issues.push(issue(row, "temel birim", "ITEM_UNIT_MISMATCH", { code: clip(code), unit: unitById.get(existing.baseUnitId)?.code ?? "?" }));
    }

    // Koli içi adet (K-3: kesirli koli yok; K-1: katsayı tek doğruluk kaynağı).
    let packQty: string | null = null;
    const packRaw = cell(r, cols, "koli içi adet");
    if (packRaw !== "") {
      const d = parseTrDecimal(packRaw);
      if (!d.ok) issues.push(issue(row, "koli içi adet", "PACK_QTY_INVALID", { value: clip(packRaw) }));
      else if (d.frac !== "") issues.push(issue(row, "koli içi adet", "PACK_QTY_FRACTIONAL", { value: clip(packRaw) }));
      else if (BigInt(d.int) < 2n) issues.push(issue(row, "koli içi adet", "PACK_QTY_TOO_SMALL", { value: clip(packRaw) }));
      else if (BigInt(d.int) > PACK_QTY_MAX) issues.push(issue(row, "koli içi adet", "PACK_QTY_TOO_LARGE", { max: Number(PACK_QTY_MAX) }));
      else packQty = d.int;
    }
    if (packQty !== null && unit !== undefined && unitKey(unit.code) === PACK_UNIT_CODE) issues.push(issue(row, "koli içi adet", "PACK_BASE_UNIT"));
    // Sistemde bu ürünün koli katsayısı varsa dosyadakiyle çelişmemeli (sessizce değiştirilmez).
    const sysFactor = existing !== undefined && packUnit !== undefined ? ctx.conversions.get(code)?.get(packUnit.id) : undefined;
    if (packQty !== null && sysFactor !== undefined && sysFactor !== packQty) issues.push(issue(row, "koli içi adet", "PACK_QTY_CONFLICT", { file: packQty, system: sysFactor }));

    const unitBarcode = cell(r, cols, "adet barkodu");
    const packBarcode = cell(r, cols, "koli barkodu");
    if (unitBarcode !== "" && barcodeProblem(unitBarcode)) issues.push(issue(row, "adet barkodu", "BARCODE_INVALID", { value: clip(unitBarcode) }));
    if (packBarcode !== "" && barcodeProblem(packBarcode)) issues.push(issue(row, "koli barkodu", "BARCODE_INVALID", { value: clip(packBarcode) }));
    if (unitBarcode !== "" && unitBarcode === packBarcode) issues.push(issue(row, "koli barkodu", "BARCODE_SAME_ROW", { value: clip(packBarcode) }));
    if (packBarcode !== "" && packQty === null && sysFactor === undefined) issues.push(issue(row, "koli içi adet", "PACK_BARCODE_NEEDS_QTY"));

    const claim = (value: string, column: ImportColumn, which: "B" | "P"): void => {
      if (value === "" || barcodeProblem(value) || (which === "P" && value === unitBarcode)) return;
      const prev = fileBarcodes.get(value);
      if (prev !== undefined) {
        if (!(prev.code === code && prev.unit === which)) issues.push(issue(row, column, "BARCODE_DUPLICATE_FILE", { value: clip(value), firstRow: prev.row }));
        return;
      }
      fileBarcodes.set(value, { row, column, code, unit: which });
      // Sistemde başka ürün/birimde kayıtlıysa (A-69: sessiz eşleştirme yok) önceden reddet.
      const others = (ctx.barcodes.get(value) ?? []).filter((b) => {
        if (b.itemCode !== code || existing === undefined) return true;
        const sysUnit = b.unitId === null || b.unitId === existing.baseUnitId ? "B" : b.unitId === packUnit?.id ? "P" : "?";
        return sysUnit !== which;
      });
      const other = others[0];
      if (other !== undefined) issues.push(issue(row, column, "BARCODE_TAKEN", { value: clip(value), item: clip(other.itemCode) }));
    };
    claim(unitBarcode, "adet barkodu", "B");
    claim(packBarcode, "koli barkodu", "P");

    if (issues.length === before && unit !== undefined) {
      plans.push({
        row,
        code,
        name,
        baseUnitCode: unit.code,
        packQty,
        unitBarcode: unitBarcode === "" ? null : unitBarcode,
        packBarcode: packBarcode === "" ? null : packBarcode,
        exists: existing !== undefined,
      });
    }
  });
  return { kind: "PRODUCTS", plans: issues.length === 0 ? plans : [], issues, rowCount, distinctItems: firstCodeRow.size };
}

// --- açılış stoku ---------------------------------------------------------------------------------------------------

export interface StockPlan {
  readonly row: number;
  readonly itemCode: string;
  readonly itemId: string;
  readonly shelfCode: string;
  readonly locationId: string;
  readonly warehouseId: string;
  /** Kanonik pozitif ondalık dizgi (temel birim). */
  readonly quantity: string;
  /** Bu (ürün, raf, miktar) önceki bir içe aktarmayla zaten yazılmış: atlanır, raporda "daha önce işlenmiş" görünür. */
  readonly alreadyApplied: boolean;
}

export function validateStock(records: Records, ctx: StockContext): PreviewResult<StockPlan> {
  const issues: ImportIssue[] = [];
  const header = records[0] ?? [];
  const cols = mapColumns(header, STOCK_ALIASES, STOCK_HEADERS, issues);
  const body = records.slice(1);
  const rowCount = body.filter((r) => !isBlankRecord(r)).length;
  if (issues.length > 0) return { kind: "STOCK", plans: [], issues, rowCount, distinctItems: 0 };
  if (rowCount === 0) return { kind: "STOCK", plans: [], issues: [issue(0, "dosya", "NO_ROWS")], rowCount, distinctItems: 0 };
  if (rowCount > IMPORT_MAX_ROWS) return { kind: "STOCK", plans: [], issues: [issue(0, "dosya", "TOO_MANY_ROWS", { max: IMPORT_MAX_ROWS, count: rowCount })], rowCount, distinctItems: 0 };

  const pairs = new Map<string, number>();
  const distinctCodes = new Set<string>();
  const plans: StockPlan[] = [];
  body.forEach((r, idx) => {
    if (isBlankRecord(r)) return;
    const row = idx + 2;
    const before = issues.length;
    if (r.length > header.length && r.slice(header.length).some((v) => v !== "")) issues.push(issue(row, "dosya", "ROW_TOO_MANY_CELLS", { cells: r.length, columns: header.length }));
    const itemCode = cell(r, cols, "ürün kodu");
    if (itemCode !== "") distinctCodes.add(itemCode);
    const shelfCode = cell(r, cols, "raf kodu");
    const qtyRaw = cell(r, cols, "miktar");

    let item: ItemInfoCtx | undefined;
    if (itemCode === "") issues.push(issue(row, "ürün kodu", "CODE_MISSING"));
    else {
      item = ctx.items.get(itemCode);
      if (item === undefined) issues.push(issue(row, "ürün kodu", "ITEM_UNKNOWN", { code: clip(itemCode) }));
      else if (item.status !== "ACTIVE") issues.push(issue(row, "ürün kodu", "ITEM_ARCHIVED", { code: clip(itemCode) }));
      else if (item.trackingMode !== "NONE") issues.push(issue(row, "ürün kodu", "ITEM_TRACKED", { code: clip(itemCode) }));
    }

    let shelf: ShelfInfo | undefined;
    if (shelfCode === "") issues.push(issue(row, "raf kodu", "SHELF_MISSING"));
    else {
      const hits = ctx.shelves.get(shelfKey(shelfCode)) ?? [];
      const active = hits.filter((s) => s.status === "ACTIVE");
      if (hits.length === 0) issues.push(issue(row, "raf kodu", "SHELF_UNKNOWN", { code: clip(shelfCode) }));
      else if (active.length === 0) issues.push(issue(row, "raf kodu", "SHELF_ARCHIVED", { code: clip(shelfCode) }));
      else if (active.length > 1) issues.push(issue(row, "raf kodu", "SHELF_AMBIGUOUS", { code: clip(shelfCode), warehouses: active.map((s) => s.warehouseCode).join(", ") }));
      else if ((active[0] as ShelfInfo).kind === "TRANSIT") issues.push(issue(row, "raf kodu", "SHELF_KIND", { code: clip(shelfCode) }));
      else shelf = active[0];
    }

    let quantity: string | null = null;
    if (qtyRaw === "") issues.push(issue(row, "miktar", "QTY_MISSING"));
    else {
      const d = parseTrDecimal(qtyRaw);
      if (!d.ok) {
        const code: IssueCode = d.reason === "NEGATIVE" ? "QTY_NEGATIVE" : d.reason === "AMBIGUOUS" ? "QTY_AMBIGUOUS" : d.reason === "TOO_LARGE" ? "QTY_TOO_LARGE" : "QTY_INVALID";
        issues.push(issue(row, "miktar", code, { value: clip(qtyRaw) }));
      } else if (!/[1-9]/.test(d.text)) issues.push(issue(row, "miktar", "QTY_ZERO"));
      else if (item !== undefined && d.frac.length > item.quantityScale) {
        issues.push(issue(row, "miktar", "QTY_FRACTIONAL", { value: clip(qtyRaw), decimals: item.quantityScale }));
      } else quantity = d.text;
    }

    if (issues.length === before && item !== undefined && shelf !== undefined) {
      const pk = `${item.id}|${shelf.id}`;
      const first = pairs.get(pk);
      if (first !== undefined) issues.push(issue(row, "raf kodu", "PAIR_DUPLICATE_FILE", { firstRow: first }));
      else pairs.set(pk, row);
    }
    // Açılış stoku yalnız stoğu OLMAYAN (ürün, raf) çifti için yazılır (A-289-3). Çiftte stok varsa: aynı miktar önceki içe aktarmadan geliyorsa
    // satır "zaten uygulanmış" (atlanır, hata değil); aksi halde hata (düzeltme için stok belgesi).
    let alreadyApplied = false;
    if (issues.length === before && item !== undefined && shelf !== undefined && quantity !== null) {
      const st = ctx.pairs?.get(`${item.id}|${shelf.id}`);
      if (st !== undefined && st.hasStock) {
        if (st.applied.has(quantity)) alreadyApplied = true;
        else issues.push(issue(row, "raf kodu", "PAIR_HAS_STOCK", { code: clip(itemCode), shelf: clip(shelfCode) }));
      }
    }
    if (issues.length === before && item !== undefined && shelf !== undefined && quantity !== null) {
      plans.push({ row, itemCode, itemId: item.id, shelfCode, locationId: shelf.id, warehouseId: shelf.warehouseId, quantity, alreadyApplied });
    }
  });
  return { kind: "STOCK", plans: issues.length === 0 ? plans : [], candidates: plans, issues, rowCount, distinctItems: distinctCodes.size };
}

/** Başlık satırından dosya türü; ayrıştırma hatası ya da bilinmeyen biçim `issue` ile döner. */
export function classify(text: string): { readonly ok: true; readonly kind: ImportKind; readonly records: Records } | { readonly ok: false; readonly issues: readonly ImportIssue[] } {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) return { ok: false, issues: [issue(0, "dosya", "FILE_TOO_LARGE", { maxKb: IMPORT_MAX_BYTES / 1024 })] };
  // U+FFFD: dosya UTF-8 değil (ör. Excel'in eski "CSV (noktalı virgül)" kaydı Windows-1254); Türkçe harfler bozulmuş olurdu.
  if (text.includes("\uFFFD")) return { ok: false, issues: [issue(0, "dosya", "FILE_ENCODING")] };
  const csv = parseCsv(text);
  if (!csv.ok) return { ok: false, issues: [issue(0, "dosya", csv.code)] };
  if (csv.limitIssues.length > 0) {
    return { ok: false, issues: csv.limitIssues.map((l) => issue(l.row, "dosya", l.code, l.code === "CELL_TOO_LONG" ? { max: l.row === 1 ? HEADER_CELL_MAX : DATA_CELL_MAX } : { max: MAX_COLUMNS })) };
  }
  const kind = detectKind(csv.records[0] ?? []);
  if (kind === null) return { ok: false, issues: [issue(1, "dosya", "FORMAT_UNKNOWN")] };
  return { ok: true, kind, records: csv.records };
}
