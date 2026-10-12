// T-314: sipariş / rezervasyon / toplama görevlendirme Server Action'ları — yetki bağlamı, doğrulama, anahtar yaşam döngüsü, decimal dizgi iletimi (I-09),
// hata eşlemesi ve i18n kapsamı. Domain komutları sahtedir (iş kuralları T-306/T-307'de, okuma sorguları order-queries.int.test.ts'te sınanır).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const createSalesOrder = vi.hoisted(() => vi.fn());
const reserveOrder = vi.hoisted(() => vi.fn());
const cancelOrderLine = vi.hoisted(() => vi.fn());
const cancelSalesOrder = vi.hoisted(() => vi.fn());
const createPickAssignment = vi.hoisted(() => vi.fn());
const stockByItem = vi.hoisted(() => vi.fn());
const runTenantQuery = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/operations", () => ({ createSalesOrder, reserveOrder, cancelOrderLine, cancelSalesOrder, createPickAssignment }));
vi.mock("@wms/domain/stock", () => ({ stockByItem }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: () => Promise.resolve((key: string) => key) }));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery }));
// Bu dosya istemci modüllerini (order-form.tsx -> receipts/actions.ts, items/actions.ts) içe aktarır; onların sunucu bağımlılıkları sahtelenir.
vi.mock("@wms/domain/catalog", () => ({ getItem: vi.fn(), listItemConversions: vi.fn(), listUnits: vi.fn(), resolveBarcodeQuery: vi.fn(), searchItems: vi.fn(), formatCompound: vi.fn() }));
vi.mock("@wms/domain/warehouse", () => ({ findLocationByCode: vi.fn() }));

import { cancelOrderAction, cancelOrderLineAction, createOrderAction, createPickAssignmentAction, lineStockAction, reserveOrderAction } from "./actions.ts";
import { createKeyRegistry, createdNumberOf, fmtQty, orderErrorKey, rememberCreated, reserveOutcome, sumQuantities, unallocatedOf, validQty } from "./order-form.tsx";
import { submitWithKey, type ActionResult } from "../receipts/receipt-form.tsx";

const OID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const ITEM = "55555555-5555-4555-8555-555555555555";
const UNIT = "77777777-7777-4777-8777-777777777777";
const MEM = "88888888-8888-4888-8888-888888888888";
const KEY = "66666666-6666-4666-8666-666666666666";
const KEY2 = "99999999-9999-4999-8999-999999999999";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://app.example.test";
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
  runTenantQuery.mockResolvedValue("tenant-1");
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const createInput = { slug: "acme", clientKey: KEY, customerRef: " MUS-1 ", lines: [{ itemId: ITEM, unitId: UNIT, quantity: "12.5" }] };
const domainCommands = [createSalesOrder, reserveOrder, cancelOrderLine, cancelSalesOrder, createPickAssignment];

