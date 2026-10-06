// T-217: stok belgesi işleme (postDocument). GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile.
// Beklenen değerler docs/spec/16-stock-effects.md Senaryo A (adım 1-3 ve varyantlar). Fikstürler sentetiktir (G-09).
// A-217-1 (kart eki gerekli): belge satırında hedef durum sütunu yok → durum değişimi (KAR→KUL) uçtan uca test edilemez; plan/rules
// birim testleri (plan.test.ts) kaynak ≠ hedef durumu ayrı kapsar.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  approveDocument,
  createStockDocument,
  postDocument,
  readAvailability,
  type DocumentLineInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { archiveLocation } from "../../../packages/domain/src/warehouse/index.ts";
import { runTenantQuery } from "../../../packages/domain/src/identity/access.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let blocker: pg.Client;
let A: TenantWorld;
let wh2: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);

const ownerP = (key: string | null = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: A.ownerUserId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  timeouts: WIDE,
});
const pickerP = (key: string = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: A.memberUserId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
});

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const codeOf = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);

// --- fikstürler -------------------------------------------------------------------------------------------------------
async function mkItem(mode: "NONE" | "LOT" | "SERIAL" | "LOT_AND_SERIAL" = "NONE", scale = 0): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T217 urun',$4,$5,$6)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, mode, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT" = "STORAGE", pickBlocked = false, warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T217 lok',0,$5,$6)", [
    A.tenantId, id, warehouseId, `L-${hex(10)}`, kind, pickBlocked,
  ]);
  return id;
}
async function mkLot(itemId: string): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.lots (tenant_id, id, item_id, lot_code) VALUES ($1,$2,$3,$4)", [A.tenantId, id, itemId, `LOT-${hex(8)}`]);
  return id;
}
async function mkSerial(itemId: string, lotId: string | null = null): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id) VALUES ($1,$2,$3,$4,$5)", [A.tenantId, id, itemId, `SN-${hex(10)}`, lotId]);
  return id;
}
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over,
});
const qty = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });

/** DRAFT → APPROVED; dönen sürüm işleme için beklenen sürümdür. */
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = await docRow(id);
  expect(v.status).toBe("APPROVED");
  return { id, version: v.version };
}
const post = (d: { id: string; version: number }, p: StockDocCallParams = ownerP()) => postDocument(p, { documentId: d.id, expectedVersion: d.version });
const docRow = async (id: string) =>
  (await q<{ status: string; version: number; number: string | null; posting_job_id: string | null }>(
    "SELECT status, version, number, posting_job_id FROM public.documents WHERE id = $1", [id]))[0] as {
    status: string; version: number; number: string | null; posting_job_id: string | null;
  };

interface Dim { item: string; loc: string; status?: string; lot?: string | null; serial?: string | null }
async function bal(d: Dim): Promise<string> {
  const r = await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
      WHERE s.tenant_id = $1 AND s.item_id = $2 AND s.location_id = $3 AND s.stock_status = $4
        AND s.lot_id IS NOT DISTINCT FROM $5 AND s.serial_id IS NOT DISTINCT FROM $6`,
    [A.tenantId, d.item, d.loc, d.status ?? "AVAILABLE", d.lot ?? null, d.serial ?? null],
  );
  return r[0]?.quantity ?? "0.000000";
}
const physical = async (item: string): Promise<string> =>
  (await q<{ s: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2",
    [A.tenantId, item]))[0]?.s as string;
const ledgerRows = async (docId: string): Promise<{ quantity: string; reason: string }[]> =>
  q("SELECT quantity::text AS quantity, reason FROM public.stock_ledger WHERE tenant_id=$1 AND document_id=$2 ORDER BY quantity", [A.tenantId, docId]);
const ledgerCount = async (docId: string): Promise<number> => (await ledgerRows(docId)).length;
/** Defter toplamı = bakiye (boyut başına; ertelenmiş denetimin dışarıdan kanıtı). */
async function ledgerMatchesBalances(item: string): Promise<boolean> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b
      JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0)`,
    [A.tenantId, item]);
  return r[0]?.n === "0";
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  blocker = new pg.Client({ connectionString: env.databaseUrlDirect });
  blocker.on("error", () => undefined);
  await blocker.connect();
  A = await seedWorld(adm, reg, "A217");
  wh2 = uuid();
  await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,'D2','T217 Depo 2')", [A.tenantId, wh2]);
}, 120_000);

