import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { AUDIT_ACTIONS } from "@wms/db";
import { AUDIT_OTHER_KEY, listMyActionsToday, summaryKeyFor } from "../audit/today.ts";
import { getTenantSettings } from "./settings-queries.ts";

const db = {} as never; // doğrulama/kimlik reddi DB'ye ulaşmadan olur
const base = { db, principal: { userId: "00000000-0000-0000-0000-000000000001", mfaVerified: true }, tenantSlug: "x" };

describe("summaryKeyFor", () => {
  it("bilinen eylem audit.<eylem>, bilinmeyen audit.other", () => {
    for (const a of AUDIT_ACTIONS) expect(summaryKeyFor(a)).toBe(`audit.${a}`);
    expect(summaryKeyFor("yeni.bilinmeyen")).toBe(AUDIT_OTHER_KEY);
    expect(summaryKeyFor("")).toBe("audit.other");
  });
});

describe("girdi doğrulama (DB'ye gitmeden)", () => {
  it.each([0, -1, 21, 1.5, Number.NaN])("limit %s → VALIDATION_FAILED", async (limit) => {
    await expect(listMyActionsToday(base, { limit })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("bozuk imleç → VALIDATION_FAILED", async () => {
    await expect(listMyActionsToday(base, { cursor: { ts: "x'; --", id: "y" } })).rejects.toBeInstanceOf(AppError);
  });
  it("principal yok → UNAUTHENTICATED", async () => {
    await expect(getTenantSettings({ ...base, principal: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