describe("anahtar yaşam döngüsü (ADR-018 §1-3): niyet başına anahtar", () => {
  const seq = (): (() => string) => {
    let n = 0;
    return () => `key-${++n}`;
  };
  const ok = (): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: true, data: { v: 1 } });
  const fail = (code: string, detail?: string): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: false, error: { code, detail, requestId: "r" } });

  it("aynı niyet (imza) aynı tutucuyu verir; ağ hatasında çift gönderim AYNI anahtarı taşır; başarıdan sonra yeni anahtar", async () => {
    const keyFor = createKeyRegistry(seq());
    const used: string[] = [];
    const net = await submitWithKey(keyFor("reserve:o1"), (k) => {
      used.push(k);
      return Promise.reject(new Error("fetch failed"));
    });
    expect(net).toEqual({ ok: false, error: { code: "NETWORK" } });
    const again = await submitWithKey(keyFor("reserve:o1"), (k) => {
      used.push(k);
      return ok();
    });
    expect(again.ok).toBe(true);
    expect(used).toEqual(["key-1", "key-1"]);
    expect(keyFor("reserve:o1").current()).toBe("key-2");
  });

  it("farklı niyet (başka sipariş, başka içerik) ayrı anahtar alır; iş kuralı reddinden sonra aynı içerik aynı anahtarı, içerik değişince yeni anahtar kullanır", async () => {
    const keyFor = createKeyRegistry(seq());
    const a = keyFor("cancel-line:l1:5:neden");
    const b = keyFor("cancel-line:l1:4:neden");
    expect(a.current()).not.toBe(b.current());
    await submitWithKey(a, () => fail("VALIDATION_FAILED"));
    expect(keyFor("cancel-line:l1:5:neden").current()).toBe("key-1"); // sunucu aynı reddi tekrar oynatır
    expect(keyFor("cancel-line:l1:4:neden").current()).toBe("key-2"); // düzeltilmiş içerik = yeni anahtar
  });

  it("geçici sunucu hatasında (INTERNAL, RATE_LIMITED) anahtar korunur", async () => {
    const keyFor = createKeyRegistry(seq());
    await submitWithKey(keyFor("assign:a"), () => fail("INTERNAL"));
    await submitWithKey(keyFor("assign:a"), () => fail("RATE_LIMITED"));
    expect(keyFor("assign:a").current()).toBe("key-1");
  });

  it("varsayılan üretici UUID verir", () => {
    expect(createKeyRegistry()("x").current()).toMatch(UUID_RE);
  });

  it("sunucu eylemi: aynı clientKey iki kez domain'e AYNEN iletilir (tekrar oynatma domain'dedir)", async () => {
    reserveOrder.mockResolvedValue({ replayed: false, lines: [] });
    await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID });
    await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID });
    await reserveOrderAction({ slug: "acme", clientKey: KEY2, orderId: OID });
    expect(reserveOrder.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey)).toEqual([KEY, KEY, KEY2]);
  });
});

describe("yetki bağlamı: komut izni sunucuda denetlenir (G: ekran kilidi yalnızca gösterim)", () => {
  it("izin eşlemesi: oluşturma document.create; rezervasyon, iptal ve görevlendirme document.approve", async () => {
    createSalesOrder.mockResolvedValue({ documentId: OID, documentNumber: "SIP-1", replayed: false });
    reserveOrder.mockResolvedValue({ replayed: false, lines: [] });
    cancelOrderLine.mockResolvedValue({ replayed: false });
    cancelSalesOrder.mockResolvedValue({ replayed: false });
    createPickAssignment.mockResolvedValue({ replayed: false, groupId: null, taskIds: [], lines: [] });
    await createOrderAction(createInput);
    await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID });
    await cancelOrderLineAction({ slug: "acme", clientKey: KEY, lineId: LID, quantity: "1", reason: "müşteri vazgeçti" });
    await cancelOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, expectedVersion: 3, reason: "müşteri vazgeçti" });
    await createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [OID] });
    const permissions = runTenantQuery.mock.calls.map((c) => (c[0] as { permission: string }).permission);
    expect(permissions).toEqual(["document.create", "document.approve", "document.approve", "document.approve", "document.approve"]);
  });

  it("yetkisiz çağıran: FORBIDDEN döner, domain komutu ÇAĞRILMAZ", async () => {
    runTenantQuery.mockRejectedValue(new AppError("FORBIDDEN"));
    expect(await createOrderAction(createInput)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [OID] })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    for (const f of domainCommands) expect(f).not.toHaveBeenCalled();
  });

  it("oturum yok: UNAUTHENTICATED", async () => {
    getPrincipal.mockResolvedValue(null);
    expect(await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    for (const f of domainCommands) expect(f).not.toHaveBeenCalled();
  });
});