afterEach(async () => {
  delete process.env.STOCK_SERIAL_LOCK_ENABLED;
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
  await blocker.query("ROLLBACK").catch(() => undefined);
  await q("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id=$1 AND membership_id=$2", [A.tenantId, A.memberMembershipId]);
});

afterAll(async () => {
  await blocker.end();
  await adm.end();
  await app.close();
}, 60_000);

describe("Senaryo A adım 1-3 (16-stock-effects) ve varyantlar", () => {
  it("kalite kontrol açık: +10 KABUL·KAR → (kalite onayı durum değişimi: bkz. A-217-1) ; kapalı varyant: +10 KABUL·KUL → yerleştirme → R-01", async () => {
    const x = await mkItem();
    const kabul = await mkLoc("RECEIVING");
    const r01 = await mkLoc("STORAGE");
    // Adım 1 (kalite kontrol açık): +10 KABUL·KAR
    const d1 = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: kabul, stockStatus: "QUARANTINE", ...qty("10") })]);
    const out1 = await post(d1);
    expect(out1.status).toBe("POSTED");
    expect(await bal({ item: x, loc: kabul, status: "QUARANTINE" })).toBe("10.000000");
    expect(await bal({ item: x, loc: kabul })).toBe("0.000000");
    expect(await physical(x)).toBe("10.000000");
    // kullanılabilir 0 (KAR ve RECEIVING)
    expect(await runTenantQuery({ ...ownerP(), permission: "stock.view" }, (tx, m) => readAvailability(tx, m.tenantId, { itemId: x }))).toEqual([]);
    // Kalite kontrol kapalı varyantı: +10 KABUL·KUL (aynı ürün, ayrı boyut)
    const d1b = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: kabul, ...qty("10") })]);
    await post(d1b);
    expect(await bal({ item: x, loc: kabul })).toBe("10.000000");
    // Adım 3: yerleştirme KABUL·KUL → R-01·KUL (−10/+10)
    const d3 = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: kabul, targetLocationId: r01, ...qty("10") })]);
    await post(d3);
    expect(await bal({ item: x, loc: kabul })).toBe("0.000000");
    expect(await bal({ item: x, loc: r01 })).toBe("10.000000");
    expect(await bal({ item: x, loc: kabul, status: "QUARANTINE" })).toBe("10.000000");
    expect(await physical(x)).toBe("20.000000"); // taşıma toplamı değiştirmez (kural 3)
    expect((await ledgerRows(d3.id)).map((r) => [r.quantity, r.reason])).toEqual([["-10.000000", "MOVE"], ["10.000000", "MOVE"]]);
    expect((await ledgerRows(d1.id)).map((r) => r.reason)).toEqual(["RECEIPT"]);
    // yerleştirilen stok kullanılabilir (STORAGE, AVAILABLE)
    const av = await runTenantQuery({ ...ownerP(), permission: "stock.view" }, (tx, m) => readAvailability(tx, m.tenantId, { itemId: x }));
    expect(av.map((r) => [r.locationId, r.available])).toEqual([[r01, "10.000000"]]);
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("hasarlı varyant: +9 KAR ve +1 DAMAGED aynı belgede; hasarlı hiçbir zaman kullanılabilir sayılmaz", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    const d = await mkApproved("STOCK_IN", [
      ln(x, { targetLocationId: store, stockStatus: "QUARANTINE", ...qty("9") }),
      ln(x, { targetLocationId: store, stockStatus: "DAMAGED", ...qty("1") }),
    ]);
    await post(d);
    expect(await bal({ item: x, loc: store, status: "QUARANTINE" })).toBe("9.000000");
    expect(await bal({ item: x, loc: store, status: "DAMAGED" })).toBe("1.000000");
    expect(await physical(x)).toBe("10.000000");
    expect(await runTenantQuery({ ...ownerP(), permission: "stock.view" }, (tx, m) => readAvailability(tx, m.tenantId, { itemId: x }))).toEqual([]);
  });

  it("pick_blocked ve RECEIVING stoku kullanılabilire girmez; STORAGE ve STAGING girer (kural 5)", async () => {
    const x = await mkItem();
    const blocked = await mkLoc("STORAGE", true);
    const recv = await mkLoc("RECEIVING");
    const stage = await mkLoc("STAGING");
    const store = await mkLoc("STORAGE");
    const d = await mkApproved("STOCK_IN", [
      ln(x, { targetLocationId: blocked, ...qty("5") }),
      ln(x, { targetLocationId: recv, ...qty("6") }),
      ln(x, { targetLocationId: stage, ...qty("7") }),
      ln(x, { targetLocationId: store, ...qty("8") }),
    ]);
    await post(d);
    const av = await runTenantQuery({ ...ownerP(), permission: "stock.view" }, (tx, m) => readAvailability(tx, m.tenantId, { itemId: x }));
    expect(new Map(av.map((r) => [r.locationId, r.available]))).toEqual(new Map([[stage, "7.000000"], [store, "8.000000"]]));
    expect(av.find((r) => r.locationId === blocked)).toBeUndefined();
    expect(av.find((r) => r.locationId === recv)).toBeUndefined();
  });

  it("STOCK_OUT kaynağı RECEIVING iken izinli (fire/iade); reason SHIPMENT", async () => {
    const x = await mkItem();
    const recv = await mkLoc("RECEIVING");
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: recv, ...qty("5") })]));
    const d = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: recv, ...qty("2") })]);
    await post(d);
    expect(await bal({ item: x, loc: recv })).toBe("3.000000");
    expect((await ledgerRows(d.id))[0]).toEqual({ quantity: "-2.000000", reason: "SHIPMENT" });
  });
});

