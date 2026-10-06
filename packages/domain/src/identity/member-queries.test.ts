import { describe, expect, it } from "vitest";
import { maskEmail, resetLinkPrechecks } from "./member-queries.ts";

const ok = { callerCanManage: true, tenantIsDemo: false, isSelf: false, isDemoTarget: false, isOwner: false };

describe("maskEmail", () => {
  it("yerel kısım >=4: ilk 2 + ***; alan adı ilk harf + ***, TLD açık", () => {
    expect(maskEmail("alice@example.test")).toBe("al***@e***.test");
    expect(maskEmail("abcd@mail.example.test")).toBe("ab***@m***.example.test");
  });
  it("yerel kısım <4: ***", () => {
    expect(maskEmail("abc@example.test")).toBe("***@e***.test");
    expect(maskEmail("a@example.test")).toBe("***@e***.test");
  });
  it("noktasız alan adı ve geçersiz adres", () => {
    expect(maskEmail("alice@localhost")).toBe("al***@l***");
    expect(maskEmail("nodomain")).toBe("***");
    expect(maskEmail("@x.test")).toBe("***");
    expect(maskEmail("a@")).toBe("***");
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
