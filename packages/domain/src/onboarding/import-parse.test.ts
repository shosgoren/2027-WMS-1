// T-289: CSV ayrıştırıcı, Türkçe ondalık, başlık eşleme ve ürün/stok doğrulama kuralları (saf; veritabanı yok).
import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  DATA_CELL_MAX,
  HEADER_CELL_MAX,
  MAX_COLUMNS,
  classify,
  detectKind,
  foldHeader,
  parseCsv,
  parseTrDecimal,
  shelfKey,
  templateCsv,
  validateProducts,
  validateStock,
  type ItemInfoCtx,
  type ProductContext,
  type ShelfInfo,
  type StockContext,
} from "./import-parse.ts";

const ok = (text: string): readonly (readonly string[])[] => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error("csv");
  return r.records;
};

describe("parseCsv", () => {
  it("; ve , ayırıcısını otomatik seçer, BOM atar, CRLF/LF/CR kabul eder", () => {
    expect(ok("﻿a;b;c\r\n1;2;3\n4;5;6\r7;8;9")).toEqual([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]);
    expect(ok("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    const semi = parseCsv("a;b\n1,5;2");
    expect(semi.ok && semi.delimiter).toBe(";");
    expect(ok("a;b\n1,5;2")[1]).toEqual(["1,5", "2"]); // virgül ondalık, ayırıcı değil
  });
  it("tırnaklı alan: ayırıcı, çift tırnak kaçışı ve alan içi satır sonu", () => {
    expect(ok('a;b\n"x;y";"he said ""hi"""\n"satır\nikinci";z')).toEqual([["a", "b"], ["x;y", 'he said "hi"'], ["satır\nikinci", "z"]]);
  });
  it("boş kayıtlar korunur (satır numarası kaymaz), baştaki/sondaki boşluk kırpılır", () => {
    expect(ok("a;b\n\n 1 ; 2 \n")).toEqual([["a", "b"], [""], ["1", "2"]]);
  });
  it("kapanmamış tırnak ve boş dosya hata verir", () => {
    expect(parseCsv('a;b\n"x;y')).toEqual({ ok: false, code: "CSV_UNTERMINATED_QUOTE" });
    expect(parseCsv("  \n ")).toEqual({ ok: false, code: "FILE_EMPTY" });
    expect(parseCsv("﻿")).toEqual({ ok: false, code: "FILE_EMPTY" });
  });
});

describe("parseTrDecimal", () => {
  it.each([
    ["12", "12"],
    ["12,5", "12.5"],
    ["0,25", "0.25"],
    ["1.250,5", "1250.5"],
    ["1.250.000", "1250000"],
    ["0.25", "0.25"],
    ["1.5", "1.5"],
    ["007", "7"],
    ["12,0", "12"],
    ["12,500", "12.5"],
    [" 12 ", "12"],
  ])("%s → %s", (raw, text) => {
    const d = parseTrDecimal(raw);
    expect(d.ok && d.text).toBe(text);
  });
  it.each([
    ["", "EMPTY"],
    ["-3", "NEGATIVE"],
    ["1.250", "AMBIGUOUS"],
    ["1,250.5", "INVALID"],
    ["1E+03", "INVALID"],
    ["12 adet", "INVALID"],
    ["1,2,3", "INVALID"],
    ["1,", "INVALID"],
    ["123456789012345", "TOO_LARGE"],
    ["1,1234567", "TOO_LARGE"],
  ])("%s reddedilir (%s)", (raw, reason) => {
    const d = parseTrDecimal(raw);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toBe(reason);
  });
});

describe("başlık", () => {
  it("Türkçe harf ve yazım farklarını katlar", () => {
    expect(foldHeader("Koli İçi Adet")).toBe("koli ici adet");
    expect(foldHeader("ÜRÜN_KODU")).toBe("urun kodu");
    expect(foldHeader("Miktar (ADET)")).toBe("miktar");
  });
  it("dosya türünü başlıktan bulur", () => {
    expect(detectKind(["Ürün kodu", "Raf kodu", "Miktar"])).toBe("STOCK");
    expect(detectKind(["kod", "ad"])).toBe("PRODUCTS");
    expect(detectKind(["foo", "bar"])).toBeNull();
  });
  it("şablonlar BOM'lu, yalnız başlık satırı ve ayrıştırıcıyla uyumlu", () => {
    for (const kind of ["PRODUCTS", "STOCK"] as const) {
      const t = templateCsv(kind);
      expect(t.charCodeAt(0)).toBe(0xfeff);
      const c = classify(t);
      expect(c.ok && c.kind).toBe(kind);
      expect(c.ok && c.records.length).toBe(1);
    }
    const p = classify(templateCsv("PRODUCTS"));
    expect(p.ok && validateProducts(p.records, productCtx()).issues.map((i) => i.code)).toEqual(["NO_ROWS"]);
  });
});

// --- bağlam yardımcıları ------------------------------------------------------------------------------------------

const ADET = { id: "u-adet", code: "ADET", name: "Adet", status: "ACTIVE" as const };
const KOLI = { id: "u-koli", code: "KOLI", name: "Koli", status: "ACTIVE" as const };
const item = (over: Partial<ItemInfoCtx> & { code: string }): ItemInfoCtx => ({ id: `i-${over.code}`, name: "Ad", baseUnitId: "u-adet", status: "ACTIVE", quantityScale: 0, trackingMode: "NONE", ...over });

function productCtx(over: Partial<ProductContext> = {}): ProductContext {
  return { units: [ADET, KOLI], items: new Map(), barcodes: new Map(), conversions: new Map(), ...over };
}
const PH = "kod;ad;temel birim;koli içi adet;adet barkodu;koli barkodu";
const products = (rows: string[], ctx = productCtx()) => {
  const c = classify([PH, ...rows].join("\n"));
  if (!c.ok) throw new Error("classify");
  return validateProducts(c.records, ctx);
};
const codes = (r: { issues: readonly { code: string; row: number; column: string }[] }) => r.issues.map((i) => `${i.row}:${i.column}:${i.code}`);

describe("validateProducts", () => {
  it("geçerli satır: varsayılan birim ADET, koli adedi ve barkodlar planlanır", () => {
    const r = products(["A1;Vida;;12;8690000000001;8690000000002", "A2;Somun;adet;;;"]);
    expect(r.issues).toEqual([]);
    expect(r.plans[0]).toMatchObject({ row: 2, code: "A1", baseUnitCode: "ADET", packQty: "12", unitBarcode: "8690000000001", packBarcode: "8690000000002", exists: false });
    expect(r.plans[1]).toMatchObject({ row: 3, code: "A2", packQty: null, unitBarcode: null });
  });
  it("kodsuz, adsız, mükerrer kod ve bilinmeyen birim: satır + sütun ile", () => {
    const r = products([";Vida;;;;", "A1;;;;;", "A2;X;;;;", "A2;Y;;;;", "A3;Z;PALET;;;"]);
    expect(codes(r)).toEqual(["2:kod:CODE_MISSING", "3:ad:NAME_MISSING", "5:kod:CODE_DUPLICATE_FILE", "6:temel birim:UNIT_UNKNOWN"]);
    expect(r.plans).toEqual([]); // hata varsa hiçbir plan yok
  });
  it("K-3: kesirli koli reddedilir; K-1: koli barkodu adedi katsayıdan gelir (adet gerekir)", () => {
    expect(codes(products(["A1;V;;12,5;;"]))).toEqual(["2:koli içi adet:PACK_QTY_FRACTIONAL"]);
    expect(codes(products(["A1;V;;1;;"]))).toEqual(["2:koli içi adet:PACK_QTY_TOO_SMALL"]);
    expect(codes(products(["A1;V;;abc;;"]))).toEqual(["2:koli içi adet:PACK_QTY_INVALID"]);
    expect(codes(products(["A1;V;;2000000;;"]))).toEqual(["2:koli içi adet:PACK_QTY_TOO_LARGE"]);
    expect(codes(products(["A1;V;;;;8690000000002"]))).toEqual(["2:koli içi adet:PACK_BARCODE_NEEDS_QTY"]);
    expect(codes(products(["A1;V;koli;6;;"]))).toEqual(["2:koli içi adet:PACK_BASE_UNIT"]);
  });
  it("koli barkodu: sistemde koli katsayısı varsa dosyada adet olmadan da olur; çelişen katsayı reddedilir", () => {
    const ctx = productCtx({ items: new Map([["A1", item({ code: "A1" })]]), conversions: new Map([["A1", new Map([["u-koli", "12"]])]]) });
    expect(products(["A1;V;;;;8690000000002"], ctx).issues).toEqual([]);
    expect(codes(products(["A1;V;;24;;"], ctx))).toEqual(["2:koli içi adet:PACK_QTY_CONFLICT"]);
    expect(products(["A1;V;;12;;"], ctx).plans[0]).toMatchObject({ exists: true });
  });
  it("barkod: dosya içi mükerrer, aynı satırda aynı, sistemde başka ürün; aynı ürün+birim zaten var kabul edilir", () => {
    expect(codes(products(["A1;V;;;111;", "A2;V;;;111;"]))).toEqual(["3:adet barkodu:BARCODE_DUPLICATE_FILE"]);
    expect(codes(products(["A1;V;;6;111;111"]))).toEqual(["2:koli barkodu:BARCODE_SAME_ROW"]);
    const ctx = productCtx({
      items: new Map([["A1", item({ code: "A1" }), ]]),
      barcodes: new Map([["111", [{ itemCode: "A1", unitId: null }]], ["222", [{ itemCode: "ZZ", unitId: null }]]]),
    });
    expect(products(["A1;V;;;111;"], ctx).issues).toEqual([]);
    expect(codes(products(["A1;V;;;222;"], ctx))).toEqual(["2:adet barkodu:BARCODE_TAKEN"]);
    expect(codes(products(["A9;V;;;111;"], ctx))).toEqual(["2:adet barkodu:BARCODE_TAKEN"]);
  });
  it("geçerli GTIN içeren GS1 dizgisi ve kontrol karakteri barkod olamaz", () => {
    expect(codes(products(["A1;V;;;0112345678901231;"]))).toEqual(["2:adet barkodu:BARCODE_INVALID"]);
    expect(products(["A1;V;;;8690504123456;"]).issues).toEqual([]);
  });
  it("var olan ürün: aynı birim = zaten var; farklı birim ya da arşivli = hata", () => {
    const ctx = productCtx({ items: new Map([["A1", item({ code: "A1" })], ["A2", item({ code: "A2", baseUnitId: "u-koli" })], ["A3", item({ code: "A3", status: "ARCHIVED" })]]) });
    expect(products(["A1;V;;;;"], ctx).plans[0]?.exists).toBe(true);
    expect(codes(products(["A2;V;;;;", "A3;V;;;;"], ctx))).toEqual(["2:temel birim:ITEM_UNIT_MISMATCH", "3:kod:ITEM_ARCHIVED"]);
  });
  it("eksik zorunlu sütun, fazla hücre, boş dosya, satır sınırı", () => {
    const miss = classify("kod;birim\nA;ADET");
    expect(miss.ok && validateProducts(miss.records, productCtx()).issues.map((i) => i.code)).toEqual(["COLUMN_MISSING"]);
    expect(codes(products(["A1;V;;;;;fazla"]))).toEqual(["2:dosya:ROW_TOO_MANY_CELLS"]);
    expect(codes(products([]))).toEqual(["0:dosya:NO_ROWS"]);
    const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `K${i};V;;;;`);
    expect(products(many).issues.map((i) => i.code)).toEqual(["TOO_MANY_ROWS"]);
  });
  it("başlık takma adları ve sütun sırası", () => {
    const c = classify("Ürün Adı;Ürün Kodu\nVida;A1");
    expect(c.ok && validateProducts(c.records, productCtx()).plans[0]).toMatchObject({ code: "A1", name: "Vida" });
  });
});

// --- açılış stoku -----------------------------------------------------------------------------------------------------

const shelf = (over: Partial<ShelfInfo> & { code: string }): ShelfInfo => ({ id: `l-${over.code}-${over.warehouseId ?? "w1"}`, warehouseId: "w1", warehouseCode: "D1", kind: "STORAGE", status: "ACTIVE", ...over });
function stockCtx(): StockContext {
  const shelves = new Map<string, ShelfInfo[]>();
  for (const s of [shelf({ code: "A-01" }), shelf({ code: "ESKI", status: "ARCHIVED" }), shelf({ code: "TR", kind: "TRANSIT" }), shelf({ code: "X1" }), shelf({ code: "X1", warehouseId: "w2", warehouseCode: "D2" })]) {
    shelves.set(shelfKey(s.code), [...(shelves.get(shelfKey(s.code)) ?? []), s]);
  }
  return { items: new Map([["A1", item({ code: "A1" })], ["A2", item({ code: "A2", quantityScale: 2 })], ["LOT", item({ code: "LOT", trackingMode: "LOT" })], ["OLD", item({ code: "OLD", status: "ARCHIVED" })]]), shelves };
}
const stock = (rows: string[]) => {
  const c = classify(["ürün kodu;raf kodu;miktar (adet)", ...rows].join("\n"));
  if (!c.ok) throw new Error("classify");
  return validateStock(c.records, stockCtx());
};

describe("validateStock", () => {
  it("geçerli satırlar kanonik miktarla planlanır (raf kodu büyük/küçük harf duyarsız)", () => {
    const r = stock(["A1;a-01;1.250,0", "A2;A-01;3,5"]);
    expect(r.issues).toEqual([]);
    expect(r.plans.map((p) => [p.itemCode, p.quantity, p.locationId])).toEqual([["A1", "1250", "l-A-01-w1"], ["A2", "3.5", "l-A-01-w1"]]);
  });
  it("bilinmeyen ürün/raf, arşivli, taşıma rafı, çok depoda aynı raf, izlenen ürün", () => {
    const r = stock(["ZZ;A-01;1", "A1;YOK;1", "A1;ESKI;1", "A1;TR;1", "A1;X1;1", "LOT;A-01;1", "OLD;A-01;1"]);
    expect(codes(r)).toEqual([
      "2:ürün kodu:ITEM_UNKNOWN",
      "3:raf kodu:SHELF_UNKNOWN",
      "4:raf kodu:SHELF_ARCHIVED",
      "5:raf kodu:SHELF_KIND",
      "6:raf kodu:SHELF_AMBIGUOUS",
      "7:ürün kodu:ITEM_TRACKED",
      "8:ürün kodu:ITEM_ARCHIVED",
    ]);
  });
  it("A-33: kesirli ADET reddedilir (ölçek 0); ölçek 2 ürün 2 ondalığa izin verir", () => {
    const r = stock(["A1;A-01;2,5", "A2;A-01;2,555", "A2;A-01;2,5"]);
    expect(codes(r)).toEqual(["2:miktar:QTY_FRACTIONAL", "3:miktar:QTY_FRACTIONAL"]);
  });
  it("miktar: boş, sıfır, negatif, belirsiz binlik, geçersiz; aynı (ürün,raf) iki kez", () => {
    const r = stock(["A1;A-01;", "A1;A-01;0", "A1;A-01;-2", "A1;A-01;1.250", "A1;A-01;iki", "A1;A-01;5", "A1;A-01;6"]);
    expect(codes(r)).toEqual(["2:miktar:QTY_MISSING", "3:miktar:QTY_ZERO", "4:miktar:QTY_NEGATIVE", "5:miktar:QTY_AMBIGUOUS", "6:miktar:QTY_INVALID", "8:raf kodu:PAIR_DUPLICATE_FILE"]);
  });
  it("eksik sütun ve boş dosya", () => {
    const c = classify("ürün kodu;raf kodu\nA1;A-01");
    expect(c.ok && validateStock(c.records, stockCtx()).issues.map((i) => `${i.column}:${i.code}`)).toEqual(["miktar:COLUMN_MISSING"]);
    expect(codes(stock([]))).toEqual(["0:dosya:NO_ROWS"]);
  });
});

describe("classify sınırları", () => {
  it("boyut sınırı ve bilinmeyen biçim", () => {
    const big = classify("a".repeat(IMPORT_MAX_BYTES + 1));
    expect(!big.ok && big.issues[0]?.code).toBe("FILE_TOO_LARGE");
    const enc = classify("kod;ad\nA;Ur\uFFFDn");
    expect(!enc.ok && enc.issues[0]?.code).toBe("FILE_ENCODING");
    const unk = classify("foo;bar\n1;2");
    expect(!unk.ok && unk.issues[0]?.code).toBe("FORMAT_UNKNOWN");
  });
});

describe("hücre/sütun sınırları ve doğrusal çalışma (ReDoS, B-1)", () => {
  /** Süre VE sonuç assert edilir. Girdiler `IMPORT_MAX_BYTES` (384 KiB) ALTINDADIR: aksi halde dosya ayrıştırılmadan FILE_TOO_LARGE ile reddedilir ve test boş kalırdı. */
  const timed = <T,>(fn: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = fn();
    return { out, ms: performance.now() - t0 };
  };
  const SIZE = IMPORT_MAX_BYTES - 16;
  const cases: Array<[string, () => string, string]> = [
    ["kapanmayan parantez başlığı", () => `${"(".repeat(SIZE - 10)}\nA;B`, "CELL_TOO_LONG"],
    ["kapanmayan parantez + kapanışlar", () => `kod;${"( ".repeat(SIZE / 4)}\nA;B`, "CELL_TOO_LONG"],
    ["tırnaklı çöp (çift tırnak kaçışları)", () => `kod;ad\n"${'""'.repeat(SIZE / 4)}";x`, "CELL_TOO_LONG"],
    ["tırnak karışık uzun alan", () => `kod;ad\n${'a"'.repeat(SIZE / 4)};x`, "CELL_TOO_LONG"],
    ["tek satırda yüz binlerce sütun", () => `kod${";x".repeat(SIZE / 2 - 4)}`, "TOO_MANY_COLUMNS"],
    ["yüz binlerce boş satır", () => `kod;ad${"\n".repeat(SIZE - 10)}`, "OK"],
    ["boşluk dolu alan + tırnak", () => `kod;ad\n${" ".repeat(SIZE / 2)}"${"x".repeat(10)}`, "CSV_UNTERMINATED_QUOTE"],
  ];
  for (const [name, make, expected] of cases) {
    it(`${name}: 200 ms altında biter, sonuç ${expected}`, () => {
      const text = make();
      expect(Buffer.byteLength(text)).toBeLessThan(IMPORT_MAX_BYTES);
      const { out, ms } = timed(() => classify(text));
      expect(out.ok ? "OK" : out.issues[0]?.code, name).toBe(expected);
      expect(ms, `${name} ${ms.toFixed(0)} ms`).toBeLessThan(200);
    });
  }
  it("foldHeader: kapanmayan parantez dizisi doğrusal", () => {
    const { out, ms } = timed(() => foldHeader(`${"(".repeat(HEADER_CELL_MAX * 2000)}ad`));
    expect(ms).toBeLessThan(200);
    expect(out).toBe("ad");
    expect(foldHeader("Miktar (adet) toplam")).toBe("miktar toplam");
    expect(foldHeader("Miktar ((a)")).toBe("miktar"); // iç içe: ilk "(" en yakın ")" e kadar atılır; kapanmayan "(" metni yutmaz
    expect(foldHeader("Miktar (a")).toBe("miktar a");
  });
  it("başlık hücresi > 200, veri hücresi > 1000, sütun > 40: satır hatası (dosya reddedilir)", () => {
    const h = classify(`${"k".repeat(HEADER_CELL_MAX + 1)};ad\nA;B`);
    expect(!h.ok && h.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["1:CELL_TOO_LONG"]);
    const d = classify(`kod;ad\nA;B\nC;${"x".repeat(DATA_CELL_MAX + 1)}`);
    expect(!d.ok && d.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["3:CELL_TOO_LONG"]);
    const edge = classify(`kod;ad\nA;${"x".repeat(DATA_CELL_MAX)}`);
    expect(edge.ok).toBe(true);
    const c = classify(`kod;ad${";x".repeat(MAX_COLUMNS)}\nA;B`);
    expect(!c.ok && c.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["1:TOO_MANY_COLUMNS"]);
  });
  it("bayt sınırı gerçek bayttır (çok baytlı karakterler)", () => {
    const big = classify(`kod;ad\nA;${"ş".repeat(IMPORT_MAX_BYTES / 2)}`); // karakter sayısı sınırın yarısı, bayt sayısı sınırı aşar
    expect(!big.ok && big.issues[0]?.code).toBe("FILE_TOO_LARGE");
  });
});

describe("açılış stoku: stoğu olan (ürün, raf) çifti", () => {
  const ctx = (pairs: StockContext["pairs"]): StockContext => ({ ...stockCtx(), pairs });
  const run = (rows: string[], pairs: StockContext["pairs"]) => {
    const c = classify(["ürün kodu;raf kodu;miktar", ...rows].join("\n"));
    if (!c.ok) throw new Error("classify");
    return validateStock(c.records, ctx(pairs));
  };
  it("stok varsa hata; aynı miktar önceki içe aktarmadan geliyorsa 'zaten uygulanmış' (hata değil)", () => {
    const pairs = new Map([
      ["i-A1|l-A-01-w1", { hasStock: true, applied: new Set(["10"]), pending: new Set<string>() }],
      ["i-A2|l-A-01-w1", { hasStock: true, applied: new Set<string>(), pending: new Set<string>() }],
    ]);
    const r = run(["A1;A-01;10", "A1;A-01;12", "A2;A-01;3"], pairs);
    expect(r.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["3:PAIR_DUPLICATE_FILE", "4:PAIR_HAS_STOCK"]);
  });
  it("aynı çift iki satırda (A1,A-01 → 10 ve 12) dosya içi mükerrer ayrı yakalanır", () => {
    const r = run(["A1;A-01;10", "A1;A-01;12"], new Map());
    expect(r.issues.map((i) => i.code)).toEqual(["PAIR_DUPLICATE_FILE"]);
  });
  it("bitmemiş (pending) belge: aynı miktar sürdürülür, farklı miktar PAIR_PENDING", () => {
    const pairs = new Map([["i-A1|l-A-01-w1", { hasStock: false, applied: new Set<string>(), pending: new Set(["10"]) }]]);
    expect(run(["A1;A-01;10"], pairs).issues).toEqual([]);
    expect(run(["A1;A-01;12"], pairs).issues.map((i) => i.code)).toEqual(["PAIR_PENDING"]);
  });
  it("uygulanmış satır planda alreadyApplied işaretli; satır sırası sonucu değiştirmez", () => {
    const pairs = new Map([["i-A1|l-A-01-w1", { hasStock: true, applied: new Set(["10"]), pending: new Set<string>() }]]);
    const a = run(["A1;A-01;10", "A2;A-01;4"], pairs);
    const b = run(["A2;A-01;4", "A1;A-01;10"], pairs);
    expect(a.issues).toEqual([]);
    expect(b.issues).toEqual([]);
    expect(a.plans.filter((p) => p.alreadyApplied).map((p) => p.itemCode)).toEqual(["A1"]);
    expect(b.plans.filter((p) => p.alreadyApplied).map((p) => p.itemCode)).toEqual(["A1"]);
  });
});

describe("doğrulayıcılar 384 KiB altında en kötü girdide doğrusal (m-3)", () => {
  const timed = <T,>(fn: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = fn();
    return { out, ms: performance.now() - t0 };
  };
  const LONG_DECIMALS = `0,${"0".repeat(DATA_CELL_MAX - 3)}1`; // 1000 karakter: 0,000…001
  const ZEROS = "0".repeat(DATA_CELL_MAX);
  const DOTTED = `1${".000".repeat(Math.floor((DATA_CELL_MAX - 1) / 4))}`;
  it("parseTrDecimal: uzun sıfır/ondalık/noktalı girdiler hemen reddedilir", () => {
    for (const v of [LONG_DECIMALS, ZEROS, DOTTED, `${"1".repeat(500)},${"0".repeat(499)}`, `${" ".repeat(900)}1`]) {
      const { out, ms } = timed(() => {
        for (let i = 0; i < 1000; i++) parseTrDecimal(v);
        return parseTrDecimal(v);
      });
      expect(out.ok, `${v.slice(0, 12)}…`).toBe(false);
      expect(ms, `${v.slice(0, 12)}… 1000 çağrı ${ms.toFixed(1)} ms`).toBeLessThan(200);
    }
    expect(parseTrDecimal("0,500000")).toMatchObject({ ok: true, text: "0.5" });
    expect(parseTrDecimal("000012,5000")).toMatchObject({ ok: true, text: "12.5" });
    expect(parseTrDecimal("0000")).toMatchObject({ ok: true, text: "0" });
  });
  it("validateStock: her hücresi ~1000 karakterlik 300 satır (< 384 KiB) 200 ms altında, sonuç doğru", () => {
    const text = ["ürün kodu;raf kodu;miktar", ...Array.from({ length: 300 }, () => `A1;A-01;${LONG_DECIMALS}`)].join("\n");
    expect(Buffer.byteLength(text)).toBeLessThan(IMPORT_MAX_BYTES);
    const { out, ms } = timed(() => {
      const c = classify(text);
      if (!c.ok) throw new Error(c.issues[0]?.code);
      return validateStock(c.records, stockCtx());
    });
    expect(out.issues).toHaveLength(300);
    expect(new Set(out.issues.map((i) => i.code))).toEqual(new Set(["QTY_TOO_LARGE"]));
    expect(ms, `${ms.toFixed(1)} ms`).toBeLessThan(200);
  });
  it("validateProducts: 1000 karakterlik koli adedi ve barkod hücreleri (180 satır) 200 ms altında, sonuç doğru", () => {
    const text = [PH, ...Array.from({ length: 180 }, (_, i) => `K${i};Ad;ADET;${LONG_DECIMALS};${"9".repeat(DATA_CELL_MAX)};`)].join("\n");
    expect(Buffer.byteLength(text)).toBeLessThan(IMPORT_MAX_BYTES);
    const { out, ms } = timed(() => {
      const c = classify(text);
      if (!c.ok) throw new Error(c.issues[0]?.code);
      return validateProducts(c.records, productCtx());
    });
    const codes = new Set(out.issues.map((i) => i.code));
    expect(codes).toEqual(new Set(["PACK_QTY_INVALID", "BARCODE_INVALID"]));
    expect(out.issues).toHaveLength(360);
    expect(ms, `${ms.toFixed(1)} ms`).toBeLessThan(200);
  });
});