describe("domain çağrısı: dizgi miktarlar ve anahtar olduğu gibi gider (I-09)", () => {
  it("sipariş oluşturma: miktar dizgi, müşteri referansı domain'e verilir, boş referans/numara iletilmez; sonuç sipariş kimliği + numara", async () => {
    createSalesOrder.mockResolvedValue({ documentId: OID, documentNumber: "SIP-2026-AB12CD34", replayed: false });
    const res = await createOrderAction(createInput);
    expect(res).toEqual({ ok: true, data: { orderId: OID, number: "SIP-2026-AB12CD34", replayed: false } });
    const [params, input] = createSalesOrder.mock.calls[0] as [{ clientKey: string; tenantSlug: string }, { customerRef?: string; number?: string; lines: { quantity: unknown }[] }];
    expect(params.clientKey).toBe(KEY);
    expect(params.tenantSlug).toBe("acme");
    expect(typeof input.lines[0]?.quantity).toBe("string");
    expect(input.lines[0]?.quantity).toBe("12.5");
    expect(input.customerRef).toBe(" MUS-1 ");
    await createOrderAction({ slug: "acme", clientKey: KEY, customerRef: "   ", number: "", lines: [{ itemId: ITEM, unitId: UNIT, quantity: "1" }] });
    const second = createSalesOrder.mock.calls[1]?.[1] as object;
    expect("customerRef" in second).toBe(false);
    expect("number" in second).toBe(false);
  });

  it("rezervasyon: overrides yoksa iletilmez (A-138 önerisi); varsa boyut + dizgi miktar AYNEN; sonuç satır başına tahsis", async () => {
    reserveOrder.mockResolvedValue({ replayed: false, lines: [{ lineId: LID, lineNo: 1, quantity: "4.000000" }, { lineId: OID, lineNo: 2, quantity: "0.000000" }] });
    const auto = await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID });
    expect(auto).toEqual({ ok: true, data: { replayed: false, lines: [{ lineId: LID, lineNo: 1, quantity: "4.000000" }, { lineId: OID, lineNo: 2, quantity: "0.000000" }] } });
    expect("overrides" in (reserveOrder.mock.calls[0]?.[1] as object)).toBe(false);
    const overrides = [{ lineId: LID, allocations: [{ dimension: { locationId: LOC, lotId: null, serialId: null, stockStatus: "AVAILABLE" as const }, quantity: "3" }] }];
    await reserveOrderAction({ slug: "acme", clientKey: KEY2, orderId: OID, overrides });
    expect(reserveOrder.mock.calls[1]?.[1]).toMatchObject({ orderId: OID, overrides });
  });

  it("satır iptali: gerekçe kırpılır ve iletilir; sipariş iptali sürümü sayı olarak taşır", async () => {
    cancelOrderLine.mockResolvedValue({ replayed: false });
    cancelSalesOrder.mockResolvedValue({ replayed: false });
    await cancelOrderLineAction({ slug: "acme", clientKey: KEY, lineId: LID, quantity: "2.5", reason: "  yanlış ürün  " });
    expect(cancelOrderLine.mock.calls[0]?.[1]).toMatchObject({ lineId: LID, quantity: "2.5", reason: "yanlış ürün" });
    await cancelOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, expectedVersion: 4, reason: "iptal" });
    expect(cancelSalesOrder.mock.calls[0]?.[1]).toMatchObject({ orderId: OID, expectedVersion: 4, reason: "iptal" });
  });

  it("görevlendirme: toplayıcı isteğe bağlı; görev üretilmediyse groupId null ve taskCount 0 AÇIKÇA döner (sessiz başarı yok)", async () => {
    createPickAssignment.mockResolvedValueOnce({ replayed: false, groupId: null, taskIds: [], lines: [{ lineId: LID, lineNo: 1, quantity: "0.000000" }] });
    const none = await createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [OID] });
    expect(none).toEqual({ ok: true, data: { replayed: false, groupId: null, taskCount: 0, lines: [{ lineId: LID, lineNo: 1, quantity: "0.000000" }] } });
    expect("assigneeMembershipId" in (createPickAssignment.mock.calls[0]?.[1] as object)).toBe(false);
    createPickAssignment.mockResolvedValueOnce({ replayed: false, groupId: LOC, taskIds: [OID, LID], lines: [] });
    const some = await createPickAssignmentAction({ slug: "acme", clientKey: KEY2, orderIds: [OID, LID], assigneeMembershipId: MEM });
    expect(some).toMatchObject({ ok: true, data: { groupId: LOC, taskCount: 2 } });
    expect(createPickAssignment.mock.calls[1]?.[1]).toMatchObject({ orderIds: [OID, LID], assigneeMembershipId: MEM });
  });

  it("elle tahsis stok listesi: uygunluk kuralı yeniden yazılmaz, sorgunun `available` değeri 0 olan boyut elenir", async () => {
    stockByItem.mockResolvedValue({
      nextCursor: null,
      rows: [
        { locationId: LOC, locationCode: "A-01", warehouseCode: "ANA", stockStatus: "AVAILABLE", lot: null, serial: null, owner: null, handlingUnit: null, available: "7.000000" },
        { locationId: OID, locationCode: "KAR-1", warehouseCode: "ANA", stockStatus: "QUARANTINE", lot: null, serial: null, owner: null, handlingUnit: null, available: "0.000000" },
      ],
    });
    const res = await lineStockAction({ slug: "acme", itemId: ITEM });
    expect(res).toMatchObject({ ok: true, data: { truncated: false, rows: [{ locationCode: "A-01", available: "7.000000", dimension: { locationId: LOC, lotId: null, stockStatus: "AVAILABLE" } }] } });
    expect((res as { data: { rows: unknown[] } }).data.rows).toHaveLength(1);
  });
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["anahtar yok", () => reserveOrderAction({ slug: "acme", orderId: OID })],
    ["anahtar uuid değil", () => reserveOrderAction({ slug: "acme", clientKey: "x", orderId: OID })],
    ["sipariş kimliği uuid değil", () => reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: "1" })],
    ["miktar sayı tipinde (float yasak)", () => createOrderAction({ slug: "acme", clientKey: KEY, lines: [{ itemId: ITEM, unitId: UNIT, quantity: 5 }] })],
    ["satır yok", () => createOrderAction({ slug: "acme", clientKey: KEY, lines: [] })],
    ["bilinmeyen alan", () => createOrderAction({ slug: "acme", clientKey: KEY, lines: [{ itemId: ITEM, unitId: UNIT, quantity: "1" }], extra: 1 })],
    ["satır iptali gerekçesiz", () => cancelOrderLineAction({ slug: "acme", clientKey: KEY, lineId: LID, quantity: "1" })],
    ["satır iptali boşluk gerekçe", () => cancelOrderLineAction({ slug: "acme", clientKey: KEY, lineId: LID, quantity: "1", reason: "   " })],
    ["sipariş iptali gerekçesiz", () => cancelOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, expectedVersion: 1 })],
    ["sipariş iptali sürüm kesirli", () => cancelOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, expectedVersion: 1.5, reason: "x" })],
    ["görevlendirme sipariş listesi boş", () => createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [] })],
    ["görevlendirme toplayıcı uuid değil", () => createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [OID], assigneeMembershipId: "ali" })],
    ["elle tahsis miktarı sayı", () => reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, overrides: [{ lineId: LID, allocations: [{ dimension: { locationId: LOC }, quantity: 3 }] }] })],
    ["elle tahsis durumu geçersiz", () => reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID, overrides: [{ lineId: LID, allocations: [{ dimension: { locationId: LOC, stockStatus: "X" }, quantity: "3" }] }] })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      for (const f of domainCommands) expect(f).not.toHaveBeenCalled();
    });
  }
});

