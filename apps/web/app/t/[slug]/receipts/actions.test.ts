// T-313: mal kabul/yerleştirme Server Action'ları — anahtar yaşam döngüsü, decimal dizgi iletimi (I-09), hata eşlemesi ve i18n kapsamı.
// Domain komutları sahtedir (iş kuralları T-305'te, okuma sorgusu receiving-queries.int.test.ts'te sınanır).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const receiveGoods = vi.hoisted(() => vi.fn());
const putaway = vi.hoisted(() => vi.fn());
const createInboundReceipt = vi.hoisted(() => vi.fn());
const openInboundReceipt = vi.hoisted(() => vi.fn());
const approveQuality = vi.hoisted(() => vi.fn());
const getAvailableAtLocation = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/operations", () => ({ receiveGoods, putaway, createInboundReceipt, openInboundReceipt, approveQuality, getAvailableAtLocation }));
vi.mock("@wms/domain/catalog", () => ({ getItem: vi.fn(), listItemConversions: vi.fn(), listUnits: vi.fn(), resolveBarcodeQuery: vi.fn(), searchItems: vi.fn() }));
vi.mock("@wms/domain/warehouse", () => ({ findLocationByCode: vi.fn() }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: () => Promise.resolve((key: string) => key) }));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: () => Promise.resolve("t1") }));

import { approveQualityAction, createReceiptAction, putawayAction, receiveGoodsAction } from "./actions.ts";
import { createKeyHolder, errorKeyOf, intOf, scanMismatch, submitWithKey, type ActionResult } from "./receipt-form.tsx";

const RID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const LOC2 = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const KEY = "66666666-6666-4666-8666-666666666666";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

describe("anahtar yaşam döngüsü (ADR-018 §1-3)", () => {
  const seq = (): (() => string) => {
    let n = 0;
    return () => `key-${++n}`;
  };
  const ok = (): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: true, data: { v: 1 } });
  const fail = (code: string, detail?: string): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: false, error: { code, detail, requestId: "r" } });

  it("form açılışında üretilir; ağ hatasında aynı anahtarla yeniden gönderilir; başarıdan sonra yenilenir", async () => {
    const h = createKeyHolder(seq());
    const used: string[] = [];
    const net = await submitWithKey(h, (k) => {
      used.push(k);
      return Promise.reject(new Error("fetch failed"));
    });
    expect(net).toEqual({ ok: false, error: { code: "NETWORK" } });
    const again = await submitWithKey(h, (k) => {
      used.push(k);
      return ok();
    });
    expect(again.ok).toBe(true);
    expect(used).toEqual(["key-1", "key-1"]);
    expect(h.current()).toBe("key-2");
  });

  it("geçici sunucu hatasında (INTERNAL, RATE_LIMITED) anahtar korunur", async () => {
    const h = createKeyHolder(seq());
    await submitWithKey(h, () => fail("INTERNAL"));
    await submitWithKey(h, () => fail("RATE_LIMITED"));
    expect(h.current()).toBe("key-1");
    h.contentChanged();
    expect(h.current()).toBe("key-1");
  });

  it("iş kuralı reddinden sonra: içerik aynıysa aynı anahtar, içerik değişince yeni anahtar", async () => {
    const h = createKeyHolder(seq());
    const r = await submitWithKey(h, () => fail("VALIDATION_FAILED"));
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(h.current()).toBe("key-1");
    await submitWithKey(h, () => fail("LOCATION_LOCKED"));
    expect(h.current()).toBe("key-1");
    h.contentChanged();
    expect(h.current()).toBe("key-2");
    h.contentChanged();
    expect(h.current()).toBe("key-2");
  });

  it("başarıdan önceki içerik değişikliği anahtarı değiştirmez (yalnız ret sonrası)", async () => {
    const h = createKeyHolder(seq());
    h.contentChanged();
    expect(h.current()).toBe("key-1");
  });

  it("varsayılan üretici UUID verir", () => {
    expect(createKeyHolder().current()).toMatch(UUID_RE);
  });

  it("açma anahtarı: aynı oluşturma anahtarından belirlenimci, girdiden farklı, geçerli UUID; başka anahtardan farklı", async () => {
    createInboundReceipt.mockResolvedValue({ documentId: RID, documentNumber: "KBL-1", replayed: false });
    openInboundReceipt.mockResolvedValue({});
    const input = { slug: "acme", warehouseId: LOC, lines: [{ itemId: ITEM, unitId: LOC2, expectedQuantity: "1" }] };
    await createReceiptAction({ ...input, clientKey: KEY });
    await createReceiptAction({ ...input, clientKey: KEY });
    await createReceiptAction({ ...input, clientKey: LOC });
    const opened = openInboundReceipt.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey);
    expect(opened[0]).toBe(opened[1]);
    expect(opened[0]).not.toBe(KEY);
    expect(opened[0]).toMatch(UUID_RE);
    expect(opened[2]).not.toBe(opened[0]);
  });
});

