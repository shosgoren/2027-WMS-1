// Hata sözleşmesi bütünlüğü (T-203): her kodun HTTP durumu, her kod/ayrıntı ve audit eyleminin TR+EN katalog anahtarı.
// Katalog düz `errors` ad alanını kullanır (next-intl anahtarda nokta kabul etmez): `errors.<kod>.<ayrıntı>` mesaj
// anahtarı katalogda `errors.<kod>_<ayrıntı>` olur; "neden + sonraki eylem" için `...Action` kardeşi de zorunludur.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "../../db/src/audit.ts";
import {
  AppError,
  ERROR_CODES,
  ERROR_DETAILS,
  ERROR_DETAIL_CODE,
  HTTP_STATUS,
  errorMessageKey,
} from "./errors.ts";

type Catalog = Record<string, unknown>;
const load = (name: string): Catalog =>
  JSON.parse(readFileSync(new URL(`../../../apps/web/messages/${name}.json`, import.meta.url), "utf8")) as Catalog;
const CATALOGS: ReadonlyArray<readonly [string, Catalog]> = [
  ["tr", load("tr")],
  ["en", load("en")],
];

function lookup(catalog: Catalog, path: readonly string[]): unknown {
  let cur: unknown = catalog;
  for (const part of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Catalog)[part];
  }
  return cur;
}
const isText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const catalogKey = (messageKey: string): string => messageKey.replace(/^errors\./, "").replace(".", "_");

describe("HTTP_STATUS", () => {
  it("her hata kodunun durumu tanımlı", () => {
    for (const code of ERROR_CODES) expect(HTTP_STATUS[code], code).toBeGreaterThanOrEqual(400);
  });
  it("ADR-018 §8 eşlemesi", () => {
    expect(HTTP_STATUS.INSUFFICIENT_STOCK).toBe(409);
    expect(HTTP_STATUS.TRACKING_VIOLATION).toBe(422);
    expect(HTTP_STATUS.LOCATION_LOCKED).toBe(423);
    expect(HTTP_STATUS.REVERSAL_BLOCKED).toBe(409);
    expect(HTTP_STATUS.IDEMPOTENCY_MISMATCH).toBe(409);
    expect(HTTP_STATUS.COUNT_LOCK_ROW_MISSING).toBe(500);
  });
  it("Faz 2'de fırlatılmayan kodlar eklenmez (A-71)", () => {
    expect(ERROR_CODES).not.toContain("PERIOD_CLOSED");
    expect(ERROR_CODES).not.toContain("ENTITLEMENT_REQUIRED");
  });
});

describe("AppError ayrıntıları", () => {
  it("her ayrıntı bir koda bağlı ve gövde iç ayrıntı taşımaz", () => {
    for (const detail of ERROR_DETAILS) {
      const code = ERROR_DETAIL_CODE[detail];
      const body = new AppError(code, { detail }).toBody();
      expect(Object.keys(body.error).sort()).toEqual(["code", "detail", "messageKey", "retryable"]);
      expect(body.error.messageKey).toBe(errorMessageKey(code, detail));
    }
  });
});

describe.each(CATALOGS)("i18n kataloğu (%s)", (_name, catalog) => {
  it("her kod için errors.<kod> ve eylem metni var", () => {
    for (const code of ERROR_CODES) {
      const key = catalogKey(errorMessageKey(code));
      expect(isText(lookup(catalog, ["errors", key])), `errors.${key}`).toBe(true);
      expect(isText(lookup(catalog, ["errors", `${key}Action`])), `errors.${key}Action`).toBe(true);
    }
  });
  it("her ayrıntı için errors.<kod>_<ayrıntı> ve eylem metni var", () => {
    for (const detail of ERROR_DETAILS) {
      const key = catalogKey(errorMessageKey(ERROR_DETAIL_CODE[detail], detail));
      expect(isText(lookup(catalog, ["errors", key])), `errors.${key}`).toBe(true);
      expect(isText(lookup(catalog, ["errors", `${key}Action`])), `errors.${key}Action`).toBe(true);
    }
  });
  it("her audit eyleminin adı var", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(isText(lookup(catalog, ["audit", ...action.split(".")])), `audit.${action}`).toBe(true);
    }
  });
});
