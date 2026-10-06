// AC-04 — katman kapsamı (T-128, qa-verifier).
// (Bu dosya bir katman testi değildir; tarama kendisini atlar.)
//
// KURAL: AC-04 "API, DB, dosya, cache, export reddeder" der. Aşağıdaki LAYERS listesi Faz 1'de var olan her tenant-kapsamlı
// katmandır; her biri en az bir `@AC-04` etiketli teste sahip OLMALIDIR. Test dosyaları katmanını dosya başındaki
// `// katman: <ad>[, <ad>…]` satırıyla bildirir (ilk `katman:` satırı; ` — ` sonrası açıklamadır). Yeni bir katman
// (arama, worker işi, ...) eklendiğinde: (1) LAYERS ve ALIASES genişletilir, (2) o katmanın `@AC-04` testi yazılır.
// Tanınmayan etiket ve etiketsiz `@AC-04` dosyası görünür kılınır (yeni katman sessizce kapsam dışı kalmasın).
// Bu dosyanın kendi test başlıkları etiket-algılanır biçimde AC-04 yazmaz (aksi halde kendi kapsamını sayardı).
// SINIR: kapsam dosya başlığı beyanına dayanır; katmanın gerçekten çalıştırıldığını/geçtiğini sınamaz (bunu test:ac yapar).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractTags, listTestFiles } from "../../../scripts/test-ac/collect.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SELF = "tests/integration/ac/ac-04-coverage.int.test.ts";

export const LAYERS = ["api-page-action", "api-route", "db", "file", "cache", "export"] as const;
type Layer = (typeof LAYERS)[number];

/** Etiket metni -> katman. İlk eşleşen kazanır; eşleşmeyen etiket "unknown" olarak raporlanır. */
const ALIASES: readonly (readonly [RegExp, Layer])[] = [
  [/^api\s*\((?:sayfa|page)[^)]*(?:eylem|action)[^)]*\)$|^api-page-action$/, "api-page-action"],
  [/^api\s*\(?\s*route\s*\)?$|^api-route$/, "api-route"],
  [/^db$/, "db"],
  [/^(?:file|dosya)$/, "file"],
  [/^(?:cache|önbellek)$/, "cache"],
  [/^export$/, "export"],
];

interface FileLayers {
  readonly file: string;
  readonly layers: Layer[];
  readonly unknown: string[];
  readonly declared: boolean;
}

/** İlk `// katman:` satırı; ` — ` ve ` (` sonrası açıklama kesilir ama `api (sayfa/eylem)` biçimi korunur. */
export function parseLayerHeader(text: string): { declared: boolean; layers: Layer[]; unknown: string[] } {
  const m = /^\/\/\s*katman:\s*(.+)$/m.exec(text);
  if (m === null) return { declared: false, layers: [], unknown: [] };
  const value = (m[1] ?? "").split(/\s+[—–-]\s+/)[0] ?? "";
  const layers: Layer[] = [];
  const unknown: string[] = [];
  for (const raw of value.split(",")) {
    const label = raw.trim().toLowerCase();
    if (label === "") continue;
    const hit = ALIASES.find(([re]) => re.test(label));
    if (hit === undefined) unknown.push(label);
    else if (!layers.includes(hit[1])) layers.push(hit[1]);
  }
  return { declared: true, layers, unknown };
}

/** `@AC-04` etiketli en az bir testi olan dosyalar ve bildirdikleri katmanlar. */
function scan(root: string): FileLayers[] {
  const out: FileLayers[] = [];
  for (const file of listTestFiles(root)) {
    if (file === SELF) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    if (!extractTags(text, file).some((t) => t.id === "AC-04")) continue;
    out.push({ file, ...parseLayerHeader(text) });
  }
  return out;
}

export function missingLayers(files: readonly FileLayers[]): Layer[] {
  const covered = new Set(files.flatMap((f) => f.layers));
  return LAYERS.filter((l) => !covered.has(l));
}

describe("AC-04 katman kapsamı (makinece)", () => {
  it("AC-04 katman kapsamı: her katman en az bir etiketli teste sahip (eksik katman = FAIL)", () => {
    const files = scan(ROOT);
    const table = LAYERS.map((l) => `${l}: ${files.filter((f) => f.layers.includes(l)).map((f) => path.basename(f.file)).join(", ") || "YOK"}`);
    console.log(`[ac-04-coverage]\n${table.join("\n")}`);
    const unlabeled = files.filter((f) => !f.declared).map((f) => f.file);
    if (unlabeled.length > 0) console.warn(`[ac-04-coverage] katman etiketi YOK (kapsam sayımına girmez): ${unlabeled.join(", ")}`);
    expect(missingLayers(files), `AC-04 katman tablosu:\n${table.join("\n")}`).toEqual([]);
  });

  it("tanınmayan katman etiketi yok (yeni katman LAYERS'a eklenmeden bildirilemez)", () => {
    const bad = scan(ROOT).flatMap((f) => f.unknown.map((u) => `${f.file}: ${u}`));
    expect(bad).toEqual([]);
  });

  it("tarayıcı kendini sınar: katman eksikse eksik listelenir, tam kümede boştur", () => {
    const mk = (layers: Layer[]): FileLayers => ({ file: "x", layers, unknown: [], declared: true });
    expect(missingLayers([])).toEqual([...LAYERS]);
    expect(missingLayers([mk(["db", "file", "cache"])])).toEqual(["api-page-action", "api-route", "export"]);
    expect(missingLayers([mk([...LAYERS])])).toEqual([]);
    expect(parseLayerHeader("// katman: DB — açıklama\n").layers).toEqual(["db"]);
    expect(parseLayerHeader("// katman: API (sayfa/eylem)\n").layers).toEqual(["api-page-action"]);
    expect(parseLayerHeader("// katman: api-route, export\n").layers).toEqual(["api-route", "export"]);
    expect(parseLayerHeader("// katman: file, cache\n").layers).toEqual(["file", "cache"]);
    expect(parseLayerHeader("// katman: arama\n")).toEqual({ declared: true, layers: [], unknown: ["arama"] });
    expect(parseLayerHeader("// başlık yok\n").declared).toBe(false);
  });
});
