import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { LabelCharsetError, encodeCode128 } from "./code128.ts";
import {
  DOT_MM,
  LABEL_TEMPLATE_VERSION,
  LabelTooLongError,
  MAX_LABELS_PER_DOCUMENT,
  escapeXml,
  toSvg,
  toSvgPages,
  toZpl,
  toZplDocument,
  wrapName,
  zplBarcodeData,
  zplText,
} from "./templates.ts";

const PRODUCT = { code: "SKU-001", name: "Cay Bardagi 250 ml", unit: "ADET", barcode: "8690000000019" };

// Sabit şablonla birebir metin (ADR-022 doğrulama): değişiklik bilinçli sürüm kararı ister (`product@2`).
const PRODUCT_ZPL = [
  "^XA",
  "^FX product@1",
  "^PW799",
  "^LL400",
  "^LH0,0",
  "^FO24,20^A0N,44,44^FH_^FDSKU-001^FS",
  "^FO24,76^A0N,32,32^FH_^FDCay Bardagi 250 ml^FS",
  "^FO24,158^A0N,28,28^FH_^FDADET^FS",
  "^FO215,318^FB369,1,0,C^A0N,30,30^FH_^FD8690000000019^FS",
  "^FO215,200^BY3,3,100^BCN,100,N,N,N^FH_^FD>:8>5690000000019^FS",
  "^XZ",
  "",
].join("\n");

const LOCATION_ZPL = [
  "^XA",
  "^FX location@1",
  "^PW799",
  "^LL400",
  "^LH0,0",
  "^FO24,30^A0N,110,110^FH_^FDA-01-02^FS",
  "^FO231,340^FB336,1,0,C^A0N,30,30^FH_^FDA-01-02^FS",
  "^FO231,220^BY3,3,110^BCN,110,N,N,N^FH_^FD>:A-01-02^FS",
  "^XZ",
  "",
].join("\n");

const ZPL_COMMANDS = new Set(["XA", "XZ", "FX", "CI", "PW", "LL", "LH", "FO", "FB", "A0", "FH", "FD", "FS", "BY", "BC"]);

/** ZPL'i komutlara böler: her `^` bir komut başlatır; komut adı izin listesinde olmalı. */
function commandsOf(zpl: string): string[] {
  return zpl
    .split("^")
    .slice(1)
    .map((tok) => tok.slice(0, 2));
}

describe("şablon sürümü", () => {
  it("sürüm sabitleri", () => {
    expect(LABEL_TEMPLATE_VERSION).toEqual({ product: "product@1", location: "location@1" });
  });
});

