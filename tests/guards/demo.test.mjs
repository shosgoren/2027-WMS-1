import { expect, it } from "vitest";

// T-008g gösterim (kontrol): temiz test → check-all ve test-ac yeşil olmalı. Birleştirilmez.
it("gösterim: temiz test", () => {
  expect(1 + 1).toBe(2);
});
