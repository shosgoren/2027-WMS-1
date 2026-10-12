// T-315: sevk ve müşteri iadesi Server Action'ları — yetki bağlamı, doğrulama, anahtar yaşam döngüsü, düğme kilidi, çift gönderim (AC-10 UI kolu), decimal dizgi
// iletimi (I-09), hata eşlemesi ve i18n kapsamı. Domain komutları sahtedir (iş kuralları T-308'de, AC-10/AC-08 gerçek koşusu tests/integration'dadır).
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const shipOrder = vi.hoisted(() => vi.fn());
const createCustomerReturn = vi.hoisted(() => vi.fn());
const listWarehouses = vi.hoisted(() => vi.fn());
const findLocationByCode = vi.hoisted(() => vi.fn());
const runTenantQuery = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/operations", () => ({ shipOrder, createCustomerReturn }));
vi.mock("@wms/domain/warehouse", () => ({ listWarehouses, findLocationByCode }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: () => Promise.resolve((key: string) => key) }));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery }));
// Bu dosya istemci modüllerini (ship-flow.tsx -> receipts/actions.ts) içe aktarır; onların sunucu bağımlılıkları sahtelenir.
vi.mock("@wms/domain/catalog", () => ({ getItem: vi.fn(), listItemConversions: vi.fn(), listUnits: vi.fn(), resolveBarcodeQuery: vi.fn(), searchItems: vi.fn(), formatCompound: vi.fn() }));

import { createCustomerReturnAction, returnLocationAction, shipOrderAction } from "./shipping-actions.ts";
import { fromMicro, micro, qtyProblem, remainingOf, shippingErrorKey, show } from "../field/ship/ship-flow.tsx";
import { placeCandidates } from "../field/return/return-flow.tsx";
import { PrimaryButton } from "../field/receive/receive-flow.tsx";
import { createKeyHolder, submitWithKey, type ActionResult } from "../receipts/receipt-form.tsx";

const OID = "11111111-1111-4111-8111-111111111111";
const LID = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const KEY = "66666666-6666-4666-8666-666666666666";
const KEY2 = "99999999-9999-4999-8999-999999999999";
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

const shipInput = { slug: "acme", clientKey: KEY, orderId: OID, lines: [{ orderLineId: LID, quantity: "3.5" }] };
const returnInput = { slug: "acme", clientKey: KEY, orderLineId: LID, quantity: "2", locationId: LOC, reason: " Müşteri vazgeçti " };
const domainCommands = [shipOrder, createCustomerReturn];

describe("anahtar yaşam döngüsü (T-229 deseni: useKeyHolder / submitWithKey)", () => {
  const seq = (): (() => string) => {
    let n = 0;
    return () => `key-${++n}`;
  };
  const ok = (): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: true, data: { v: 1 } });
  const fail = (code: string, detail?: string): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: false, error: { code, detail, requestId: "r" } });

  it("ağ hatasında çift gönderim AYNI anahtarı taşır; başarıdan sonra yeni anahtar", async () => {
    const holder = createKeyHolder(seq());
    const used: string[] = [];
    const net = await submitWithKey(holder, (k) => {
      used.push(k);
      return Promise.reject(new Error("fetch failed"));
    });
    expect(net).toEqual({ ok: false, error: { code: "NETWORK" } });
    expect((await submitWithKey(holder, (k) => (used.push(k), ok()))).ok).toBe(true);
    expect(used).toEqual(["key-1", "key-1"]);
    expect(holder.current()).toBe("key-2");
  });

  it("geçici sunucu hatasında (INTERNAL, RATE_LIMITED) anahtar korunur", async () => {
    const holder = createKeyHolder(seq());
    await submitWithKey(holder, () => fail("INTERNAL"));
    await submitWithKey(holder, () => fail("RATE_LIMITED"));
    expect(holder.current()).toBe("key-1");
  });

  it("iş kuralı reddinden sonra içerik değişmedikçe aynı anahtar (sunucu aynı reddi oynatır); içerik değişince yeni anahtar", async () => {
    const holder = createKeyHolder(seq());
    await submitWithKey(holder, () => fail("INSUFFICIENT_STOCK"));
    holder.contentChanged();
    expect(holder.current()).toBe("key-2");
    await submitWithKey(holder, () => fail("VALIDATION_FAILED", "RETURN_EXCEEDS_SHIPPED"));
    expect(holder.current()).toBe("key-2");
    holder.contentChanged();
    expect(holder.current()).toBe("key-3");
  });

  it("sunucu eylemi: aynı clientKey iki kez domain'e AYNEN iletilir (tekrar oynatma domain'dedir); farklı anahtar ayrı iletilir", async () => {
    shipOrder.mockResolvedValue({ replayed: false });
    await shipOrderAction(shipInput);
    await shipOrderAction(shipInput);
    await shipOrderAction({ ...shipInput, clientKey: KEY2 });
    expect(shipOrder.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey)).toEqual([KEY, KEY, KEY2]);
  });
});

