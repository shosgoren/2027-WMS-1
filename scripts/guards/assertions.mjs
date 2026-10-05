// `pnpm check:assertions [--update] [--base <ref>]` (T-008d; PROTOCOL §3b): içi boşaltılmış
// `@AC` testlerini yakalar. Sayım `lib/assertion-count.mjs` (AST). Taban: `tests/.ac-baseline.json`
// (`acFileAssertions`: `@AC` dosyası başına sabit olmayan assertion sayısı).
//
// Neden kodları (satıra bağlı olanlar `dosya:satır`):
//   CONSTANT_ASSERTION    `expect(true)`, `expect(1).toBe(1)`, `expect(x).toBe(x)`, `assert(true)` …
//   NO_ASSERTION          sabit olmayan assertion içermeyen `@AC` testi (boş `it`, yalnızca sabit
//                         assertion, `describe("@AC-x")` altındaki assertion'sız `it`) veya içinde
//                         test olmayan `@AC` describe'ı
//   ASSERTIONS_DECREASED  dosyanın assertion sayısı < taban (dosya silindi / `@AC` etiketi kalktı: 0)
//   BASELINE_STALE        sayı > taban veya tabanda olmayan `@AC` dosyası → `--update`
//   BASELINE_MISSING / BASELINE_INVALID / READ_ERROR  bkz. `check:ac-ratchet`
//   WARN BASELINE_MOVED   dosya taşınmış (aynı AC kümesi, aynı sayı): FAIL değil; yeni yol eski
//                         yolun tabanına göre denetlenir, `--update` taban yolunu günceller.
import { AC_BASELINE, prepare, UPDATE_HINT } from "./lib/assertion-count.mjs";

/**
 * @param {{ root: string, argv: string[], out: import("./lib/output.mjs").Reporter }} ctx
 */
export function run(ctx) {
  const { out } = ctx;
  const p = prepare("assertions", ctx);
  if (p === null) return;
  const { baseline, scans, moves } = p;
  const base = baseline.acFileAssertions;
  const movedTo = new Map(moves.map((m) => [m.to, m]));
  const movedFrom = new Set(moves.map((m) => m.from));

  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of scans) {
    counts[s.file] = s.assertions;
    for (const c of s.constants) out.fail("CONSTANT_ASSERTION", `${s.file}:${c.line}`, `sabit assertion: ${c.message}`);
    for (const n of s.noAssertion) out.fail("NO_ASSERTION", `${s.file}:${n.line}`, n.message);

    const mv = movedTo.get(s.file);
    const key = mv === undefined ? s.file : mv.from;
    const was = base[key];
    if (mv !== undefined) out.warn("BASELINE_MOVED", s.file, `${mv.from} → ${s.file} taşınmış (${mv.count} assertion); ${UPDATE_HINT}`);
    if (was === undefined) out.fail("BASELINE_STALE", s.file, `tabanda yok (${s.assertions} assertion); ${UPDATE_HINT}`);
    else if (s.assertions < was) out.fail("ASSERTIONS_DECREASED", s.file, `assertion sayısı ${was} → ${s.assertions}`);
    else if (s.assertions > was) out.fail("BASELINE_STALE", s.file, `taban ${was} < gerçek ${s.assertions}; ${UPDATE_HINT}`);
  }
  out.detail("acFileAssertions", counts);

  for (const [file, was] of Object.entries(base)) {
    if (file in counts || movedFrom.has(file)) continue;
    if (was > 0) out.fail("ASSERTIONS_DECREASED", file, `assertion sayısı ${was} → 0 (dosya yok veya artık \`@AC\` testi içermiyor; taban: ${AC_BASELINE})`);
  }
}
