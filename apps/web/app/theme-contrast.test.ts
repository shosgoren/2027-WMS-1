import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// palette.md §7 (ADR-020): WCAG 2.2 kontrast çiftleri, globals.css'ten okunan değerlerle.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const css = readFileSync(join(here, "globals.css"), "utf8");

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

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("belirteç dışı renk yasağı", () => {
  const files = [...walk(join(repoRoot, "apps/web/app")), ...walk(join(repoRoot, "packages/ui/src"))].filter(
    (f) => !f.endsWith(".test.tsx"),
  );
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ["hex sabiti", /#[0-9a-fA-F]{3,8}\b/],
    ["rgb(", /\brgba?\(/],
    [
      "Tailwind varsayılan palet sınıfı",
      /\b(?:text|bg|border|ring|fill|stroke)-(?:red|green|blue|amber|yellow|orange|gray|slate|zinc|neutral|stone|emerald|teal|sky|indigo)-\d/,
    ],
  ];
  it("taranacak dosya var", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files.map((f) => relative(repoRoot, f)))("%s", (rel) => {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const [name, re] of rules) if (re.test(line)) hits.push(`${rel}:${i + 1} ${name}`);
    });
    expect(hits).toEqual([]);
  });
});
