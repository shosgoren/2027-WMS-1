// T-008f `check:pilot` testleri. Her senaryo geçici dizinde gerçek dosyalarla `cli.mjs main`
// üzerinden uçtan uca koşar (çıkış kodu + neden kodu satırı).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.mjs";
import { isKnownKey, parsePilotArgs, placeholderIn, PILOT_KEYS, registeredAssumptions } from "./pilot.mjs";

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Tam ve tutarlı profil: [key, Alan, Değer, Varsayım]. */
const BASE = /** @type {Array<[string, string, string, string]>} */ ([
  ["sector", "Sektör", "PACKAGING_SUPPLIES", "A-11"],
  ["customer_code", "Müşteri kodu", "PILOT-A", "A-12"],
  ["warehouse_count", "Depo sayısı", "1", "SABİT"],
  ["location_count", "Lokasyon sayısı", "120", "A-13"],
  ["location_depth", "Lokasyon derinliği", "ZONE>RACK>BIN", "A-14"],
  ["active_sku_count", "Aktif SKU", "300", "A-15"],
  ["tracking_mode.ALL", "Takip modu", "NONE", "A-16"],
  ["expiry_tracking", "SKT", "NO", "A-17"],
  ["expiry_fefo", "FEFO", "NOT_APPLICABLE", "A-18"],
  ["min_shelf_life_days", "Raf ömrü", "NOT_APPLICABLE", "A-19"],
  ["handling_unit_mode", "Koli/palet", "UNIT_ONLY", "A-20"],
  ["partial_case_opening", "Kısmi koli", "YES", "A-21"],
  ["stock_owner", "Stok sahibi", "SINGLE", "A-22"],
  ["current_system", "Mevcut sistem", "EXCEL", "A-23"],
  ["opening_stock_source", "Açılış stoku", "EXCEL_IMPORT", "A-24"],
  ["daily_receipt_lines", "Kabul satırı", "30", "A-25"],
  ["daily_order_lines", "Sipariş satırı", "60", "A-26"],
  ["daily_shipment_lines", "Sevk satırı", "60", "A-27"],
  ["users_by_role", "Kullanıcılar", "1 yönetici, 1 depo şefi, 3 toplayıcı", "A-28"],
  ["devices", "Cihazlar", "2 Android + 1 USB okuyucu", "A-29"],
  ["label_printer", "Etiket yazıcısı", "ZPL, 203 dpi", "A-30"],
  ["offline_required", "Offline", "NO", "A-31"],
  ["erp_integration", "ERP", "NONE", "SABİT"],
  ["base_units", "Temel birim", "ADET", "A-32"],
  ["quantity_decimals", "Ondalık", "0", "A-33"],
  ["success.unexplained_count_diff_max", "Sayım farkı", "5", "A-34"],
  ["success.unassisted_tasks_per_week_max", "Destekli görev", "3", "A-35"],
]);

const OQ = ["# Açık Sorular ve Varsayımlar", "## Varsayımlar"]
  .concat(Array.from({ length: 25 }, (_, i) => `A-${i + 11} | varsayım | koşul | Q-12`))
  .join("\n");
const DEC_ACCEPTED = "ADR-011 | 2026-10-05 | Taşıma birimi | kabul\n";
const DEC_PROPOSED = "ADR-011 | 2026-10-05 | Taşıma birimi | önerildi\n";

/**
 * @param {Array<[string, string, string, string]>} rows
 * @param {string} [prose]
 */
