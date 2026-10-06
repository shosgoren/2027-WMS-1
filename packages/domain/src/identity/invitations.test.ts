// T-117 birim testleri: belirteç biçimi/özeti, e-posta normalizasyonu, demo adres kuralı (saf işlevler).
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import {
  generateInvitationToken,
  hashInvitationToken,
  isDemoAddress,
  isWellFormedInvitationToken,
  normalizeInvitationEmail,
  placeholderTokenHash,
} from "./invitations.ts";

describe("belirteç", () => {
  it("32 bayt, base64url, 43 karakter; her çağrıda farklı", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isWellFormedInvitationToken(a)).toBe(true);
  });

  it("biçimsiz belirteç reddedilir", () => {
    for (const bad of ["", "abc", `${"a".repeat(42)}=`, `${"a".repeat(43)} `, "a".repeat(44), 5, null, undefined]) {
      expect(isWellFormedInvitationToken(bad)).toBe(false);
    }
  });

  it("özet: 64 küçük harf hex, deterministik, belirteçten farklı; yer tutucu rastgele ve biçimce geçerli", () => {
    const t = generateInvitationToken();
    expect(hashInvitationToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken(t)).toBe(hashInvitationToken(t));
    expect(hashInvitationToken(t)).not.toContain(t);
    const p1 = placeholderTokenHash();
    expect(p1).toMatch(/^[0-9a-f]{64}$/);
    expect(p1).not.toBe(placeholderTokenHash());
  });
});

describe("e-posta normalizasyonu", () => {
  it("kırpar ve küçük harfe çevirir", () => {
    expect(normalizeInvitationEmail("  Ayse.Yilmaz@Example.COM ")).toBe("ayse.yilmaz@example.com");
  });

  it("geçersiz girdi VALIDATION_FAILED (değer hataya girmez)", () => {
    for (const bad of ["", "a", "a@b", "a b@c.com", "a@b.com, c@d.com", "<a@b.com>", "a@b.com\r\nBcc: x@y.com", 12, null]) {
      try {
        normalizeInvitationEmail(bad);
        throw new Error("expected rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe("VALIDATION_FAILED");
        expect((e as AppError).message).not.toContain("@");
      }
    }
  });
});

describe("demo adres kuralı (A-43, M9)", () => {
  it("DEMO_EMAIL_DOMAIN alan adındaki adres demo sayılır; büyük/küçük harf ve alt alan adı ayrımı", () => {
    expect(isDemoAddress("x@demo.example.invalid", "demo.example.invalid")).toBe(true);
    expect(isDemoAddress("X@DEMO.example.invalid", "Demo.Example.Invalid")).toBe(true);
    expect(isDemoAddress("x@evil-demo.example.invalid", "demo.example.invalid")).toBe(false);
    expect(isDemoAddress("x@example.com", "demo.example.invalid")).toBe(false);
  });

  it("alan adı tanımsızsa kısıt yok", () => {
    expect(isDemoAddress("x@demo.example.invalid", null)).toBe(false);
    expect(isDemoAddress("x@demo.example.invalid", undefined)).toBe(false);
    expect(isDemoAddress("x@demo.example.invalid", "")).toBe(false);
  });
});
