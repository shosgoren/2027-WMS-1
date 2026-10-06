import { describe, expect, it } from "vitest";
import { maskEmail, resetLinkPrechecks } from "./member-queries.ts";

const ok = { callerCanManage: true, tenantIsDemo: false, isSelf: false, isDemoTarget: false, isOwner: false };

describe("maskEmail", () => {
  it("yerel kısmı kısaltır, alan adını korur", () => {
    expect(maskEmail("alice@example.test")).toBe("al***@example.test");
    expect(maskEmail("a@example.test")).toBe("a***@example.test");
  });
  it("geçersiz adres tamamen maskelenir", () => {
    expect(maskEmail("nodomain")).toBe("***");
    expect(maskEmail("@x.test")).toBe("***");
  });
});

describe("resetLinkPrechecks", () => {
  it("tüm koşullar sağlanınca true", () => expect(resetLinkPrechecks(ok)).toBe(true));
  it.each([
    ["yetkisiz çağıran", { callerCanManage: false }],
    ["demo tenant", { tenantIsDemo: true }],
    ["kendisi", { isSelf: true }],
    ["demo hedef", { isDemoTarget: true }],
    ["sahip", { isOwner: true }],
  ])("%s → false", (_n, o) => expect(resetLinkPrechecks({ ...ok, ...o })).toBe(false));
});
