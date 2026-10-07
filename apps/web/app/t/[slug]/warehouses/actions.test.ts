// T-207: Server Action doğrulama hataları ve hata kodu → mesaj anahtarı eşlemesi. Domain komutları sahtedir (iş kuralı T-205'te
// test edilir); burada yalnızca ince girişin davranışı (zod, hata sözleşmesi) ve UI eşlemesi doğrulanır.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const createWarehouse = vi.hoisted(() => vi.fn());
const archiveWarehouse = vi.hoisted(() => vi.fn());
const createLocation = vi.hoisted(() => vi.fn());
const archiveLocation = vi.hoisted(() => vi.fn());
const getLocationTree = vi.hoisted(() => vi.fn());
const renameWarehouse = vi.hoisted(() => vi.fn());
const renameLocation = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/warehouse", () => ({ createWarehouse, archiveWarehouse, createLocation, archiveLocation, getLocationTree, renameWarehouse, renameLocation }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: () => Promise.resolve("t1") }));

import { archiveLocationAction, archiveWarehouseAction, createLocationAction, createWarehouseAction, loadMoreLocationsAction, renameLocationAction, renameWarehouseAction } from "./actions.ts";
import { errorKey } from "./warehouses-view.tsx";

const WID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";
let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://app.example.test";
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
  vi.clearAllMocks();
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["depo: boş kod", () => createWarehouseAction({ slug: "acme", code: "", name: "Ana" })],
    ["depo: ad eksik", () => createWarehouseAction({ slug: "acme", code: "A" })],
    ["depo: bilinmeyen alan", () => createWarehouseAction({ slug: "acme", code: "A", name: "Ana", extra: 1 })],
    ["depo arşiv: uuid değil", () => archiveWarehouseAction({ slug: "acme", warehouseId: "x" })],
    ["lokasyon: geçersiz tür", () => createLocationAction({ slug: "acme", warehouseId: WID, parentId: null, code: "A", name: "n", kind: "BOGUS" })],
    ["lokasyon: parentId uuid değil", () => createLocationAction({ slug: "acme", warehouseId: WID, parentId: "p", code: "A", name: "n", kind: "STORAGE" })],
    ["lokasyon arşiv: uuid değil", () => archiveLocationAction({ slug: "acme", locationId: "x" })],
    ["daha fazla: imleç eksik", () => loadMoreLocationsAction({ slug: "acme", warehouseId: WID })],
    ["daha fazla: derinlik negatif", () => loadMoreLocationsAction({ slug: "acme", warehouseId: WID, after: { depth: -1, code: "A", id: LID } })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      for (const f of [createWarehouse, archiveWarehouse, createLocation, archiveLocation, getLocationTree]) expect(f).not.toHaveBeenCalled();
    });
  }
});

