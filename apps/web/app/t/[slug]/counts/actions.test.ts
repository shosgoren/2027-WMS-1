// T-316: sayım Server Action'ları — yetki, anahtar yaşam döngüsü, kör kip, zincir ("onaylandı, fiş bekliyor"), hata eşlemesi, decimal iletimi (I-09) ve i18n kapsamı.
// Domain komutları sahtedir (kilit/yetki/durum kuralları T-309'da ve counting*.int.test.ts'te sınanır); burada ince giriş katmanının sözleşmesi sınanır.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@wms/shared/errors";

const startCount = vi.hoisted(() => vi.fn());
const recordCount = vi.hoisted(() => vi.fn());
const submitCount = vi.hoisted(() => vi.fn());
const approveCount = vi.hoisted(() => vi.fn());
const postCountAdjustment = vi.hoisted(() => vi.fn());
const cancelCount = vi.hoisted(() => vi.fn());
const getCountSession = vi.hoisted(() => vi.fn());
const getLocationTree = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());
const runTenantQuery = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test", "fly-client-ip": "203.0.113.7" })) }));
vi.mock("../../../../lib/auth-service.ts", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/operations", () => ({ startCount, recordCount, submitCount, approveCount, postCountAdjustment, cancelCount, getCountSession }));
vi.mock("@wms/domain/warehouse", () => ({ getLocationTree }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("next-intl/server", () => ({ getTranslations: () => Promise.resolve((key: string) => key) }));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery }));

import { approveAndPostCountAction, approveCountAction, cancelCountAction, fieldCountAction, postCountAdjustmentAction, recordCountAction, startCountAction, submitCountAction } from "./actions.ts";
import { countErrorKey, createAttemptKey, diffSign, needsRefresh, plainQty, runAttempt } from "./[id]/count-review.tsx";
import type { ActionResult } from "../receipts/receipt-form.tsx";

const SID = "11111111-1111-4111-8111-111111111111";
const WH = "22222222-2222-4222-8222-222222222222";
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
  runTenantQuery.mockResolvedValue("t1");
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const permissionOfLastCall = (): string => (runTenantQuery.mock.calls.at(-1)?.[0] as { permission: string }).permission;
const base = { slug: "acme", clientKey: KEY };

describe("yetki: her eylem kendi izniyle sayaç/üyelik çözümünden geçer, yetkisiz çağrıda domain çalışmaz (A-132)", () => {
  const cases: Array<[string, string, () => Promise<unknown>, { mock: { calls: unknown[][] } }]> = [
    ["startCount", "document.approve", () => startCountAction({ ...base, warehouseId: WH, locationIds: [LOC] }), startCount],
    ["recordCount", "document.create", () => recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "3" }] }), recordCount],
    ["submitCount", "document.create", () => submitCountAction({ ...base, sessionId: SID }), submitCount],
    ["approveCount", "count_diff.approve", () => approveCountAction({ ...base, sessionId: SID }), approveCount],
    ["postCountAdjustment", "count_diff.approve", () => postCountAdjustmentAction({ ...base, sessionId: SID }), postCountAdjustment],
    ["cancelCount", "document.approve", () => cancelCountAction({ ...base, sessionId: SID, reason: "yanlış raf" }), cancelCount],
    ["zincir (approve+post)", "count_diff.approve", () => approveAndPostCountAction({ ...base, sessionId: SID }), approveCount],
  ];
  for (const [name, permission, call, command] of cases) {
    it(`${name}: ${permission} ister; yetkisizse FORBIDDEN döner ve komut çağrılmaz`, async () => {
      for (const f of [startCount, recordCount, submitCount, approveCount, postCountAdjustment, cancelCount]) f.mockResolvedValue({ sessionId: SID, replayed: false, recorded: 1, status: "SUBMITTED", differences: [] });
      await call();
      expect(permissionOfLastCall()).toBe(permission);
      expect(command.mock.calls.length).toBeGreaterThan(0);

      vi.clearAllMocks();
      getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
      runTenantQuery.mockRejectedValue(new AppError("FORBIDDEN"));
      const res = (await call()) as { ok: boolean; error?: { code: string } };
      expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(command).not.toHaveBeenCalled();
    });
  }

  it("oturum yok: UNAUTHENTICATED", async () => {
    getPrincipal.mockResolvedValue(null);
    expect(await recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "1" }] })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(recordCount).not.toHaveBeenCalled();
  });

  it("domain FORBIDDEN (izin yok / depo kapsamı) ayrıntısıyla aktarılır", async () => {
    submitCount.mockRejectedValue(new AppError("FORBIDDEN", { detail: "WAREHOUSE_OUT_OF_SCOPE" }));
    expect(await submitCountAction({ ...base, sessionId: SID })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", detail: "WAREHOUSE_OUT_OF_SCOPE" } });
  });
});

