// Etiket şablonları (T-312, ADR-022): tek şablon tanımından iki çıktı — ZPL II (203 dpi, nokta koordinatı) ve SVG (mm).
// Saf işlevler; veri tabanına dokunmaz. Etiket 100x50 mm (A-137); boyut/alanlar iş kuralıdır, doğrulanana kadar varsayımdır (Q-77).
// Varsayımlar: A-137 (alanlar), A-T312-1 (barkod kümesi ZPL'de açık çağrı kodlarıyla, SVG ile aynı sembol dizisi; yazıcıda
// doğrulanmadı), A-T312-2 (ASCII dışı herhangi bir karakter varsa `^CI28`; dosya UTF-8), A-T312-3 (ad en çok 2 satır x 32 karakter,
// fazlası "…" ile kesilir; en çok 1000 etiket/belge), A-T312-4 (modül genişliği: sığan en büyük 1..3 nokta).
import { AppError } from "@wms/shared/errors";
import { encodeCode128, CODE_B, CODE_C, START_B, START_C, type Code128Result } from "./code128.ts";

export const LABEL_TEMPLATE_VERSION = { product: "product@1", location: "location@1" } as const;
export type LabelTemplate = keyof typeof LABEL_TEMPLATE_VERSION;

export const DPI = 203;
/** Bir yazıcı noktasının mm karşılığı. */
export const DOT_MM = 25.4 / DPI;
/** 100x50 mm etiket, nokta cinsinden. */
export const LABEL_W_DOTS = Math.round(100 / DOT_MM);
export const LABEL_H_DOTS = Math.round(50 / DOT_MM);
export const MAX_LABELS_PER_DOCUMENT = 1000;

const MARGIN = 24;
const QUIET_MODULES = 10;
const NAME_LINE_CHARS = 32;
const NAME_LINES = 2;
const BAR_HEIGHT = 100;

export interface ProductLabelData {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Birincil barkod; yoksa ürün kodu basılır (A-137). */
  readonly barcode?: string | null;
}
export interface LocationLabelData {
  readonly code: string;
  readonly name?: string | null;
}
export type LabelData = ProductLabelData | LocationLabelData;

/** Etiket üretilemiyor: barkod seçilen etiket genişliğine sığmıyor. `VALIDATION_FAILED` + neden `LABEL_TOO_LONG`. */
export class LabelTooLongError extends AppError {
  readonly reason = "LABEL_TOO_LONG" as const;
  constructor() {
    super("VALIDATION_FAILED");
  }
}

// ---- Ortak yerleşim ----
interface Line {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly text: string;
  /** Verilirse bu genişlikte ortalanır. */
  readonly centerWidth?: number;
}
interface Layout {
  readonly lines: readonly Line[];
  readonly barcode: { readonly x: number; readonly y: number; readonly module: number; readonly height: number; readonly result: Code128Result; readonly text: string };
}

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

function clean(s: string): string {
  return s.replace(CONTROL_RE, " ").replace(/ {2,}/g, " ").trim();
}

function moduleFor(modules: number): number {
  for (const m of [3, 2, 1]) {
    if ((modules + 2 * QUIET_MODULES) * m <= LABEL_W_DOTS) return m;
  }
  throw new LabelTooLongError();
}

/** Adı en çok `NAME_LINES` satıra böler (kelime sınırı; uzun kelime sert bölünür); sığmayan kısım "…" ile kesilir. */
export function wrapName(name: string): readonly string[] {
  const chunks: string[] = [];
  for (const word of clean(name).split(" ")) {
    const cp = Array.from(word);
    for (let k = 0; k < cp.length; k += NAME_LINE_CHARS) chunks.push(cp.slice(k, k + NAME_LINE_CHARS).join(""));
  }
  const lines: string[] = [];
  for (const c of chunks) {
    const last = lines[lines.length - 1];
    if (last !== undefined && Array.from(last).length + 1 + Array.from(c).length <= NAME_LINE_CHARS) lines[lines.length - 1] = `${last} ${c}`;
    else lines.push(c);
  }
  if (lines.length <= NAME_LINES) return lines;
  const kept = lines.slice(0, NAME_LINES);
  kept[NAME_LINES - 1] = `${Array.from(kept[NAME_LINES - 1] ?? "").slice(0, NAME_LINE_CHARS - 1).join("")}…`;
  return kept;
}

function layoutOf(template: LabelTemplate, data: LabelData): Layout {
  if (template === "product") {
    const d = data as ProductLabelData;
    const value = d.barcode !== undefined && d.barcode !== null && d.barcode !== "" ? d.barcode : d.code;
    const result = encodeCode128(value);
    const module = moduleFor(result.modules);
    const bw = result.modules * module;
    const x = Math.floor((LABEL_W_DOTS - bw) / 2);
    const lines: Line[] = [{ x: MARGIN, y: 20, size: 44, text: clean(d.code) }];
    wrapName(d.name).forEach((text, k) => lines.push({ x: MARGIN, y: 76 + k * 38, size: 32, text }));
    lines.push({ x: MARGIN, y: 158, size: 28, text: clean(d.unit) });
    lines.push({ x, y: 318, size: 30, text: value, centerWidth: bw });
    return { lines, barcode: { x, y: 200, module, height: BAR_HEIGHT, result, text: value } };
  }
  const d = data as LocationLabelData;
  const result = encodeCode128(d.code);
  const module = moduleFor(result.modules);
  const bw = result.modules * module;
  const x = Math.floor((LABEL_W_DOTS - bw) / 2);
  const len = Math.max(1, Array.from(d.code).length);
  const size = Math.max(40, Math.min(110, Math.floor((LABEL_W_DOTS - 2 * MARGIN) / (len * 0.6))));
  const lines: Line[] = [{ x: MARGIN, y: 30, size, text: clean(d.code) }];
  const name = d.name === undefined || d.name === null ? "" : clean(d.name);
  if (name !== "") lines.push({ x: MARGIN, y: 160, size: 32, text: wrapName(name)[0] ?? "" });
  lines.push({ x, y: 340, size: 30, text: d.code, centerWidth: bw });
  return { lines, barcode: { x, y: 220, module, height: 110, result, text: d.code } };
}