describe("yeterlilik, ölçek, takip modu, belge durumu", () => {
  it("yetersiz stok INSUFFICIENT_STOCK; hiçbir şey yazılmaz (negatif stok yok)", async () => {
    const x = await mkItem();
    const store = await mkLoc();
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, ...qty("3") })]));
    const d = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") }), ln(x, { sourceLocationId: store, ...qty("2") })]); // toplam 4 > 3
    expect(codeOf(await failure(post(d)))).toBe("INSUFFICIENT_STOCK");
    expect((await docRow(d.id)).status).toBe("APPROVED");
    expect(await ledgerCount(d.id)).toBe(0);
    expect(await bal({ item: x, loc: store })).toBe("3.000000");
  });

  it("miktar ölçeği aşımı VALIDATION_FAILED/QUANTITY_SCALE; takip ihlalleri TRACKING_VIOLATION (NONE+lot, LOT lotsuz)", async () => {
    const x = await mkItem("NONE", 0);
    const store = await mkLoc();
    expect(codeOf(await failure(post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, ...qty("1.5") })]))))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    const lotItem = await mkItem("LOT");
    const lot = await mkLot(lotItem);
    expect(codeOf(await failure(post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, lotId: await mkLot(x) })]))))).toBe("TRACKING_VIOLATION");
    expect(codeOf(await failure(post(await mkApproved("STOCK_IN", [ln(lotItem, { targetLocationId: store })]))))).toBe("TRACKING_VIOLATION");
    const ok = await mkApproved("STOCK_IN", [ln(lotItem, { targetLocationId: store, lotId: lot, ...qty("2") })]);
    await post(ok);
    expect(await bal({ item: lotItem, loc: store, lot })).toBe("2.000000");
  });

  it("DRAFT belge işlenemez (DOCUMENT_STATE); sürüm uyuşmazlığı VERSION_CONFLICT; POSTED tekrar işlenemez", async () => {
    const x = await mkItem();
    const store = await mkLoc();
    const c = await createStockDocument(ownerP(), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [ln(x, { targetLocationId: store })] });
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: c.documentId as string, expectedVersion: 1 })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store })]);
    expect((await failure(postDocument(ownerP(), { documentId: d.id, expectedVersion: d.version + 5 }))).code).toBe("VERSION_CONFLICT");
    await post(d);
    const done = await docRow(d.id);
    expect(done.status).toBe("POSTED");
    expect(done.version).toBe(d.version + 1);
    expect(done.number).toMatch(/^GRS-/);
    expect(codeOf(await failure(postDocument(ownerP(), { documentId: d.id, expectedVersion: done.version })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });

  it("posting_job_id dolu belge senkron işlenmez → DOCUMENT_STATE (M-6)", async () => {
    const x = await mkItem();
    const store = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store })]);
    await q("UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [d.id, uuid(), A.ownerUserId]);
    const cur = await docRow(d.id);
    expect(codeOf(await failure(post({ id: d.id, version: cur.version })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await ledgerCount(d.id)).toBe(0);
  });

  it("200 satır üstü senkron işlenmez: açık hata (DOCUMENT_STATE), sahte başarı ve yazım yok", async () => {
    const x = await mkItem();
    const store = await mkLoc();
    const lines = Array.from({ length: 201 }, () => ln(x, { targetLocationId: store }));
    const d = await mkApproved("STOCK_IN", lines);
    expect(codeOf(await failure(post(d)))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await ledgerCount(d.id)).toBe(0);
  }, 60_000);

  it("başarılı işleme: audit stock_document.posted 1 kez, durum geçmişi POSTED, aynı anahtar saklı sonucu döner (ikinci yazım yok)", async () => {
    const x = await mkItem();
    const store = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, ...qty("4") })]);
    const key = uuid();
    const first = await post(d, ownerP(key));
    const again = await post(d, ownerP(key));
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.documentNumber).toBe(first.documentNumber);
    expect(await ledgerCount(d.id)).toBe(1);
    expect(await bal({ item: x, loc: store })).toBe("4.000000");
    const audit = await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE tenant_id=$1 AND action='stock_document.posted' AND entity_id=$2", [A.tenantId, d.id]);
    expect(audit[0]?.n).toBe("1");
    const hist = await q<{ to_status: string }>("SELECT to_status FROM public.document_status_history WHERE tenant_id=$1 AND document_id=$2 ORDER BY occurred_at, to_status", [A.tenantId, d.id]);
    expect(hist.map((h) => h.to_status)).toContain("POSTED");
  });
});