function pilotText(rows, prose = "Varsayımsal profil.") {
  return [
    "# Pilot",
    "",
    prose,
    "",
    "| key | Alan | Değer | Varsayım |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ].join("\n");
}

/**
 * BASE üzerinde anahtar bazlı değişiklik: `null` satırı siler.
 * @param {Record<string, Partial<{ value: string, assumption: string }> | null>} patch
 * @param {Array<[string, string, string, string]>} [extra]
 */
function rowsWith(patch, extra = []) {
  /** @type {Array<[string, string, string, string]>} */
  const out = [];
  for (const [k, f, v, a] of BASE) {
    if (!Object.hasOwn(patch, k)) out.push([k, f, v, a]);
    else {
      const p = patch[k];
      if (p !== null && p !== undefined) out.push([k, f, p.value ?? v, p.assumption ?? a]);
    }
  }
  return out.concat(extra);
}

/**
 * @param {{ pilot?: string | null, oq?: string | null, decisions?: string | null }} files
 * @param {string[]} [args]
 */
async function check(files, args = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pilot-"));
  dirs.push(root);
  mkdirSync(path.join(root, "docs"), { recursive: true });
  const pilot = files.pilot === undefined ? pilotText(BASE) : files.pilot;
  if (pilot !== null) writeFileSync(path.join(root, "docs/PILOT.md"), pilot);
  const oq = files.oq === undefined ? OQ : files.oq;
  if (oq !== null) writeFileSync(path.join(root, "docs/OPEN_QUESTIONS.md"), oq);
  const dec = files.decisions === undefined ? DEC_ACCEPTED : files.decisions;
  if (dec !== null) writeFileSync(path.join(root, "docs/DECISIONS.md"), dec);
  /** @type {string[]} */
  const lines = [];
  const code = await main(["pilot", ...args], { root, log: (l) => lines.push(l) });
  return { code, lines, out: lines.join("\n") };
}

/**
 * Tek neden koduyla FAIL beklentisi.
 * @param {Awaited<ReturnType<typeof check>>} r
 * @param {string} reason
 * @param {string} [needle] FAIL satırında geçmesi gereken metin
 */
function expectFail(r, reason, needle) {
  expect(r.code).toBe(1);
  const hits = r.lines.filter((l) => l.startsWith(`[check:pilot] FAIL ${reason} `));
  expect(hits.length, r.out).toBeGreaterThan(0);
  if (needle !== undefined) expect(hits.some((l) => l.includes(needle)), r.out).toBe(true);
  expect(r.lines.at(-1)).toMatch(/^check:pilot FAIL \(\d+\)$/);
}

describe("check:pilot — OK", () => {
  it("tam ve tutarlı dosya → OK (Faz 0, A-xx serbest)", async () => {
    const r = await check({});
    expect(r.out).not.toContain("FAIL");
    expect(r.lines.at(-1)).toBe("check:pilot OK");
    expect(r.code).toBe(0);
  });

  it("SKT var + LOT grubu + FEFO + raf ömrü sayısı → OK", async () => {
    const pilot = pilotText(
      rowsWith(
        { expiry_tracking: { value: "YES" }, expiry_fefo: { value: "YES" }, min_shelf_life_days: { value: "30" } },
        [["tracking_mode.FOOD", "Takip modu gıda", "LOT", "A-35"]],
      ),
    );
    const r = await check({ pilot });
    expect(r.out).not.toContain("FAIL");
    expect(r.code).toBe(0);
  });

  it("handling_unit_mode TRACKED + ADR-011 kabul → OK", async () => {
    const r = await check({ pilot: pilotText(rowsWith({ handling_unit_mode: { value: "MIXED" } })) });
    expect(r.code).toBe(0);
  });

  it("--phase 3A + tüm satırlar DOĞRULANDI/SABİT → OK", async () => {
    const rows = BASE.map(([k, f, v, a]) => /** @type {[string, string, string, string]} */ ([k, f, v, a === "SABİT" ? a : "DOĞRULANDI"]));
    const r = await check({ pilot: pilotText(rows) }, ["--phase", "3A"]);
    expect(r.out).not.toContain("FAIL");
    expect(r.code).toBe(0);
  });
});

describe("check:pilot — FAIL neden kodları", () => {
  it("PILOT_MISSING: dosya yok (fail-closed)", async () => {
    expectFail(await check({ pilot: null }), "PILOT_MISSING", "docs/PILOT.md");
  });

  it("PILOT_PARSE_ERROR: tablo başlığı sözleşmeye uymuyor", async () => {
    const pilot = pilotText(BASE).replace("| key | Alan | Değer | Varsayım |", "| key | Değer |");
    expectFail(await check({ pilot }), "PILOT_PARSE_ERROR");
  });

  it("PILOT_PARSE_ERROR: yinelenen key", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({}, [["sector", "x", "OTHER", "A-11"]])) }), "PILOT_PARSE_ERROR", "yinelenen");
  });

  it("PILOT_INCOMPLETE: T-006 anahtarı eksik", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ label_printer: null })) }), "PILOT_INCOMPLETE", "label_printer");
  });

  it("PILOT_INCOMPLETE: hiç tracking_mode.* grubu yok", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ "tracking_mode.ALL": null })) }), "PILOT_INCOMPLETE", "tracking_mode.*");
  });

  it("PILOT_INCOMPLETE: Değer boş", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ devices: { value: "" } })) }), "PILOT_INCOMPLETE", "devices: Değer boş");
  });

  for (const [name, value] of [
    ["…", "…"],
    ["...", "2 Android ..."],
    ["TBD", "TBD"],
    ["tbd küçük harf", "tbd"],
    ["?", "120?"],
    ["/ seçilmemiş seçenek", "Evet / Hayır"],
  ]) {
    it(`PILOT_INCOMPLETE: Değer'de ${name}`, async () => {
      const r = await check({ pilot: pilotText(rowsWith({ location_count: { value: value ?? "" } })) });
      expectFail(r, "PILOT_INCOMPLETE", "location_count: Değer");
    });
  }

  it("PILOT_INCOMPLETE: enum alanında seçilmemiş seçenek listesi (NONE / LOT)", async () => {
    const r = await check({ pilot: pilotText(rowsWith({ "tracking_mode.ALL": { value: "NONE / LOT" } })) });
    expectFail(r, "PILOT_INCOMPLETE", "tracking_mode.ALL");
  });

  it("PILOT_INCOMPLETE: Varsayım boş", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ sector: { assumption: "" } })) }), "PILOT_INCOMPLETE", "sector: Varsayım boş");
  });

  it("PILOT_INCOMPLETE: tablo dışı metinde … kalmış", async () => {
    expectFail(await check({ pilot: pilotText(BASE, "Müşteri: …") }), "PILOT_INCOMPLETE", "docs/PILOT.md:3");
  });

  it("PILOT_INVALID_VALUE: enum dışı değer", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ stock_owner: { value: "3PL" } })) }), "PILOT_INVALID_VALUE", "stock_owner");
  });

  it("PILOT_INVALID_VALUE: tracking_mode grubunda enum dışı değer", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ "tracking_mode.ALL": { value: "BATCH" } })) }), "PILOT_INVALID_VALUE", "tracking_mode.ALL");
  });

  it("PILOT_INVALID_VALUE: SABİT izinli olmayan anahtarda", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ sector: { assumption: "SABİT" } })) }), "PILOT_INVALID_VALUE", "sector: SABİT");
  });

  it("PILOT_INVALID_VALUE: SABİT warehouse_count ama değer 1 değil", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ warehouse_count: { value: "2" } })) }), "PILOT_INVALID_VALUE", "warehouse_count");
  });

  it("PILOT_INVALID_VALUE: Varsayım sütunu geçersiz biçim", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ sector: { assumption: "A-11, A-12" } })) }), "PILOT_INVALID_VALUE", "sector: Varsayım");
  });

  it("PILOT_INVALID_VALUE: expiry_tracking=NO iken expiry_fefo / min_shelf_life_days değerli", async () => {
    const r = await check({ pilot: pilotText(rowsWith({ expiry_fefo: { value: "NO" }, min_shelf_life_days: { value: "30" } })) });
    expectFail(r, "PILOT_INVALID_VALUE", "expiry_fefo: expiry_tracking=NO");
    expectFail(r, "PILOT_INVALID_VALUE", "min_shelf_life_days: expiry_tracking=NO");
  });

  it("PILOT_INVALID_VALUE: expiry_tracking=YES iken expiry_fefo NOT_APPLICABLE ve raf ömrü sayı değil", async () => {
    const r = await check({
      pilot: pilotText(rowsWith({ expiry_tracking: { value: "YES" }, "tracking_mode.ALL": { value: "LOT" } })),
    });
    expectFail(r, "PILOT_INVALID_VALUE", "expiry_fefo: expiry_tracking=YES");
    expectFail(r, "PILOT_INVALID_VALUE", "min_shelf_life_days: expiry_tracking=YES");
    expect(r.out).not.toContain("PILOT_EXPIRY_WITHOUT_LOT");
  });

  it("PILOT_UNKNOWN_KEY: yazım hatalı anahtar", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({}, [["sectr", "Sektör", "X", "A-11"]])) }), "PILOT_UNKNOWN_KEY", "sectr");
  });

  it("PILOT_UNKNOWN_KEY: önek eksik grup anahtarı (tracking_mode.a.b)", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({}, [["tracking_mode.a.b", "x", "NONE", "A-16"]])) }), "PILOT_UNKNOWN_KEY", "tracking_mode.a.b");
  });

  it("PILOT_ASSUMPTION_UNREGISTERED: A-xx OPEN_QUESTIONS'ta yok", async () => {
    expectFail(await check({ pilot: pilotText(rowsWith({ sector: { assumption: "A-99" } })) }), "PILOT_ASSUMPTION_UNREGISTERED", "A-99");
  });

  it("PILOT_ASSUMPTION_UNREGISTERED: OPEN_QUESTIONS.md yok (fail-closed)", async () => {
    expectFail(await check({ oq: null }), "PILOT_ASSUMPTION_UNREGISTERED", "A-11");
  });

  it("PILOT_EXPIRY_WITHOUT_LOT: SKT var ama lot grubu yok", async () => {
    const r = await check({
      pilot: pilotText(rowsWith({ expiry_tracking: { value: "YES" }, expiry_fefo: { value: "YES" }, min_shelf_life_days: { value: "30" } })),
    });
    expectFail(r, "PILOT_EXPIRY_WITHOUT_LOT", "expiry_tracking");
  });

  it("PILOT_ADR011_NOT_ACCEPTED: TRACKED + ADR-011 önerildi", async () => {
    const r = await check({ pilot: pilotText(rowsWith({ handling_unit_mode: { value: "TRACKED" } })), decisions: DEC_PROPOSED });
    expectFail(r, "PILOT_ADR011_NOT_ACCEPTED", "TRACKED");
  });

  it("PILOT_ADR011_NOT_ACCEPTED: MIXED + DECISIONS.md yok", async () => {
    const r = await check({ pilot: pilotText(rowsWith({ handling_unit_mode: { value: "MIXED" } })), decisions: null });
    expectFail(r, "PILOT_ADR011_NOT_ACCEPTED", "MIXED");
  });

  it("UNIT_ONLY iken ADR-011 önerildi → ADR şartı yok (OK)", async () => {
    expect((await check({ decisions: DEC_PROPOSED })).code).toBe(0);
  });

  it("PILOT_UNVERIFIED_ASSUMPTION: --phase 3A ve A-xx'li dosya", async () => {
    const r = await check({}, ["--phase", "3A"]);
    expectFail(r, "PILOT_UNVERIFIED_ASSUMPTION", "sector: A-11");
    expect(r.lines.filter((l) => l.includes("PILOT_UNVERIFIED_ASSUMPTION"))).toHaveLength(25);
  });

  it("PILOT_UNVERIFIED_ASSUMPTION: --phase=3A biçimi", async () => {
    expectFail(await check({}, ["--phase=3A"]), "PILOT_UNVERIFIED_ASSUMPTION");
  });
});

