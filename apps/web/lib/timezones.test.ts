import { describe, expect, it } from "vitest";
import { TIME_ZONES, isListedTimeZone } from "./timezones.ts";

describe("TIME_ZONES", () => {
  it("Europe/Istanbul ve UTC içerir; yinelenen yok", () => {
    expect(TIME_ZONES).toContain("Europe/Istanbul");
    expect(TIME_ZONES).toContain("UTC");
    expect(new Set(TIME_ZONES).size).toBe(TIME_ZONES.length);
  });
  it("her ad Intl tarafından tanınır", () => {
    for (const z of TIME_ZONES) expect(() => new Intl.DateTimeFormat("en", { timeZone: z }), z).not.toThrow();
  });
  it("isListedTimeZone yalnızca listedekileri kabul eder", () => {
    expect(isListedTimeZone("Europe/Berlin")).toBe(true);
    for (const bad of ["Mars/Olympus", "America/Argentina/ComodRivadavia", "europe/istanbul", "", "EST5EDT", "Europe/Istanbul "]) {
      expect(isListedTimeZone(bad)).toBe(false);
    }
  });
});
