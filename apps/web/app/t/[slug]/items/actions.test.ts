// T-216: ürün kartı Server Action'ları — doğrulama hataları, decimal dizgisinin bozulmadan iletilmesi (I-09), hata sözleşmesi ve
// hata kodu → mesaj anahtarı eşlemesi. Domain komutları sahtedir (iş kuralı T-208/T-240'ta test edilir); yetki/Origin davranışı
// `tests/integration/catalog/item-actions.int.test.ts` içinde gerçek wms_app + RLS ile kanıtlanır.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const createItem = vi.hoisted(() => vi.fn());
const updateItem = vi.hoisted(() => vi.fn());
const archiveItem = vi.hoisted(() => vi.fn());
const setUnitConversion = vi.hoisted(() => vi.fn());
const addBarcode = vi.hoisted(() => vi.fn());
const removeBarcode = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/catalog", () => ({ createItem, updateItem, archiveItem, setUnitConversion, addBarcode, removeBarcode }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: () => Promise.resolve("t1") }));

import { addBarcodeAction, archiveItemAction, createItemAction, removeBarcodeAction, setConversionAction, updateItemAction } from "./actions.ts";
import { errorKey } from "./items-view.tsx";

const IID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
const BID = "33333333-3333-4333-8333-333333333333";
const domainMocks = [createItem, updateItem, archiveItem, setUnitConversion, addBarcode, removeBarcode];
let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://app.example.test";
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["ürün: boş kod", () => createItemAction({ slug: "acme", code: "", name: "n", baseUnitId: UID })],
    ["ürün: temel birim uuid değil", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: "x" })],
    ["ürün: ölçek 7", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: UID, quantityScale: 7 })],
    ["ürün: ölçek kesirli", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: UID, quantityScale: 1.5 })],
    ["ürün: geçersiz takip modu", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: UID, trackingMode: "BAD" })],
    ["ürün: bilinmeyen alan", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: UID, extra: 1 })],
    ["güncelle: uuid değil", () => updateItemAction({ slug: "acme", itemId: "x", name: "n" })],
    ["güncelle: temel birim değişimi alanı kabul edilmez", () => updateItemAction({ slug: "acme", itemId: IID, baseUnitId: UID })],
    ["arşiv: uuid değil", () => archiveItemAction({ slug: "acme", itemId: "x" })],
    ["dönüşüm: katsayı sayı tipinde (float yasak)", () => setConversionAction({ slug: "acme", itemId: IID, unitId: UID, factor: 12 })],
    ["dönüşüm: katsayı boş", () => setConversionAction({ slug: "acme", itemId: IID, unitId: UID, factor: "" })],
    ["barkod: miktar sayı tipinde", () => addBarcodeAction({ slug: "acme", itemId: IID, unitId: null, barcode: "123", quantity: 5 })],
    ["barkod: birim eksik (null olmalı)", () => addBarcodeAction({ slug: "acme", itemId: IID, barcode: "123", quantity: null })],
    ["barkod kaldır: uuid değil", () => removeBarcodeAction({ slug: "acme", barcodeId: "x" })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      for (const f of domainMocks) expect(f).not.toHaveBeenCalled();
    });
  }
});

describe("domain çağrısı: dizgiler olduğu gibi gider (I-09)", () => {
  it("dönüşüm katsayısı bozulmadan iletilir (sondaki sıfır, ondalık, 6 hane)", async () => {
    for (const factor of ["12", "0.5", "12.500000", "0.000001", "007", "1e3", " 12 "]) {
      setUnitConversion.mockResolvedValueOnce({ itemId: IID, unitId: UID, factor: "x" });
      const res = await setConversionAction({ slug: "acme", itemId: IID, unitId: UID, factor });
      expect(res.ok, factor).toBe(true);
      const input = setUnitConversion.mock.calls.at(-1)?.[1] as { factor: unknown };
      expect(typeof input.factor).toBe("string");
      expect(input.factor).toBe(factor);
    }
    expect(setUnitConversion).toHaveBeenCalledTimes(7);
  });

  it("dönüşüm girdisi tam eşitlikle: ürün, birim ve istek kimliği", async () => {
    setUnitConversion.mockResolvedValue({ itemId: IID, unitId: UID, factor: "12" });
    const res = await setConversionAction({ slug: "acme", itemId: IID, unitId: UID, factor: "12" });
    expect(res).toEqual({ ok: true, data: { factor: "12" } });
    expect(setUnitConversion.mock.calls[0]?.[1]).toEqual({ itemId: IID, unitId: UID, factor: "12" });
  });

  it("barkod miktarı dizgi olarak, birimsiz barkod unitId null olarak gider", async () => {
    addBarcode.mockResolvedValue({ barcodeId: BID });
    const res = await addBarcodeAction({ slug: "acme", itemId: IID, unitId: null, barcode: " 869000 ", quantity: "12.50" });
    expect(res).toEqual({ ok: true, data: { barcodeId: BID } });
    expect(addBarcode.mock.calls[0]?.[1]).toEqual({ itemId: IID, unitId: null, barcode: " 869000 ", quantity: "12.50" });
  });

  it("ürün oluşturma: ham kod domain'e gider; verilmeyen isteğe bağlı alanlar iletilmez (varsayılan domain'de)", async () => {
    createItem.mockResolvedValue({ itemId: IID });
    const res = await createItemAction({ slug: "acme", code: " vida-1 ", name: "Vida", baseUnitId: UID });
    expect(res).toEqual({ ok: true, data: { itemId: IID } });
    expect(createItem.mock.calls[0]?.[1]).toEqual({ code: " vida-1 ", name: "Vida", baseUnitId: UID });
    createItem.mockResolvedValue({ itemId: IID });
    await createItemAction({ slug: "acme", code: "B", name: "n", baseUnitId: UID, quantityScale: 3, trackingMode: "LOT", pickPolicy: "FEFO" });
    expect(createItem.mock.calls[1]?.[1]).toEqual({ code: "B", name: "n", baseUnitId: UID, quantityScale: 3, trackingMode: "LOT", pickPolicy: "FEFO" });
  });
});