describe("check:pilot — argümanlar ve yardımcılar", () => {
  it("--phase 0 açıkça verilince A-xx serbest", async () => {
    expect((await check({}, ["--phase", "0"])).code).toBe(0);
  });

  it("geçersiz argüman → kullanım hatası (çıkış 2)", async () => {
    expect((await check({}, ["--phase", "9"])).code).toBe(2);
    expect((await check({}, ["--foo"])).code).toBe(2);
    expect((await check({}, ["--phase"])).code).toBe(2);
    expect(() => parsePilotArgs(["--phase", "0", "--phase", "3A"])).toThrow(/birden fazla/);
  });

  it("placeholderIn: geçerli serbest metin değerleri işaretlenmez", () => {
    for (const v of ["ZONE>RACK>BIN", "1 yönetici, 1 depo şefi", "ADET (koli = birim dönüşümü)", "PILOT-A", "STBD"]) {
      expect(placeholderIn(v), v).toBeNull();
    }
    expect(placeholderIn("   ")).toBe("boş");
  });

  it("isKnownKey: T-006 listesi + tracking_mode.<grup>", () => {
    for (const k of PILOT_KEYS.filter((k) => !k.endsWith(".*"))) expect(isKnownKey(k), k).toBe(true);
    expect(isKnownKey("tracking_mode.FOOD")).toBe(true);
    expect(isKnownKey("tracking_mode.*")).toBe(false);
    expect(isKnownKey("tracking_mode")).toBe(false);
    expect(isKnownKey("success.other")).toBe(false);
  });

  it("registeredAssumptions: yalnızca satır başı A-xx | … tanımları", () => {
    const ids = registeredAssumptions("A-01 | x | y | Q-1\nQ-12 | A-50 hakkında | t | açık\n| A-02 | x | y | z |\n");
    expect([...ids].sort()).toEqual(["A-01", "A-02"]);
    expect(registeredAssumptions(null).size).toBe(0);
  });
});
