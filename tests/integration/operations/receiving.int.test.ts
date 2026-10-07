// T-305: mal kabul, kalite onayı, yerleştirme (ADR-021 §2-3; 16 Senaryo A adım 1-3 ve Senaryo D adım 1-3). GERÇEK roller (wms_app, pooler);
// fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md'den birebir; her adımdan sonra tüm sütunlar
// ve G1 satır durumu doğrulanır. Fikstürler sentetiktir (G-09). Bağımsız kanıt (AC-31/AC-40 tam akış) T-317'dedir.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import {
  approveQuality,
  cancelInboundReceipt,
  createInboundReceipt,
  openInboundReceipt,
  putaway,
  receiveGoods,
} from "../../../packages/domain/src/operations/index.ts";
import {
  EMPTY_LOCK_PLAN,
  approveDocument,
  createStockDocument,
  executeStockCommand,
  postApprovedDocumentInTx,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

const NO_WAIT = { sleep: async () => undefined } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const ownerP = (key: string | null = uuid(), extra: Partial<StockDocCallParams> = {}): StockDocCallParams => ({
  db: app,
  principal: { userId: A.ownerUserId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  ...extra,
});
const pickerP = (key: string = uuid(), extra: Partial<StockDocCallParams> = {}): StockDocCallParams => ({
  db: app,
  principal: { userId: A.memberUserId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  ...extra,
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

// --- fikstürler ---------------------------------------------------------------------------------------------------------
async function mkItem(mode: "NONE" | "LOT" | "SERIAL" = "NONE"): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T305 urun',$4,$5,0)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, mode,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" = "STORAGE"): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T305 lok',0,$5)", [
    A.tenantId, id, A.warehouseId, `L-${hex(10)}`, kind,
  ]);
  return id;
}
async function setQc(on: boolean): Promise<void> {
  await q("UPDATE public.tenant_settings SET receiving_qc_enabled = $2 WHERE tenant_id = $1", [A.tenantId, on]);
}

interface Receipt {
  id: string;
  lineIds: string[];
}
/** DRAFT → OPEN beklenen teslim. */
async function mkReceipt(lines: { itemId: string; expected: string }[]): Promise<Receipt> {
  const c = await createInboundReceipt(ownerP(), {
    warehouseId: A.warehouseId,
    supplierRef: "T305-TED",
    lines: lines.map((l) => ({ itemId: l.itemId, unitId: A.unitId, expectedQuantity: l.expected })),
  });
  const id = c.documentId as string;
  expect(c.documentNumber).toMatch(/^KBL-\d{4}-\d{6}$/);
  await openInboundReceipt(ownerP(), { receiptId: id, expectedVersion: 1 });
  const rows = await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1 ORDER BY line_no", [id]);
  return { id, lineIds: rows.map((r) => r.id) };
}
const receiptRow = async (id: string) =>
  (await q<{ status: string; version: number }>("SELECT status, version FROM public.inbound_receipts WHERE id = $1", [id]))[0] as { status: string; version: number };
const lineRow = async (id: string) =>
  (await q<{ expected: string; received: string; damaged: string }>(
    "SELECT expected_quantity::text AS expected, received_quantity::text AS received, damaged_quantity::text AS damaged FROM public.inbound_receipt_lines WHERE id = $1", [id],
  ))[0] as { expected: string; received: string; damaged: string };
const n = (v: string | number): string => Number(v).toFixed(6);

async function bal(item: string, loc: string, status: string): Promise<string> {
  const r = await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
      WHERE s.tenant_id = $1 AND s.item_id = $2 AND s.location_id = $3 AND s.stock_status = $4`,
    [A.tenantId, item, loc, status],
  );
  return r[0]?.quantity ?? "0.000000";
}
const physical = async (item: string): Promise<string> =>
  (await q<{ s: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2",
    [A.tenantId, item]))[0]?.s as string;
const reservedOf = async (item: string): Promise<string> =>
  (await q<{ s: string }>(
    "SELECT COALESCE(sum(b.reserved_quantity),0)::text AS s FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2",
    [A.tenantId, item]))[0]?.s as string;
/** 16 kural 5: AVAILABLE ∧ STORAGE|STAGING ∧ pick_blocked=false − rezerve. */
const available = async (item: string): Promise<string> =>
  (await q<{ s: string }>(
    `SELECT COALESCE(sum(b.quantity - b.reserved_quantity),0)::text AS s FROM public.stock_balances b
       JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
       JOIN public.locations l ON l.tenant_id=s.tenant_id AND l.id=s.location_id
      WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.stock_status='AVAILABLE' AND l.kind IN ('STORAGE','STAGING') AND l.pick_blocked=false`,
    [A.tenantId, item]))[0]?.s as string;
const ledgerSum = async (item: string): Promise<string> =>
  (await q<{ s: string }>("SELECT COALESCE(sum(quantity),0)::text AS s FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2", [A.tenantId, item]))[0]?.s as string;
const ledgerCount = async (item: string): Promise<number> =>
  Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.stock_ledger WHERE tenant_id=$1 AND item_id=$2", [A.tenantId, item]))[0]?.c);
const tasksOf = async (receiptId: string) =>
  q<{ id: string; kind: string; status: string; quantity: string; item_id: string; location_id: string; source_line_id: string }>(
    "SELECT id, kind, status, quantity::text AS quantity, item_id, location_id, source_line_id FROM public.warehouse_tasks WHERE tenant_id=$1 AND source_kind='INBOUND_RECEIPT' AND source_id=$2 ORDER BY created_at, id",
    [A.tenantId, receiptId],
  );
async function audits(action: string, entityId: string): Promise<number> {
  return (await q("SELECT 1 FROM public.audit_logs WHERE tenant_id=$1 AND action=$2 AND entity_id=$3", [A.tenantId, action, entityId])).length;
}

type Num = string | number;
interface Row { kar: Num; kul: Num; dmg?: Num; raf: Num; fiz: Num; rez: Num; kullan: Num }
/** Senaryo tablosundaki bir satır: KABUL·KAR, KABUL·KUL, (KABUL·DMG), raf, fiziksel, rezerve, kullanılabilir. */
async function expectRow(item: string, kabul: string, raf: string, e: Row, label: string): Promise<void> {
  const got = {
    kar: await bal(item, kabul, "QUARANTINE"),
    kul: await bal(item, kabul, "AVAILABLE"),
    dmg: await bal(item, kabul, "DAMAGED"),
    raf: await bal(item, raf, "AVAILABLE"),
    fiz: n(await physical(item)),
    rez: n(await reservedOf(item)),
    kullan: n(await available(item)),
  };
  expect(got, label).toEqual({ kar: n(e.kar), kul: n(e.kul), dmg: n(e.dmg ?? "0"), raf: n(e.raf), fiz: n(e.fiz), rez: n(e.rez), kullan: n(e.kullan) });
  expect(n(await ledgerSum(item)), `${label} defter toplamı = fiziksel`).toBe(got.fiz);
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A305");
  B = await seedWorld(adm, reg, "B305");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("dışa açık yüzey", () => {
  it("field-posting iç yardımcıdır: operations/index.ts dışa açmaz", () => {
    expect(Object.keys(ops)).toEqual(expect.arrayContaining(["createInboundReceipt", "receiveGoods", "approveQuality", "putaway"]));
    expect(Object.keys(ops)).not.toContain("postFieldDocument");
    expect(Object.keys(ops)).not.toContain("planFieldPosting");
  });
});

describe("Senaryo A adım 1–3 (kalite kontrol açık; X, KABUL, R-01)", () => {
  it("kabul 10 → kalite onayı 10 → yerleştirme 10 → R-01: her adımda 16 tablosuyla birebir", async () => {
    await setQc(true);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    await expectRow(X, KABUL, R01, { kar: 0, kul: 0, raf: 0, fiz: 0, rez: 0, kullan: 0 }, "adım 0");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);

    // 1. Mal kabul 10: +10 KABUL·KAR
    const r1 = await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "10", locationId: KABUL }] });
    expect(r1.status).toBe("POSTED");
    await expectRow(X, KABUL, R01, { kar: 10, kul: 0, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "adım 1");
    expect(await lineRow(g.lineIds[0] as string)).toEqual({ expected: n(10), received: n(10), damaged: n(0) });
    expect(await receiptRow(g.id)).toMatchObject({ status: "CLOSED" });
    const doc = await q<{ kind: string; status: string; source_kind: string; source_id: string }>("SELECT kind, status, source_kind, source_id FROM public.documents WHERE id = $1", [r1.documentId]);
    expect(doc[0]).toEqual({ kind: "STOCK_IN", status: "POSTED", source_kind: "INBOUND_RECEIPT", source_id: g.id });
    const dl = await q<{ source_line_id: string }>("SELECT source_line_id FROM public.document_lines WHERE document_id = $1", [r1.documentId]);
    expect(dl.map((d) => d.source_line_id)).toEqual([g.lineIds[0]]);
    expect(await audits("inbound_receipt.received", g.id)).toBe(1);
    expect(await audits("inbound_receipt.created", g.id)).toBe(1);
    expect(await audits("inbound_receipt.opened", g.id)).toBe(1);

    // 2. Kalite onayı 10: −10 KABUL·KAR, +10 KABUL·KUL (kullanılabilir 0: KABUL RECEIVING)
    const r2 = await approveQuality(ownerP(), { receiptId: g.id });
    expect(r2.status).toBe("POSTED");
    await expectRow(X, KABUL, R01, { kar: 0, kul: 10, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "adım 2");
    const mv = await q<{ kind: string; target_stock_status: string; stock_status: string }>(
      "SELECT d.kind, l.stock_status, l.target_stock_status FROM public.document_lines l JOIN public.documents d ON d.id=l.document_id WHERE d.id=$1", [r2.documentId]);
    expect(mv).toEqual([{ kind: "STOCK_MOVE", stock_status: "QUARANTINE", target_stock_status: "AVAILABLE" }]);
    const reasons = await q<{ reason: string }>("SELECT reason FROM public.stock_ledger WHERE document_id=$1", [r2.documentId]);
    expect(reasons.map((r) => r.reason)).toEqual(["MOVE", "MOVE"]);
    const tasks = await tasksOf(g.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "PUTAWAY", status: "OPEN", quantity: n(10), item_id: X, location_id: KABUL, source_line_id: g.lineIds[0] });

    // 3. Yerleştirme 10 → R-01 (görev aynı transaction'da DONE; ikinci stok girişi yok)
    const ledgerBefore = await ledgerCount(X);
    const r3 = await putaway(pickerP(), { taskId: tasks[0]?.id as string, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "10" });
    expect(r3.status).toBe("POSTED");
    await expectRow(X, KABUL, R01, { kar: 0, kul: 0, raf: 10, fiz: 10, rez: 0, kullan: 10 }, "adım 3");
    expect(await ledgerCount(X)).toBe(ledgerBefore + 2); // yalnızca −10/+10
    expect((await tasksOf(g.id))[0]?.status).toBe("DONE");
    expect(await audits("warehouse_task.completed", tasks[0]?.id as string)).toBe(1);

    // Onaylanmış karantina tekrar onaylanamaz; fazla onay yok.
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id })))).toBe("VALIDATION_FAILED");
  });

  it("kalite kontrol kapalı varyantı: +10 doğrudan KABUL·KUL, adım 2 yok (onay denemesi reddedilir)", async () => {
    await setQc(false);
    try {
      const X = await mkItem();
      const KABUL = await mkLoc("RECEIVING");
      const R01 = await mkLoc("STORAGE");
      const g = await mkReceipt([{ itemId: X, expected: "10" }]);
      await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "10", locationId: KABUL }] });
      await expectRow(X, KABUL, R01, { kar: 0, kul: 10, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "QC kapalı adım 1");
      expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id })))).toBe("VALIDATION_FAILED");
      await putaway(pickerP(), { sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "10" }); // görevsiz yerleştirme
      await expectRow(X, KABUL, R01, { kar: 0, kul: 0, raf: 10, fiz: 10, rez: 0, kullan: 10 }, "QC kapalı adım 3");
    } finally {
      await setQc(true);
    }
  });

  it("hasarlı varyant: +9 KAR ve +1 DAMAGED; hasarlı hiçbir zaman kullanılabilir olmaz (onaydan sonra da)", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "10", damaged: "1", locationId: KABUL }] });
    await expectRow(X, KABUL, R01, { kar: 9, kul: 0, dmg: 1, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "hasarlı adım 1");
    await approveQuality(ownerP(), { receiptId: g.id });
    await expectRow(X, KABUL, R01, { kar: 0, kul: 9, dmg: 1, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "hasarlı adım 2");
    // DAMAGED → AVAILABLE hiçbir yolla yok: onay komutu hasarlı stoğa dokunmaz (dimensions yolu da).
    const e = await failure(approveQuality(ownerP(), { dimensions: [{ itemId: X, locationId: KABUL, quantity: "1" }] }));
    expect(codeOf(e)).toBe("INSUFFICIENT_STOCK"); // QUARANTINE yok; DAMAGED karantina sayılmaz
    expect(await bal(X, KABUL, "DAMAGED")).toBe(n(1));
    // Belge katmanı ve DB: doğrudan DAMAGED → AVAILABLE taşıma belgesi reddedilir (T-258 beyaz listesi + 0020).
    const d = await failure(
      createStockDocument(ownerP(), {
        kind: "STOCK_MOVE",
        warehouseId: A.warehouseId,
        lines: [{ itemId: X, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", sourceLocationId: KABUL, targetLocationId: KABUL, stockStatus: "DAMAGED", targetStockStatus: "AVAILABLE" }],
      }),
    );
    expect(d.code).toBe("VALIDATION_FAILED");
    expect(await bal(X, KABUL, "DAMAGED")).toBe(n(1));
  });

  it("KABUL·KAR ve KABUL·KUL (RECEIVING) kullanılabilire girmez", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "4" }]);
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "4", locationId: KABUL }] });
    expect(n(await available(X))).toBe(n(0));
    await approveQuality(ownerP(), { receiptId: g.id });
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(4));
    expect(n(await available(X))).toBe(n(0));
  });
});

describe("Senaryo D adım 1–3 (G1: X 20, Y 10; gelen X 18, Y 10 + 1 hasarlı)", () => {
  it("kabul, kalite onayı, yerleştirme: X ve Y tabloları ve G1 satır durumu birebir", async () => {
    await setQc(true);
    const X = await mkItem();
    const Y = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const R02 = await mkLoc("STORAGE");
    const g = await mkReceipt([{ itemId: X, expected: "20" }, { itemId: Y, expected: "10" }]);
    const [lx, ly] = g.lineIds as [string, string];

    // 1. Mal kabul G1: X +18 KAR · Y +9 KAR, +1 DMG
    await receiveGoods(pickerP(), {
      receiptId: g.id,
      lines: [{ lineId: lx, received: "18", locationId: KABUL }, { lineId: ly, received: "10", damaged: "1", locationId: KABUL }],
    });
    await expectRow(X, KABUL, R01, { kar: 18, kul: 0, raf: 0, fiz: 18, rez: 0, kullan: 0 }, "X adım 1");
    await expectRow(Y, KABUL, R02, { kar: 9, kul: 0, dmg: 1, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "Y adım 1");
    // Belge son durumu G1: X 20/18/açık 2; Y 10/10/açık 0 (1 hasarlı).
    expect(await lineRow(lx)).toEqual({ expected: n(20), received: n(18), damaged: n(0) });
    expect(await lineRow(ly)).toEqual({ expected: n(10), received: n(10), damaged: n(1) });
    expect(await receiptRow(g.id)).toMatchObject({ status: "OPEN" }); // X'te 2 açık (A-305-5: kapatma komutu yok)

    // 2. Kalite onayı: X −18 KAR +18 KUL · Y −9 KAR +9 KUL (DMG kalır)
    await approveQuality(ownerP(), { receiptId: g.id });
    await expectRow(X, KABUL, R01, { kar: 0, kul: 18, raf: 0, fiz: 18, rez: 0, kullan: 0 }, "X adım 2");
    await expectRow(Y, KABUL, R02, { kar: 0, kul: 9, dmg: 1, raf: 0, fiz: 10, rez: 0, kullan: 0 }, "Y adım 2");
    const tasks = await tasksOf(g.id);
    expect(tasks.map((t) => [t.item_id, t.quantity]).sort()).toEqual([[X, n(18)], [Y, n(9)]].sort());

    // 3. Yerleştirme: X −18 KUL +18 R-01 · Y −9 KUL +9 R-02
    const tx = tasks.find((t) => t.item_id === X) as { id: string };
    const ty = tasks.find((t) => t.item_id === Y) as { id: string };
    await putaway(pickerP(), { taskId: tx.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "18" });
    await expectRow(X, KABUL, R01, { kar: 0, kul: 0, raf: 18, fiz: 18, rez: 0, kullan: 18 }, "X adım 3");
    await putaway(pickerP(), { taskId: ty.id, sourceLocationId: KABUL, targetLocationId: R02, itemId: Y, quantity: "9" });
    await expectRow(Y, KABUL, R02, { kar: 0, kul: 0, dmg: 1, raf: 9, fiz: 10, rez: 0, kullan: 9 }, "Y adım 3");
    expect((await tasksOf(g.id)).every((t) => t.status === "DONE")).toBe(true);
  });
});

describe("kurallar", () => {
  it("@AC-02 aynı istemci anahtarıyla tekrar kabul → tek etki (AC-02 eşdeğeri)", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    const key = uuid();
    const input = { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "4", locationId: KABUL }] };
    const first = await receiveGoods(pickerP(key), input);
    const again = await receiveGoods(pickerP(key), input);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, documentId: first.documentId });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(4));
    expect(await ledgerCount(X)).toBe(1);
    expect(await lineRow(g.lineIds[0] as string)).toMatchObject({ received: n(4) });
    expect(await audits("inbound_receipt.received", g.id)).toBe(1);
    // Aynı anahtar farklı içerik → IDEMPOTENCY_MISMATCH
    const e = await failure(receiveGoods(pickerP(key), { ...input, lines: [{ lineId: g.lineIds[0] as string, received: "5", locationId: KABUL }] }));
    expect(e.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("fazla kabul reddedilir (kümülatif); stok ve satır değişmez; kısmi kabul satırı açık bırakır", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    const lineId = g.lineIds[0] as string;
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "6", locationId: KABUL }] });
    expect(await receiptRow(g.id)).toMatchObject({ status: "OPEN" });
    const e = await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "5", locationId: KABUL }] }));
    expect(codeOf(e)).toBe("VALIDATION_FAILED");
    expect(await lineRow(lineId)).toMatchObject({ received: n(6) });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(6));
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "4", locationId: KABUL }] });
    expect(await receiptRow(g.id)).toMatchObject({ status: "CLOSED" });
    // CLOSED belgeye kabul → DOCUMENT_STATE
    expect(codeOf(await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "1", locationId: KABUL }] })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });

  it("hedef RECEIVING değilse reddedilir; beklenen teslimsiz (DRAFT/olmayan) kabul yok", async () => {
    const X = await mkItem();
    const STORAGE = await mkLoc("STORAGE");
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "5" }]);
    const lineId = g.lineIds[0] as string;
    expect(codeOf(await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "1", locationId: STORAGE }] })))).toBe("VALIDATION_FAILED");
    expect(await ledgerCount(X)).toBe(0);
    const c = await createInboundReceipt(ownerP(), { warehouseId: A.warehouseId, lines: [{ itemId: X, unitId: A.unitId, expectedQuantity: "5" }] });
    const dLine = (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id=$1", [c.documentId]))[0]?.id as string;
    expect(codeOf(await failure(receiveGoods(pickerP(), { receiptId: c.documentId as string, lines: [{ lineId: dLine, received: "1", locationId: KABUL }] })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect((await failure(receiveGoods(pickerP(), { receiptId: uuid(), lines: [{ lineId, received: "1", locationId: KABUL }] }))).code).toBe("NOT_FOUND");
  });

  it("başka belgenin satırı (A-152) NOT_FOUND; başka tenant'ın belgesi NOT_FOUND; hiçbir yazım kalmaz", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g1 = await mkReceipt([{ itemId: X, expected: "5" }]);
    const g2 = await mkReceipt([{ itemId: X, expected: "5" }]);
    const foreign = g2.lineIds[0] as string;
    expect((await failure(receiveGoods(pickerP(), { receiptId: g1.id, lines: [{ lineId: foreign, received: "1", locationId: KABUL }] }))).code).toBe("NOT_FOUND");
    expect(await ledgerCount(X)).toBe(0);
    expect(await lineRow(foreign)).toMatchObject({ received: n(0) });
    const bP: StockDocCallParams = { db: app, principal: { userId: B.ownerUserId, mfaVerified: true }, tenantSlug: B.slug, clientKey: uuid(), retry: NO_WAIT };
    expect((await failure(receiveGoods(bP, { receiptId: g1.id, lines: [{ lineId: g1.lineIds[0] as string, received: "1", locationId: KABUL }] }))).code).toBe("NOT_FOUND");
    expect(await ledgerCount(X)).toBe(0);
  });

  it("PICKER kalite onayı → FORBIDDEN; stok değişmez; PICKER kabul ve yerleştirme yapabilir", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "5" }]);
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "5", locationId: KABUL }] });
    expect((await failure(approveQuality(pickerP(), { receiptId: g.id }))).code).toBe("FORBIDDEN");
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(5));
    expect(await tasksOf(g.id)).toHaveLength(0);
    // PICKER belge oluşturamaz/açamaz (document.create yok)
    expect((await failure(createInboundReceipt(pickerP(), { warehouseId: A.warehouseId, lines: [{ itemId: X, unitId: A.unitId, expectedQuantity: "1" }] }))).code).toBe("FORBIDDEN");
  });

  it("iptal: kabul yapılmamışsa CANCELLED; kabul varsa DOCUMENT_STATE; sürüm uyuşmazlığı VERSION_CONFLICT", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g1 = await mkReceipt([{ itemId: X, expected: "5" }]);
    expect((await failure(cancelInboundReceipt(ownerP(), { receiptId: g1.id, expectedVersion: 1 }))).code).toBe("VERSION_CONFLICT");
    await cancelInboundReceipt(ownerP(), { receiptId: g1.id, expectedVersion: 2, reason: "yanlis kayit" });
    expect(await receiptRow(g1.id)).toMatchObject({ status: "CANCELLED" });
    expect(await audits("inbound_receipt.cancelled", g1.id)).toBe(1);
    expect(codeOf(await failure(cancelInboundReceipt(ownerP(), { receiptId: g1.id, expectedVersion: 3 })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const g2 = await mkReceipt([{ itemId: X, expected: "5" }]);
    await receiveGoods(pickerP(), { receiptId: g2.id, lines: [{ lineId: g2.lineIds[0] as string, received: "1", locationId: KABUL }] });
    const v = (await receiptRow(g2.id)).version;
    expect(codeOf(await failure(cancelInboundReceipt(ownerP(), { receiptId: g2.id, expectedVersion: v })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await receiptRow(g2.id)).toMatchObject({ status: "OPEN" });
  });

  it("yerleştirme: hedef STORAGE değil / aynı lokasyon / görev uyuşmazlığı reddedilir; sayımdaki lokasyon LOCATION_LOCKED", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const STAGE = await mkLoc("STAGING");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "10", locationId: KABUL }] });
    await approveQuality(ownerP(), { receiptId: g.id });
    const task = (await tasksOf(g.id))[0] as { id: string };
    expect(codeOf(await failure(putaway(pickerP(), { sourceLocationId: KABUL, targetLocationId: STAGE, itemId: X, quantity: "1" })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(putaway(pickerP(), { taskId: task.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "9" })))).toBe("VALIDATION_FAILED"); // görev miktarı 10
    expect((await tasksOf(g.id))[0]?.status).toBe("OPEN");
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(10));

    // Sayım kilidi: hedef lokasyon COUNTING → LOCATION_LOCKED, stok değişmez.
    const session = uuid();
    await q("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, started_by) VALUES ($1,$2,$3,$4)", [A.tenantId, session, A.warehouseId, A.ownerMembershipId]);
    await q("UPDATE public.location_count_locks SET status='COUNTING', count_session_id=$3, locked_at=now(), locked_by=$4 WHERE tenant_id=$1 AND location_id=$2", [
      A.tenantId, R01, session, A.ownerMembershipId,
    ]);
    try {
      expect((await failure(putaway(pickerP(), { taskId: task.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "10" }))).code).toBe("LOCATION_LOCKED");
      expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(10));
      expect((await tasksOf(g.id))[0]?.status).toBe("OPEN");
    } finally {
      await q("UPDATE public.location_count_locks SET status='IDLE', count_session_id=NULL, locked_at=NULL, locked_by=NULL WHERE tenant_id=$1 AND location_id=$2", [A.tenantId, R01]);
    }
    await putaway(pickerP(), { taskId: task.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "10" });
    expect(await bal(X, R01, "AVAILABLE")).toBe(n(10));
  });

  it("başkasına atanmış görev: PICKER (atanmayan) FORBIDDEN; yönetici tamamlayabilir", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const g = await mkReceipt([{ itemId: X, expected: "3" }]);
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "3", locationId: KABUL }] });
    await approveQuality(ownerP(), { receiptId: g.id });
    const task = (await tasksOf(g.id))[0] as { id: string };
    await q("UPDATE public.warehouse_tasks SET status='ASSIGNED', assigned_membership_id=$3 WHERE tenant_id=$1 AND id=$2", [A.tenantId, task.id, A.ownerMembershipId]);
    expect((await failure(putaway(pickerP(), { taskId: task.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "3" }))).code).toBe("FORBIDDEN");
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(3));
    await putaway(ownerP(), { taskId: task.id, sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "3" });
    expect((await tasksOf(g.id))[0]?.status).toBe("DONE");
  });

  it("kalite onayı kısmi (satır + lokasyon + miktar): kalan karantinada kalır; fazlası reddedilir; dimensions yolu da kabul satırına atfedilir", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    const lineId = g.lineIds[0] as string;
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "10", locationId: KABUL }] });
    await approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId, locationId: KABUL, quantity: "4" }] });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(6));
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(4));
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId, locationId: KABUL, quantity: "7" }] })))).toBe("VALIDATION_FAILED");
    await approveQuality(ownerP(), { dimensions: [{ itemId: X, locationId: KABUL, quantity: "2" }] });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(4));
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(6));
    expect(n(await physical(X))).toBe(n(10));
    // dimensions yolu da kabul satırına atfedilir (FIFO): görev kaynaklı ve bekleyen sayaç tutarlı (2 + 4 görev; 4 bekleyen kaldı).
    expect((await tasksOf(g.id)).map((t) => t.quantity)).toEqual([n(4), n(2)]);
    await approveQuality(ownerP(), { receiptId: g.id }); // kalan bekleyen = 10 − 4 − 2 = 4
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(0));
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(10));
  });

  it("eşzamanlı iki kabul (aynı belge, farklı satır/lokasyon): başlık kilidi serileştirir; 40P01 yok, son tamamlayan belgeyi kapatır", async () => {
    for (let round = 0; round < 4; round++) {
      const X = await mkItem();
      const Y = await mkItem();
      const K1 = await mkLoc("RECEIVING");
      const K2 = await mkLoc("RECEIVING");
      const g = await mkReceipt([{ itemId: X, expected: "5" }, { itemId: Y, expected: "5" }]);
      const once = { maxAttempts: 1, sleep: async () => undefined };
      const results = await Promise.allSettled([
        receiveGoods(pickerP(uuid(), { retry: once }), { receiptId: g.id, lines: [{ lineId: g.lineIds[0] as string, received: "5", locationId: K1 }] }),
        receiveGoods(pickerP(uuid(), { retry: once }), { receiptId: g.id, lines: [{ lineId: g.lineIds[1] as string, received: "5", locationId: K2 }] }),
      ]);
      expect(results.map((r) => r.status), `tur ${round}: ${JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")))}`).toEqual(["fulfilled", "fulfilled"]);
      expect(await receiptRow(g.id), `tur ${round}`).toMatchObject({ status: "CLOSED" });
      expect(await lineRow(g.lineIds[0] as string)).toMatchObject({ received: n(5) });
      expect(await lineRow(g.lineIds[1] as string)).toMatchObject({ received: n(5) });
      expect(n(await physical(X))).toBe(n(5));
      expect(n(await physical(Y))).toBe(n(5));
    }
  }, 120_000);

  it("eşzamanlı aynı satıra iki kabul: toplam beklenen aşılmaz (biri fazla kabul olarak reddedilir)", async () => {
    const X = await mkItem();
    const K1 = await mkLoc("RECEIVING");
    const K2 = await mkLoc("RECEIVING");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    const lineId = g.lineIds[0] as string;
    const results = await Promise.allSettled([
      receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "6", locationId: K1 }] }),
      receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "6", locationId: K2 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await lineRow(lineId)).toMatchObject({ received: n(6) });
    expect(n(await physical(X))).toBe(n(6));
  });
  it("MINOR-2 R1/R2: dimensions onayı kabul satırlarına FIFO atfedilir; bekleyen karantina belgeler arasında sapmaz", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const r1 = await mkReceipt([{ itemId: X, expected: "5" }]);
    const r2 = await mkReceipt([{ itemId: X, expected: "5" }]);
    await receiveGoods(pickerP(), { receiptId: r1.id, lines: [{ lineId: r1.lineIds[0] as string, received: "5", locationId: KABUL }] });
    await receiveGoods(pickerP(), { receiptId: r2.id, lines: [{ lineId: r2.lineIds[0] as string, received: "5", locationId: KABUL }] });
    // 7 birim: en eski kabul (R1) 5'in tamamı, R2'den 2.
    await approveQuality(ownerP(), { dimensions: [{ itemId: X, locationId: KABUL, quantity: "7" }] });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(3));
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(7));
    expect((await tasksOf(r1.id)).map((t) => t.quantity)).toEqual([n(5)]);
    expect((await tasksOf(r2.id)).map((t) => t.quantity)).toEqual([n(2)]);
    // R1'in bekleyeni 0 (onay yok → VALIDATION_FAILED); R2'nin bekleyeni 3 (5 değil): tamamı onaylanınca karantina 0.
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: r1.id })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: r2.id, lines: [{ lineId: r2.lineIds[0] as string, locationId: KABUL, quantity: "4" }] })))).toBe("VALIDATION_FAILED");
    await approveQuality(ownerP(), { receiptId: r2.id });
    expect(await bal(X, KABUL, "QUARANTINE")).toBe(n(0));
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(10));
    expect((await tasksOf(r2.id)).map((t) => t.quantity)).toEqual([n(2), n(3)]);
    // Mevcut karantinadan fazlası motorda reddedilir (INSUFFICIENT_STOCK); hiçbir şey yazılmaz.
    expect(codeOf(await failure(approveQuality(ownerP(), { dimensions: [{ itemId: X, locationId: KABUL, quantity: "1" }] })))).toBe("INSUFFICIENT_STOCK");
    expect(n(await physical(X))).toBe(n(10));
  });

  it("MINOR-6: LOT/SERIAL takipli ürünle beklenen teslim açılamaz (VALIDATION_FAILED); hiçbir satır yazılmaz", async () => {
    for (const mode of ["LOT", "SERIAL"] as const) {
      const T = await mkItem(mode);
      const before = Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.inbound_receipts WHERE tenant_id=$1", [A.tenantId]))[0]?.c);
      const e = await failure(createInboundReceipt(ownerP(), { warehouseId: A.warehouseId, lines: [{ itemId: T, unitId: A.unitId, expectedQuantity: "1" }] }));
      expect(codeOf(e), mode).toBe("VALIDATION_FAILED");
      expect(Number((await q<{ c: string }>("SELECT count(*)::text AS c FROM public.inbound_receipts WHERE tenant_id=$1", [A.tenantId]))[0]?.c)).toBe(before);
    }
  });

  it("MINOR-7: görevsiz yerleştirme eşleşen açık PUTAWAY görevlerini FIFO kapatır; karşılamayan ilk görevde durur", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const R01 = await mkLoc("STORAGE");
    const g = await mkReceipt([{ itemId: X, expected: "10" }]);
    const lineId = g.lineIds[0] as string;
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId, received: "10", locationId: KABUL }] });
    await approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId, locationId: KABUL, quantity: "4" }] }); // görev 1: 4
    await approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId, locationId: KABUL, quantity: "6" }] }); // görev 2: 6
    const [t1, t2] = (await tasksOf(g.id)) as unknown as [{ id: string }, { id: string }];
    // 3 birim: ilk görev (4) karşılanmaz → hiçbiri kapanmaz (görev miktarı sütunu değişmez; A-305-10).
    await putaway(pickerP(), { sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "3" });
    expect((await tasksOf(g.id)).map((t) => t.status)).toEqual(["OPEN", "OPEN"]);
    // 4 birim: FIFO ilk görev (4) karşılanır → DONE; ikinci görev (6) kalan 0 ile karşılanmaz.
    await putaway(pickerP(), { sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "4" });
    expect((await tasksOf(g.id)).map((t) => [t.id, t.status])).toEqual([[t1.id, "DONE"], [t2.id, "OPEN"]]);
    // 3 birim: ikinci görev (6) karşılanmaz → açık kalır.
    await putaway(pickerP(), { sourceLocationId: KABUL, targetLocationId: R01, itemId: X, quantity: "3" });
    expect((await tasksOf(g.id)).map((t) => t.status)).toEqual(["DONE", "OPEN"]);
    expect(n(await physical(X))).toBe(n(10));
    expect(await audits("warehouse_task.completed", t1.id)).toBe(1);
  });

  it("posting çekirdeği: belge kilitli değil / yabancı / bu tx'te yaratılmamış → INTERNAL; belge APPROVED kalır, defter yazılmaz (MAJOR)", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const mk = async () => {
      const c = await createStockDocument(ownerP(), {
        kind: "STOCK_IN",
        warehouseId: A.warehouseId,
        lines: [{ itemId: X, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", targetLocationId: KABUL, stockStatus: "AVAILABLE" }],
      });
      const id = c.documentId as string;
      await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
      return id;
    };
    const docA = await mk();
    const docB = await mk();
    const versionOf = async (id: string) => Number((await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [id]))[0]?.version);
    const vB = await versionOf(docB);
    const callCore = (lockedDoc: string | null, target: string) =>
      executeStockCommand({
        db: app,
        principal: { userId: A.ownerUserId, mfaVerified: true },
        tenantSlug: A.slug,
        clientKey: uuid(),
        retry: NO_WAIT,
        commandType: "stock.test.core",
        permission: "stock.post",
        input: { lockedDoc, target },
        plan: async () => ({
          warehouseIds: [A.warehouseId],
          locks: {
            ...EMPTY_LOCK_PLAN,
            locationIds: [KABUL],
            dimensions: [{ itemId: X, locationId: KABUL, lotId: null, serialId: null, stockStatus: "AVAILABLE", inventoryOwnerId: null, handlingUnitId: null }],
            ...(lockedDoc === null ? {} : { document: { id: lockedDoc, expectedVersion: vB } }),
          },
        }),
        apply: (tx, locked, ctx) => postApprovedDocumentInTx(tx, locked, ctx, target, { requestId: null }),
      });
    const docStatus = async (id: string) => (await q<{ status: string }>("SELECT status FROM public.documents WHERE id=$1", [id]))[0]?.status;
    // 1) kilit planında belge yok, bu tx'te yaratılmadı
    expect((await failure(callCore(null, docA))).code).toBe("INTERNAL");
    // 2) başka belge kilitli, çekirdek yabancı belgeyi işlemek istiyor
    expect((await failure(callCore(docB, docA))).code).toBe("INTERNAL");
    expect(await docStatus(docA)).toBe("APPROVED");
    expect(await ledgerCount(X)).toBe(0);
    expect(n(await physical(X))).toBe(n(0));
    // Kontrol: kilitli belge (postDocument'la aynı koşul) işlenir.
    await callCore(docB, docB);
    expect(await docStatus(docB)).toBe("POSTED");
    expect(await ledgerCount(X)).toBe(1);
  });
});