describe("toZpl", () => {
  it("ürün etiketi sabit şablonla birebir", () => {
    expect(toZpl("product", PRODUCT)).toBe(PRODUCT_ZPL);
  });
  it("lokasyon etiketi: ad yoksa ad satırı yok, birebir", () => {
    expect(toZpl("location", { code: "A-01-02" })).toBe(LOCATION_ZPL);
  });
  it("barkod yoksa ürün kodu Code 128 olur", () => {
    const z = toZpl("product", { code: "SKU-001", name: "x", unit: "ADET" });
    expect(z).toContain("^BCN,100,N,N,N^FH_^FD>:SKU-001^FS");
    expect(toZpl("product", { code: "SKU-001", name: "x", unit: "ADET", barcode: "" })).toContain("^FD>:SKU-001^FS");
  });
  it("yapı: ^XA ile başlar, ^XZ ile biter, ^PW/^LL 203 dpi 100x50 mm, yalnızca izinli komutlar", () => {
    const z = toZpl("product", PRODUCT);
    expect(z.startsWith("^XA\n")).toBe(true);
    expect(z.endsWith("^XZ\n")).toBe(true);
    expect(z).toContain("^PW799");
    expect(z).toContain("^LL400");
    expect(Math.round(100 / DOT_MM)).toBe(799);
    expect(commandsOf(z).every((c) => ZPL_COMMANDS.has(c))).toBe(true);
    expect(z.match(/\^BC/g)?.length).toBe(1);
    expect(z.match(/\^FD/g)?.length).toBe(z.match(/\^FS/g)?.length);
  });
  it("^CI28 yalnızca ASCII dışı karakter varsa ve ^PW'dan önce", () => {
    expect(toZpl("product", PRODUCT)).not.toContain("^CI28");
    const z = toZpl("product", { ...PRODUCT, name: "Şeker Çuvalı İğne" });
    expect(z).toContain("^CI28");
    expect(z.indexOf("^CI28")).toBeLessThan(z.indexOf("^PW"));
    expect(z).toContain("^FDŞeker Çuvalı İğne^FS");
    // Barkod içeriği ASCII kalır; Türkçe barkod reddedilir.
    expect(() => toZpl("product", { ...PRODUCT, barcode: "ŞEKER" })).toThrow(LabelCharsetError);
    expect(() => toZpl("location", { code: "ÇAY-1" })).toThrow(LabelCharsetError);
  });
  it("komut enjeksiyonu: ürün adı ve kodundaki ^ ve ~ onaltılık kaçışa çevrilir, ek komut oluşmaz", () => {
    const evil = "A^XZ^XA^FO0,0^FDpwn~DGR,1,1,1~JA";
    const z = toZpl("product", { code: "SKU^FS^XZ", name: evil, unit: "~HS^PR", barcode: "BC~1^2" });
    expect(z).not.toContain("~"); // ~ komut öneki hiçbir yerde ham yazılmaz
    expect(commandsOf(z).every((c) => ZPL_COMMANDS.has(c))).toBe(true);
    expect(z.match(/\^XA/g)?.length).toBe(1);
    expect(z.match(/\^XZ/g)?.length).toBe(1);
    expect(z.match(/\^FS/g)?.length).toBe(5); // kod, ad, birim, okunur metin, barkod
    expect(z).toContain("A_5EXZ_5EXA_5EFO0,0_5EFDpwn_7EDGR,1,1,1_7EJA");
    expect(z).toContain("SKU_5EFS_5EXZ");
    expect(z).toContain("_7EHS_5EPR");
    // Barkod verisi de kaçışlı: ^ ve ~ ham yok.
    expect(z).toContain("^FD>:BC_7E1_5E2^FS");
  });
  it("kaçış karakteri '_' kendisi kaçışlanır; denetim karakterleri (CR/LF) alanı bölemez", () => {
    expect(zplText("a_b")).toBe("a_5Fb");
    const z = toZpl("product", { ...PRODUCT, name: "satir1\r\n^XZ\nsatir2" });
    expect(z.split("\n").length).toBe(PRODUCT_ZPL.split("\n").length + 0);
    expect(commandsOf(z).every((c) => ZPL_COMMANDS.has(c))).toBe(true);
    expect(z).toContain("satir1 _5EXZ satir2");
  });
  it("barkod verisi SVG ile aynı sembol dizisini üretir (kod seti çağrıları)", () => {
    expect(zplBarcodeData(encodeCode128("1234"))).toBe(">;1234");
    expect(zplBarcodeData(encodeCode128("AB1234"))).toBe(">:AB>51234");
    expect(zplBarcodeData(encodeCode128("123456AB"))).toBe(">;123456>6AB");
    expect(zplBarcodeData(encodeCode128("A>B"))).toBe(">:A>0B");
    expect(zplBarcodeData(encodeCode128("A^B"))).toBe(">:A_5EB");
  });
  it("çok uzun barkod: LabelTooLongError (VALIDATION_FAILED)", () => {
    const e = (() => {
      try {
        toZpl("product", { ...PRODUCT, barcode: "A".repeat(80) });
      } catch (x) {
        return x;
      }
      return undefined;
    })();
    expect(e).toBeInstanceOf(LabelTooLongError);
    expect((e as AppError).code).toBe("VALIDATION_FAILED");
  });
});