describe("domain çağrısı: anahtar ve miktar dizgileri olduğu gibi gider (I-09)", () => {
  it("receiveGoods: clientKey ve dizgi miktarlar; damaged yoksa iletilmez", async () => {
    receiveGoods.mockResolvedValue({ replayed: false });
    for (const received of ["12", "0.5", "12.500000", "007"]) {
      const res = await receiveGoodsAction({ slug: "acme", clientKey: KEY, receiptId: RID, lines: [{ lineId: LID, received, locationId: LOC }] });
      expect(res, received).toEqual({ ok: true, data: { replayed: false } });
      const [params, input] = receiveGoods.mock.calls.at(-1) as [{ clientKey: string; tenantSlug: string }, { lines: { received: unknown; damaged?: unknown }[]; receiptId: string }];
      expect(params.clientKey).toBe(KEY);
      expect(params.tenantSlug).toBe("acme");
      expect(input.receiptId).toBe(RID);
      expect(typeof input.lines[0]?.received).toBe("string");
      expect(input.lines[0]?.received).toBe(received);
      expect("damaged" in (input.lines[0] ?? {})).toBe(false);
    }
    await receiveGoodsAction({ slug: "acme", clientKey: KEY, receiptId: RID, lines: [{ lineId: LID, received: "10", damaged: "2", locationId: LOC }] });
    expect((receiveGoods.mock.calls.at(-1)?.[1] as { lines: { damaged: unknown }[] }).lines[0]?.damaged).toBe("2");
  });

  it("putaway: görevli ve görevsiz; miktar dizgi", async () => {
    putaway.mockResolvedValue({ replayed: false });
    await putawayAction({ slug: "acme", clientKey: KEY, taskId: RID, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "10" });
    expect(putaway.mock.calls[0]?.[1]).toMatchObject({ taskId: RID, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "10" });
    await putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "3.5" });
    const second = putaway.mock.calls[1]?.[1] as { quantity: unknown };
    expect(second.quantity).toBe("3.5");
    expect("taskId" in second).toBe(false);
  });

  it("teslim oluşturma: oluştur + aç; açma anahtarı türetilir, beklenen miktar dizgi", async () => {
    createInboundReceipt.mockResolvedValue({ documentId: RID, documentNumber: "KBL-2026-000001", replayed: false });
    openInboundReceipt.mockResolvedValue({});
    const res = await createReceiptAction({ slug: "acme", clientKey: KEY, warehouseId: LOC, supplierRef: " IRS-1 ", lines: [{ itemId: ITEM, unitId: LOC2, expectedQuantity: "12" }] });
    expect(res).toEqual({ ok: true, data: { receiptId: RID, number: "KBL-2026-000001" } });
    expect((createInboundReceipt.mock.calls[0]?.[0] as { clientKey: string }).clientKey).toBe(KEY);
    expect((createInboundReceipt.mock.calls[0]?.[1] as { lines: { expectedQuantity: unknown }[] }).lines[0]?.expectedQuantity).toBe("12");
    expect((openInboundReceipt.mock.calls[0]?.[0] as { clientKey: string }).clientKey).not.toBe(KEY);
    expect(openInboundReceipt.mock.calls[0]?.[1]).toMatchObject({ receiptId: RID, expectedVersion: 1 });
  });

  it("açma başarısız olursa hata döner; aynı anahtarla yeniden gönderimde oluşturma aynı anahtarla çağrılır (tekrar oynatma)", async () => {
    createInboundReceipt.mockResolvedValue({ documentId: RID, documentNumber: "KBL-1", replayed: false });
    openInboundReceipt.mockRejectedValueOnce(new AppError("VERSION_CONFLICT")).mockResolvedValueOnce({});
    const input = { slug: "acme", clientKey: KEY, warehouseId: LOC, lines: [{ itemId: ITEM, unitId: LOC2, expectedQuantity: "1" }] };
    expect(await createReceiptAction(input)).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
    expect(await createReceiptAction(input)).toMatchObject({ ok: true });
    expect(createInboundReceipt.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey)).toEqual([KEY, KEY]);
  });

  it("kalite onayı: document.approve komutu, tüm belge", async () => {
    approveQuality.mockResolvedValue({ replayed: false });
    expect(await approveQualityAction({ slug: "acme", clientKey: KEY, receiptId: RID })).toEqual({ ok: true, data: { replayed: false } });
    expect(approveQuality.mock.calls[0]?.[1]).toMatchObject({ receiptId: RID });
  });
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["anahtar yok", () => receiveGoodsAction({ slug: "acme", receiptId: RID, lines: [{ lineId: LID, received: "1", locationId: LOC }] })],
    ["anahtar uuid değil", () => receiveGoodsAction({ slug: "acme", clientKey: "x", receiptId: RID, lines: [{ lineId: LID, received: "1", locationId: LOC }] })],
    ["miktar sayı tipinde (float yasak)", () => receiveGoodsAction({ slug: "acme", clientKey: KEY, receiptId: RID, lines: [{ lineId: LID, received: 5, locationId: LOC }] })],
    ["miktar boş", () => putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "" })],
    ["satır yok", () => receiveGoodsAction({ slug: "acme", clientKey: KEY, receiptId: RID, lines: [] })],
    ["bilinmeyen alan", () => putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "1", extra: 1 })],
    ["hedef uuid değil", () => putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: "x", itemId: ITEM, quantity: "1" })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      for (const f of [receiveGoods, putaway, createInboundReceipt, approveQuality]) expect(f).not.toHaveBeenCalled();
    });
  }

  it("oturum yok: UNAUTHENTICATED", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "1" });
    expect(res).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(putaway).not.toHaveBeenCalled();
  });
});