describe("anahtar yaşam döngüsü (T-277a: her deneme yeni anahtar; çift gönderimde aynı anahtar)", () => {
  const seq = (): (() => string) => {
    let n = 0;
    return () => `key-${++n}`;
  };
  const ok = (): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: true, data: { v: 1 } });
  const fail = (code: string, detail?: string): Promise<ActionResult<{ v: number }>> => Promise.resolve({ ok: false, error: { code, detail, requestId: "r" } });

  it("deneme sürerken begin aynı anahtarı verir; settle sonrası yenisini", () => {
    const h = createAttemptKey(seq());
    expect(h.begin()).toBe("key-1");
    expect(h.begin()).toBe("key-1");
    h.settle();
    expect(h.begin()).toBe("key-2");
  });

  it("çift gönderim (eşzamanlı iki çağrı): aynı anahtar", async () => {
    const h = createAttemptKey(seq());
    const used: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = (k: string): Promise<ActionResult<{ v: number }>> => {
      used.push(k);
      return gate.then(ok);
    };
    const a = runAttempt(h, slow);
    const b = runAttempt(h, slow);
    release();
    await Promise.all([a, b]);
    expect(used).toEqual(["key-1", "key-1"]);
  });

  it("kalıcı ret (VALIDATION_FAILED, LOCATION_LOCKED) sonrası yeni kullanıcı denemesi YENİ anahtar kullanır", async () => {
    const h = createAttemptKey(seq());
    const used: string[] = [];
    const rec = (res: () => Promise<ActionResult<{ v: number }>>) => (k: string) => {
      used.push(k);
      return res();
    };
    expect(await runAttempt(h, rec(() => fail("VALIDATION_FAILED")))).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await runAttempt(h, rec(() => fail("LOCATION_LOCKED")));
    await runAttempt(h, rec(ok));
    expect(used).toEqual(["key-1", "key-2", "key-3"]);
  });

  it("ağ hatası NETWORK olur (yutulmaz) ve sonraki deneme yeni anahtar alır", async () => {
    const h = createAttemptKey(seq());
    const used: string[] = [];
    const net = await runAttempt(h, (k) => {
      used.push(k);
      return Promise.reject(new Error("fetch failed"));
    });
    expect(net).toEqual({ ok: false, error: { code: "NETWORK" } });
    await runAttempt(h, (k) => {
      used.push(k);
      return ok();
    });
    expect(used).toEqual(["key-1", "key-2"]);
  });

  it("varsayılan üretici UUID verir", () => {
    expect(createAttemptKey().begin()).toMatch(UUID_RE);
  });

  it("anahtar sunucu eylemine olduğu gibi gider; anahtar yoksa ya da UUID değilse domain çağrılmaz", async () => {
    recordCount.mockResolvedValue({ recorded: 1 });
    await recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "1" }] });
    expect((recordCount.mock.calls[0]?.[0] as { clientKey: string }).clientKey).toBe(KEY);
    vi.clearAllMocks();
    for (const clientKey of [undefined, "x"]) {
      const res = (await recordCountAction({ slug: "acme", ...(clientKey === undefined ? {} : { clientKey }), sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "1" }] })) as { ok: boolean; error?: { code: string } };
      expect(res.error?.code).toBe("VALIDATION_FAILED");
    }
    expect(recordCount).not.toHaveBeenCalled();
  });
});

