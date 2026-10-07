// T-289 e2e ortak yardımcıları (import.spec.ts ve zzz-import-partial.spec.ts): ölçüm, ekran görüntüsü, CSV üretimi, demo yönetici girişi.
import path from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const OUT = path.resolve(import.meta.dirname, "../../.artifacts/t-289");
export const PHONE_SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;
export const DESKTOP_SIZES = [{ width: 1280, height: 800 }] as const;

export interface Metrics {
  readonly overflowX: boolean;
  readonly smallTargets: readonly { n: string; w: number; h: number }[];
  readonly tightPairs: readonly string[];
  readonly filledButtons: number;
  readonly largestGapPx: number;
  readonly rawCodeText: readonly string[];
  readonly mainWidth: number;
  readonly clippedText: readonly string[];
}

/** Sayfa ölçümleri (rubrik İ-01, İ-03, İ-04, İ-09, İ-11, İ-12): dize ifadesi, tarayıcıda çalışır. */
const MEASURE = `(() => {
  const main = document.querySelector('main');
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const interactive = [...main.querySelectorAll('a[href],button,input:not([type=file]),select,textarea,summary')].filter(vis);
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 30);
  const rect = (el) => el.getBoundingClientRect();
  const smallTargets = interactive.map((el) => ({ n: name(el), w: Math.round(rect(el).width), h: Math.round(rect(el).height) })).filter((x) => x.w < 47.5 || x.h < 47.5);
  const tightPairs = [];
  for (let i = 0; i < interactive.length; i++) for (let j = i + 1; j < interactive.length; j++) {
    const a = rect(interactive[i]); const b = rect(interactive[j]);
    const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right)); const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    if (Math.hypot(dx, dy) < 8 && !interactive[i].contains(interactive[j]) && !interactive[j].contains(interactive[i])) tightPairs.push(name(interactive[i]) + ' | ' + name(interactive[j]));
  }
  const filled = [...main.querySelectorAll('[data-variant="primary"]')].filter(vis).length;
  // En büyük içeriksiz dikey bant: metin düğümü, etkileşimli öğe ya da svg taşıyan öğelerin birleşik aralıkları arasındaki en geniş boşluk.
  const boxes = [];
  for (const el of main.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    const kind = el.matches('svg,img,progress,input,button,a[href],select,textarea');
    if (!own && !kind) continue;
    const r = rect(el); boxes.push([r.top + scrollY, r.bottom + scrollY]);
  }
  boxes.sort((x, y) => x[0] - y[0]);
  let gap = 0; let end = boxes.length ? boxes[0][1] : 0;
  for (const [s, e] of boxes) { if (s - end > gap) gap = s - end; if (e > end) end = e; }
  const text = main.innerText;
  const rawCodeText = (text.match(/[A-Z_]{6,}|Error:|SQLSTATE|undefined|null/g) || []);
  const clippedText = [...main.querySelectorAll('h1,h2,p,span,li,label')].filter(vis).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').map(name);
  return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, smallTargets, tightPairs, filledButtons: filled, largestGapPx: Math.round(gap), rawCodeText, mainWidth: Math.round(rect(main).width), clippedText };
})()`;

export async function measure(page: Page): Promise<Metrics> {
  return page.evaluate<Metrics>(MEASURE);
}

export async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Yönetici olarak gir" }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
}

export const csv = (rows: string[]): { name: string; mimeType: string; buffer: Buffer } => ({ name: "dosya.csv", mimeType: "text/csv", buffer: Buffer.from(`﻿${rows.join("\r\n")}\r\n`, "utf8") });
export const PRODUCT_HEADER = "kod;ad;temel birim;koli içi adet;adet barkodu;koli barkodu";
export const STOCK_HEADER = "ürün kodu;raf kodu;miktar";

/** Mobilde uygulama kabuğunun içerik alanı (`.tenant-body`) kendi içinde kayar: tam sayfa kanıt için pencere kaydırıcı taşmasının boyu kadar uzatılır (kabuk içeriği tümüyle görünür); masaüstünde sayfa gövdesi kayar (fullPage). */
export async function shootFull(page: Page, size: { width: number; height: number }, file: string): Promise<void> {
  await page.setViewportSize(size);
  const extra = await page.evaluate<number>(`(() => { const b = document.querySelector('.tenant-body'); return b && getComputedStyle(b).overflowY === 'auto' ? b.scrollHeight - b.clientHeight : 0; })()`);
  if (extra > 0) {
    await page.setViewportSize({ width: size.width, height: size.height + extra + 4 });
    const left = await page.evaluate<number>(`(() => { const b = document.querySelector('.tenant-body'); return b.scrollHeight - b.clientHeight; })()`);
    expect(left, `${file}: kabuk içeriği tümüyle görünür`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }
  await page.setViewportSize(size);
}


/** Her boyutta ölçüm + iki görüntü: kullanıcının gördüğü görünüm ve tam sayfa (kabuk içeriği tümüyle). */
export async function captureState(page: Page, project: string, sizes: readonly { width: number; height: number }[], metrics: Record<string, Metrics>, state: string, scrollTo?: string): Promise<void> {
  for (const size of sizes) {
    await page.setViewportSize(size);
    if (scrollTo !== undefined) await page.getByTestId(scrollTo).scrollIntoViewIfNeeded();
    const key = `${state}-${size.width}`;
    const m = await measure(page);
    metrics[key] = m;
    expect(m.overflowX, `${key}: yatay taşma`).toBe(false);
    expect(m.smallTargets, `${key}: küçük dokunma hedefi`).toEqual([]);
    expect(m.tightPairs, `${key}: sıkışık komşu hedefler`).toEqual([]);
    expect(m.filledButtons, `${key}: dolu birincil düğme`).toBeLessThanOrEqual(1);
    expect(m.rawCodeText, `${key}: ham teknik metin`).toEqual([]);
    expect(m.clippedText, `${key}: kesilen metin`).toEqual([]);
    await page.screenshot({ path: path.join(OUT, `${project}-${state}-${size.width}-view.png`) });
    await shootFull(page, size, path.join(OUT, `${project}-${state}-${size.width}-full.png`));
  }
  await page.setViewportSize(sizes[0] as { width: number; height: number });
}
