// T-293 birim testleri: girdi şeması (strict, IDOR alanları reddedilir) ve sade ondalık (DB'siz).
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { GUIDED_TASK_KINDS, TASK_PROGRESS_STEPS, parseRecordStepInput, plainDecimal } from "./task-progress.ts";

const TASK = "0b9d2e0a-6c2d-4e55-9c3f-0d6f1f0a1b11";

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("hata bekleniyordu");
}

describe("parseRecordStepInput (strict)", () => {
  it("geçerli okutma ve miktar girdisi", () => {
    expect(parseRecordStepInput({ taskId: TASK.toUpperCase(), step: "SCAN_ITEM", scannedCode: " 869001 " })).toEqual({
      taskId: TASK,
      step: "SCAN_ITEM",
      scannedCode: " 869001 ",
      quantity: null,
      expectedVersion: null,
    });
    expect(parseRecordStepInput({ taskId: TASK, step: "ENTER_QUANTITY", quantity: "6", expectedVersion: 3 })).toMatchObject({ step: "ENTER_QUANTITY", quantity: "6", expectedVersion: 3 });
  });

  for (const extra of ["membershipId", "membership_id", "locationId", "location_id", "itemId", "item_id", "tenantId", "step2"]) {
    it(`fazla alan ${extra} → VALIDATION_FAILED`, () => {
      expect(failure(() => parseRecordStepInput({ taskId: TASK, step: "SCAN_TARGET", scannedCode: "B-12", [extra]: "x" })).code).toBe("VALIDATION_FAILED");
    });
  }

  it("adım/yük uyuşmazlıkları ve bozuk değerler reddedilir", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { taskId: TASK },
      { taskId: "x", step: "SCAN_ITEM", scannedCode: "a" },
      { taskId: TASK, step: "CONFIRM", scannedCode: "a" },
      { taskId: TASK, step: "SAVING" },
      { taskId: TASK, step: "SCAN_ITEM" },
      { taskId: TASK, step: "SCAN_ITEM", scannedCode: "   " },
      { taskId: TASK, step: "SCAN_ITEM", scannedCode: "a".repeat(257) },
      { taskId: TASK, step: "SCAN_ITEM", scannedCode: "a", quantity: "1" },
      { taskId: TASK, step: "ENTER_QUANTITY" },
      { taskId: TASK, step: "ENTER_QUANTITY", quantity: 6 },
      { taskId: TASK, step: "ENTER_QUANTITY", quantity: "1e3" },
      { taskId: TASK, step: "ENTER_QUANTITY", quantity: "1.1234567" },
      { taskId: TASK, step: "ENTER_QUANTITY", quantity: "6", scannedCode: "a" },
      { taskId: TASK, step: "SCAN_ITEM", scannedCode: "a", expectedVersion: 0 },
      { taskId: TASK, step: "SCAN_ITEM", scannedCode: "a", expectedVersion: 1.5 },
    ];
    for (const b of bad) expect(failure(() => parseRecordStepInput(b)).code, JSON.stringify(b)).toBe("VALIDATION_FAILED");
  });
});

describe("plainDecimal", () => {
  it("sondaki sıfırları atar", () => {
    expect(plainDecimal("6.000000")).toBe("6");
    expect(plainDecimal("6")).toBe("6");
    expect(plainDecimal("2.500000")).toBe("2.5");
    expect(plainDecimal("10.000100")).toBe("10.0001");
    expect(plainDecimal("0")).toBe("0");
    expect(plainDecimal("100")).toBe("100");
  });
});

describe("sabitler", () => {
  it("adım kümesi migration CHECK'iyle uyumlu (SCAN_ITEM satırsız ilk adımdır)", () => {
    expect(TASK_PROGRESS_STEPS).toEqual(["SCAN_ITEM", "SCAN_TARGET", "ENTER_QUANTITY", "CONFIRM", "SAVING"]);
    expect([...GUIDED_TASK_KINDS]).toEqual(["PUTAWAY", "REPUTAWAY"]);
  });
});