describe("seri takipli ürün (AC-09, I-05) ve seri kilidi bayrağı (A-121)", () => {
  it("SERIAL: R-01→R-02 STOCK_MOVE kabul (azalt-sonra-artır); aynı seri hedefte başka pozitif boyutta iken STOCK_IN reddedilir", async () => {
    process.env.STOCK_SERIAL_LOCK_ENABLED = "true";
    const x = await mkItem("SERIAL");
    const r1 = await mkLoc();
    const r2 = await mkLoc();
    const r3 = await mkLoc();
    const s = await mkSerial(x);
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: r1, serialId: s })]));
    expect(await bal({ item: x, loc: r1, serial: s })).toBe("1.000000");
    await post(await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: r1, targetLocationId: r2, serialId: s })]));
    expect(await bal({ item: x, loc: r1, serial: s })).toBe("0.000000");
    expect(await bal({ item: x, loc: r2, serial: s })).toBe("1.000000");
    // aynı seri başka konuma girişte (r2'de pozitif) TRACKING_VIOLATION
    const dup = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: r3, serialId: s })]);
    expect(codeOf(await failure(post(dup)))).toBe("TRACKING_VIOLATION");
    expect(await bal({ item: x, loc: r3, serial: s })).toBe("0.000000");
    // seri miktarı 1
    const two = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: r3, serialId: await mkSerial(x), ...qty("2") })]);
    expect(codeOf(await failure(post(two)))).toBe("TRACKING_VIOLATION");
    // seri boyutunun türetilen sütunu: bakiye serial_key = seri kimliği (tetikleyici)
    const sk = await q<{ serial_key: string }>(
      "SELECT b.serial_key FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id=b.tenant_id AND d.id=b.stock_dimension_id WHERE d.tenant_id=$1 AND d.serial_id=$2 AND b.quantity>0",
      [A.tenantId, s]);
    expect(sk[0]?.serial_key).toBe(s);
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("seri kilidi bayrağı kapalıyken seri planı FEATURE_DISABLED ile reddedilir; serisiz yeniden deneme yok (belge APPROVED, defter boş)", async () => {
    const x = await mkItem("SERIAL");
    const r1 = await mkLoc();
    const s = await mkSerial(x);
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: r1, serialId: s })]);
    expect(codeOf(await failure(post(d)))).toBe("VALIDATION_FAILED/FEATURE_DISABLED");
    expect((await docRow(d.id)).status).toBe("APPROVED");
    expect(await ledgerCount(d.id)).toBe(0);
    expect(await bal({ item: x, loc: r1, serial: s })).toBe("0.000000");
  });
});

