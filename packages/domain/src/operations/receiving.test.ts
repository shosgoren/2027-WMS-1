// T-305 birim testleri (DB'siz): girdi doğrulama (satır, fazla/hasarlı miktar, boyut sınırı), ondalık yardımcıları, numara öneki.
// Stok etkisi ve kilit davranışı tests/integration/operations/receiving.int.test.ts'tedir.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { NUMBER_PREFIX, formatDocumentNumber, type StockDocCallParams } from "../stock/index.ts";
import { baseQuantityOf, decimalToMicro, microToDecimal } from "./field-posting.ts";
import { approveQuality, cancelInboundReceipt, createInboundReceipt, openInboundReceipt, receiveGoods } from "./receiving.ts";
import { putaway } from "./putaway.ts";

const params = (): StockDocCallParams => ({ db: undefined as never, principal: null, tenantSlug: "t", clientKey: randomUUID() });
const id = (): string => randomUUID();

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const detail = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);

describe("receiveGoods girdi doğrulama (DB'ye gitmeden)", () => {
  const line = (over: Record<string, unknown> = {}) => ({ lineId: id(), received: "5", damaged: "0", locationId: id(), ...over });

  it("hasarlı > kabul → VALIDATION_FAILED", async () => {
    expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines: [line({ received: "5", damaged: "6" })] })))).toBe("VALIDATION_FAILED");
  });
  it("kabul 0, negatif, ondalık biçim hatası, 7 basamak → VALIDATION_FAILED", async () => {
    for (const received of ["0", "-1", "1e3", "1.1234567", "abc", ""]) {
      expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines: [line({ received })] }))), received).toBe("VALIDATION_FAILED");
    }
  });
  it("aynı satır iki kez, boş satır listesi, geçersiz kimlik → VALIDATION_FAILED", async () => {
    const dup = id();
    expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines: [line({ lineId: dup }), line({ lineId: dup })] })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines: [] })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(receiveGoods(params(), { receiptId: "x", lines: [line()] })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines: [line({ locationId: "x" })] })))).toBe("VALIDATION_FAILED");
  });
  it("> 200 satır → DOCUMENT_TOO_LARGE (A-142; sahte başarı yok)", async () => {
    const lines = Array.from({ length: 201 }, () => line());
    expect(detail(await rejection(receiveGoods(params(), { receiptId: id(), lines })))).toBe("VALIDATION_FAILED/DOCUMENT_TOO_LARGE");
  });
});

