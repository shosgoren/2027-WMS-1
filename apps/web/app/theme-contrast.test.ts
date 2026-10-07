import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// palette.md §7 (ADR-020): WCAG 2.2 kontrast çiftleri, globals.css'ten okunan değerlerle.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const css = readFileSync(join(here, "globals.css"), "utf8");
const paletteMd = readFileSync(join(repoRoot, "docs/design/palette.md"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`globals.css: ${selector} bloğu yok`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

function tokens(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)) m.set(x[1] as string, (x[2] as string).toLowerCase());
  return m;
}

export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const T = 4.5;
const U = 3;
// [ön plan, zemin, eşik] — palette.md §7.1 sırası, 41 çift.
const PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ["ink", "surface", T], ["ink", "bg", T], ["ink-muted", "surface", T], ["ink-muted", "bg", T],
  ["ink", "locked-bg", T], ["locked-ink", "locked-bg", T], ["locked-ink", "border", T],
  ["on-accent", "accent", T], ["accent-ink", "accent-soft", T], ["accent-ink", "surface", T], ["accent-ink", "bg", T],
  ["warning-ink", "warning-bg", T], ["undo-ink", "undo-bg", T], ["success-ink", "success-bg", T],
  ["danger-ink", "danger-bg", T], ["info-ink", "info-bg", T], ["danger-ink", "surface", T], ["success-ink", "surface", T],
  ["on-accent", "danger", T], ["on-accent", "success", T],
  ["border-strong", "surface", U], ["border-strong", "bg", U], ["focus", "surface", U], ["focus", "bg", U],
  ["accent", "surface", U], ["accent", "bg", U], ["danger", "surface", U], ["danger", "danger-bg", U],
  ["warning", "surface", U], ["warning", "warning-bg", U], ["success", "surface", U], ["success", "success-bg", U],
  ["info", "surface", U], ["info", "info-bg", U], ["undo", "surface", U], ["undo", "undo-bg", U],
  ["ink-muted", "surface", U], ["accent", "accent-soft", U], ["danger", "bg", U], ["ink-muted", "locked-bg", U],
  ["accent-ink", "accent-soft", U],
];

const flow = tokens(block("@theme"));
const cockpit = new Map([...flow, ...tokens(block('[data-view="cockpit"]'))]);