describe("sunucu hatasının aktarımı", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string; detail?: string } }>, () => void, string, string | undefined]> = [
    ["CODE_TAKEN", () => createItemAction({ slug: "acme", code: "A", name: "n", baseUnitId: UID }), () => createItem.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" })), "VALIDATION_FAILED", "CODE_TAKEN"],
    ["IN_USE (arşiv)", () => archiveItemAction({ slug: "acme", itemId: IID }), () => archiveItem.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "IN_USE" })), "VALIDATION_FAILED", "IN_USE"],
    ["UNIT_CONVERSION_INVALID", () => setConversionAction({ slug: "acme", itemId: IID, unitId: UID, factor: "2" }), () => setUnitConversion.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "UNIT_CONVERSION_INVALID" })), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID"],
    ["FORBIDDEN (yetkisiz yazma)", () => addBarcodeAction({ slug: "acme", itemId: IID, unitId: null, barcode: "1", quantity: null }), () => addBarcode.mockRejectedValue(new AppError("FORBIDDEN")), "FORBIDDEN", undefined],
    ["NOT_FOUND (barkod)", () => removeBarcodeAction({ slug: "acme", barcodeId: BID }), () => removeBarcode.mockRejectedValue(new AppError("NOT_FOUND")), "NOT_FOUND", undefined],
  ];
  for (const [name, call, arrange, code, detail] of cases) {
    it(name, async () => {
      arrange();
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe(code);
      expect(res.error?.detail).toBe(detail);
    });
  }

  it("beklenmeyen hata: genel INTERNAL (ayrıntı sızmaz)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    archiveItem.mockRejectedValue(new Error("secret sql detail"));
    const res = await archiveItemAction({ slug: "acme", itemId: IID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expect(JSON.stringify(res)).not.toContain("secret");
  });
});

describe("errorKey eşlemesi ve mesaj anahtarları", () => {
  it("bilinen kod + ayrıntı", () => {
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" })).toBe("validation_failed_code_taken");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "IN_USE" })).toBe("validation_failed_in_use");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "UNIT_CONVERSION_INVALID" })).toBe("validation_failed_unit_conversion_invalid");
    expect(errorKey({ code: "FORBIDDEN", detail: "MFA_REQUIRED" })).toBe("forbidden_mfa_required");
    expect(errorKey({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" })).toBe("unauthenticated_recent_auth_required");
  });
  it("bilinmeyen kod veya ayrıntı genel anahtara düşer", () => {
    expect(errorKey({ code: "WHATEVER" })).toBe("internal");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "UNKNOWN" })).toBe("validation_failed");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "BARCODE_AMBIGUOUS" })).toBe("validation_failed");
    expect(errorKey({ code: "NOT_FOUND" })).toBe("not_found");
  });
  it("her anahtar için neden ve sonraki eylem metni hem tr hem en dosyasında var", () => {
    const keys = [
      errorKey({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" }),
      errorKey({ code: "VALIDATION_FAILED", detail: "IN_USE" }),
      errorKey({ code: "VALIDATION_FAILED", detail: "UNIT_CONVERSION_INVALID" }),
      errorKey({ code: "FORBIDDEN", detail: "MFA_REQUIRED" }),
      errorKey({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" }),
      ...["forbidden", "unauthenticated", "not_found", "validation_failed", "version_conflict", "rate_limited", "tenant_suspended", "tenant_closing", "internal"],
    ];
    for (const lang of ["tr", "en"]) {
      const msgs = JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../../../messages/${lang}.json`), "utf8")) as { items: { errors: Record<string, string> } };
      for (const k of keys) {
        expect(typeof msgs.items.errors[k], `${lang}:${k}`).toBe("string");
        expect(typeof msgs.items.errors[`${k}Action`], `${lang}:${k}Action`).toBe("string");
      }
    }
  });
});