describe("diğer komutların girdi doğrulaması", () => {
  it("createInboundReceipt: beklenen 0 / eksik / >200 satır", async () => {
    const l = (expectedQuantity: string) => ({ itemId: id(), unitId: id(), expectedQuantity });
    expect(detail(await rejection(createInboundReceipt(params(), { warehouseId: id(), lines: [l("0")] })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(createInboundReceipt(params(), { warehouseId: id(), lines: [] })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(createInboundReceipt(params(), { warehouseId: id(), lines: Array.from({ length: 201 }, () => l("1")) })))).toBe(
      "VALIDATION_FAILED/DOCUMENT_TOO_LARGE",
    );
    expect(detail(await rejection(createInboundReceipt(params(), { warehouseId: id(), supplierRef: "x".repeat(101), lines: [l("1")] })))).toBe("VALIDATION_FAILED");
  });
  it("open/cancel: sürüm biçimi", async () => {
    expect(detail(await rejection(openInboundReceipt(params(), { receiptId: id(), expectedVersion: 0 })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(cancelInboundReceipt(params(), { receiptId: id(), expectedVersion: 1.5 })))).toBe("VALIDATION_FAILED");
  });
  it("approveQuality: receiptId ve dimensions birlikte ya da ikisi de yok → VALIDATION_FAILED", async () => {
    const d = [{ itemId: id(), locationId: id(), quantity: "1" }];
    expect(detail(await rejection(approveQuality(params(), { receiptId: id(), dimensions: d } as never)))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(approveQuality(params(), {} as never)))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(approveQuality(params(), { dimensions: [...d, ...d] })))).toBe("VALIDATION_FAILED");
  });
  it("putaway: kaynak = hedef (boş hareket), miktar 0 → VALIDATION_FAILED", async () => {
    const loc = id();
    expect(detail(await rejection(putaway(params(), { sourceLocationId: loc, targetLocationId: loc, itemId: id(), quantity: "1" })))).toBe("VALIDATION_FAILED");
    expect(detail(await rejection(putaway(params(), { sourceLocationId: id(), targetLocationId: id(), itemId: id(), quantity: "0" })))).toBe("VALIDATION_FAILED");
  });
  it("istemci anahtarı zorunlu (IDEMPOTENCY_KEY_REQUIRED) — fazla kabul denemesi anahtarsız yazılamaz", async () => {
    const e = await rejection(receiveGoods({ ...params(), clientKey: null }, { receiptId: id(), lines: [{ lineId: id(), received: "1", locationId: id() }] }));
    expect(detail(e)).toBe("VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("ondalık yardımcıları (I-09: float yok)", () => {
  it("decimalToMicro / microToDecimal gidiş-dönüş", () => {
    expect(decimalToMicro("18")).toBe(18_000_000n);
    expect(decimalToMicro("0.000001")).toBe(1n);
    expect(microToDecimal(9_500_000n)).toBe("9.500000");
    expect(() => decimalToMicro("1.0000001")).toThrow(AppError);
    expect(() => microToDecimal(-1n)).toThrow(AppError);
  });
  it("baseQuantityOf: katsayı satıra kopyalanır; 6 basamağa yarım yukarı yuvarlanır", () => {
    expect(baseQuantityOf("10", "1")).toBe("10.000000");
    expect(baseQuantityOf("3", "12")).toBe("36.000000");
    expect(baseQuantityOf("0.333333", "3")).toBe("0.999999");
    expect(baseQuantityOf("0.000001", "0.5")).toBe("0.000001"); // 0.0000005 → yukarı
    expect(baseQuantityOf("0.000001", "0.4")).toBe("0.000000");
  });
});

describe("numara öneki (A-305-1)", () => {
  it("INBOUND_RECEIPT → KBL-<yıl>-<6 hane>; mevcut önekler değişmedi", () => {
    expect(formatDocumentNumber("INBOUND_RECEIPT", "2026", 7)).toBe("KBL-2026-000007");
    expect(NUMBER_PREFIX).toMatchObject({ STOCK_IN: "GRS", STOCK_OUT: "CKS", STOCK_MOVE: "TSM", REVERSAL: "TRS", INBOUND_RECEIPT: "KBL" });
  });
});

describe("apps/web posting çekirdeğini import edemez (eslint no-restricted-imports; T-305 MAJOR)", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const lint = async (code: string, rel: string): Promise<string[]> => {
    const eslint = new ESLint({ cwd: ROOT });
    const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, rel), warnIgnored: true });
    return (r?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
  };
  it.each([
    'import { postApprovedDocumentInTx } from "@wms/domain/stock";\nexport const x = postApprovedDocumentInTx;\n',
    'import { registerTxCreatedDocument } from "@wms/domain/stock";\nexport const x = registerTxCreatedDocument;\n',
    'import * as stock from "@wms/domain/stock";\nexport const x = stock;\n',
  ])("apps/web içinde ihlal: %s", async (code) => {
    const msgs = await lint(code, "apps/web/lib/__core_probe__.ts");
    expect(msgs.some((m) => m.includes("posting çekirdeğini"))).toBe(true);
  }, 60_000);
  it("komut yüzeyi ve diğer stok adları serbest (kapsam dar)", async () => {
    expect(await lint('import { postDocument, receiveGoods } from "@wms/domain/stock";\nexport const x = [postDocument, receiveGoods];\n', "apps/web/lib/__ok_probe__.ts")).toEqual([]);
  }, 60_000);
});