describe("domain çağrısı: miktarlar dizgi olarak gider (I-09), yazma komutları anahtarlıdır", () => {
  it("recordCount: ondalık dizgi AYNEN; durum yoksa iletilmez, varsa iletilir", async () => {
    recordCount.mockResolvedValue({ recorded: 2 });
    const res = await recordCountAction({
      ...base,
      sessionId: SID,
      lines: [
        { locationId: LOC, itemId: ITEM, countedQuantity: "12.500000" },
        { locationId: LOC2, itemId: ITEM, countedQuantity: "0", stockStatus: "DAMAGED" },
      ],
    });
    expect(res).toEqual({ ok: true, data: { recorded: 2 } });
    const [params, input] = recordCount.mock.calls[0] as [{ clientKey: string; tenantSlug: string }, { sessionId: string; lines: Array<Record<string, unknown>> }];
    expect(params).toMatchObject({ clientKey: KEY, tenantSlug: "acme" });
    expect(input.lines[0]).toEqual({ locationId: LOC, itemId: ITEM, countedQuantity: "12.500000" });
    expect(typeof input.lines[0]?.countedQuantity).toBe("string");
    expect(input.lines[1]).toEqual({ locationId: LOC2, itemId: ITEM, countedQuantity: "0", stockStatus: "DAMAGED" });
  });

  it("startCount: blind yoksa iletilmez (domain varsayılanı A-136), false açıkça iletilir; tekrar oynatma bayrağı döner", async () => {
    startCount.mockResolvedValue({ sessionId: SID, replayed: true });
    expect(await startCountAction({ ...base, warehouseId: WH, locationIds: [LOC, LOC2] })).toEqual({ ok: true, data: { sessionId: SID, replayed: true } });
    expect(startCount.mock.calls[0]?.[1]).toMatchObject({ warehouseId: WH, locationIds: [LOC, LOC2] });
    expect(startCount.mock.calls[0]?.[1]).not.toHaveProperty("blind");
    await startCountAction({ ...base, warehouseId: WH, locationIds: [LOC], blind: false });
    expect(startCount.mock.calls[1]?.[1]).toMatchObject({ blind: false });
  });

  it("iptal: gerekçe zorunlu (boş/boşluk reddedilir, komut çağrılmaz), kırpılmış gerekçe iletilir", async () => {
    for (const reason of ["", "   "]) {
      expect(await cancelCountAction({ ...base, sessionId: SID, reason })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    expect(cancelCount).not.toHaveBeenCalled();
    cancelCount.mockResolvedValue({ replayed: false });
    await cancelCountAction({ ...base, sessionId: SID, reason: "  yanlış raf seçildi  " });
    expect(cancelCount.mock.calls[0]?.[1]).toMatchObject({ sessionId: SID, reason: "yanlış raf seçildi" });
  });

  const invalid: Array<[string, () => Promise<unknown>]> = [
    ["miktar sayı tipinde (float yasak)", () => recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: 5 }] })],
    ["miktar boş", () => recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "" }] })],
    ["satır yok", () => recordCountAction({ ...base, sessionId: SID, lines: [] })],
    ["201 satır", () => recordCountAction({ ...base, sessionId: SID, lines: Array.from({ length: 201 }, () => ({ locationId: LOC, itemId: ITEM, countedQuantity: "1" })) })],
    ["bilinmeyen durum", () => recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "1", stockStatus: "RESERVED" }] })],
    ["bilinmeyen alan (referans göndermeye çalışmak)", () => recordCountAction({ ...base, sessionId: SID, lines: [{ locationId: LOC, itemId: ITEM, countedQuantity: "1", referenceQuantity: "9" }] })],
    ["lokasyon yok", () => startCountAction({ ...base, warehouseId: WH, locationIds: [] })],
    ["201 lokasyon", () => startCountAction({ ...base, warehouseId: WH, locationIds: Array.from({ length: 201 }, () => LOC) })],
    ["oturum uuid değil", () => submitCountAction({ ...base, sessionId: "x" })],
  ];
  for (const [name, call] of invalid) {
    it(`doğrulama: ${name} → VALIDATION_FAILED, domain çağrılmaz`, async () => {
      const res = (await call()) as { ok: boolean; error?: { code: string } };
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_FAILED");
      for (const f of [startCount, recordCount, submitCount, cancelCount]) expect(f).not.toHaveBeenCalled();
    });
  }
});