// ---- ZPL ----
/** ZPL alan verisi: denetim karakterleri boşluk olur; `^`, `~` ve `_` (^FH kaçış karakteri) onaltılık kaçışla yazılır. */
export function zplText(s: string): string {
  return clean(s).replace(/[\^~_]/g, (c) => `_${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Barkod verisi: SVG ile aynı sembol dizisi, açık kod seti çağrılarıyla (`>:` B başlangıç, `>;` C başlangıç, `>5` C'ye, `>6` B'ye). */
export function zplBarcodeData(result: Code128Result): string {
  let out = "";
  let set: "B" | "C" = "B";
  const v = result.values;
  for (let k = 0; k < v.length - 2; k++) {
    const x = v[k] as number;
    if (x === START_B) out += ">:";
    else if (x === START_C) {
      out += ">;";
      set = "C";
    } else if (x === CODE_C) {
      out += ">5";
      set = "C";
    } else if (x === CODE_B) {
      out += ">6";
      set = "B";
    } else if (set === "C") out += String(x).padStart(2, "0");
    else {
      const ch = String.fromCharCode(x + 32);
      out += ch === ">" ? ">0" : zplText(ch);
    }
  }
  return out; // kontrol karakteri ve bitişi yazıcı ekler
}

function needsUtf8(s: string): boolean {
  return /[^\u0000-\u007F]/.test(s);
}

export function toZpl(template: LabelTemplate, data: LabelData): string {
  const l = layoutOf(template, data);
  const texts = l.lines.map((x) => x.text).join("");
  const out: string[] = ["^XA", `^FX ${LABEL_TEMPLATE_VERSION[template]}`];
  if (needsUtf8(texts)) out.push("^CI28");
  out.push(`^PW${LABEL_W_DOTS}`, `^LL${LABEL_H_DOTS}`, "^LH0,0");
  for (const x of l.lines) {
    const fb = x.centerWidth === undefined ? "" : `^FB${x.centerWidth},1,0,C`;
    out.push(`^FO${x.x},${x.y}${fb}^A0N,${x.size},${x.size}^FH_^FD${zplText(x.text)}^FS`);
  }
  const b = l.barcode;
  out.push(`^FO${b.x},${b.y}^BY${b.module},3,${b.height}^BCN,${b.height},N,N,N^FH_^FD${zplBarcodeData(b.result)}^FS`, "^XZ");
  return `${out.join("\n")}\n`;
}

// ---- SVG ----
/** XML/HTML kaçışı: `& < > " '`; XML'de geçersiz denetim karakterleri boşluk olur. */
export function escapeXml(s: string): string {
  return s
    .replace(CONTROL_RE, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mm(dots: number): string {
  return (dots * DOT_MM).toFixed(5);
}

export function toSvg(template: LabelTemplate, data: LabelData): string {
  const l = layoutOf(template, data);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50" data-label-template="${LABEL_TEMPLATE_VERSION[template]}">`,
    `<rect x="0" y="0" width="100" height="50" fill="#fff"/>`,
  ];
  for (const x of l.lines) {
    const size = x.size;
    const anchor = x.centerWidth === undefined ? "" : ` text-anchor="middle"`;
    const tx = x.centerWidth === undefined ? x.x : x.x + x.centerWidth / 2;
    // Taban çizgisi: yazıcı alanı üstten konumlanır; yaklaşık 0.8 x yazı boyu.
    parts.push(
      `<text x="${mm(tx)}" y="${mm(x.y + size * 0.8)}" font-size="${mm(size)}" font-family="Arial, Helvetica, sans-serif"${anchor} fill="#000">${escapeXml(x.text)}</text>`,
    );
  }
  const b = l.barcode;
  parts.push(`<g class="bars" fill="#000">`);
  let cursor = b.x;
  b.result.widths.forEach((w, idx) => {
    const wd = w * b.module;
    if (idx % 2 === 0) parts.push(`<rect x="${mm(cursor)}" y="${mm(b.y)}" width="${mm(wd)}" height="${mm(b.height)}"/>`);
    cursor += wd;
  });
  parts.push(`</g>`, `</svg>`);
  return parts.join("");
}

// ---- Toplu belge ----
function expand(datas: readonly LabelData[], copies: number): LabelData[] {
  if (!Number.isInteger(copies) || copies < 1) throw new AppError("VALIDATION_FAILED");
  if (datas.length === 0 || datas.length * copies > MAX_LABELS_PER_DOCUMENT) throw new AppError("VALIDATION_FAILED");
  const out: LabelData[] = [];
  for (const d of datas) for (let k = 0; k < copies; k++) out.push(d);
  return out;
}

/** Tek belge: her etiket bir sayfa (SVG). Sayfa sayısı = etiket sayısı x adet. */
export function toSvgPages(template: LabelTemplate, datas: readonly LabelData[], copies = 1): readonly string[] {
  return expand(datas, copies).map((d) => toSvg(template, d));
}

/** Tek `.zpl` belgesi: etiket başına bir `^XA…^XZ` bloğu. */
export function toZplDocument(template: LabelTemplate, datas: readonly LabelData[], copies = 1): string {
  return expand(datas, copies).map((d) => toZpl(template, d)).join("");
}
