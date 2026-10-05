// `pnpm check:ac-ratchet [--update] [--base <ref>]` (T-008d; PROTOCOL §3b): `@AC` testlerinin
// silinmesini veya azalmasını yakalar. Sayım `lib/assertion-count.mjs` (AST; etiket describe'dan
// miras alınır). Taban: `tests/.ac-baseline.json` (`acTests`).
//
// Neden kodları:
//   AC_TEST_REMOVED   AC'nin gerçek test sayısı < daldaki taban. Dosya: `--base` ortak atasına göre
//                     testi azalan dosya(lar); belirlenemezse taban dosyası.
//   BASELINE_STALE    gerçek > taban veya tabanda olmayan AC → `pnpm check:ac-ratchet --update`.
//   BASELINE_MISSING  taban dosyası yok (`--update` ilk oluşturmayı yapar).
//   BASELINE_INVALID  taban ayrıştırılamadı / biçim hatalı.
//   READ_ERROR        test dosyası okunamadı.
//   WARN BASELINE_LOWERED  daldaki taban < `--base` (varsayılan `origin/main`) ortak atasındaki
//                     taban. Yalnızca bildirilir; onayı `check:protected` doğrular (T-008c kuralı,
//                     `baselineLowered`; burada tekrar uygulanmaz).
//   WARN BASELINE_MOVED    `--update` taşınan dosyanın taban yolunu güncelledi.
//   WARN BASE_UNAVAILABLE  `--base` ref'i / ortak ata yok.
// `--update`: taban yalnızca yukarı güncellenir (her iki bölüm); düşüş yazılmaz, azalma FAIL kalır.
import { baselineLowered } from "./protected-paths.mjs";
import { AC_BASELINE, perAc, prepare, scanAtRef, UPDATE_HINT } from "./lib/assertion-count.mjs";
import { fileAtRef } from "./lib/git.mjs";

/**
 * @param {{ root: string, argv: string[], out: import("./lib/output.mjs").Reporter }} ctx
 */
export function run(ctx) {
  const { out, root } = ctx;
  const p = prepare("ac-ratchet", ctx);
  if (p === null) return;
  const { baseline, scans, base } = p;

  /** @type {Record<string, number>} */
  const actual = {};
  for (const s of scans) for (const [id, n] of perAc(s)) actual[id] = (actual[id] ?? 0) + n;
  out.detail("acTests", actual);

  /** @type {Map<string, Map<string, number>> | null} */
  let baseByFile = null;
  const removed = Object.entries(baseline.acTests).filter(([id, n]) => (actual[id] ?? 0) < n);
  if (removed.length > 0 && base !== null) {
    baseByFile = new Map(scanAtRef(root, base).map((s) => [s.file, perAc(s)]));
  }
  for (const [id, n] of removed) {
    const now = actual[id] ?? 0;
    /** @type {string[]} */
    const files = [];
    if (baseByFile !== null) {
      for (const [file, m] of baseByFile) {
        const was = m.get(id) ?? 0;
        const cur = scans.find((s) => s.file === file);
        const is = cur === undefined ? 0 : (perAc(cur).get(id) ?? 0);
        if (is < was) files.push(file);
      }
    }
    const msg = `${id}: ${n - now} test eksik (taban ${n}, gerçek ${now}); testi geri ekleyin — taban düşürmek korunan değişikliktir (§Onay kaynağı)`;
    if (files.length === 0) out.fail("AC_TEST_REMOVED", AC_BASELINE, msg);
    for (const f of files) out.fail("AC_TEST_REMOVED", f, msg);
  }

  for (const [id, n] of Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const was = baseline.acTests[id];
    if (was === undefined) out.fail("BASELINE_STALE", AC_BASELINE, `${id}: tabanda yok (gerçek ${n}); ${UPDATE_HINT}`);
    else if (n > was) out.fail("BASELINE_STALE", AC_BASELINE, `${id}: taban ${was} < gerçek ${n}; ${UPDATE_HINT}`);
  }

  if (base !== null) {
    const lowered = baselineLowered(fileAtRef(root, base, AC_BASELINE), p.baselineText);
    if (lowered !== null) {
      out.warn("BASELINE_LOWERED", AC_BASELINE, `${lowered}; onay \`check:protected\` ile doğrulanır (§Onay kaynağı)`);
    }
  }
}
