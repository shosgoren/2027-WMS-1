import { expect, it } from "vitest";

// T-008g gösterim (AC-37): it.skip → guards / check-all kırmızı (SKIP). Birleştirilmez.
it.skip("gösterim: atlanan test", () => {
  expect(1 + 1).toBe(2);
});
