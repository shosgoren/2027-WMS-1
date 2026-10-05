#!/usr/bin/env node
// `node scripts/check-docs.mjs`: docs/STACK.md ve docs/MAP.md'nin repo gerçekliğiyle uyumunu doğrular (T-004).
// (a) STACK "Kilitli sürümler" tablosunda sürümü yazılı her satır, kaynak dosyadaki değerle birebir eşleşir;
//     `^`/`~` aralığı (STACK'te veya kaynakta) hatadır. Sürüm hücresi `—` ile başlayan satır kilitsizdir, atlanır.
// (b) MAP tablosunda `var` işaretli her yol mevcuttur, `planlı: …` işaretliler mevcut değildir.
// Konsola yalnızca uyuşmazlıklar + tek özet satırı basılır; FAIL → çıkış kodu 1. Yeni npm bağımlılığı yoktur.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ ok: boolean, count: number, failures: string[] }} CheckResult
 * @typedef {(relPath: string) => string | null} ReadFile  Dosya yoksa `null`.
 * @typedef {(relPath: string) => boolean} Exists
 */

/** Kilitsiz satır işareti: sürüm hücresi bununla başlar. */
export const UNLOCKED_MARK = "—";

/**
 * Markdown tablo satırını hücrelere böler (baştaki/sondaki `|` atılır, hücreler kırpılır).
 * @param {string} line
 * @returns {string[]}
 */
export function splitRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/**
 * `startIndex`ten sonraki ilk Markdown tablosunu döndürür (başlık + veri satırları; ayraç satırı atılır).
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {{ header: string[], rows: string[][] } | null}
 */
function tableAfter(lines, startIndex) {
  let i = startIndex;
  while (i < lines.length && !(lines[i] ?? "").trim().startsWith("|")) i++;
  if (i >= lines.length) return null;
  const header = splitRow(lines[i] ?? "");
  i++;
  if (!/^\|?\s*:?-{3,}/.test((lines[i] ?? "").trim())) return null;
  i++;
  /** @type {string[][]} */
  const rows = [];
  while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
    rows.push(splitRow(lines[i] ?? ""));
    i++;
  }
  return { header, rows };
}

/**
 * STACK.md'deki "## Kilitli sürümler" bölümünün tablosu.
 * @param {string} md
 * @returns {{ header: string[], rows: string[][] } | null}
 */
export function parseStackTable(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Kilitli sürümler\s*$/.test(l.trim()));
  return at === -1 ? null : tableAfter(lines, at + 1);
}

/**
 * MAP.md'deki ilk tablo (başlığı `yol` ile başlayan).
 * @param {string} md
 * @returns {{ header: string[], rows: string[][] } | null}
 */
export function parseMapTable(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().startsWith("|") && splitRow(l)[0] === "yol");
  return at === -1 ? null : tableAfter(lines, at);
}

/**
 * Sürüm dizgisi aralık mı (`^`, `~` önekli veya joker)?
 * @param {string} v
 * @returns {boolean}
 */
export function isRange(v) {
  return /^[\^~]/.test(v.trim()) || v.includes("*");
}

/**
 * docker-compose.yml metninde `services.<servis>.image` değerini bulur (YAML kütüphanesi olmadan,
 * servis bloğunun girintisine göre). Bulunamazsa `null`.
 * @param {string} text
 * @param {string} service
 * @returns {string | null}
 */
export function composeImage(text, service) {
  const lines = text.split(/\r?\n/);
  const svcIdx = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (svcIdx === -1) return null;
  /** @type {number | null} */
  let svcIndent = null;
  let inService = false;
  for (let i = svcIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // `services:` bloğu bitti
    svcIndent ??= indent;
    if (indent === svcIndent) {
      inService = line.trim() === `${service}:`;
      continue;
    }
    if (inService) {
      const m = /^image:\s*["']?([^"'\s#]+)["']?/.exec(line.trim());
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

/**
 * `<dosya>#<alan>` kaynağının değerini okur. package.json için alan `üst.anahtar` (iki düzey; anahtar
 * `@kapsam/ad` olabilir), compose için servis adıdır.
 * @param {string} source
 * @param {ReadFile} readFile
 * @returns {{ value: string } | { error: string }}
 */
export function readSource(source, readFile) {
  const hash = source.indexOf("#");
  if (hash <= 0 || hash === source.length - 1) return { error: `kaynak biçimi geçersiz: "${source}"` };
  const file = source.slice(0, hash);
  const field = source.slice(hash + 1);
  const text = readFile(file);
  if (text === null) return { error: `kaynak dosya yok: ${file}` };
  if (/(^|\/)docker-compose\.ya?ml$/.test(file) || /(^|\/)compose\.ya?ml$/.test(file)) {
    const image = composeImage(text, field);
    return image === null ? { error: `${file}: "${field}" servisinin imajı bulunamadı` } : { value: image };
  }
  if (!file.endsWith(".json")) return { error: `desteklenmeyen kaynak dosya türü: ${file}` };
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: `${file}: JSON çözümlenemedi` };
  }
  const dot = field.indexOf(".");
  const keys = dot === -1 ? [field] : [field.slice(0, dot), field.slice(dot + 1)];
  /** @type {unknown} */
  let cur = data;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, k)) {
      return { error: `${file}: "${field}" alanı yok` };
    }
    cur = /** @type {Record<string, unknown>} */ (cur)[k];
  }
  if (typeof cur !== "string") return { error: `${file}: "${field}" dizgi değil` };
  return { value: cur };
}