describe("WCAG formülü", () => {
  it("bilinen çiftler", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe("palet kontrastı (palette.md §7)", () => {
  it("41 çift tanımlı", () => {
    expect(PAIRS).toHaveLength(41);
  });

  it("Kokpit yalnız vurgu/zemin belirteçlerini geçersiz kılar; anlam belirteçleri Akış ile aynı", () => {
    for (const k of ["success", "danger", "warning", "info", "undo", "border-strong", "ink", "ink-muted"]) {
      expect(cockpit.get(k)).toBe(flow.get(k));
    }
  });

  for (const [view, map] of [["Akış", flow], ["Kokpit", cockpit]] as const) {
    describe(view, () => {
      it.each(PAIRS)("%s / %s >= eşik", (fg, bg, min) => {
        const f = map.get(fg);
        const b = map.get(bg);
        if (!f || !b) throw new Error(`belirteç eksik: ${f ? bg : fg}`);
        const ratio = contrast(f, b);
        expect(ratio, `${fg} ${f} / ${bg} ${b} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      });
    });
  }
});

// --- T-270 (ADR-020 ek, kural 8): iş kategorisi renk ailesi ---
// Döşeme zemini = açık `*-bg` (ya da `accent-soft`), ikon/başlık = aynı ailenin `*-ink`'i; ikon beyaz rozet (`surface`) üstünde de durur.
// Metin (başlık, açıklama) ≥4,5:1 ve ikon ≥3:1: ikon çiftleri de 4,5:1 ile denetlenir (daha sıkı). Yeni `count-*` çifti `globals.css`
// içindeki AYRI ikinci `@theme` bloğundan okunur (palette.md §2 tablosu 28 belirteçle sabit; tablo güncellemesi ADR-020 ekinde takip).
const CATEGORY_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ["success-ink", "success-bg", T], ["success-ink", "surface", T], ["ink", "success-bg", T],
  ["warning-ink", "warning-bg", T], ["warning-ink", "surface", T], ["ink", "warning-bg", T],
  ["info-ink", "info-bg", T], ["info-ink", "surface", T], ["ink", "info-bg", T],
  ["count-ink", "count-bg", T], ["count-ink", "surface", T], ["ink", "count-bg", T],
  ["accent-ink", "accent-soft", T], ["accent-ink", "surface", T], ["ink", "accent-soft", T],
  ["undo-ink", "undo-bg", T], ["undo-ink", "surface", T], ["ink", "undo-bg", T],
  ["ink-muted", "locked-bg", T], ["ink", "surface", T],
  ["success-ink", "success-bg", U], ["warning-ink", "warning-bg", U], ["info-ink", "info-bg", U],
  ["count-ink", "count-bg", U], ["accent-ink", "accent-soft", U], ["undo-ink", "undo-bg", U], ["ink-muted", "locked-bg", U],
];

function secondThemeBlock(): string {
  const first = css.indexOf("@theme");
  const second = css.indexOf("@theme", css.indexOf("\n}", first));
  if (first < 0 || second < 0) throw new Error("globals.css: ikinci @theme bloğu (T-270 kategori belirteçleri) yok");
  const open = css.indexOf("{", second);
  return css.slice(open + 1, css.indexOf("\n}", open));
}

const categoryExtra = tokens(secondThemeBlock());
const categoryFlow = new Map([...flow, ...categoryExtra]);
const categoryCockpit = new Map([...cockpit, ...categoryExtra]);

describe("iş kategorisi renk ailesi (T-270)", () => {
  it("yeni belirteçler yalnız ikinci @theme bloğundadır ve count-ink/count-bg'dir", () => {
    expect([...categoryExtra.keys()].sort()).toEqual(["count-bg", "count-ink"]);
    expect(flow.has("count-ink")).toBe(false);
  });

  for (const [view, map] of [["Akış", categoryFlow], ["Kokpit", categoryCockpit]] as const) {
    describe(view, () => {
      it.each(CATEGORY_PAIRS)("%s / %s >= eşik", (fg, bg, min) => {
        const f = map.get(fg);
        const b = map.get(bg);
        if (!f || !b) throw new Error(`belirteç eksik: ${f ? bg : fg}`);
        const ratio = contrast(f, b);
        expect(ratio, `${fg} ${f} / ${bg} ${b} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      });
    });
  }
});

// --- palette.md §2/§3 ile globals.css eşitliği (fail-closed: tablo biçimi bozulursa test kırılır) ---

function section(md: string, from: RegExp, to: RegExp): string {
  const a = md.search(from);
  const b = md.search(to);
  if (a < 0 || b < 0 || b <= a) throw new Error("palette.md: bölüm başlığı bulunamadı");
  return md.slice(a, b);
}

/** Tablodaki her veri satırı `| `ad` ... | **#hex** | ... |` olmalı; olmayan satır hata verir. */
function parseTable(body: string, label: string): Map<string, string> {
  const rows = body.split("\n").filter((l) => l.trimStart().startsWith("|"));
  if (rows.length < 3) throw new Error(`palette.md ${label}: tablo yok`);
  const out = new Map<string, string>();
  for (const row of rows.slice(2)) {
    const cells = row.split("|");
    const name = /^\s*`([a-z-]+)`/.exec(cells[1] ?? "")?.[1];
    const hex = /^\s*\*\*(#[0-9a-fA-F]{6})\*\*\s*$/.exec(cells[3] ?? "")?.[1];
    if (!name || !hex) throw new Error(`palette.md ${label}: satır ayrıştırılamadı: ${row}`);
    if (out.has(name)) throw new Error(`palette.md ${label}: yinelenen belirteç ${name}`);
    out.set(name, hex.toLowerCase());
  }
  return out;
}

const docFlow = parseTable(section(paletteMd, /^## 2\./m, /^## 3\./m).split("### Nötr")[0] as string, "§2");
const docCockpit = parseTable(section(paletteMd, /^## 3\./m, /^## 4\./m).split("\n\nAnlam belirteçleri")[0] as string, "§3");

describe("palette.md ile globals.css eşitliği", () => {
  it("§2 tablosu 28 belirteç, §3 tablosu 8 belirteç ayrıştırır", () => {
    expect(docFlow.size).toBe(28);
    expect(docCockpit.size).toBe(8);
  });

  it("Akış: @theme renk belirteçleri tablodakilerle birebir aynı (iki yönlü)", () => {
    expect([...flow.keys()].sort()).toEqual([...docFlow.keys()].sort());
    for (const [k, v] of docFlow) expect(flow.get(k), `--color-${k}`).toBe(v);
  });

  it("Kokpit: geçersiz kılınan belirteçler §3 tablosuyla birebir aynı (iki yönlü)", () => {
    const own = tokens(block('[data-view="cockpit"]'));
    expect([...own.keys()].sort()).toEqual([...docCockpit.keys()].sort());
    for (const [k, v] of docCockpit) expect(own.get(k), `cockpit --color-${k}`).toBe(v);
  });

  it("bozuk tablo biçimi hata verir (fail-closed)", () => {
    const good = "| Belirteç | E | Y | R |\n|---|---|---|---|\n| `ink` | #000000 | **#172133** | x |";
    expect(parseTable(good, "t").get("ink")).toBe("#172133");
    expect(() => parseTable(good.replace("**#172133**", "#172133"), "t")).toThrow();
    expect(() => parseTable(good.replace("`ink`", "ink"), "t")).toThrow();
    expect(() => parseTable("yok", "t")).toThrow();
  });
});

// --- belirteç dışı renk yasağı ---

const PALETTES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const TW_PREFIX = "bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|caret|accent|shadow";
const NAMED = "red|blue|green|white|black|gray|grey|orange|yellow|purple|pink";
const CSS_PROP =
  "color|background(?:-color)?|backgroundColor|border(?:-[a-z]+)*|borderColor|fill|stroke|outline(?:-color)?|stopColor|floodColor|caret-color|accent-color|box-shadow|text-shadow";

export const COLOR_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["hex sabiti", /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/],
  ["renk işlevi", /(?<![\w-])(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i],
  [
    "Tailwind varsayılan palet sınıfı",
    new RegExp(`(?<![\\w-])(?:${TW_PREFIX})-(?:${PALETTES})-\\d{2,3}(?![\\w-])`),
  ],
  ["bg/text-white|black", new RegExp(`(?<![\\w-])(?:${TW_PREFIX})-(?:white|black)(?![\\w-])`)],
  [
    "CSS adlı renk (stil bağlamı)",
    new RegExp(`(?<![\\w-])(?:${CSS_PROP})["']?\\s*[:=]\\s*\\{?\\s*["']?[^;"'}]*?(?<![\\w-])(?:${NAMED})(?![\\w-])`, "i"),
  ],
];

// Açık ve dar muafiyet: yalnız globals.css içindeki belirteç tanım satırları (`--color-*`, `--shadow-*`).
const EXEMPT_LINE: ReadonlyArray<readonly [string, RegExp]> = [["apps/web/app/globals.css", /^\s*--(?:color|shadow)-[a-z-]+:/]];

export function scanLine(rel: string, line: string): string[] {
  if (EXEMPT_LINE.some(([f, re]) => f === rel && re.test(line))) return [];
  return COLOR_RULES.filter(([, re]) => re.test(line)).map(([name]) => name);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:ts|tsx|css)$/.test(p) && !/\.(?:test|spec)\.tsx?$/.test(p) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("belirteç dışı renk yasağı", () => {
  const files = [...walk(join(repoRoot, "apps/web")), ...walk(join(repoRoot, "packages/ui"))].map((f) => relative(repoRoot, f));

  it("taranacak dosyalar var (globals.css ve ui bileşenleri dahil)", () => {
    expect(files).toContain("apps/web/app/globals.css");
    expect(files).toContain("packages/ui/src/banner.tsx");
  });

  it.each(files)("%s", (rel) => {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const name of scanLine(rel, line)) hits.push(`${rel}:${i + 1} ${name}`);
    });
    expect(hits).toEqual([]);
  });

  it.each([
    ["hex 3", 'style={{ color: "#f00" }}'],
    ["hex 4", "x = '#f00a'"],
    ["hex 6", 'c="#1559c7"'],
    ["hex 8", "c: #1559c7cc;"],
    ["rgb", "rgb(0 0 0 / .5)"],
    ["rgba", "rgba(0,0,0,.5)"],
    ["hsl", "color: hsl(10 20% 30%)"],
    ["hsla", "hsla(10,20%,30%,.5)"],
    ["oklch", "background: oklch(0.7 0.1 200)"],
    ["oklab", "oklab(0.7 0.1 0.1)"],
    ["lab", "lab(50% 40 59)"],
    ["lch", "lch(50% 40 59)"],
    ["color()", "color(display-p3 1 0 0)"],
    ["tw palet", 'className="text-red-600"'],
    ["tw varyant", 'className="hover:md:bg-sky-50 flex"'],
    ["tw from", 'className="from-indigo-500 to-pink-500 via-lime-400"'],
    ["tw divide", 'className="divide-zinc-200 decoration-rose-500 placeholder-slate-400 caret-teal-500"'],
    ["tw accent/shadow", 'className="accent-fuchsia-500 shadow-violet-500/50"'],
    ["tw keyfi", 'className="bg-[#fff] text-white"'],
    ["tw white", 'className="bg-white"'],
    ["tw black", 'className="text-black"'],
    ["tw border-black", 'className="border-black"'],
    ["css adlı", "  color: red;"],
    ["css adlı arka plan", "background: white;"],
    ["css adlı border", "border: 1px solid black;"],
    ["jsx fill", '<path fill="orange" />'],
    ["style nesnesi", 'style={{ backgroundColor: "purple" }}'],
    ["style nesnesi gray", "{ color: 'grey' }"],
    ["css yellow", "outline-color: yellow"],
  ] as const)("tarayıcı yakalar: %s", (_n, sample) => {
    expect(scanLine("x.tsx", sample).length).toBeGreaterThan(0);
  });

  it.each([
    'className="bg-accent text-on-accent border-border-strong"',
    'className="text-danger-ink bg-danger-bg shadow-card ring-focus"',
    "color: var(--color-ink);",
    '<a href="#main">Ana içeriğe geç</a>',
    "const label = 'Kırmızı'",
    'className="accent-soft stroke-2 text-lg"',
  ])("tarayıcı yakalamaz: %s", (sample) => {
    expect(scanLine("x.tsx", sample)).toEqual([]);
  });

  it("muafiyet yalnız globals.css belirteç tanım satırlarıdır", () => {
    expect(scanLine("apps/web/app/globals.css", "  --color-ink: #172133;")).toEqual([]);
    expect(scanLine("apps/web/app/globals.css", "  --shadow-card: 0 1px 2px rgb(23 33 51 / 0.08);")).toEqual([]);
    expect(scanLine("apps/web/app/globals.css", "  background: #fff;").length).toBeGreaterThan(0);
    expect(scanLine("apps/web/app/other.css", "  --color-ink: #172133;").length).toBeGreaterThan(0);
  });
});