describe("domain çağrısı ve sunucu hatasının aktarımı", () => {
  it("depo oluşturma: ham kod domain'e olduğu gibi gider (normalleştirme sunucuda, A-98)", async () => {
    createWarehouse.mockResolvedValue({ warehouseId: WID });
    const res = await createWarehouseAction({ slug: "acme", code: " ana ", name: "Ana depo" });
    expect(res).toMatchObject({ ok: true, data: { warehouseId: WID } });
    expect(createWarehouse).toHaveBeenCalledTimes(1);
    expect(createWarehouse.mock.calls[0]?.[1]).toMatchObject({ code: " ana ", name: "Ana depo" });
  });

  it("CODE_TAKEN ayrıntısı korunur", async () => {
    createWarehouse.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" }));
    const res = await createWarehouseAction({ slug: "acme", code: "A", name: "n" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    expect(errorKey(res.error)).toBe("validation_failed_code_taken");
  });

  it("IN_USE ayrıntısı korunur (depo arşivi)", async () => {
    archiveWarehouse.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "IN_USE" }));
    const res = await archiveWarehouseAction({ slug: "acme", warehouseId: WID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ code: "VALIDATION_FAILED", detail: "IN_USE" });
  });

  it("yetkisiz yazma: domain FORBIDDEN atar, hata aktarılır", async () => {
    createLocation.mockRejectedValue(new AppError("FORBIDDEN"));
    const res = await createLocationAction({ slug: "acme", warehouseId: WID, parentId: null, code: "A", name: "n", kind: "STORAGE" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("beklenmeyen hata: genel INTERNAL (ayrıntı sızmaz)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    archiveLocation.mockRejectedValue(new Error("secret sql detail"));
    const res = await archiveLocationAction({ slug: "acme", locationId: LID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expect(JSON.stringify(res)).not.toContain("secret");
  });
});

describe("errorKey eşlemesi", () => {
  it("bilinen kod + ayrıntı", () => {
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" })).toBe("validation_failed_code_taken");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "IN_USE" })).toBe("validation_failed_in_use");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "IN_USE" }, "location")).toBe("validation_failed_in_use_location");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "PARENT_INVALID" })).toBe("validation_failed_parent_invalid");
    expect(errorKey({ code: "FORBIDDEN", detail: "MFA_REQUIRED" })).toBe("forbidden_mfa_required");
    expect(errorKey({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" })).toBe("unauthenticated_recent_auth_required");
  });
  it("kodlar", () => {
    expect(errorKey({ code: "NOT_FOUND" })).toBe("not_found");
    expect(errorKey({ code: "RATE_LIMITED" })).toBe("rate_limited");
    expect(errorKey({ code: "FORBIDDEN" })).toBe("forbidden");
  });
  it("bilinmeyen kod veya ayrıntı genel anahtara düşer", () => {
    expect(errorKey({ code: "WHATEVER" })).toBe("internal");
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "UNKNOWN" })).toBe("validation_failed");
    expect(errorKey({ code: "INSUFFICIENT_STOCK" })).toBe("internal");
  });
});

describe("T-257: kod değiştirme eylemleri", () => {
  it("depo: code domain'e ham iletilir; sonuç changed", async () => {
    renameWarehouse.mockResolvedValue({ changed: true });
    const res = await renameWarehouseAction({ slug: "acme", warehouseId: WID, code: " yeni " });
    expect(res).toMatchObject({ ok: true, data: { changed: true } });
    expect(renameWarehouse.mock.calls[0]?.[1]).toMatchObject({ warehouseId: WID, code: " yeni " });
  });
  it("lokasyon: code domain'e ham iletilir", async () => {
    renameLocation.mockResolvedValue({ changed: false });
    const res = await renameLocationAction({ slug: "acme", locationId: LID, code: "A-10" });
    expect(res).toMatchObject({ ok: true, data: { changed: false } });
    expect(renameLocation.mock.calls[0]?.[1]).toMatchObject({ locationId: LID, code: "A-10" });
  });
  it("şemalar strict: boş kod, uuid değil, bilinmeyen alan (ör. name) reddedilir; domain çağrılmaz", async () => {
    const bad = [
      () => renameWarehouseAction({ slug: "acme", warehouseId: WID, code: "" }),
      () => renameWarehouseAction({ slug: "acme", warehouseId: "x", code: "A" }),
      () => renameWarehouseAction({ slug: "acme", warehouseId: WID, code: "A", name: "n" }),
      () => renameLocationAction({ slug: "acme", locationId: LID }),
      () => renameLocationAction({ slug: "acme", locationId: LID, code: "A", parentId: null }),
    ];
    for (const call of bad) {
      const res = await call();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION_FAILED");
    }
    expect(renameWarehouse).not.toHaveBeenCalled();
    expect(renameLocation).not.toHaveBeenCalled();
  });
  it("sunucu hatası kod + ayrıntıyla aktarılır (CODE_TAKEN, yetki)", async () => {
    renameLocation.mockRejectedValueOnce(new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" }));
    const a = await renameLocationAction({ slug: "acme", locationId: LID, code: "A" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatchObject({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" });
    renameWarehouse.mockRejectedValueOnce(new AppError("FORBIDDEN"));
    const b = await renameWarehouseAction({ slug: "acme", warehouseId: WID, code: "A" });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("FORBIDDEN");
  });
  it("CODE_AMBIGUOUS hata anahtarına eşlenir ve tr/en metni var", () => {
    expect(errorKey({ code: "VALIDATION_FAILED", detail: "CODE_AMBIGUOUS" })).toBe("validation_failed_code_ambiguous");
    for (const lang of ["tr", "en"]) {
      const m = JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../../../messages/${lang}.json`), "utf8")) as { warehouses: { errors: Record<string, unknown> } };
      expect(typeof m.warehouses.errors.validation_failed_code_ambiguous).toBe("string");
      expect(typeof m.warehouses.errors.validation_failed_code_ambiguousAction).toBe("string");
    }
  });
});