describe("lokasyon ve ürün durumu (T-243 MAJOR) ve depo kuralı (A-145)", () => {
  it("arşivli lokasyon/ürüne hareket reddedilir (onaydan sonra arşivlenmiş)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc })]);
    await q("UPDATE public.locations SET status='ARCHIVED', archived_at=now() WHERE id=$1", [loc]);
    expect(codeOf(await failure(post(d)))).toBe("VALIDATION_FAILED/IN_USE");
    const y = await mkItem();
    const loc2 = await mkLoc();
    const d2 = await mkApproved("STOCK_IN", [ln(y, { targetLocationId: loc2 })]);
    await q("UPDATE public.items SET status='ARCHIVED', archived_at=now() WHERE id=$1", [y]);
    expect(codeOf(await failure(post(d2)))).toBe("VALIDATION_FAILED/IN_USE");
    expect(await ledgerCount(d2.id)).toBe(0);
  });

  it("KAPI: arşiv (FOR NO KEY UPDATE tutuyor) ile STOCK_IN eşzamanlı → işleme kilitte bekler, arşivlenmiş lokasyonu reddeder; pozitif stok oluşmaz", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("5") })]);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM public.locations WHERE id=$1 FOR NO KEY UPDATE", [loc]); // arşivleyicinin ara hâli
    const pending = post(d).then(() => undefined, (e: unknown) => e as AppError);
    // işlemenin lokasyon kilidinde beklediğini gözle (en çok ~5 sn)
    // Doğru koşulu bekle: işleme lokasyon kilidinde "bekliyor" görünene dek (üst sınır 30 sn; yavaş CI'da yanlış kırmızı vermesin).
    let waiting = false;
    for (let i = 0; i < 300 && !waiting; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const w = await q<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%public.locations%FOR SHARE%'");
      waiting = w[0]?.n !== "0";
    }
    expect(waiting).toBe(true);
    await blocker.query("UPDATE public.locations SET status='ARCHIVED', archived_at=now() WHERE id=$1", [loc]);
    await blocker.query("COMMIT");
    const res = await pending;
    expect(res).toBeInstanceOf(AppError);
    expect(codeOf(res as AppError)).toBe("VALIDATION_FAILED/IN_USE");
    expect(await bal({ item: x, loc })).toBe("0.000000");
    expect((await docRow(d.id)).status).toBe("APPROVED");
  });

  it("GERÇEK yarış: archiveLocation ∥ postDocument (6 tur): arşivli lokasyonda pozitif stok asla oluşmaz", async () => {
    const x = await mkItem();
    let archivedRounds = 0;
    let postedRounds = 0;
    for (let i = 0; i < 6; i++) {
      const loc = await mkLoc();
      const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("2") })]);
      const [a, p] = await Promise.allSettled([
        archiveLocation(ownerP() as never, { locationId: loc }),
        post(d),
      ]);
      const status = (await q<{ status: string }>("SELECT status FROM public.locations WHERE id=$1", [loc]))[0]?.status;
      const stock = Number(await bal({ item: x, loc }));
      if (status === "ARCHIVED") {
        expect(stock).toBe(0);
        archivedRounds += 1;
      }
      if (p.status === "fulfilled") {
        postedRounds += 1;
        expect(status).toBe("ACTIVE"); // stok yazıldıysa arşiv IN_USE ile reddedilmiş olmalı
        expect(a.status === "rejected" || (a.status === "fulfilled" && a.value.archived === false)).toBe(true);
      }
    }
    expect(archivedRounds + postedRounds).toBeGreaterThan(0);
  }, 90_000);

  it("A-145: satır lokasyonu belge deposunda değilse LOCATION_WAREHOUSE_MISMATCH; kapsamdışı depo FORBIDDEN (kapsam denetimine girer)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d0 = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc })]);
    // Belge deposu onaydan sonra değişmiş gibi (fikstür): satır lokasyonu artık belge deposunda değil. (Oluşturma/onay yolu bunu zaten reddeder.)
    await q("UPDATE public.documents SET warehouse_id = $2 WHERE id = $1", [d0.id, wh2]);
    const d = { id: d0.id, version: (await docRow(d0.id)).version };
    expect(codeOf(await failure(post(d)))).toBe("VALIDATION_FAILED/LOCATION_WAREHOUSE_MISMATCH");
    expect(await ledgerCount(d.id)).toBe(0);
    // Kapsam: picker yalnızca depo 2'ye kapsamlı; satır lokasyonu depo A'da → plan satır depolarını da kapsam denetimine alır → FORBIDDEN.
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, A.memberMembershipId, wh2]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    expect((await failure(post(d, pickerP()))).code).toBe("FORBIDDEN");
    expect(await ledgerCount(d.id)).toBe(0);
  });
});