describe("kör kip: saha okuması yalnız `field` kipini kullanır ve referans/fark alanı istemciye geçmez", () => {
  it("fieldCountAction: view=field; domain yanlışlıkla referans/fark sızdırsa bile yanıtta yoktur", async () => {
    getCountSession.mockResolvedValue({
      view: "field",
      session: { id: SID },
      locations: [{ id: LOC, code: "A-01", name: "Raf A-01", locked: true, extra: "x" }],
      lines: [{ id: "l1", locationId: LOC, itemId: ITEM, itemCode: "C1", itemName: "Cıvata", unitCode: "AD", unitName: "Adet", quantityScale: 0, stockStatus: "AVAILABLE", counted: null, reference: "7777.5", referenceQuantity: "7777.5", difference: "-8888.5" }],
    });
    const res = await fieldCountAction({ slug: "acme", sessionId: SID });
    expect(getCountSession.mock.calls[0]?.[1]).toEqual({ sessionId: SID, view: "field" });
    expect(res.ok).toBe(true);
    const wire = JSON.stringify(res);
    for (const forbidden of ["reference", "difference", "7777", "8888"]) expect(wire, forbidden).not.toContain(forbidden);
    expect(res).toMatchObject({ data: { lines: [{ itemName: "Cıvata", counted: null }] } });
  });

  it("kaynak denetimi: saha dosyaları `review` kipini ve referans alanlarını hiç anmaz", () => {
    const root = path.join(__dirname, "..");
    for (const f of ["field/count/count-flow.tsx", "field/count/page.tsx"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, `${f}: view review`).not.toMatch(/view:\s*"review"/);
      expect(src, `${f}: reference`).not.toMatch(/\.reference\b|referenceQuantity|\.difference\b/);
    }
    // Yalnız gözden geçirme sayfası `review` okur ve onu `count_diff.approve` koşuluna bağlar.
    const review = readFileSync(path.join(__dirname, "[id]/page.tsx"), "utf8");
    expect(review).toMatch(/canReview\s*\?\s*await getCountSession\(call, \{ sessionId: id, view: "review" \}\)/);
  });
});

