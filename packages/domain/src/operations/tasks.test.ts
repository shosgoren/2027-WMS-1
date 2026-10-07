// T-304 birim testleri: durum geçiş tablosu ve izin eşlemesi (DB'siz).
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, hasPermission } from "../identity/permissions.ts";
import { cancelTask, isCalendarTime, REASON_MAX, TASK_KIND_PERMISSION, TASK_KINDS, TASK_STATUSES, nextTaskStatus, type TaskEvent, type TaskStatus } from "./tasks.ts";

const EVENTS: readonly TaskEvent[] = ["ASSIGN", "CLAIM", "CANCEL", "COMPLETE"];

describe("nextTaskStatus (durum geçiş tablosu)", () => {
  // Beklenen tablo (ADR-021 §6; A-304-2/3): satır = durum, sütun = olay.
  const TABLE: Record<TaskStatus, Record<TaskEvent, TaskStatus | null>> = {
    OPEN: { ASSIGN: "ASSIGNED", CLAIM: "ASSIGNED", CANCEL: "CANCELLED", COMPLETE: "DONE" },
    ASSIGNED: { ASSIGN: "ASSIGNED", CLAIM: null, CANCEL: "CANCELLED", COMPLETE: "DONE" },
    DONE: { ASSIGN: null, CLAIM: null, CANCEL: null, COMPLETE: null },
    CANCELLED: { ASSIGN: null, CLAIM: null, CANCEL: null, COMPLETE: null },
  };

  for (const status of TASK_STATUSES) {
    for (const event of EVENTS) {
      it(`${status} + ${event} -> ${String(TABLE[status][event])}`, () => {
        expect(nextTaskStatus(status, event)).toBe(TABLE[status][event]);
      });
    }
  }

  it("claim yalnızca OPEN'dan geçer", () => {
    expect(TASK_STATUSES.filter((s) => nextTaskStatus(s, "CLAIM") !== null)).toEqual(["OPEN"]);
  });

  it("DONE ve CANCELLED terminaldir", () => {
    for (const s of ["DONE", "CANCELLED"] as const) for (const e of EVENTS) expect(nextTaskStatus(s, e)).toBeNull();
  });
});

describe("TASK_KIND_PERMISSION (A-132)", () => {
  it("PUTAWAY/PICK/REPUTAWAY stock.post, COUNT document.create", () => {
    expect(TASK_KIND_PERMISSION).toEqual({ PUTAWAY: "stock.post", PICK: "stock.post", REPUTAWAY: "stock.post", COUNT: "document.create" });
    expect(Object.keys(TASK_KIND_PERMISSION).sort()).toEqual([...TASK_KINDS].sort());
  });

  it("PICKER sayım görevini üstlenemez, COUNTER taşıma görevlerini üstlenemez, READ_ONLY hiçbirini", () => {
    expect(hasPermission(["PICKER"], TASK_KIND_PERMISSION.PICK)).toBe(true);
    expect(hasPermission(["PICKER"], TASK_KIND_PERMISSION.COUNT)).toBe(false);
    expect(hasPermission(["COUNTER"], TASK_KIND_PERMISSION.COUNT)).toBe(true);
    expect(hasPermission(["COUNTER"], TASK_KIND_PERMISSION.PICK)).toBe(false);
    for (const k of TASK_KINDS) expect(hasPermission(["READ_ONLY"], TASK_KIND_PERMISSION[k])).toBe(false);
  });

  it("atama/iptal izni (document.approve) PICKER ve COUNTER'da yok", () => {
    expect(ROLE_PERMISSIONS.PICKER.includes("document.approve")).toBe(false);
    expect(ROLE_PERMISSIONS.COUNTER.includes("document.approve")).toBe(false);
    expect(ROLE_PERMISSIONS.WAREHOUSE_MANAGER.includes("document.approve")).toBe(true);
  });
});

describe("isCalendarTime (imleç zamanı, MINOR-2)", () => {
  it("gerçek takvim zamanlarını kabul eder, olmayanları reddeder", () => {
    expect(isCalendarTime("2026-02-28T23:59:59.123456Z")).toBe(true);
    expect(isCalendarTime("2028-02-29T00:00:00.000000Z")).toBe(true);
    for (const bad of ["2026-02-31T00:00:00.000000Z", "2027-02-29T00:00:00.000000Z", "2026-13-01T00:00:00.000000Z", "2026-01-01T24:00:00.000000Z", "2026-01-01T00:60:00.000000Z", "2026-00-10T00:00:00.000000Z"]) {
      expect(isCalendarTime(bad), bad).toBe(false);
    }
  });
});

describe("cancelTask gerekçe uzunluğu (MINOR-3, audit optText ile aynı UTF-16 ölçüsü)", () => {
  const params = { db: undefined as never, principal: { userId: "00000000-0000-4000-8000-000000000001", mfaVerified: true }, tenantSlug: "x" };
  const input = { taskId: "00000000-0000-4000-8000-000000000002", expectedVersion: 1 };
  it("300 emoji (600 UTF-16 birimi) veritabanına gitmeden VALIDATION_FAILED", async () => {
    await expect(cancelTask(params, { ...input, reason: "😀".repeat(300) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(cancelTask(params, { ...input, reason: "x".repeat(REASON_MAX + 1) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