describe("AC-10 UI kolu: çift gönderim tek müşteri çıkışı", () => {
  it("ikinci FARKLI anahtarlı deneme sunucuda reddedilir ve ekran 'sevk edilecek toplanmış miktar yok' iletisini seçer", async () => {
    shipOrder.mockResolvedValueOnce({ replayed: false }).mockRejectedValueOnce(new AppError("INSUFFICIENT_STOCK"));
    const holder = createKeyHolder();
    const first = await submitWithKey(holder, (clientKey) => shipOrderAction({ ...shipInput, clientKey }));
    expect(first.ok).toBe(true);
    const second = await submitWithKey(holder, (clientKey) => shipOrderAction({ ...shipInput, clientKey }));
    expect(second).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_STOCK" } });
    if (second.ok) throw new Error("unreachable");
    const keys = shipOrder.mock.calls.map((c) => (c[0] as { clientKey: string }).clientKey);
    expect(keys[0]).not.toBe(keys[1]); // başarıdan sonra yeni anahtar: ikinci deneme AYRI niyettir
    expect(shipOrder).toHaveBeenCalledTimes(2);
    const key = shippingErrorKey(second.error);
    expect(key).toBe("insufficient_stock");
    const tr = JSON.parse(readFileSync(path.join(__dirname, "../../../../messages/tr.json"), "utf8")) as { shipping: { errors: Record<string, string> } };
    expect(tr.shipping.errors[key]).toBe("Bu sipariş için sevk edilecek toplanmış miktar yok.");
  });

  it("sipariş ilk sevkle KAPANMIŞSA ikinci deneme domain'de VALIDATION_FAILED/DOCUMENT_STATE verir: ekran aynı 'sevk edilecek toplanmış miktar yok' iletisini seçer", async () => {
    shipOrder.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" }));
    const res = await shipOrderAction({ ...shipInput, clientKey: KEY2 });
    expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" } });
    if (res.ok) throw new Error("unreachable");
    const tr = JSON.parse(readFileSync(path.join(__dirname, "../../../../messages/tr.json"), "utf8")) as { shipping: { errors: Record<string, string> } };
    expect(tr.shipping.errors[shippingErrorKey(res.error)]).toBe("Bu sipariş için sevk edilecek toplanmış miktar yok.");
  });

  it("düğme kilidi: gönderimde birincil düğme devre dışıdır (aria-busy); akış çift basışı ref ile de keser", () => {
    const html = renderToStaticMarkup(PrimaryButton({ loading: true, children: "Sevk et" }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(PrimaryButton({ children: "Sevk et" }))).not.toContain('disabled=""');
    const ship = readFileSync(path.join(__dirname, "../field/ship/ship-flow.tsx"), "utf8");
    expect(ship).toMatch(/<PrimaryButton loading=\{busy\} onClick=\{\(\) => void confirm\(\)\}>/);
    expect(ship).toMatch(/async function confirm\(\)[^{]*\{\s*if \(busyRef\.current\) return;/);
    const ret = readFileSync(path.join(__dirname, "../field/return/return-flow.tsx"), "utf8");
    expect(ret).toMatch(/<PrimaryButton loading=\{busy\} onClick=\{\(\) => void confirm\(\)\}>/);
    expect(ret).toMatch(/async function confirm\(\)[^{]*\{\s*if \(busyRef\.current \|\|/);
  });
});

describe("yetki bağlamı: komut izni sunucuda denetlenir (ekran kilidi yalnızca gösterim)", () => {
  it("sevk ve iade stock.post ister", async () => {
    shipOrder.mockResolvedValue({ replayed: false });
    createCustomerReturn.mockResolvedValue({ replayed: false });
    await shipOrderAction(shipInput);
    await createCustomerReturnAction(returnInput);
    expect(runTenantQuery.mock.calls.map((c) => (c[0] as { permission: string }).permission)).toEqual(["stock.post", "stock.post"]);
  });

  it("yetkisiz çağıran: FORBIDDEN döner, domain komutu ÇAĞRILMAZ", async () => {
    runTenantQuery.mockRejectedValue(new AppError("FORBIDDEN"));
    expect(await shipOrderAction(shipInput)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await createCustomerReturnAction(returnInput)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    for (const f of domainCommands) expect(f).not.toHaveBeenCalled();
  });

  it("oturum yok: UNAUTHENTICATED", async () => {
    getPrincipal.mockResolvedValue(null);
    expect(await shipOrderAction(shipInput)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await returnLocationAction({ slug: "acme", code: "KABUL-1" })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    for (const f of domainCommands) expect(f).not.toHaveBeenCalled();
  });
});

describe("domain çağrısı: dizgi miktarlar ve anahtar olduğu gibi gider (I-09)", () => {
  it("sevk: satır miktarı dizgi, istek kimliği eklenir; sonuç yalnız tekrar oynatma bayrağı", async () => {
    shipOrder.mockResolvedValue({ replayed: true, documentId: "gizli" });
    const res = await shipOrderAction(shipInput);
    expect(res).toEqual({ ok: true, data: { replayed: true } });
    const [params, input] = shipOrder.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({ clientKey: KEY, tenantSlug: "acme" });
    expect(input).toMatchObject({ orderId: OID, lines: [{ orderLineId: LID, quantity: "3.5" }] });
    expect(typeof input.requestId).toBe("string");
  });

  it("iade: miktar dizgi, neden kırpılır, hedef raf ve satır AYNEN iletilir", async () => {
    createCustomerReturn.mockResolvedValue({ replayed: false });
    expect(await createCustomerReturnAction(returnInput)).toEqual({ ok: true, data: { replayed: false } });
    expect(createCustomerReturn.mock.calls[0]?.[1]).toMatchObject({ orderLineId: LID, quantity: "2", locationId: LOC, reason: "Müşteri vazgeçti" });
  });

  it("raf kodu çözümü: etkin depolarda aranır; eşleşme türü ve durumu ile döner; hiç yoksa NOT_FOUND", async () => {
    listWarehouses.mockResolvedValue({ items: [{ id: "w1", status: "ACTIVE" }, { id: "w2", status: "ARCHIVED" }, { id: "w3", status: "ACTIVE" }] });
    findLocationByCode.mockImplementation((_p: unknown, i: { warehouseId: string }) =>
      Promise.resolve(i.warehouseId === "w1" ? { id: LOC, code: "KABUL-1", name: "Kabul 1", kind: "RECEIVING", status: "ACTIVE" } : null),
    );
    expect(await returnLocationAction({ slug: "acme", code: " KABUL-1 " })).toEqual({
      ok: true,
      data: { matches: [{ id: LOC, code: "KABUL-1", name: "Kabul 1", kind: "RECEIVING", status: "ACTIVE" }] },
    });
    expect(findLocationByCode).toHaveBeenCalledTimes(2); // arşivlenmiş depo aranmaz
    findLocationByCode.mockResolvedValue(null);
    expect(await returnLocationAction({ slug: "acme", code: "YOK" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("doğrulama hataları (domain çağrılmaz)", () => {
  const cases: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ["sevk: anahtar yok", () => shipOrderAction({ slug: "acme", orderId: OID, lines: shipInput.lines })],
    ["sevk: anahtar uuid değil", () => shipOrderAction({ ...shipInput, clientKey: "x" })],
    ["sevk: satır yok", () => shipOrderAction({ ...shipInput, lines: [] })],
    ["sevk: miktar sayı tipinde (float yasak)", () => shipOrderAction({ ...shipInput, lines: [{ orderLineId: LID, quantity: 3 }] })],
    ["sevk: bilinmeyen alan", () => shipOrderAction({ ...shipInput, extra: 1 })],
    ["iade: nedensiz", () => createCustomerReturnAction({ ...returnInput, reason: undefined })],
    ["iade: boşluk neden", () => createCustomerReturnAction({ ...returnInput, reason: "   " })],
    ["iade: neden 500 karakteri aşıyor", () => createCustomerReturnAction({ ...returnInput, reason: "a".repeat(501) })],
    ["iade: miktar sayı tipinde", () => createCustomerReturnAction({ ...returnInput, quantity: 2 })],
    ["iade: raf uuid değil", () => createCustomerReturnAction({ ...returnInput, locationId: "kabul" })],
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
    shipOrder.mockRejectedValue(new AppError("INSUFFICIENT_STOCK"));
    expect(await shipOrderAction(shipInput)).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_STOCK" } });
    createCustomerReturn.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "RETURN_EXCEEDS_SHIPPED" }));
    expect(await createCustomerReturnAction(returnInput)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", detail: "RETURN_EXCEEDS_SHIPPED" } });
    shipOrder.mockRejectedValue(new AppError("LOCATION_LOCKED"));
    expect(await shipOrderAction({ ...shipInput, clientKey: KEY2 })).toMatchObject({ ok: false, error: { code: "LOCATION_LOCKED" } });
  });

  it("INSUFFICIENT_STOCK, RETURN_EXCEEDS_SHIPPED, LOCATION_LOCKED ve diğerleri doğru ileti anahtarına gider", () => {
    expect(shippingErrorKey({ code: "INSUFFICIENT_STOCK" })).toBe("insufficient_stock");
    expect(shippingErrorKey({ code: "VALIDATION_FAILED", detail: "RETURN_EXCEEDS_SHIPPED" })).toBe("return_exceeds_shipped");
    expect(shippingErrorKey({ code: "LOCATION_LOCKED" })).toBe("location_locked");
    expect(shippingErrorKey({ code: "FORBIDDEN" })).toBe("forbidden");
    expect(shippingErrorKey({ code: "FORBIDDEN", detail: "WAREHOUSE_OUT_OF_SCOPE" })).toBe("forbidden_scope");
    expect(shippingErrorKey({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" })).toBe("document_state");
    expect(shippingErrorKey({ code: "VALIDATION_FAILED" })).toBe("validation_failed");
    expect(shippingErrorKey({ code: "TRACKING_VIOLATION" })).toBe("tracking_violation");
    expect(shippingErrorKey({ code: "NETWORK" })).toBe("network");
    expect(shippingErrorKey({ code: "WHATEVER" })).toBe("internal");
  });
});

describe("gösterim ve erken denetim yardımcıları (kural değil, biçim; float yok)", () => {
  it("micro / fromMicro / show: kesin ondalık", () => {
    expect(micro("2,5")).toBe(2_500_000n);
    expect(micro("0.000001")).toBe(1n);
    expect(micro("1e3")).toBeNull();
    expect(micro("")).toBeNull();
    expect(micro("-1")).toBeNull();
    expect(fromMicro(6_000_000n)).toBe("6");
    expect(show("6.000000")).toBe("6");
    expect(show("0.500000")).toBe("0.5");
    expect(show("x")).toBe("x");
  });

  it("qtyProblem: sıfır geçerli (satır sevk edilmez), üst sınır aşımı over, biçim hatası bad", () => {
    expect(qtyProblem("4", "4.000000")).toBeNull();
    expect(qtyProblem("0", "4.000000")).toBeNull();
    expect(qtyProblem("4.000001", "4.000000")).toBe("over");
    expect(qtyProblem("", "4")).toBe("bad");
    expect(qtyProblem("abc", "4")).toBe("bad");
  });

  it("remainingOf: kısmi sevkte kalan 'SEVK'te bekliyor' miktarı; tam sevkte null", () => {
    expect(remainingOf("10.000000", "6")).toBe("4");
    expect(remainingOf("10.000000", "10")).toBeNull();
    expect(remainingOf("10.000000", "0")).toBe("10");
    expect(remainingOf("2.500000", "1")).toBe("1.5");
  });

  it("placeCandidates: yalnız etkin RECEIVING raf aday; diğerleri için neden", () => {
    const r = { id: "a", code: "K1", name: "Kabul", kind: "RECEIVING", status: "ACTIVE" };
    expect(placeCandidates([r, { ...r, id: "b", kind: "STORAGE" }, { ...r, id: "c", status: "ARCHIVED" }])).toEqual({ candidates: [{ id: "a", code: "K1", name: "Kabul" }], reason: null });
    expect(placeCandidates([{ ...r, kind: "STORAGE" }])).toEqual({ candidates: [], reason: "placeNotReceiving" });
  });
});

describe("i18n: TR + EN ileti kümeleri eşit ve dolu; ekranda kullanılan her anahtar var", () => {
  const dir = path.join(__dirname, "../../../../messages");
  type Msgs = { shipping: Record<string, unknown>; returns: Record<string, unknown> };
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Msgs;
  const flat = (o: unknown, p = ""): string[] => (typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}${k}.`)) : [p]);
  const empties = (o: unknown): number => (typeof o === "object" && o !== null ? Object.values(o).reduce<number>((a, v) => a + empties(v), 0) : o === "" ? 1 : 0);
  const has = (root: unknown, key: string): boolean => key.split(".").reduce<unknown>((o, p) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[p] : undefined), root) !== undefined;

  it("TR ve EN anahtar kümesi eşit; boş değer yok", () => {
    for (const ns of ["shipping", "returns"] as const) {
      expect(flat(load("tr.json")[ns]).sort()).toEqual(flat(load("en.json")[ns]).sort());
      expect(empties(load("tr.json")[ns])).toBe(0);
      expect(empties(load("en.json")[ns])).toBe(0);
    }
  });

  it("her hata anahtarı için neden + sonraki eylem iletisi var (TR + EN)", () => {
    const outs = new Set<string>();
    const errs: Array<[string, string?]> = [
      ["VALIDATION_FAILED"], ["VALIDATION_FAILED", "RETURN_EXCEEDS_SHIPPED"], ["VALIDATION_FAILED", "BARCODE_AMBIGUOUS"], ["VALIDATION_FAILED", "DOCUMENT_STATE"], ["VALIDATION_FAILED", "QUANTITY_SCALE"],
      ["FORBIDDEN"], ["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"], ["LOCATION_LOCKED"], ["INSUFFICIENT_STOCK"], ["TRACKING_VIOLATION"], ["VERSION_CONFLICT"], ["IDEMPOTENCY_MISMATCH"],
      ["NOT_FOUND"], ["UNAUTHENTICATED"], ["RATE_LIMITED"], ["TENANT_SUSPENDED"], ["TENANT_CLOSING"], ["NETWORK"], ["INTERNAL"],
    ];
    for (const [code, detail] of errs) outs.add(shippingErrorKey({ code, detail }));
    for (const f of ["tr.json", "en.json"]) {
      const m = load(f).shipping.errors as Record<string, string>;
      for (const k of outs) {
        expect(m[k], `${f} errors.${k}`).toBeTruthy();
        expect(m[`${k}Action`], `${f} errors.${k}Action`).toBeTruthy();
      }
    }
  });

  it("ekranda kullanılan her `t(\"...\")` anahtarı ve değişkenle seçilen sorun/istem anahtarları iletide vardır (kaynak taraması)", () => {
    const read = (f: string): string => readFileSync(path.join(__dirname, f), "utf8");
    const shipSrc = ["../field/ship/ship-flow.tsx", "../field/ship/page.tsx"].map(read).join("\n");
    const retSrc = ["../field/return/return-flow.tsx", "../field/return/page.tsx"].map(read).join("\n");
    const used = (src: string): string[] => [...src.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1] as string);
    const tr = load("tr.json");
    // `ShippingErrorNotice` (ship-flow.tsx) iletileri `shipping` ad alanından alır; iade akışı onu içe aktarır.
    const shipKeys = [...used(shipSrc), "notInOrder", "alreadyVerified", "scanFailed", "nothingVerified", "badQuantity"];
    const retKeys = [...used(retSrc), "scanMismatch", "scanFailed", "badQuantity", "notVerified", "placeNotReceiving", "placeUnknown", "placeMissing", "reasonRequired", "scanPrompt", "placePrompt"];
    expect(shipKeys.length).toBeGreaterThan(20);
    expect(retKeys.length).toBeGreaterThan(20);
    for (const k of new Set(shipKeys)) expect(has(tr.shipping, k), `shipping.${k}`).toBe(true);
    for (const k of new Set(retKeys)) expect(has(tr.returns, k), `returns.${k}`).toBe(true);
  });
});
