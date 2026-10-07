// T-289: içe aktarma Server Action'ları — girdi doğrulama (domain çağrılmaz), metnin değiştirilmeden domain'e gitmesi, yetki/hata
// aktarımı ve dosya içeriğinin hata yanıtında/logunda görünmemesi (G-09). Domain sahtedir; iş kuralı `import-parse.test.ts` ve
// `tests/integration/onboarding/import.int.test.ts` içinde sınanır.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const previewImport = vi.hoisted(() => vi.fn());
const applyImportChunk = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/onboarding/import", () => ({ IMPORT_MAX_BYTES: 512 * 1024, previewImport, applyImportChunk }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: () => Promise.resolve("t1") }));

import { applyImportChunkAction, previewImportAction } from "./actions.ts";

const CSV = "kod;ad\nA1;Vida\n";
const DIGEST = "a".repeat(64);
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
  vi.restoreAllMocks();
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["önizleme: boş metin", () => previewImportAction({ slug: "acme", text: "" })],
    ["önizleme: metin değil", () => previewImportAction({ slug: "acme", text: 5 })],
    ["önizleme: sınırı aşan metin", () => previewImportAction({ slug: "acme", text: "a".repeat(512 * 1024 + 1) })],
    ["önizleme: bilinmeyen alan", () => previewImportAction({ slug: "acme", text: CSV, extra: 1 })],
    ["uygula: negatif parça", () => applyImportChunkAction({ slug: "acme", text: CSV, chunk: -1, digest: DIGEST })],
    ["uygula: kesirli parça", () => applyImportChunkAction({ slug: "acme", text: CSV, chunk: 0.5, digest: DIGEST })],
    ["uygula: parça eksik", () => applyImportChunkAction({ slug: "acme", text: CSV, digest: DIGEST })],
    ["uygula: özet eksik", () => applyImportChunkAction({ slug: "acme", text: CSV, chunk: 0 })],
    ["uygula: özet biçimi geçersiz", () => applyImportChunkAction({ slug: "acme", text: CSV, chunk: 0, digest: "xyz" })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      expect(previewImport).not.toHaveBeenCalled();
      expect(applyImportChunk).not.toHaveBeenCalled();
    });
  }
});

describe("domain çağrısı", () => {
  it("önizleme: metin değiştirilmeden, istek kimliğiyle gider ve sonuç aynen döner", async () => {
    previewImport.mockResolvedValue({ kind: "PRODUCTS", rowCount: 1, issues: [], issueTotal: 0, chunkCount: 1, digest: "d" });
    const res = await previewImportAction({ slug: "acme", text: `﻿${CSV}` });
    expect(res.ok).toBe(true);
    expect(previewImport).toHaveBeenCalledTimes(1);
    const [params, text] = previewImport.mock.calls[0] as [{ tenantSlug: string; requestId: string }, string];
    expect(text).toBe(`﻿${CSV}`);
    expect(params.tenantSlug).toBe("acme");
    expect(typeof params.requestId).toBe("string");
  });

  it("uygula: parça numarası ve metin iletilir", async () => {
    applyImportChunk.mockResolvedValue({ chunk: 2, complete: false, rows: [{ row: 5, code: "A1", status: "FAILED", errorCode: "INTERNAL", errorDetail: "SECRET_DETAIL" }] });
    const res = await applyImportChunkAction({ slug: "acme", text: CSV, chunk: 2, digest: DIGEST });
    // errorDetail istemciye gitmez (MINOR-6); diğer alanlar aynen döner.
    expect(res).toEqual({ ok: true, data: { chunk: 2, complete: false, rows: [{ row: 5, code: "A1", status: "FAILED", errorCode: "INTERNAL" }] } });
    expect(applyImportChunk.mock.calls[0]?.[1]).toEqual({ text: CSV, chunk: 2, digest: DIGEST });
  });
});

describe("hata aktarımı", () => {
  it("yetkisiz: FORBIDDEN kodu döner, dosya içeriği yanıtta yok", async () => {
    applyImportChunk.mockRejectedValue(new AppError("FORBIDDEN"));
    const res = await applyImportChunkAction({ slug: "acme", text: CSV, chunk: 0, digest: DIGEST });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(res)).not.toContain("Vida");
  });

  it("hatalı satır: VALIDATION_FAILED aktarılır", async () => {
    applyImportChunk.mockRejectedValue(new AppError("VALIDATION_FAILED"));
    const res = await applyImportChunkAction({ slug: "acme", text: CSV, chunk: 0, digest: DIGEST });
    expect(res.ok === false && res.error.code).toBe("VALIDATION_FAILED");
  });

  it("beklenmeyen hata: genel INTERNAL; ne yanıta ne loga dosya içeriği ya da ayrıntı girer (G-09)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    previewImport.mockRejectedValue(new Error(`secret sql detail ${CSV}`));
    const res = await previewImportAction({ slug: "acme", text: CSV });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INTERNAL");
    expect(JSON.stringify(res)).not.toMatch(/secret|Vida/);
    const logged = JSON.stringify([...log.mock.calls, ...out.mock.calls]);
    expect(logged).not.toMatch(/secret|Vida/);
  });

  it("oturum yok: UNAUTHENTICATED, domain çağrılmaz", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await previewImportAction({ slug: "acme", text: CSV });
    expect(res.ok === false && res.error.code).toBe("UNAUTHENTICATED");
    expect(previewImport).not.toHaveBeenCalled();
  });
});