/** SVG'den çubuk dikdörtgenlerini (x, genişlik; mm) çıkarır. */
function bars(svg: string): { x: number; w: number }[] {
  const g = /<g class="bars"[^>]*>(.*?)<\/g>/.exec(svg)?.[1] ?? "";
  return [...g.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
}

describe("toSvg", () => {
  it("etiket boyutu 100x50 mm ve şablon sürümü", () => {
    const s = toSvg("product", PRODUCT);
    expect(s).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
    expect(s).toContain('data-label-template="product@1"');
    expect(toSvg("location", { code: "A1" })).toContain('data-label-template="location@1"');
  });
  it("modül genişliği 203 dpi nokta katı: her çubuk ve konum tam sayıda nokta", () => {
    for (const [tpl, data] of [
      ["product", PRODUCT],
      ["product", { code: "X", name: "n", unit: "u", barcode: "ABC-123456789" }],
      ["location", { code: "A-01-02" }],
    ] as const) {
      const b = bars(toSvg(tpl, data));
      expect(b.length).toBeGreaterThan(10);
      for (const r of b) {
        const dots = r.w / DOT_MM;
        expect(Math.abs(dots - Math.round(dots))).toBeLessThan(0.002);
        expect(Math.round(dots)).toBeGreaterThanOrEqual(1);
        const xd = r.x / DOT_MM;
        expect(Math.abs(xd - Math.round(xd))).toBeLessThan(0.002);
      }
    }
  });
  it("çubuk deseni kodlayıcı çıktısıyla aynı (ilk çubuk başlangıç B: 2 modül) ve toplam genişlik", () => {
    const r = encodeCode128("A-01-02");
    const b = bars(toSvg("location", { code: "A-01-02" }));
    const module = 3;
    // Çubuk sayısı: her sembolün 3 çubuğu (bitiş 4).
    expect(b.length).toBe((r.values.length - 1) * 3 + 4);
    expect(Math.round(b[0]!.w / DOT_MM)).toBe(2 * module);
    const last = b[b.length - 1]!;
    const total = Math.round((last.x + last.w - b[0]!.x) / DOT_MM);
    expect(total).toBe(r.modules * module);
  });
  it("XSS: ürün adı, kodu, birimi ve barkod metnindeki < & \" ' > kaçışlanır; ham etiket/öznitelik oluşmaz", () => {
    const name = `<script>alert(1)</script> & "x" 'y' </text><image href=x onerror=alert(2)>`;
    const s = toSvg("product", { code: `<b>"&'`, name, unit: `"><svg onload=1>`, barcode: "ABC" });
    expect(s).not.toContain("<script");
    expect(s).not.toContain("<image");
    expect(s).not.toContain("<b>");
    expect(s).not.toContain("<svg onload");
    expect(s).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(s).toContain("&amp;");
    expect(s).toContain("&quot;");
    expect(s).toContain("&#39;");
    // Yalnızca kendi ürettiğimiz öğeler: svg, rect, text, g.
    const tags = [...s.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["svg", "rect", "text", "g"]));
    // Kaçışlanmamış ham tırnak yalnızca öznitelik sınırlarında: metin düğümlerinde < yok.
    for (const t of s.matchAll(/<text[^>]*>(.*?)<\/text>/g)) expect(t[1]).not.toMatch(/[<>"']/);
  });
  it("lokasyon adı da kaçışlanır; barkod metni ASCII dışıysa reddedilir", () => {
    const s = toSvg("location", { code: "A1", name: `<img src=x onerror=1>` });
    expect(s).not.toContain("<img");
    expect(s).toContain("&lt;img src=x onerror=1&gt;");
    expect(() => toSvg("location", { code: "Ş1" })).toThrow(LabelCharsetError);
  });
  it("escapeXml: beş karakter ve denetim karakterleri", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeXml("a\u0000b\u0008c")).toBe("a b c");
    expect(escapeXml("&amp;")).toBe("&amp;amp;"); // çift kaçış: girdi her zaman düz metin sayılır
  });
});

describe("wrapName", () => {
  it("kısa ad tek satır; uzun ad 2 satıra bölünür ve fazlası … ile kesilir", () => {
    expect(wrapName("Cay Bardagi")).toEqual(["Cay Bardagi"]);
    const two = wrapName("alfa ".repeat(10).trim());
    expect(two.length).toBe(2);
    const cut = wrapName("kelime ".repeat(30));
    expect(cut.length).toBe(2);
    expect(cut[1]!.endsWith("…")).toBe(true);
    for (const l of cut) expect(Array.from(l).length).toBeLessThanOrEqual(32);
  });
  it("boşluksuz uzun kelime sert bölünür; boş ad boş dizi", () => {
    expect(wrapName("x".repeat(40)).map((l) => l.length)).toEqual([32, 8]);
    expect(wrapName("   ")).toEqual([]);
  });
});

describe("toplu belge", () => {
  const locations = Array.from({ length: 120 }, (_, i) => ({ code: `A-${String(i + 1).padStart(3, "0")}`, name: `Raf ${i + 1}` }));
  it("120 lokasyon: tek belge, 120 sayfa (SVG) ve 120 ^XA…^XZ bloğu (ZPL)", () => {
    const pages = toSvgPages("location", locations);
    expect(pages.length).toBe(120);
    expect(pages[0]).toContain("A-001");
    expect(pages[119]).toContain("A-120");
    const zpl = toZplDocument("location", locations);
    expect(zpl.match(/\^XA/g)?.length).toBe(120);
    expect(zpl.match(/\^XZ/g)?.length).toBe(120);
    expect(commandsOf(zpl).every((c) => ZPL_COMMANDS.has(c))).toBe(true);
  });
  it("adet çarpılır; sınır ve geçersiz adet VALIDATION_FAILED", () => {
    expect(toSvgPages("location", locations.slice(0, 3), 4).length).toBe(12);
    expect(() => toSvgPages("location", locations, 0)).toThrow(AppError);
    expect(() => toSvgPages("location", locations, 1.5)).toThrow(AppError);
    expect(() => toSvgPages("location", [], 1)).toThrow(AppError);
    expect(() => toZplDocument("location", locations.slice(0, 1), MAX_LABELS_PER_DOCUMENT + 1)).toThrow(AppError);
    expect(toSvgPages("location", locations.slice(0, 1), MAX_LABELS_PER_DOCUMENT).length).toBe(MAX_LABELS_PER_DOCUMENT);
  });
});