// --- T-275 (T-305 MINOR-2/3/5; T-222 MINOR-4 wms_app yolu) ---------------------------------------------------------------
describe("T-275: birim yuvarlama, numara kilit sırası, özet normalizasyonu, damga bekçisi", () => {
  /** Ölçeği 6 olan ürün + koli birimi katsayısı 0,5 (1 koli = 0,5 temel); kabul satırı KOLİ biriminde. */
  async function mkHalfReceipt(expected: string, factor = "0.5"): Promise<{ id: string; lineId: string; item: string }> {
    const item = uuid();
    await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T275 urun',$4,'NONE',6)", [A.tenantId, item, `I-${hex(10)}`, A.unitId]);
    await q("INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1,$2,$3,$4)", [A.tenantId, item, A.boxUnitId, factor]);
    const c = await createInboundReceipt(ownerP(), { warehouseId: A.warehouseId, lines: [{ itemId: item, unitId: A.boxUnitId, expectedQuantity: expected }] });
    const id = c.documentId as string;
    await openInboundReceipt(ownerP(), { receiptId: id, expectedVersion: 1 });
    return { id, lineId: ((await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1", [id]))[0] as { id: string }).id, item };
  }

  // T-287 + T-290 (I-09): temel miktar KESİN çarpım, tek `toBase` kuralı; 6 ondalığa inmeyen sonuç yuvarlanmaz, reddedilir.
  // T-275'in yarım-yukarı yuvarlama beklentileri bu kurala göre yeniden yazıldı (Supervisor kararı 2026-10-07).
  it("MINOR-2 (I-09): kabul 0,000008 (hasarlı 0,000002) × 0,5 → toplam 0,000004 = iyi 0,000003 + hasarlı 0,000001; ölçeğe inmeyen onay reddedilir, kesin onay kalanın tamamını alır", async () => {
    await setQc(true);
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkHalfReceipt("0.000010");
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, received: "0.000008", damaged: "0.000002", locationId: KABUL }] });
    expect(await bal(g.item, KABUL, "DAMAGED")).toBe(n("0.000001"));
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n("0.000003"));
    expect(n(await ledgerSum(g.item))).toBe(n("0.000004"));
    const ledgerBefore = await ledgerCount(g.item);
    // 0,000003 × 0,5 = 0,0000015 → 6 ondalığa inmez: yuvarlanmaz, reddedilir; hiçbir şey yazılmaz.
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, locationId: KABUL, quantity: "0.000003" }] })))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(await ledgerCount(g.item)).toBe(ledgerBefore);
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n("0.000003"));
    await approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, locationId: KABUL, quantity: "0.000006" }] });
    expect(await bal(g.item, KABUL, "AVAILABLE")).toBe(n("0.000003"));
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n(0));
    expect(await bal(g.item, KABUL, "DAMAGED")).toBe(n("0.000001"));
    expect(n(await ledgerSum(g.item))).toBe(n("0.000004"));
    // Bekleyenin ikinci katı aşılmaz: kalan yokken yeni onay reddedilir.
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, locationId: KABUL, quantity: "0.000002" }] })))).toBe("VALIDATION_FAILED");
  });

  it("MINOR-2 (I-09): toplamı ya da hasarlısı × 0,5 ile 6 ondalığa inmeyen kabul QUANTITY_SCALE ile reddedilir; hiçbir şey yazılmaz, birim sayaçları değişmez", async () => {
    await setQc(true);
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkHalfReceipt("0.000010");
    // hasarlı 0,000001 × 0,5 = 0,0000005 (eski davranış: 0,000001'e yuvarlanırdı)
    expect(codeOf(await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, received: "0.000002", damaged: "0.000001", locationId: KABUL }] })))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    // toplam 0,000003 × 0,5 = 0,0000015
    expect(codeOf(await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, received: "0.000003", damaged: "0", locationId: KABUL }] })))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(await ledgerCount(g.item)).toBe(0);
    expect(await bal(g.item, KABUL, "DAMAGED")).toBe(n(0));
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n(0));
    expect(await lineRow(g.lineId)).toMatchObject({ received: n(0), damaged: n(0) });
  });

  it("MINOR-2 (hasarlı yuvarlama): hasarlı > 0 ama temel birimde 0'a yuvarlanıyorsa kabul VALIDATION_FAILED; hasarlı mal iyi stok olmaz, hiçbir şey yazılmaz", async () => {
    await setQc(false); // kalite kapalı: iyi stok doğrudan AVAILABLE olurdu
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkHalfReceipt("0.000010", "0.3");
    // hasarlı 0,000001 × 0,3 = 0,0000003 → 0 temel; toplam 0,000010 × 0,3 = 3 temel. Eski: hasarlı satır atlanır, 3 birimin tamamı AVAILABLE olurdu.
    const e = await failure(receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, received: "0.000010", damaged: "0.000001", locationId: KABUL }] }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(await ledgerCount(g.item)).toBe(0);
    expect(await bal(g.item, KABUL, "AVAILABLE")).toBe(n(0));
    expect(await lineRow(g.lineId)).toMatchObject({ received: n(0), damaged: n(0) });
    await setQc(true);
  });

  it("MINOR-3 (tolerans): katsayı 12'de bekleyeni bir mikro-birim (12 temel mikro) aşan onay isteği KIRPILMAZ, reddedilir; bekleyenin kendisi onaylanır", async () => {
    await setQc(true);
    const KABUL = await mkLoc("RECEIVING");
    const g = await mkHalfReceipt("0.000010", "12");
    await receiveGoods(pickerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, received: "0.000001", locationId: KABUL }] }); // 0,000012 temel bekleyen
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n("0.000012"));
    expect(codeOf(await failure(approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, locationId: KABUL, quantity: "0.000002" }] })))).toBe("VALIDATION_FAILED");
    expect(await bal(g.item, KABUL, "QUARANTINE")).toBe(n("0.000012"));
    await approveQuality(ownerP(), { receiptId: g.id, lines: [{ lineId: g.lineId, locationId: KABUL, quantity: "0.000001" }] });
    expect(await bal(g.item, KABUL, "AVAILABLE")).toBe(n("0.000012"));
  });

  it("MINOR-3: createInboundReceipt numara satırını beklerken birim satırlarını ZATEN paylaşımlı kilitlemiştir (number_sequences son kilit)", async () => {
    // Sayaç satırı yoksa oluşsun: bir kabul.
    await createInboundReceipt(ownerP(), { warehouseId: A.warehouseId, lines: [{ itemId: await mkItem(), unitId: A.unitId, expectedQuantity: "1" }] });
    const year = (await q<{ y: string }>("SELECT period AS y FROM public.number_sequences WHERE tenant_id=$1 AND document_kind='INBOUND_RECEIPT' LIMIT 1", [A.tenantId]))[0]?.y;
    expect(year).toBeDefined();
    const item = await mkItem();
    const holder = new pg.Client({ connectionString: env.databaseUrlDirect });
    const probe = new pg.Client({ connectionString: env.databaseUrlDirect });
    holder.on("error", () => undefined);
    probe.on("error", () => undefined);
    await holder.connect();
    await probe.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM public.number_sequences WHERE tenant_id=$1 AND document_kind='INBOUND_RECEIPT' AND period=$2 FOR UPDATE", [A.tenantId, year]);
      pending = createInboundReceipt(ownerP(), { warehouseId: A.warehouseId, lines: [{ itemId: item, unitId: A.unitId, expectedQuantity: "1" }] });
      pending.catch(() => undefined);
      // Komut sıra satırında bloklanana dek bekle.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = (await probe.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%number_sequences%' AND pid <> pg_backend_pid()")).rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, "komut number_sequences satırında bloklanmalı").toBe(true);
      // Bu anda komut birim, ürün ve depo satırlarını tutuyor olmalı: NOWAIT kilit denemesi başarısız (55P03).
      for (const [tbl, id] of [["units", A.unitId], ["items", item], ["warehouses", A.warehouseId]] as const) {
        await probe.query("BEGIN");
        await expect(probe.query(`SELECT 1 FROM public.${tbl} WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT`, [A.tenantId, id]), `${tbl} kilitli olmalı`).rejects.toMatchObject({ code: "55P03" });
        await probe.query("ROLLBACK");
      }
    } finally {
      await holder.query("COMMIT").catch(() => undefined);
      if (pending !== undefined) await pending.catch(() => undefined);
      await holder.end();
      await probe.end();
    }
    expect((await pending) as { documentNumber: string }).toMatchObject({ documentNumber: expect.stringMatching(/^KBL-\d{4}-\d{6}$/) });
  });

  it("MINOR-5: '10' ve '10.000000' aynı idempotency özeti (kabul, oluşturma, onay); farklı miktar IDEMPOTENCY_MISMATCH", async () => {
    await setQc(true);
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const ckey = uuid();
    const c1 = await createInboundReceipt(ownerP(ckey), { warehouseId: A.warehouseId, lines: [{ itemId: X, unitId: A.unitId, expectedQuantity: "10" }] });
    const c2 = await createInboundReceipt(ownerP(ckey), { warehouseId: A.warehouseId, lines: [{ itemId: X, unitId: A.unitId, expectedQuantity: "10.000000" }] });
    expect(c2.replayed).toBe(true);
    expect(c2.documentId).toBe(c1.documentId);
    const id = c1.documentId as string;
    await openInboundReceipt(ownerP(), { receiptId: id, expectedVersion: 1 });
    const lineId = ((await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1", [id]))[0] as { id: string }).id;
    const rkey = uuid();
    const r1 = await receiveGoods(pickerP(rkey), { receiptId: id, lines: [{ lineId, received: "10", locationId: KABUL }] });
    const r2 = await receiveGoods(pickerP(rkey), { receiptId: id, lines: [{ lineId, received: "10.000000", damaged: "0.0", locationId: KABUL }] });
    expect(r2.replayed).toBe(true);
    expect(r2.documentId).toBe(r1.documentId);
    expect(n(await physical(X))).toBe(n(10)); // tek etki
    expect(codeOf(await failure(receiveGoods(pickerP(rkey), { receiptId: id, lines: [{ lineId, received: "10.000001", locationId: KABUL }] })))).toBe("IDEMPOTENCY_MISMATCH");
    const akey = uuid();
    const a1 = await approveQuality(ownerP(akey), { receiptId: id, lines: [{ lineId, locationId: KABUL, quantity: "4" }] });
    const a2 = await approveQuality(ownerP(akey), { receiptId: id, lines: [{ lineId, locationId: KABUL, quantity: "4.000000" }] });
    expect(a2.replayed).toBe(true);
    expect(a2.documentId).toBe(a1.documentId);
    expect(await bal(X, KABUL, "AVAILABLE")).toBe(n(4));
  });

  it("T-222 MINOR-4 (wms_app): damga yalnızca posting_job_id NULL→dolu geçişinde yazılır; sonradan yazma/değiştirme reddedilir; temizleme serbest", async () => {
    const X = await mkItem();
    const KABUL = await mkLoc("RECEIVING");
    const created = await createStockDocument(ownerP(), {
      kind: "STOCK_IN",
      warehouseId: A.warehouseId,
      lines: [{ itemId: X, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", targetLocationId: KABUL, stockStatus: "AVAILABLE" }],
    });
    const id = created.documentId as string;
    await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
    const web = new pg.Client({ connectionString: env.databaseUrl }); // wms_app (pooler)
    web.on("error", () => undefined);
    await web.connect();
    const tryUpdate = async (text: string, params: unknown[]): Promise<"ok" | string> => {
      await web.query("BEGIN");
      try {
        await web.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        await web.query(text, params);
        await web.query("COMMIT");
        return "ok";
      } catch (e) {
        await web.query("ROLLBACK");
        return /POSTING_STAMP_GUARD/.test((e as Error).message) ? "guard" : `other:${(e as Error).message}`;
      }
    };
    const stamp = async () =>
      (await q<{ job: string | null; mfa: Date | null; rec: string | null }>("SELECT posting_job_id AS job, posting_mfa_verified_at AS mfa, posting_idempotency_record_id AS rec FROM public.documents WHERE id=$1", [id]))[0] as {
        job: string | null; mfa: Date | null; rec: string | null;
      };
    try {
      const job = uuid();
      const rec = uuid();
      // Gelecek damga (yalnızca now() kabul): kilitle birlikte bile reddedilir.
      expect(
        await tryUpdate("UPDATE public.documents SET posting_job_id=$3, posting_requested_by=$4, posting_mfa_verified_at=now() + interval '1 hour', posting_idempotency_record_id=$5 WHERE tenant_id=$1 AND id=$2", [A.tenantId, id, job, A.ownerUserId, rec]),
      ).toBe("guard");
      // Kilit yokken tek başına damga: reddedilir.
      expect(await tryUpdate("UPDATE public.documents SET posting_mfa_verified_at = now() WHERE tenant_id=$1 AND id=$2", [A.tenantId, id])).toBe("guard");
      // deferToWorker biçimi: kilit + damga aynı ifadede.
      expect(
        await tryUpdate("UPDATE public.documents SET posting_job_id=$3, posting_requested_by=$4, posting_mfa_verified_at=now(), posting_idempotency_record_id=$5 WHERE tenant_id=$1 AND id=$2", [A.tenantId, id, job, A.ownerUserId, rec]),
      ).toBe("ok");
      const s1 = await stamp();
      expect(s1.job).toBe(job);
      expect(s1.mfa).not.toBeNull();
      // Kilit doluyken damgayı değiştirme / yeniden yazma: reddedilir, değer değişmez.
      expect(await tryUpdate("UPDATE public.documents SET posting_mfa_verified_at = now() + interval '5 seconds' WHERE tenant_id=$1 AND id=$2", [A.tenantId, id])).toBe("guard");
      expect(await tryUpdate("UPDATE public.documents SET posting_idempotency_record_id=$3 WHERE tenant_id=$1 AND id=$2", [A.tenantId, id, uuid()])).toBe("guard");
      expect(await stamp()).toEqual(s1);
      // MINOR-1: damga işine/istek sahibine bağlıdır: kilit doluyken istek sahibi ya da iş damga temizlenmeden değiştirilemez.
      expect(await tryUpdate("UPDATE public.documents SET posting_requested_by=$3 WHERE tenant_id=$1 AND id=$2", [A.tenantId, id, A.memberUserId])).toBe("guard");
      expect(await tryUpdate("UPDATE public.documents SET posting_job_id=$3 WHERE tenant_id=$1 AND id=$2", [A.tenantId, id, uuid()])).toBe("guard");
      expect(await stamp()).toEqual(s1);
      // Temizleme (failPostingInTx / assignNumber biçimi): serbest.
      expect(
        await tryUpdate("UPDATE public.documents SET posting_job_id=NULL, posting_requested_by=NULL, posting_mfa_verified_at=NULL, posting_idempotency_record_id=NULL WHERE tenant_id=$1 AND id=$2", [A.tenantId, id]),
      ).toBe("ok");
      expect(await stamp()).toEqual({ job: null, mfa: null, rec: null });
    } finally {
      await web.end();
    }
  });
});