describe("hata eşlemesi: sunucu kodu kod + ayrıntıyla aktarılır, ekran neden + sonraki eylem seçer", () => {
  it("sunucu hataları sessizce yutulmaz", async () => {
    reserveOrder.mockRejectedValue(new AppError("INSUFFICIENT_STOCK"));
    expect(await reserveOrderAction({ slug: "acme", clientKey: KEY, orderId: OID })).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_STOCK" } });
    createPickAssignment.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" }));
    expect(await createPickAssignmentAction({ slug: "acme", clientKey: KEY, orderIds: [OID] })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" } });
    reserveOrder.mockRejectedValue(new AppError("LOCATION_LOCKED"));
    expect(await reserveOrderAction({ slug: "acme", clientKey: KEY2, orderId: OID })).toMatchObject({ ok: false, error: { code: "LOCATION_LOCKED" } });
  });

  it("INSUFFICIENT_STOCK → tahsis edilemeyen miktar; LOCATION_LOCKED; DOCUMENT_STATE; FORBIDDEN (kapsam ayrı)", () => {
    expect(orderErrorKey({ code: "INSUFFICIENT_STOCK" }, "reserve")).toBe("insufficient_stock");
    expect(orderErrorKey({ code: "LOCATION_LOCKED" }, "reserve")).toBe("location_locked");
    expect(orderErrorKey({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" }, "assign")).toBe("document_state");
    expect(orderErrorKey({ code: "FORBIDDEN" }, "assign")).toBe("forbidden");
    expect(orderErrorKey({ code: "FORBIDDEN", detail: "WAREHOUSE_OUT_OF_SCOPE" }, "reserve")).toBe("forbidden_scope");
    expect(orderErrorKey({ code: "NETWORK" }, "create")).toBe("network");
    expect(orderErrorKey({ code: "WHATEVER" }, "create")).toBe("internal");
  });

  it("ayrıntısız VALIDATION_FAILED işleme göre açıklanır; bilinen ayrıntılar öncelikli", () => {
    expect(orderErrorKey({ code: "VALIDATION_FAILED" }, "assign")).toBe("assign_invalid");
    expect(orderErrorKey({ code: "VALIDATION_FAILED" }, "cancel")).toBe("cancel_invalid");
    expect(orderErrorKey({ code: "VALIDATION_FAILED" }, "reserve")).toBe("reserve_invalid");
    expect(orderErrorKey({ code: "VALIDATION_FAILED" }, "create")).toBe("validation_failed");
    expect(orderErrorKey({ code: "VALIDATION_FAILED", detail: "CODE_TAKEN" }, "create")).toBe("code_taken");
    expect(orderErrorKey({ code: "VALIDATION_FAILED", detail: "QUANTITY_SCALE" }, "cancel")).toBe("quantity_scale");
    expect(orderErrorKey({ code: "VALIDATION_FAILED", detail: "DOCUMENT_TOO_LARGE" }, "assign")).toBe("too_large");
  });
});

describe("gösterim yardımcıları (kural değil, biçim)", () => {
  it("fmtQty: sondaki sıfırlar atılır, tam sayı korunur, sayı olmayan olduğu gibi kalır", () => {
    expect(fmtQty("4.000000")).toBe("4");
    expect(fmtQty("2.500000")).toBe("2.5");
    expect(fmtQty("10")).toBe("10");
    expect(fmtQty("100.000000")).toBe("100");
    expect(fmtQty("x")).toBe("x");
  });
  it("unallocatedOf: açık − tahsisli, negatif olmaz (BigInt, float yok)", () => {
    expect(unallocatedOf("5.000000", "2.000000")).toBe(3_000_000n);
    expect(unallocatedOf("5.000000", "5.000000")).toBe(0n);
    expect(unallocatedOf("2.000000", "5.000000")).toBe(0n);
    expect(unallocatedOf("0.100000", "0.000000")).toBe(100_000n);
  });
  it("sumQuantities: ondalık toplam kesin", () => {
    expect(sumQuantities(["0.100000", "0.200000"])).toBe("0.3");
    expect(sumQuantities([])).toBe("0");
    expect(sumQuantities(["4.000000", "0.000000"])).toBe("4");
  });
});

describe("sonuç türü, miktar doğrulama ve oluşturma numarası (A-314a-2)", () => {
  it("reserveOutcome: tam / kısmi / hiç / yeni rezervasyon yok — 0 tahsiste yeşil 'tamamlandı' çıkmaz (SR-MINOR-1)", () => {
    expect(reserveOutcome(5_000_000n, 0)).toBe("full");
    expect(reserveOutcome(3_000_000n, 1)).toBe("partial");
    expect(reserveOutcome(0n, 2)).toBe("none");
    expect(reserveOutcome(0n, 0)).toBe("nothing");
  });

  it("validQty: yalnız 1–999999999 tam sayı; ondalık, sıfır, boş, işaretli reddedilir", () => {
    for (const ok of ["1", "12", "999999999"]) expect(validQty(ok), ok).toBe(true);
    for (const bad of ["", "0", "01", "1.5", "1,5", "-3", "1000000000", " 5", "5 ", "x"]) expect(validQty(bad), bad).toBe(false);
  });

  it("oluşturma numarası: yalnız oluşturma eyleminin kimliğiyle eşleşince döner; başka kimlik (rastgele UUID) göstermez; tüketince silinir", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    try {
      expect(createdNumberOf(OID, false)).toBeNull();
      rememberCreated({ id: OID.toUpperCase(), number: "SIP-2026-AB12CD34" });
      expect(createdNumberOf(LID, false)).toBeNull();
      expect(createdNumberOf(OID, false)).toBe("SIP-2026-AB12CD34");
      expect(createdNumberOf(OID, true)).toBe("SIP-2026-AB12CD34");
      expect(createdNumberOf(OID, false)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("i18n: her hata anahtarı için TR + EN ileti ve sonraki eylem var; anahtar kümeleri eşit", () => {
  const dir = path.join(__dirname, "../../../../messages");
  type Msgs = { orders: Record<string, unknown> & { errors: Record<string, string> } };
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Msgs;
  const keys = new Set<string>();
  const ctxs = ["create", "reserve", "cancel", "assign", "lookup"] as const;
  const errs = [
    ["VALIDATION_FAILED"], ["VALIDATION_FAILED", "DOCUMENT_STATE"], ["VALIDATION_FAILED", "QUANTITY_SCALE"], ["VALIDATION_FAILED", "CODE_TAKEN"], ["VALIDATION_FAILED", "DOCUMENT_TOO_LARGE"],
    ["FORBIDDEN"], ["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"], ["LOCATION_LOCKED"], ["INSUFFICIENT_STOCK"], ["TRACKING_VIOLATION"], ["VERSION_CONFLICT"], ["IDEMPOTENCY_MISMATCH"],
    ["NOT_FOUND"], ["UNAUTHENTICATED"], ["RATE_LIMITED"], ["TENANT_SUSPENDED"], ["TENANT_CLOSING"], ["NETWORK"], ["INTERNAL"],
  ] as const;
  for (const [code, detail] of errs) for (const c of ctxs) keys.add(orderErrorKey({ code, detail }, c));

  for (const f of ["tr.json", "en.json"]) {
    it(`${f}: ${keys.size} hata anahtarı (neden + sonraki eylem)`, () => {
      const m = load(f);
      for (const k of keys) {
        expect(m.orders.errors[k], `${f} errors.${k}`).toBeTruthy();
        expect(m.orders.errors[`${k}Action`], `${f} errors.${k}Action`).toBeTruthy();
      }
    });
  }

  it("TR ve EN anahtar kümesi eşit; tüm değerler dolu", () => {
    const flat = (o: unknown, p = ""): string[] => (typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}${k}.`)) : [p]);
    expect(flat(load("tr.json").orders).sort()).toEqual(flat(load("en.json").orders).sort());
    const empties = (o: unknown): number => (typeof o === "object" && o !== null ? Object.values(o).reduce<number>((a, v) => a + empties(v), 0) : o === "" ? 1 : 0);
    expect(empties(load("tr.json").orders)).toBe(0);
    expect(empties(load("en.json").orders)).toBe(0);
  });

  it("terim tutarlılığı (R-08): rezervasyon ailesi tek terim; 'tahsis' / 'ayır' ve teknik terimler ekran metninde yok; hitap 'sen'", () => {
    const text = JSON.stringify(load("tr.json").orders).toLowerCase();
    for (const banned of ["tahsis", "ayır", "override", "uuid", "sku", "yönetici ne", "yapınız", "giriniz"]) expect(text, banned).not.toContain(banned);
    expect(text).toContain("rezerve");
  });

  it("ekranda kullanılan her `orders.*` anahtarı iletide vardır (kaynak taraması)", () => {
    const src = ["order-form.tsx", "page.tsx", "[orderId]/page.tsx"].map((f) => readFileSync(path.join(__dirname, f), "utf8")).join("\n");
    const tr = load("tr.json").orders;
    const has = (key: string): boolean => key.split(".").reduce<unknown>((o, p) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[p] : undefined), tr) !== undefined;
    const used = [...src.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(50);
    for (const k of used) expect(has(k), `orders.${k}`).toBe(true);
  });
});
