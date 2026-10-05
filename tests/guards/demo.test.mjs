import { expect, it } from "vitest";

// T-008g gösterim (AC-44 a): kayıtsız @quarantine → guards / check-all kırmızı. Birleştirilmez.
it("gösterim: kayıtsız karantina @quarantine Q-99", () => {
  expect(1 + 1).toBe(2);
});