describe("zincir: onayla → fark fişi (iki ayrı komut; ikinci hata durumu)", () => {
  it("ikisi de başarılı: approved + posted; fiş anahtarı onay anahtarından türetilir, farklı ve belirlenimcidir", async () => {
    approveCount.mockResolvedValue({ status: "APPROVED", differences: [{ referenceQuantity: "99" }] });
    postCountAdjustment.mockResolvedValue({ replayed: false });
    const res = await approveAndPostCountAction({ ...base, sessionId: SID });
    expect(res).toEqual({ ok: true, data: { approved: true, posted: true } });
    expect(JSON.stringify(res)).not.toContain("99"); // fark listesi (referans) istemciye taşınmaz
    expect(approveCount).toHaveBeenCalledTimes(1);
    expect(postCountAdjustment).toHaveBeenCalledTimes(1);
    const approveKey = (approveCount.mock.calls[0]?.[0] as { clientKey: string }).clientKey;
    const postKey = (postCountAdjustment.mock.calls[0]?.[0] as { clientKey: string }).clientKey;
    expect(approveKey).toBe(KEY);
    expect(postKey).toMatch(UUID_RE);
    expect(postKey).not.toBe(KEY);
    await approveAndPostCountAction({ ...base, sessionId: SID });
    expect((postCountAdjustment.mock.calls[1]?.[0] as { clientKey: string }).clientKey).toBe(postKey);
    await approveAndPostCountAction({ slug: "acme", clientKey: LOC, sessionId: SID });
    expect((postCountAdjustment.mock.calls[2]?.[0] as { clientKey: string }).clientKey).not.toBe(postKey);
  });

  for (const [code, detail] of [["LOCATION_LOCKED", undefined], ["INSUFFICIENT_STOCK", undefined], ["VALIDATION_FAILED", "DOCUMENT_STATE"], ["FORBIDDEN", undefined]] as const) {
    it(`onay başarılı, fiş ${code}${detail === undefined ? "" : `/${detail}`}: istek BAŞARILI döner, posted=false ve neden aktarılır ("onaylandı, fiş bekliyor")`, async () => {
      approveCount.mockResolvedValue({ status: "APPROVED", differences: [] });
      postCountAdjustment.mockRejectedValue(new AppError(code, detail === undefined ? undefined : { detail }));
      const res = await approveAndPostCountAction({ ...base, sessionId: SID });
      expect(res).toMatchObject({ ok: true, data: { approved: true, posted: false, postError: { code } } });
      const err = (res as { data: { postError: { code: string; detail?: string; requestId: string } } }).data.postError;
      expect(err.requestId).toBeTruthy();
      if (detail !== undefined) expect(err.detail).toBe(detail);
      expect(approveCount).toHaveBeenCalledTimes(1);
    });
  }

  it("tanınmayan fiş hatası INTERNAL olarak aktarılır, ayrıntısı sızmaz ve yutulmaz", async () => {
    approveCount.mockResolvedValue({ status: "APPROVED", differences: [] });
    postCountAdjustment.mockRejectedValue(new Error("connection reset SELECT secret"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await approveAndPostCountAction({ ...base, sessionId: SID });
    expect(res).toMatchObject({ ok: true, data: { approved: true, posted: false, postError: { code: "INTERNAL" } } });
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("onay başarısızsa hata aynen döner ve fiş HİÇ denenmez", async () => {
    approveCount.mockRejectedValue(new AppError("VALIDATION_FAILED"));
    expect(await approveAndPostCountAction({ ...base, sessionId: SID })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(postCountAdjustment).not.toHaveBeenCalled();
  });

  it("'fiş bekliyor' durumundan yeniden deneme yalnız fark fişini çağırır (onay tekrarlanmaz)", async () => {
    postCountAdjustment.mockResolvedValue({ replayed: false });
    expect(await postCountAdjustmentAction({ ...base, sessionId: SID })).toEqual({ ok: true, data: { replayed: false } });
    expect(approveCount).not.toHaveBeenCalled();
  });
});

describe("hata eşlemesi (kod + ayrıntı → ileti anahtarı)", () => {
  it("sunucu hatası kod + ayrıntıyla aktarılır (LOCATION_LOCKED, DOCUMENT_STATE, FORBIDDEN)", async () => {
    startCount.mockRejectedValue(new AppError("LOCATION_LOCKED"));
    expect(await startCountAction({ ...base, warehouseId: WH, locationIds: [LOC] })).toMatchObject({ ok: false, error: { code: "LOCATION_LOCKED" } });
    submitCount.mockRejectedValue(new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" }));
    expect(await submitCountAction({ ...base, sessionId: SID })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" } });
    approveCount.mockRejectedValue(new AppError("FORBIDDEN"));
    expect(await approveCountAction({ ...base, sessionId: SID })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("LOCATION_LOCKED: başlatmada 'kısmi kilit yok' iletisi, diğer bağlamlarda 'kilit kapandı'", () => {
    expect(countErrorKey({ code: "LOCATION_LOCKED" }, "start")).toBe("start_locked");
    expect(countErrorKey({ code: "LOCATION_LOCKED" }, "record")).toBe("location_locked");
    expect(countErrorKey({ code: "LOCATION_LOCKED" }, "post")).toBe("location_locked");
  });

  it("DOCUMENT_STATE, QUANTITY_SCALE, ayrıntısız VALIDATION_FAILED bağlama göre", () => {
    expect(countErrorKey({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" }, "approve")).toBe("document_state");
    expect(countErrorKey({ code: "VALIDATION_FAILED", detail: "QUANTITY_SCALE" }, "record")).toBe("quantity_scale");
    expect(countErrorKey({ code: "VALIDATION_FAILED", detail: "TOO_MANY_LINES" }, "record")).toBe("too_large");
    expect(countErrorKey({ code: "VALIDATION_FAILED", detail: "IN_USE" }, "record")).toBe("item_inactive");
    expect(countErrorKey({ code: "VALIDATION_FAILED" }, "start")).toBe("start_invalid");
    expect(countErrorKey({ code: "VALIDATION_FAILED" }, "submit")).toBe("uncounted");
    expect(countErrorKey({ code: "VALIDATION_FAILED" }, "approve")).toBe("uncounted");
    expect(countErrorKey({ code: "VALIDATION_FAILED" }, "record")).toBe("validation_failed");
  });

  it("FORBIDDEN, kapsam, 55P03 → VERSION_CONFLICT ('tekrar dene'), NOT_FOUND, ağ ve bilinmeyen kod", () => {
    expect(countErrorKey({ code: "FORBIDDEN" }, "approve")).toBe("forbidden");
    expect(countErrorKey({ code: "FORBIDDEN", detail: "WAREHOUSE_OUT_OF_SCOPE" }, "start")).toBe("forbidden_scope");
    expect(countErrorKey({ code: "VERSION_CONFLICT" }, "record")).toBe("version_conflict");
    expect(countErrorKey({ code: "INSUFFICIENT_STOCK" }, "post")).toBe("insufficient_stock");
    expect(countErrorKey({ code: "NOT_FOUND" }, "scan")).toBe("scan_unknown");
    expect(countErrorKey({ code: "NOT_FOUND" }, "read")).toBe("not_found");
    expect(countErrorKey({ code: "NETWORK" }, "record")).toBe("network");
    expect(countErrorKey({ code: "WHATEVER" }, "record")).toBe("internal");
  });

  it("durum değişimi hataları sunucudan yeniden okumayı ister", () => {
    expect(needsRefresh({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" })).toBe(true);
    expect(needsRefresh({ code: "NOT_FOUND" })).toBe(true);
    expect(needsRefresh({ code: "FORBIDDEN" })).toBe(false);
  });

  it("gösterim yardımcıları: plainQty zeroları atar, diffSign işareti sınıflar (hesap sunucuda)", () => {
    expect(plainQty("3.000000")).toBe("3");
    expect(plainQty("-2.500000")).toBe("-2.5");
    expect(plainQty("100")).toBe("100");
    expect(plainQty("0.000000")).toBe("0");
    expect(plainQty("abc")).toBe("abc");
    expect(diffSign("0.000000")).toBe(0);
    expect(diffSign("-0.000000")).toBe(0);
    expect(diffSign("-2.000000")).toBe(-1);
    expect(diffSign("0.500000")).toBe(1);
  });
});

describe("i18n: her hata anahtarı ve her statik anahtar için TR + EN ileti var", () => {
  const dir = path.join(__dirname, "../../../../messages");
  type Msgs = { counting: Record<string, unknown> };
  const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Msgs;
  const pick = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((acc, k) => (typeof acc === "object" && acc !== null ? (acc as Record<string, unknown>)[k] : undefined), o);

  const keys = new Set<string>();
  const ctxs = ["start", "record", "submit", "approve", "post", "cancel", "scan", "read"] as const;
  const errs = [
    ["VALIDATION_FAILED"], ["VALIDATION_FAILED", "DOCUMENT_STATE"], ["VALIDATION_FAILED", "QUANTITY_SCALE"], ["VALIDATION_FAILED", "TOO_MANY_LINES"], ["VALIDATION_FAILED", "IN_USE"],
    ["VALIDATION_FAILED", "BARCODE_AMBIGUOUS"], ["FORBIDDEN"], ["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"], ["LOCATION_LOCKED"], ["INSUFFICIENT_STOCK"], ["TRACKING_VIOLATION"],
    ["VERSION_CONFLICT"], ["IDEMPOTENCY_MISMATCH"], ["NOT_FOUND"], ["UNAUTHENTICATED"], ["RATE_LIMITED"], ["TENANT_SUSPENDED"], ["TENANT_CLOSING"], ["NETWORK"], ["INTERNAL"],
  ] as const;
  for (const [code, detail] of errs) for (const c of ctxs) keys.add(countErrorKey({ code, detail }, c));
  for (const k of ["loc_not_in_session", "loc_closed", "unit_mismatch", "qty_fractional", "finish_first"]) keys.add(k);

  for (const f of ["tr.json", "en.json"]) {
    it(`${f}: ${keys.size} hata anahtarı + sonraki eylem`, () => {
      const m = load(f);
      for (const k of keys) {
        expect(pick(m.counting, `errors.${k}`), `${f} errors.${k}`).toBeTruthy();
        expect(pick(m.counting, `errors.${k}Action`), `${f} errors.${k}Action`).toBeTruthy();
      }
    });

    it(`${f}: ekran dosyalarındaki her statik t("...") anahtarı tanımlıdır`, () => {
      const m = load(f);
      const root = path.join(__dirname, "..");
      const files = ["counts/page.tsx", "counts/start-count-form.tsx", "counts/[id]/page.tsx", "counts/[id]/count-review.tsx", "field/count/page.tsx", "field/count/count-flow.tsx"];
      const missing: string[] = [];
      for (const file of files) {
        const src = readFileSync(path.join(root, file), "utf8");
        for (const mt of src.matchAll(/\bt\(\s*(?:inItem \? )?"([A-Za-z0-9_.]+)"(?: : "([A-Za-z0-9_.]+)")?/g)) {
          for (const key of [mt[1], mt[2]]) if (key !== undefined && pick(m.counting, key) === undefined) missing.push(`${file}: ${key}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it("TR ve EN anahtar kümesi eşit; kart metinleri sabit", () => {
    const flat = (o: unknown, p = ""): string[] => (typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}${k}.`)) : [p]);
    expect(flat(load("tr.json").counting).sort()).toEqual(flat(load("en.json").counting).sort());
    expect(pick(load("tr.json").counting, "cancel.effect")).toBe("Fark uygulanmayacak, kilit açılacak.");
    expect(pick(load("tr.json").counting, "status.APPROVED")).toBe("Onaylandı, fiş bekliyor");
    expect(pick(load("tr.json").counting, "flow.noneButton")).toBe("Bu rafta başka ürün yok");
  });
});