describe("açık sütun listesi (türetilen sütunlar)", () => {
  it("defter item_id/created_xid/occurred_at ve bakiye serial_key sunucu/tetikleyici değerleridir; yazım SQL'i bu sütunları adlandırmaz", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc })]);
    await post(d);
    const r = await q<{ item_id: string; xid_ok: boolean; at_ok: boolean }>(
      "SELECT item_id, created_xid IS NOT NULL AS xid_ok, occurred_at > now() - interval '1 minute' AS at_ok FROM public.stock_ledger WHERE tenant_id=$1 AND document_id=$2", [A.tenantId, d.id]);
    expect(r[0]).toEqual({ item_id: x, xid_ok: true, at_ok: true });
    const sk = await q<{ serial_key: string }>(
      "SELECT b.serial_key FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2", [A.tenantId, x]);
    expect(sk[0]?.serial_key).toBe("00000000-0000-0000-0000-000000000000");
    const src = readFileSync(new URL("../../../packages/domain/src/stock/posting.ts", import.meta.url), "utf8");
    const insert = /INSERT INTO public\.stock_ledger\s*\(([^)]*)\)/.exec(src)?.[1] ?? "";
    expect(insert).toContain("stock_dimension_id");
    for (const col of ["item_id", "created_xid", "occurred_at", "serial_key"]) expect(insert).not.toContain(col);
    const update = /UPDATE public\.stock_balances b SET ([^\n]*)/.exec(src)?.[1] ?? "";
    expect(update).not.toContain("serial_key");
  });
});
