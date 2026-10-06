import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { itemInUse, listItemBarcodes, listItemConversions, searchItems, SEARCH_MAX_LIMIT } from "./reads.ts";

// Girdi doğrulaması DB'ye gitmeden önce yapılır: bağlantı nesnesi hiç kullanılmamalı (kullanılırsa test TypeError ile kırmızı olur).
const params = {} as never;
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
const ID = "123e4567-e89b-42d3-a456-426614174000";

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return `${(e as AppError).code}/${(e as AppError).detail ?? ""}`;
}

describe("searchItems girdi doğrulaması", () => {
  it("limit 1..100 tam sayı", async () => {
    for (const limit of [0, -1, 1.5, SEARCH_MAX_LIMIT + 1, Number.NaN, "5" as unknown as number]) {
      expect(await code(searchItems(params, { limit }))).toBe("VALIDATION_FAILED/");
    }
  });
  it("durum yalnızca ACTIVE/ARCHIVED", async () => {
    expect(await code(searchItems(params, { status: "ALL" as never }))).toBe("VALIDATION_FAILED/");
  });
  it("q: metin değilse, kontrol karakteri içeriyorsa ya da 128'den uzunsa ret", async () => {
    expect(await code(searchItems(params, { q: 5 as never }))).toBe("VALIDATION_FAILED/");
    expect(await code(searchItems(params, { q: "a\u0000b" }))).toBe("VALIDATION_FAILED/");
    expect(await code(searchItems(params, { q: "x".repeat(129) }))).toBe("VALIDATION_FAILED/");
  });
  it("imleç: biçim, şekil, UUID ve kod sınırı sıkı doğrulanır", async () => {
    const bad = [
      "",
      "***",
      Buffer.from("not json").toString("base64url"),
      b64({ code: "A", id: ID }),
      b64(["A"]),
      b64(["A", "x"]),
      b64([5, ID]),
      b64(["", ID]),
      b64(["x".repeat(65), ID]),
      b64(["A", ID, "fazla"]),
      b64(["A\u0000", ID]),
    ];
    for (const after of bad) expect(await code(searchItems(params, { after }))).toBe("VALIDATION_FAILED/");
  });
});

describe("tek ürün okumaları", () => {
  it("UUID olmayan kimlik DB'ye gitmeden VALIDATION_FAILED", async () => {
    expect(await code(listItemConversions(params, "nope"))).toBe("VALIDATION_FAILED/");
    expect(await code(listItemBarcodes(params, "nope"))).toBe("VALIDATION_FAILED/");
    expect(await code(itemInUse(params, "nope"))).toBe("VALIDATION_FAILED/");
  });
});
