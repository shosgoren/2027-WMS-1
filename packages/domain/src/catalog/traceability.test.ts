// T-212 birim testleri: tarih doğrulama, NFC, takip modu × kart uyumu (DB'siz).
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { assertLotDates, modeAllowsLot, parseDateOnly, parseNfcText } from "./lots.ts";

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof AppError ? e.code : "OTHER";
  }
  return undefined;
};

describe("parseDateOnly", () => {
  it.each(["2025-01-31", "2024-02-29", "2000-12-01"])("geçerli %s", (d) => expect(parseDateOnly(d)).toBe(d));
  it.each(["2025-02-30", "2023-02-29", "2025-13-01", "2025-00-10", "2025-1-1", "25-01-01", "2025-01-01T00:00:00Z", " 2025-01-01", "", "1800-01-01"])(
    "geçersiz %j → VALIDATION_FAILED",
    (d) => expect(code(() => parseDateOnly(d))).toBe("VALIDATION_FAILED"),
  );
  it("string olmayan reddedilir", () => {
    expect(code(() => parseDateOnly(20250101))).toBe("VALIDATION_FAILED");
    expect(code(() => parseDateOnly(new Date()))).toBe("VALIDATION_FAILED");
  });
});

describe("assertLotDates", () => {
  it("üretim ≤ SKT geçer; eşit geçer; SKT < üretim reddedilir; tek tarih geçer", () => {
    expect(code(() => assertLotDates("2025-01-01", "2025-01-01"))).toBeUndefined();
    expect(code(() => assertLotDates("2025-01-01", "2025-06-01"))).toBeUndefined();
    expect(code(() => assertLotDates(undefined, "2025-06-01"))).toBeUndefined();
    expect(code(() => assertLotDates("2025-01-01", undefined))).toBeUndefined();
    expect(code(() => assertLotDates("2025-06-02", "2025-06-01"))).toBe("VALIDATION_FAILED");
  });
});

describe("parseNfcText", () => {
  it("NFC'ye normalize eder; bileşik ve ayrışık biçim aynı değere iner", () => {
    expect(parseNfcText("é", 8)).toBe("é");
    expect(parseNfcText("  A1  ", 8)).toBe("A1");
  });
  it("boş, kontrol karakteri, uzunluk ve tür reddedilir", () => {
    expect(code(() => parseNfcText("  ", 8))).toBe("VALIDATION_FAILED");
    expect(code(() => parseNfcText("a\u0000b", 8))).toBe("VALIDATION_FAILED");
    expect(code(() => parseNfcText("x".repeat(9), 8))).toBe("VALIDATION_FAILED");
    expect(code(() => parseNfcText(5, 8))).toBe("VALIDATION_FAILED");
  });
});

describe("takip modu × lot uyumu", () => {
  it.each([
    ["NONE", false],
    ["LOT", true],
    ["SERIAL", false],
    ["LOT_AND_SERIAL", true],
  ] as const)("%s → lot %s", (mode, ok) => expect(modeAllowsLot(mode)).toBe(ok));
});