describe("hata eşlemesi", () => {
  it("sunucu hatası kod + ayrıntıyla aktarılır", async () => {
    receiveGoods.mockRejectedValue(new AppError("VALIDATION_FAILED"));
    expect(await receiveGoodsAction({ slug: "acme", clientKey: KEY, receiptId: RID, lines: [{ lineId: LID, received: "99", locationId: LOC }] })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    putaway.mockRejectedValue(new AppError("LOCATION_LOCKED"));
    expect(await putawayAction({ slug: "acme", clientKey: KEY, sourceLocationId: LOC, targetLocationId: LOC2, itemId: ITEM, quantity: "1" })).toMatchObject({ ok: false, error: { code: "LOCATION_LOCKED" } });
    approveQuality.mockRejectedValue(new AppError("FORBIDDEN"));
    expect(await approveQualityAction({ slug: "acme", clientKey: KEY, receiptId: RID })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("OVER_RECEIPT: kabulde ayrıntısız VALIDATION_FAILED sade 'fazla okuttun' iletisine eşlenir (A-305-3)", () => {
    expect(errorKeyOf({ code: "VALIDATION_FAILED" }, "receive")).toBe("over_receipt");
    expect(errorKeyOf({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" }, "receive")).toBe("document_state");
    expect(errorKeyOf({ code: "VALIDATION_FAILED", detail: "QUANTITY_SCALE" }, "receive")).toBe("quantity_scale");
    expect(errorKeyOf({ code: "VALIDATION_FAILED" }, "putaway")).toBe("putaway_invalid");
    expect(errorKeyOf({ code: "VALIDATION_FAILED" }, "create")).toBe("validation_failed");
    expect(errorKeyOf({ code: "VALIDATION_FAILED", detail: "BARCODE_AMBIGUOUS" }, "scan")).toBe("barcode_ambiguous");
  });

  it("LOCATION_LOCKED, FORBIDDEN, NOT_FOUND ve ağ hatası", () => {
    expect(errorKeyOf({ code: "LOCATION_LOCKED" }, "putaway")).toBe("location_locked");
    expect(errorKeyOf({ code: "FORBIDDEN" }, "approve")).toBe("forbidden");
    expect(errorKeyOf({ code: "FORBIDDEN", detail: "WAREHOUSE_OUT_OF_SCOPE" }, "receive")).toBe("forbidden_scope");
    expect(errorKeyOf({ code: "NOT_FOUND" }, "scan")).toBe("scan_unknown");
    expect(errorKeyOf({ code: "NOT_FOUND" }, "receive")).toBe("not_found");
    expect(errorKeyOf({ code: "NETWORK" }, "receive")).toBe("network");
    expect(errorKeyOf({ code: "WHATEVER" }, "receive")).toBe("internal");
  });

  it("SCAN_MISMATCH: taranan ürün işin ürünlerinden değilse engellenir", () => {
    expect(scanMismatch(ITEM, [LID, LOC])).toBe(true);
    expect(scanMismatch(ITEM, [LID, ITEM])).toBe(false);
    expect(scanMismatch(ITEM, [])).toBe(true);
  });

  it("intOf: yalnız tam sayı değerleri çözer", () => {
    expect(intOf("6.000000")).toBe(6);
    expect(intOf("12")).toBe(12);
    expect(intOf("0.500000")).toBeNull();
    expect(intOf("x")).toBeNull();
    expect(intOf(null)).toBeNull();
  });
});

describe("i18n: her hata anahtarı için TR + EN ileti ve sonraki eylem var", () => {
  const dir = path.join(__dirname, "../../../../messages");
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { receiving: { errors: Record<string, string>; alert: Record<string, string> }; field: Record<string, string> };
  const keys = new Set<string>();
  const ctxs = ["receive", "putaway", "create", "approve", "scan"] as const;
  const errs = [
    ["VALIDATION_FAILED"], ["VALIDATION_FAILED", "DOCUMENT_STATE"], ["VALIDATION_FAILED", "QUANTITY_SCALE"], ["VALIDATION_FAILED", "BARCODE_AMBIGUOUS"], ["FORBIDDEN"], ["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"],
    ["LOCATION_LOCKED"], ["INSUFFICIENT_STOCK"], ["TRACKING_VIOLATION"], ["VERSION_CONFLICT"], ["IDEMPOTENCY_MISMATCH"], ["NOT_FOUND"], ["UNAUTHENTICATED"], ["RATE_LIMITED"],
    ["TENANT_SUSPENDED"], ["TENANT_CLOSING"], ["NETWORK"], ["INTERNAL"], ["COUNT_LOCK_ROW_MISSING"],
  ] as const;
  for (const [code, detail] of errs) for (const c of ctxs) keys.add(errorKeyOf({ code, detail }, c));
  for (const k of ["scan_mismatch", "line_done", "finish_first", "no_stock_here"]) keys.add(k);

  for (const f of ["tr.json", "en.json"]) {
    it(`${f}: ${keys.size} anahtar`, () => {
      const m = load(f);
      for (const k of keys) {
        expect(m.receiving.errors[k], `${f} errors.${k}`).toBeTruthy();
        expect(m.receiving.errors[`${k}Action`], `${f} errors.${k}Action`).toBeTruthy();
      }
      expect(m.receiving.errors.over_receipt).toContain("{remaining}");
      expect(m.field.noPermission).toBeTruthy();
    });
  }

  it("TR ve EN anahtar kümesi eşit; OVER_RECEIPT metni sade Türkçe", () => {
    const flat = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}${k}.`)) : [p];
    expect(flat(load("tr.json").receiving).sort()).toEqual(flat(load("en.json").receiving).sort());
    expect(load("tr.json").receiving.errors.over_receipt).toBe("Beklenenden fazla okuttun. Kalan: {remaining}");
    expect(load("tr.json").receiving.errors.location_locked).toBe("Bu lokasyonda sayım sürüyor.");
  });
});
