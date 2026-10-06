import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, isValidSlug, slugBaseFromName, slugCandidates, workspaceCreationAllowed } from "./workspace.ts";
import { SECTOR_TEMPLATES, getTemplate } from "./templates.ts";

describe("slug kuralları", () => {
  it("demo ve Demo (ve DEMO) reddedilir", () => {
    for (const s of ["demo", "Demo", "DEMO", " demo "]) expect(isValidSlug(s)).toBe(false);
    expect(RESERVED_SLUGS.has("demo")).toBe(true);
  });
  it("biçim: küçük harf, rakam, tire; uçlarda tire yok", () => {
    expect(isValidSlug("acme-1")).toBe(true);
    expect(isValidSlug("Acme-1")).toBe(true); // küçük harfe çevrilir
    for (const s of ["-a", "a-", "a_b", "a b", "", "a".repeat(64), "ç"]) expect(isValidSlug(s)).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
  });
  it("ayrılmış kelimeler reddedilir", () => {
    for (const s of ["admin", "API", "t", "onboarding"]) expect(isValidSlug(s)).toBe(false);
  });
  it("üretilen slug Türkçe karakterleri sadeleştirir ve ayrılmış kelimeye düşmez", () => {
    expect(slugBaseFromName("Çağrı Ambalaj Ltd.")).toBe("cagri-ambalaj-ltd");
    expect(slugBaseFromName("İĞÜŞ")).toBe("igus");
    expect(slugBaseFromName("!!!")).toBe("workspace");
    const c = slugCandidates("Demo", "11111111-1111-4111-8111-111111111111");
    expect(c).not.toContain("demo");
    for (const s of c) expect(isValidSlug(s)).toBe(true);
    expect(c).toEqual(slugCandidates("Demo", "11111111-1111-4111-8111-111111111111"));
  });
});

describe("kayıt kapısı (A-50)", () => {
  it("yalnızca local|ci ve bayrak tam 'true'", () => {
    expect(workspaceCreationAllowed({ WMS_ENV: "local", SIGNUP_ENABLED: "true" })).toBe(true);
    expect(workspaceCreationAllowed({ WMS_ENV: "ci", SIGNUP_ENABLED: "true" })).toBe(true);
    for (const env of ["staging", "production", undefined]) {
      expect(workspaceCreationAllowed({ WMS_ENV: env, SIGNUP_ENABLED: "true" })).toBe(false);
    }
    expect(workspaceCreationAllowed({ WMS_ENV: "local", SIGNUP_ENABLED: "1" })).toBe(false);
    expect(workspaceCreationAllowed({ WMS_ENV: "local" })).toBe(false);
  });
});

describe("şablonlar", () => {
  it("PACKAGING_SUPPLIES v1 ve GENERIC v1 mevcut; Faz 1 adımları yalnızca settings/terminology", () => {
    for (const key of ["PACKAGING_SUPPLIES", "GENERIC"]) {
      const t = getTemplate(key, 1);
      expect(t?.version).toBe(1);
      expect(t?.steps).toEqual(["settings.applied", "terminology.applied"]);
      expect(t?.locationTemplatePreview).toEqual({ levels: ["ZONE", "RACK", "BIN"], trackingMode: "NONE" });
      expect(t?.unitsPreview.baseUnit).toBe("ADET");
    }
    const p = getTemplate("PACKAGING_SUPPLIES");
    expect(p?.unitsPreview.conversions.map((c) => c.unit)).toEqual(["KOLI", "PAKET", "RULO"]);
    expect(p?.terminology["location.bin"]).toBe("Göz Kodu");
    expect(getTemplate("NOPE")).toBeUndefined();
  });
  it("sürüm değişmezliği: tanımlar dondurulmuş ve (key, version) tekil", () => {
    const seen = new Set<string>();
    for (const t of SECTOR_TEMPLATES) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.terminology)).toBe(true);
      expect(() => {
        (t.terminology as Record<string, string>)["x"] = "y";
      }).toThrow();
      const id = `${t.key}@${t.version}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