/**
 * STACK "Kilitli sürümler" tablosunu kaynaklara karşı doğrular.
 * @param {string} md
 * @param {ReadFile} readFile
 * @returns {CheckResult}
 */
export function checkStack(md, readFile) {
  const table = parseStackTable(md);
  if (!table) return { ok: false, count: 0, failures: ['stack: "## Kilitli sürümler" tablosu bulunamadı'] };
  const col = (/** @type {string} */ name) => table.header.indexOf(name);
  const [iName, iPkg, iVer, iSrc] = [col("bileşen"), col("paket/imaj"), col("sürüm"), col("kaynak")];
  if ([iName, iPkg, iVer, iSrc].some((i) => i === -1)) {
    return { ok: false, count: 0, failures: ["stack: tablo başlığı `bileşen | paket/imaj | sürüm | kaynak | ADR` değil"] };
  }
  /** @type {string[]} */
  const failures = [];
  let count = 0;
  for (const row of table.rows) {
    const name = row[iName] ?? "";
    const pkg = row[iPkg] ?? "";
    const ver = row[iVer] ?? "";
    const src = row[iSrc] ?? "";
    if (ver === "" || ver.startsWith(UNLOCKED_MARK)) continue;
    count++;
    const label = `stack: ${name} (${src || "kaynak yok"})`;
    if (isRange(ver)) {
      failures.push(`${label}: STACK sürümü aralık "${ver}" (tam sürüm olmalı)`);
      continue;
    }
    const r = readSource(src, readFile);
    if ("error" in r) {
      failures.push(`${label}: ${r.error}`);
      continue;
    }
    let actual = r.value;
    if (/compose\.ya?ml#/.test(src)) {
      if (!actual.startsWith(`${pkg}:`)) {
        failures.push(`${label}: imaj adı uyuşmuyor STACK=${pkg}:${ver} kaynak=${actual}`);
        continue;
      }
      actual = actual.slice(pkg.length + 1);
    } else if (actual.startsWith(`${pkg}@`)) {
      actual = actual.slice(pkg.length + 1); // packageManager: "pnpm@x.y.z"
    }
    if (isRange(actual)) {
      failures.push(`${label}: kaynak sürümü aralık "${actual}" (tam sürüm olmalı)`);
    } else if (actual !== ver) {
      failures.push(`${label}: STACK=${ver} kaynak=${actual}`);
    }
  }
  return { ok: failures.length === 0, count, failures };
}

/**
 * MAP tablosundaki yolların durumunu doğrular.
 * @param {string} md
 * @param {Exists} exists
 * @returns {CheckResult}
 */
export function checkMap(md, exists) {
  const table = parseMapTable(md);
  if (!table) return { ok: false, count: 0, failures: ["map: `yol | durum | açıklama` tablosu bulunamadı"] };
  const iStatus = table.header.indexOf("durum");
  if (iStatus === -1) return { ok: false, count: 0, failures: ["map: `durum` sütunu yok"] };
  /** @type {string[]} */
  const failures = [];
  let count = 0;
  for (const row of table.rows) {
    const p = (row[0] ?? "").replace(/`/g, "").trim();
    const status = (row[iStatus] ?? "").trim();
    count++;
    if (p === "" || path.isAbsolute(p) || p.split("/").includes("..")) {
      failures.push(`map: geçersiz yol "${p}"`);
      continue;
    }
    const present = exists(p.replace(/\/+$/, ""));
    if (status === "var") {
      if (!present) failures.push(`map: ${p} "var" işaretli ama mevcut değil`);
    } else if (/^planlı:\s*\S/.test(status)) {
      if (present) failures.push(`map: ${p} "${status}" işaretli ama mevcut`);
    } else {
      failures.push(`map: ${p} durumu tanınmıyor "${status}" (var | planlı: <kart>)`);
    }
  }
  return { ok: failures.length === 0, count, failures };
}

/**
 * @param {CheckResult} stack
 * @param {CheckResult} map
 * @returns {string}
 */
export function summaryLine(stack, map) {
  const s = (/** @type {CheckResult} */ r) => (r.ok ? "OK" : "FAIL");
  return `check-docs: stack ${s(stack)} (${stack.count} satır) · map ${s(map)} (${map.count} yol)`;
}

/** @returns {number} çıkış kodu */
export function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  /** @type {ReadFile} */
  const readFile = (rel) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const stackMd = readFile("docs/STACK.md");
  const mapMd = readFile("docs/MAP.md");
  const stack = stackMd === null ? { ok: false, count: 0, failures: ["stack: docs/STACK.md okunamadı"] } : checkStack(stackMd, readFile);
  const map = mapMd === null
    ? { ok: false, count: 0, failures: ["map: docs/MAP.md okunamadı"] }
    : checkMap(mapMd, (rel) => existsSync(path.join(root, rel)));
  for (const f of [...stack.failures, ...map.failures]) console.log(f);
  console.log(summaryLine(stack, map));
  return stack.ok && map.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
