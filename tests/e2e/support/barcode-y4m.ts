// T-286: sahte kamera için barkod görüntülü video üretici. Chromium `--use-file-for-fake-video-capture=<y4m>` bu dosyayı kamera akışı olarak döngüde oynatır.
// EAN-13 çizimi GS1 kuralıyla yapılır (L/G/R kodları, ilk hane eşlik deseni); çıktı gri tonlu YUV 4:2:0 (C420jpeg). Bağımlılık yok; ikili dosya repoya girmez
// (test sırasında `.artifacts/` altına yazılır).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
// İlk hanenin sol grup (2.–7. haneler) L/G eşlik deseni.
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** GS1 mod-10 kontrol hanesini hesaplar (12 haneden 13. hane). */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** 95 modüllük EAN-13 deseni ("1" = çubuk). Kod 13 hane ve kontrol hanesi doğru olmalıdır. */
export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code)) throw new Error("ean13: 13 hane gerekli");
  if (ean13CheckDigit(code.slice(0, 12)) !== Number(code[12])) throw new Error("ean13: kontrol hanesi hatalı");
  const parity = PARITY[Number(code[0])] as string;
  let out = "101";
  for (let i = 0; i < 6; i++) out += (parity[i] === "L" ? L : G)[Number(code[i + 1])];
  out += "01010";
  for (let i = 0; i < 6; i++) out += R[Number(code[i + 7])];
  return out + "101";
}

export interface Y4mOptions {
  readonly width?: number;
  readonly height?: number;
  readonly frames?: number;
  readonly modulepx?: number;
}

/** Barkodu beyaz zeminde ortalayıp y4m dosyası yazar; yolu döndürür. */
export function writeBarcodeY4m(file: string, code: string, opts: Y4mOptions = {}): string {
  const w = opts.width ?? 640;
  const h = opts.height ?? 480;
  const frames = opts.frames ?? 3;
  const px = opts.modulepx ?? 4;
  const modules = ean13Modules(code);
  const barsW = modules.length * px;
  const barsH = Math.round(h * 0.45);
  const x0 = Math.floor((w - barsW) / 2);
  const y0 = Math.floor((h - barsH) / 2);
  const luma = Buffer.alloc(w * h, 235); // beyaz
  for (let m = 0; m < modules.length; m++) {
    if (modules[m] !== "1") continue;
    for (let y = y0; y < y0 + barsH; y++) luma.fill(16, y * w + x0 + m * px, y * w + x0 + (m + 1) * px);
  }
  const chroma = Buffer.alloc((w / 2) * (h / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma, chroma]);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, ...Array.from({ length: frames }, () => frame)]));
  return file;
}
