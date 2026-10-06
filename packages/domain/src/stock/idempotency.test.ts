// T-213 idempotency.ts birim testleri: kanonik özet kararlılığı, alan sırası bağımsızlığı, sunucu alanları, anahtar, beyaz liste, hata kodu saklama.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import {
  assertResultWhitelisted,
  canonicalJson,
  decodeErrorCode,
  encodeErrorCode,
  isPersistedRejectionCode,
  parseClientKey,
  requestHash,
} from "./idempotency.ts";
import { FeatureDisabledError, mapStockError } from "./command.ts";
import { formatDocumentNumber, periodOf, yearOfBusinessDate } from "./numbering.ts";

const U1 = "11111111-1111-4111-8111-111111111111";

describe("kanonik JSON ve istek özeti", () => {
  it("alan sırasından bağımsızdır (her derinlikte)", () => {
    const a = { b: 1, a: { y: [1, 2, { q: 1, p: 2 }], x: "s" } };
    const b = { a: { x: "s", y: [1, 2, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(requestHash(a)).toBe(requestHash(b));
  });
  it("kararlıdır: bilinen girdi için sabit çıktı ve 64 haneli küçük harf hex", () => {
    expect(canonicalJson({ b: [1, null, "x"], a: true })).toBe('{"a":true,"b":[1,null,"x"]}');
    expect(requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash({ a: 1 })).toBe(requestHash({ a: 1 }));
  });
  it("dizi sırası ve değer farkı özeti değiştirir", () => {
    expect(requestHash({ l: [1, 2] })).not.toBe(requestHash({ l: [2, 1] }));
    expect(requestHash({ q: "1.5" })).not.toBe(requestHash({ q: "1.50" }));
  });
  it("undefined alanlar ve sunucu alanları (aktör, zaman, istek kimliği) özete girmez", () => {
    const base = requestHash({ documentId: U1, qty: "2" });
    expect(requestHash({ documentId: U1, qty: "2", extra: undefined })).toBe(base);
    expect(requestHash({ documentId: U1, qty: "2", actorUserId: U1, requestId: U1, requestedAt: "2026-01-01", occurredAt: 1 })).toBe(base);
    expect(requestHash({ documentId: U1, qty: "2", nested: { clientKey: U1 } })).toBe(requestHash({ documentId: U1, qty: "2", nested: {} }));
  });
  it("JSON olmayan değerleri reddeder", () => {
    for (const bad of [{ a: Number.NaN }, { a: 1n }, { a: () => 1 }, { a: new Map() }, undefined]) {
      expect(() => canonicalJson(bad)).toThrow(AppError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(AppError);
  });
});

describe("istemci anahtarı", () => {
  it("anahtarsız → VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED", () => {
    for (const k of [undefined, null, "", "   "]) {
      expect(() => parseClientKey(k)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", detail: "IDEMPOTENCY_KEY_REQUIRED" }));
    }
  });
  it("UUID olmayan anahtar VALIDATION_FAILED; UUID küçük harfe çevrilir", () => {
    expect(() => parseClientKey("not-a-uuid")).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseClientKey(12)).toThrow(AppError);
    expect(parseClientKey(U1.toUpperCase())).toBe(U1);
  });
});

describe("result beyaz listesi (ADR-017 §10)", () => {
  it("geçerli sonuç kabul edilir", () => {
    const ok = {
      documentId: U1,
      documentNumber: "GRS-2026-000001",
      status: "POSTED",
      reservationIds: [U1],
      lines: [{ lineId: U1, lineNo: 1, quantity: "2.5", baseQuantity: "5", reversedQuantity: "0" }],
    } as const;
    expect(assertResultWhitelisted(ok)).toBe(ok);
    expect(() => assertResultWhitelisted({})).not.toThrow();
  });
  it("liste dışı üst düzey ve satır alanı reddedilir (kişisel veri/serbest metin yok)", () => {
    expect(() => assertResultWhitelisted({ documentId: U1, note: "serbest metin" } as never)).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
    expect(() => assertResultWhitelisted({ lines: [{ lineId: U1, supplierName: "x" }] } as never)).toThrow(AppError);
  });
  it("biçim ihlalleri reddedilir", () => {
    for (const bad of [
      { documentId: "x" },
      { status: "DONE" },
      { reservationIds: ["x"] },
      { lines: [{ lineNo: 1 }] },
      { lines: [{ lineId: U1, quantity: "1e3" }] },
      { lines: [{ lineId: U1, lineNo: 0 }] },
      { documentNumber: "" },
    ]) {
      expect(() => assertResultWhitelisted(bad as never)).toThrow(AppError);
    }
  });
  it("ret nedeni cause'da kalır, kullanıcı hatasında ayrıntı yok", () => {
    try {
      assertResultWhitelisted({ foo: 1 } as never);
    } catch (e) {
      expect((e as AppError).message).toBe("INTERNAL");
      expect(String((e as AppError).cause)).toContain("field not allowed: foo");
    }
  });
});

describe("saklanan ret kodu", () => {
  it("kod/ayrıntı gidiş-dönüş", () => {
    expect(encodeErrorCode("INSUFFICIENT_STOCK", undefined)).toBe("INSUFFICIENT_STOCK");
    expect(encodeErrorCode("VALIDATION_FAILED", "DOCUMENT_STATE")).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const e = decodeErrorCode("VALIDATION_FAILED/DOCUMENT_STATE");
    expect([e.code, e.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_STATE"]);
    expect(decodeErrorCode("INSUFFICIENT_STOCK").code).toBe("INSUFFICIENT_STOCK");
  });
  it("tanınmayan değer INTERNAL olur", () => {
    expect(decodeErrorCode("BOGUS").code).toBe("INTERNAL");
  });
  it("yalnızca iş kuralı retleri kalıcıdır; geçici/yetki/mismatch değil (ADR-018 §3)", () => {
    for (const c of ["INSUFFICIENT_STOCK", "TRACKING_VIOLATION", "LOCATION_LOCKED", "REVERSAL_BLOCKED", "VALIDATION_FAILED"] as const) {
      expect(isPersistedRejectionCode(c)).toBe(true);
    }
    for (const c of ["VERSION_CONFLICT", "FORBIDDEN", "UNAUTHENTICATED", "TENANT_SUSPENDED", "IDEMPOTENCY_MISMATCH", "NOT_FOUND", "INTERNAL", "COUNT_LOCK_ROW_MISSING"] as const) {
      expect(isPersistedRejectionCode(c)).toBe(false);
    }
  });
});

describe("numaralama biçimi (A-70)", () => {
  it("biçim ve dönem", () => {
    expect(formatDocumentNumber("STOCK_IN", "2026", 1)).toBe("GRS-2026-000001");
    expect(formatDocumentNumber("STOCK_OUT", "2026", 42)).toBe("CKS-2026-000042");
    expect(formatDocumentNumber("STOCK_MOVE", "2026", 7n)).toBe("TSM-2026-000007");
    expect(formatDocumentNumber("REVERSAL", "2026", 1234567)).toBe("TRS-2026-1234567");
    expect(periodOf("2026-12-31")).toBe("2026");
  });
  it("geçersiz iş tarihi reddedilir", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", "x"]) {
      expect(() => yearOfBusinessDate(bad)).toThrow(AppError);
    }
  });
});

describe("mapStockError (command.ts): alt katman hatalarının AppError eşlemesi", () => {
  const lockErr = (code: string, detail?: string): Error => Object.assign(new Error(code), { name: "StockLockError", code, detail });
  const pg = (code: string, message: string): Error => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error(message), { code }) });

  it("StockLockError FORBIDDEN → AppError FORBIDDEN (kök neden cause'da)", () => {
    const src = lockErr("FORBIDDEN", "tenantId does not match the transaction tenant context");
    const mapped = mapStockError(src) as AppError;
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe("FORBIDDEN");
    expect(mapped.cause).toBe(src);
    expect(mapped.message).toBe("FORBIDDEN"); // iç ayrıntı yanıta girmez
  });
  it("StockLockError kodları aynı adlı AppError'a eşlenir; VERSION_CONFLICT yeniden denenemez (belge sürümü)", () => {
    for (const c of ["NOT_FOUND", "LOCATION_LOCKED", "COUNT_LOCK_ROW_MISSING", "VERSION_CONFLICT"] as const) {
      const m = mapStockError(lockErr(c)) as AppError;
      expect([m.code, m.retryable]).toEqual([c, false]);
    }
    expect((mapStockError(lockErr("INTERNAL")) as AppError).code).toBe("INTERNAL");
  });
  it("seri bayrağı kapalı VALIDATION_FAILED → FeatureDisabledError (ayrı mesaj anahtarı); diğer VALIDATION_FAILED genel", () => {
    const off = mapStockError(lockErr("VALIDATION_FAILED", "serial locking is disabled (STOCK_SERIAL_LOCK_ENABLED, Q-56)"));
    expect(off).toBeInstanceOf(FeatureDisabledError);
    expect([(off as AppError).code, (off as AppError).detail]).toEqual(["VALIDATION_FAILED", "FEATURE_DISABLED"]);
    expect((off as AppError).messageKey).toBe("errors.validation_failed.feature_disabled");
    const other = mapStockError(lockErr("VALIDATION_FAILED", "serialIds must be an array")) as AppError;
    expect(other).not.toBeInstanceOf(FeatureDisabledError);
    expect(other.messageKey).toBe("errors.validation_failed");
  });
  it("23514: TRACKING_VIOLATION önekli → TRACKING_VIOLATION; belge durumu → DOCUMENT_STATE; diğer → VALIDATION_FAILED", () => {
    expect((mapStockError(pg("23514", "TRACKING_VIOLATION: ürün takip modu")) as AppError).code).toBe("TRACKING_VIOLATION");
    const st = mapStockError(pg("23514", "DOCUMENT_NOT_DRAFT: yalnızca taslak")) as AppError;
    expect([st.code, st.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_STATE"]);
    expect((mapStockError(pg("23514", "DOCUMENT_POSTED_IMMUTABLE: x")) as AppError).detail).toBe("DOCUMENT_STATE");
    const generic = mapStockError(pg("23514", "check constraint violated")) as AppError;
    expect([generic.code, generic.detail]).toEqual(["VALIDATION_FAILED", undefined]);
  });
  it("23503 → NOT_FOUND; geçici SQLSTATE ve tanınmayan hata DOKUNULMADAN döner (yeniden deneme sınıflandırması)", () => {
    expect((mapStockError(pg("23503", "fk")) as AppError).code).toBe("NOT_FOUND");
    for (const code of ["40P01", "40001", "55P03"]) {
      const e = pg(code, "x");
      expect(mapStockError(e)).toBe(e);
    }
    const biz = new AppError("INSUFFICIENT_STOCK");
    expect(mapStockError(biz)).toBe(biz);
    const plain = new Error("boom");
    expect(mapStockError(plain)).toBe(plain);
  });
});
