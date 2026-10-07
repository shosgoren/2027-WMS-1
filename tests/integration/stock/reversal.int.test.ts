// T-224: ters kayıt (reverseDocument). GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile.
// Beklenen değerler docs/spec/16-stock-effects.md Senaryo C (AC-06) ve I-08/I-15. Fikstürler sentetiktir (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  approveDocument,
  createStockDocument,
  getReversalCapacity,
  postDocument,
  reserve,
  reverseDocument,
  type DocumentLineInput,
  type ReverseDocumentInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import {
  approveQuality,
  createInboundReceipt,
  openInboundReceipt,
  receiveGoods,
} from "../../../packages/domain/src/operations/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;

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
async function mkItem(mode: "NONE" | "SERIAL" = "NONE", scale = 0): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T224 urun',$4,$5,$6)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId, mode, scale,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" = "STORAGE"): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T224 lok',0,$5,false)", [
    A.tenantId, id, A.warehouseId, `L-${hex(10)}`, kind,
  ]);
  return id;
}
async function mkSerial(itemId: string): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id) VALUES ($1,$2,$3,$4,NULL)", [A.tenantId, id, itemId, `SN-${hex(10)}`]);
  return id;
}
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({ itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over });
const qty = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });

/** DRAFT → APPROVED. */
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<{ id: string; version: number; lineIds: string[] }> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = await docRow(id);
  expect(v.status).toBe("APPROVED");
  return { id, version: v.version, lineIds: (c.lines ?? []).map((l) => l.lineId) };
}
type Doc = Awaited<ReturnType<typeof mkApproved>>;
const post = (d: { id: string; version: number }, p: StockDocCallParams = ownerP()) => postDocument(p, { documentId: d.id, expectedVersion: d.version });
/** Onayla + işle; POSTED belge döner. */
async function mkPosted(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<Doc> {
  const d = await mkApproved(kind, lines);
  expect((await post(d)).status).toBe("POSTED");
  return d;
}
const docRow = async (id: string) =>
  (await q<{ status: string; version: number; number: string | null; posting_job_id: string | null; kind: string; reversal_of_document_id: string | null; reason: string | null }>(
    "SELECT status, version, number, posting_job_id, kind, reversal_of_document_id, reason FROM public.documents WHERE id = $1", [id]))[0] as {
    status: string; version: number; number: string | null; posting_job_id: string | null; kind: string; reversal_of_document_id: string | null; reason: string | null;
  };
const lineRow = async (id: string) =>
  (await q<{ reversed_quantity: string; reversal_status: string; base_quantity: string }>(
    "SELECT reversed_quantity::text AS reversed_quantity, reversal_status, base_quantity::text AS base_quantity FROM public.document_lines WHERE id = $1", [id]))[0] as {
    reversed_quantity: string; reversal_status: string; base_quantity: string;
  };

interface Dim { item: string; loc: string; status?: string; serial?: string | null }
async function bal(d: Dim): Promise<string> {
  const r = await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
      WHERE s.tenant_id = $1 AND s.item_id = $2 AND s.location_id = $3 AND s.stock_status = $4 AND s.serial_id IS NOT DISTINCT FROM $5`,
    [A.tenantId, d.item, d.loc, d.status ?? "AVAILABLE", d.serial ?? null],
  );
  return r[0]?.quantity ?? "0.000000";
}
const ledgerOf = async (docId: string): Promise<{ quantity: string; reason: string }[]> =>
  q("SELECT quantity::text AS quantity, reason FROM public.stock_ledger WHERE tenant_id=$1 AND document_id=$2 ORDER BY quantity", [A.tenantId, docId]);
const reversalDocsOf = async (docId: string): Promise<{ id: string; status: string; number: string | null }[]> =>
  q("SELECT id, status, number FROM public.documents WHERE tenant_id=$1 AND reversal_of_document_id=$2 ORDER BY created_at", [A.tenantId, docId]);
const reversalLedgerCount = async (item: string): Promise<number> =>
  Number((await q<{ n: string }>(
    "SELECT count(*)::text AS n FROM public.stock_ledger l JOIN public.stock_dimensions d ON d.tenant_id=l.tenant_id AND d.id=l.stock_dimension_id WHERE l.tenant_id=$1 AND d.item_id=$2 AND l.reason='REVERSAL'",
    [A.tenantId, item]))[0]?.n);
/** Defter toplamı = bakiye ve hiçbir bakiye negatif değil (boyut başına). */
async function ledgerMatchesBalances(item: string): Promise<boolean> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b
      JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND (b.quantity < 0 OR b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0))`,
    [A.tenantId, item]);
  return r[0]?.n === "0";
}
const auditCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE tenant_id=$1 AND action='stock_document.reversed' AND entity_id=$2", [A.tenantId, docId]))[0]?.n);

const reverse = (docId: string, lines: ReverseDocumentInput["lines"], p: StockDocCallParams = ownerP(), reason = "Yanlış giriş") =>
  reverseDocument(p, { documentId: docId, lines, reason });

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A224");
}, 120_000);

afterEach(() => {
  delete process.env.STOCK_SERIAL_LOCK_ENABLED;
});

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("Senaryo C (16-stock-effects) — AC-06", () => {
  it("100 giriş, 60 çıkış: tam ters REVERSAL_BLOCKED (hiçbir şey yazılmaz); 40 ters → R-01 = 0, PARTIAL 40/100; aynı anahtar tekrarı ilk sonuç", async () => {
    const x = await mkItem();
    const r01 = await mkLoc();
    const g1 = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: r01, ...qty("100") })]);
    await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: r01, ...qty("60") })]);
    expect(await bal({ item: x, loc: r01 })).toBe("40.000000");
    const g1Line = g1.lineIds[0] as string;

    // Kullanıcıya "kalan X; en çok X": kapasite okuması
    const cap = await getReversalCapacity(ownerP(null), g1.id);
    expect(cap).toEqual([{ lineId: g1Line, lineNo: 1, baseQuantity: "100.000000", reversedQuantity: "0.000000", remaining: "100.000000", maxReversible: "40.000000", estimated: true }]);

    // Satır 1: tamamını ters çevir → ret, hiçbir satır yazılmaz
    const before = await reversalLedgerCount(x);
    const e = await failure(reverse(g1.id, "ALL"));
    expect(codeOf(e)).toBe("REVERSAL_BLOCKED/STOCK_USED");
    expect(e.httpStatus).toBe(409);
    expect(await bal({ item: x, loc: r01 })).toBe("40.000000");
    expect(await reversalLedgerCount(x)).toBe(before);
    expect(await reversalDocsOf(g1.id)).toEqual([]);
    expect(await lineRow(g1Line)).toMatchObject({ reversed_quantity: "0.000000", reversal_status: "NONE" });
    expect(await auditCount(g1.id)).toBe(0);

    // Satır 2: 40 ters çevir
    const key = uuid();
    const input: ReverseDocumentInput = { documentId: g1.id, lines: [{ lineId: g1Line, quantity: "40" }], reason: "Yanlış giriş" };
    const first = await reverseDocument(ownerP(key), input);
    expect(first.status).toBe("POSTED");
    expect(first.replayed).toBe(false);
    expect(first.lines).toEqual([{ lineId: g1Line, lineNo: 1, baseQuantity: "40.000000", reversedQuantity: "40.000000" }]);
    expect(await bal({ item: x, loc: r01 })).toBe("0.000000");
    expect(await lineRow(g1Line)).toMatchObject({ reversed_quantity: "40.000000", reversal_status: "PARTIAL" });
    const rev = await docRow(first.documentId as string);
    expect(rev).toMatchObject({ kind: "REVERSAL", status: "POSTED", reversal_of_document_id: g1.id, reason: "Yanlış giriş" });
    expect(rev.number).toMatch(/^TRS-\d{4}-\d{6}$/);
    expect(first.documentNumber).toBe(rev.number);
    expect(await ledgerOf(first.documentId as string)).toEqual([{ quantity: "-40.000000", reason: "REVERSAL" }]);
    // asıl belge değişmedi
    expect((await docRow(g1.id)).status).toBe("POSTED");
    expect(await ledgerOf(g1.id)).toEqual([{ quantity: "100.000000", reason: "RECEIPT" }]);
    expect(await auditCount(g1.id)).toBe(1);
    const audit = (await q<{ actor_user_id: string; reason: string; change_summary: Record<string, unknown> }>(
      "SELECT actor_user_id, reason, change_summary FROM public.audit_logs WHERE tenant_id=$1 AND action='stock_document.reversed' AND entity_id=$2", [A.tenantId, g1.id]))[0];
    expect(audit?.actor_user_id).toBe(A.ownerUserId);
    expect(audit?.reason).toBe("Yanlış giriş");
    expect(audit?.change_summary).toMatchObject({ reversalDocumentId: first.documentId, reversalOfDocumentId: g1.id });

    // Satır 3: aynı anahtar tekrarı → ilk sonuç, ikinci −40 yazılmaz
    const again = await reverseDocument(ownerP(key), input);
    expect(again.replayed).toBe(true);
    expect(again.documentId).toBe(first.documentId);
    expect(again.documentNumber).toBe(first.documentNumber);
    expect(await bal({ item: x, loc: r01 })).toBe("0.000000");
    expect(await reversalDocsOf(g1.id)).toHaveLength(1);
    expect(await lineRow(g1Line)).toMatchObject({ reversed_quantity: "40.000000" });
    expect(await auditCount(g1.id)).toBe(1);
    // aynı anahtar, farklı içerik
    expect(codeOf(await failure(reverseDocument(ownerP(key), { ...input, lines: [{ lineId: g1Line, quantity: "41" }] })))).toBe("IDEMPOTENCY_MISMATCH");
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("ret kalıcıdır: aynı anahtar + aynı içerik aynı reddi döner (I-06), yeni anahtar yeniden değerlendirir", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    const out = await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("4") })]);
    const key = uuid();
    expect(codeOf(await failure(reverseDocument(ownerP(key), { documentId: g.id, lines: "ALL", reason: "r" })))).toBe("REVERSAL_BLOCKED/STOCK_USED");
    // 4'ü geri getir (çıkışı ters çevir) → artık tam ters mümkün; eski anahtar yine eski reddi döner
    await reverse(out.id, "ALL");
    expect(codeOf(await failure(reverseDocument(ownerP(key), { documentId: g.id, lines: "ALL", reason: "r" })))).toBe("REVERSAL_BLOCKED/STOCK_USED");
    const ok = await reverseDocument(ownerP(uuid()), { documentId: g.id, lines: "ALL", reason: "r" });
    expect(ok.status).toBe("POSTED");
    expect(await bal({ item: x, loc })).toBe("0.000000");
  });
});

describe("kalan ters çevrilmemiş miktar sınırı (I-08)", () => {
  it("4 + 7 > 10 reddedilir; 4 + 6 = FULL; sonrası EXCEEDS_REMAINING; ALL kalanı çevirir", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    const lid = g.lineIds[0] as string;
    await reverse(g.id, [{ lineId: lid, quantity: "4" }]);
    expect(await lineRow(lid)).toMatchObject({ reversed_quantity: "4.000000", reversal_status: "PARTIAL" });
    expect(codeOf(await failure(reverse(g.id, [{ lineId: lid, quantity: "7" }])))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
    expect(await lineRow(lid)).toMatchObject({ reversed_quantity: "4.000000" });
    expect((await getReversalCapacity(ownerP(null), g.id))[0]).toMatchObject({ remaining: "6.000000", maxReversible: "6.000000" });
    const r = await reverse(g.id, "ALL"); // kalan 6
    expect(r.lines).toEqual([{ lineId: lid, lineNo: 1, baseQuantity: "6.000000", reversedQuantity: "10.000000" }]);
    expect(await lineRow(lid)).toMatchObject({ reversed_quantity: "10.000000", reversal_status: "FULL" });
    expect(codeOf(await failure(reverse(g.id, "ALL")))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
    expect(codeOf(await failure(reverse(g.id, [{ lineId: lid, quantity: "0.000001" }])))).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
    expect(await bal({ item: x, loc })).toBe("0.000000");
    expect(await ledgerMatchesBalances(x)).toBe(true);
    expect(await reversalDocsOf(g.id)).toHaveLength(2);
  });

  it("ürün ölçeğine uymayan miktar (ölçek 0 → 0,5) QUANTITY_SCALE; bilinmeyen satır, boş gerekçe VALIDATION_FAILED", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    const lid = g.lineIds[0] as string;
    expect(codeOf(await failure(reverse(g.id, [{ lineId: lid, quantity: "0.5" }])))).toBe("VALIDATION_FAILED/QUANTITY_SCALE");
    expect(codeOf(await failure(reverse(g.id, [{ lineId: uuid(), quantity: "1" }])))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(reverse(g.id, "ALL", ownerP(), "  ")))).toBe("VALIDATION_FAILED");
    expect(await bal({ item: x, loc })).toBe("10.000000");
  });
});

describe("hareket türleri", () => {
  it("STOCK_OUT ters kaydı stoğu kaynağa geri koyar", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    const out = await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("6") })]);
    expect(await bal({ item: x, loc })).toBe("4.000000");
    const r = await reverse(out.id, "ALL");
    expect(await bal({ item: x, loc })).toBe("10.000000");
    expect(await ledgerOf(r.documentId as string)).toEqual([{ quantity: "6.000000", reason: "REVERSAL" }]);
    expect(await lineRow(out.lineIds[0] as string)).toMatchObject({ reversal_status: "FULL" });
  });

  it("STOCK_MOVE ters kaydı iki boyutu birlikte geri alır (lokasyon); durum değiştiren taşıma reddedilir", async () => {
    const x = await mkItem();
    const a = await mkLoc();
    const b = await mkLoc();
    await mkPosted("STOCK_IN", [ln(x, { targetLocationId: a, ...qty("10") })]);
    const mv = await mkPosted("STOCK_MOVE", [ln(x, { sourceLocationId: a, targetLocationId: b, ...qty("7") })]);
    expect(await bal({ item: x, loc: a })).toBe("3.000000");
    expect(await bal({ item: x, loc: b })).toBe("7.000000");
    const r = await reverse(mv.id, "ALL");
    expect(await bal({ item: x, loc: a })).toBe("10.000000");
    expect(await bal({ item: x, loc: b })).toBe("0.000000");
    expect(await ledgerOf(r.documentId as string)).toEqual([
      { quantity: "-7.000000", reason: "REVERSAL" },
      { quantity: "7.000000", reason: "REVERSAL" },
    ]);
    // durum değiştiren taşıma (AVAILABLE → QUARANTINE) ters çevrilmez (M-1, A-224-3): hiçbir şey yazılmaz
    const sm = await mkPosted("STOCK_MOVE", [ln(x, { sourceLocationId: a, targetLocationId: a, targetStockStatus: "QUARANTINE", ...qty("5") })]);
    expect(await bal({ item: x, loc: a, status: "QUARANTINE" })).toBe("5.000000");
    const before = await reversalLedgerCount(x);
    expect(codeOf(await failure(reverse(sm.id, "ALL")))).toBe("REVERSAL_BLOCKED/STATUS_CHANGE");
    expect(codeOf(await failure(reverse(sm.id, [{ lineId: sm.lineIds[0] as string, quantity: "1" }])))).toBe("REVERSAL_BLOCKED/STATUS_CHANGE");
    expect((await getReversalCapacity(ownerP(null), sm.id))[0]?.maxReversible).toBe("0.000000");
    expect(await bal({ item: x, loc: a, status: "QUARANTINE" })).toBe("5.000000");
    expect(await bal({ item: x, loc: a })).toBe("5.000000");
    expect(await reversalLedgerCount(x)).toBe(before);
    expect(await reversalDocsOf(sm.id)).toEqual([]);
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("taşıma sonrası hedefteki mal çıktıysa taşımanın ters kaydı reddedilir; kısmi ters mümkün olan kadar", async () => {
    const x = await mkItem();
    const a = await mkLoc();
    const b = await mkLoc();
    await mkPosted("STOCK_IN", [ln(x, { targetLocationId: a, ...qty("10") })]);
    const mv = await mkPosted("STOCK_MOVE", [ln(x, { sourceLocationId: a, targetLocationId: b, ...qty("10") })]);
    await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: b, ...qty("8") })]);
    expect(codeOf(await failure(reverse(mv.id, "ALL")))).toBe("REVERSAL_BLOCKED/STOCK_USED");
    expect((await getReversalCapacity(ownerP(null), mv.id))[0]?.maxReversible).toBe("2.000000");
    await reverse(mv.id, [{ lineId: mv.lineIds[0] as string, quantity: "2" }]);
    expect(await bal({ item: x, loc: a })).toBe("2.000000");
    expect(await bal({ item: x, loc: b })).toBe("0.000000");
  });
});

describe("bağımlı işlem denetimi: rezervasyon ve seri", () => {
  it("aktif rezervasyon kullanılabiliri düşürüyorsa STOCK_RESERVED; rezervasyonun bıraktığı kadar ters çevrilebilir", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    const pendingOut = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("4") })]);
    await reserve(ownerP(), { documentLineId: pendingOut.lineIds[0] as string, allocations: [{ dimension: { locationId: loc }, quantity: "4" }] });
    expect(codeOf(await failure(reverse(g.id, "ALL")))).toBe("REVERSAL_BLOCKED/STOCK_RESERVED");
    expect(codeOf(await failure(reverse(g.id, [{ lineId: g.lineIds[0] as string, quantity: "7" }])))).toBe("REVERSAL_BLOCKED/STOCK_RESERVED");
    expect((await getReversalCapacity(ownerP(null), g.id))[0]?.maxReversible).toBe("6.000000");
    await reverse(g.id, [{ lineId: g.lineIds[0] as string, quantity: "6" }]);
    expect(await bal({ item: x, loc })).toBe("4.000000");
    const resv = await q<{ quantity: string; status: string }>("SELECT quantity::text AS quantity, status FROM public.reservations WHERE tenant_id=$1 AND document_line_id=$2", [A.tenantId, pendingOut.lineIds[0]]);
    expect(resv).toEqual([{ quantity: "4.000000", status: "ACTIVE" }]); // rezervasyona dokunulmaz (A-224-4)
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("seri: başka belgeyle taşınmış seri girişi ters çevrilemez; çıkışı ters çevirirken seri başka yerde stokta ise SERIAL_IN_USE", async () => {
    process.env.STOCK_SERIAL_LOCK_ENABLED = "true";
    const x = await mkItem("SERIAL");
    const s = await mkSerial(x);
    const a = await mkLoc();
    const b = await mkLoc();
    const c = await mkLoc();
    const inn = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: a, serialId: s, ...qty("1") })]);
    await mkPosted("STOCK_MOVE", [ln(x, { sourceLocationId: a, targetLocationId: b, serialId: s, ...qty("1") })]);
    expect(codeOf(await failure(reverse(inn.id, "ALL")))).toBe("REVERSAL_BLOCKED/STOCK_USED");
    expect(await bal({ item: x, loc: b, serial: s })).toBe("1.000000");

    const out = await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: b, serialId: s, ...qty("1") })]);
    await mkPosted("STOCK_IN", [ln(x, { targetLocationId: c, serialId: s, ...qty("1") })]); // aynı seri yeniden girdi
    expect(codeOf(await failure(reverse(out.id, "ALL")))).toBe("REVERSAL_BLOCKED/SERIAL_IN_USE");
    expect((await getReversalCapacity(ownerP(null), out.id))[0]?.maxReversible).toBe("0.000000"); // m-3: seri çakışması hesaba katılır
    expect(await bal({ item: x, loc: b, serial: s })).toBe("0.000000");
    expect(await ledgerMatchesBalances(x)).toBe(true);
  });

  it("arşivli lokasyona stok geri yazılamaz (IN_USE); lokasyondan çıkış arşiv engeli değildir", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("5") })]);
    const out = await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("5") })]);
    await q("UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [loc]);
    expect(codeOf(await failure(reverse(out.id, "ALL")))).toBe("VALIDATION_FAILED/IN_USE");
    expect((await getReversalCapacity(ownerP(null), out.id))[0]).toMatchObject({ maxReversible: "0.000000", estimated: true }); // m-3: arşiv hesaba katılır
    expect(await bal({ item: x, loc })).toBe("0.000000");
  });
});

describe("belge durumu ve yetki", () => {
  it("DRAFT/APPROVED/CANCELLED belge, ters kaydın ters kaydı ve işleme kilidi DOCUMENT_STATE", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const draft = await createStockDocument(ownerP(), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [ln(x, { targetLocationId: loc, ...qty("1") })] });
    expect(codeOf(await failure(reverse(draft.documentId as string, "ALL")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const approved = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("1") })]);
    expect(codeOf(await failure(reverse(approved.id, "ALL")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // işleme kilidi (T-222): APPROVED + posting_job_id
    await q("UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [approved.id, uuid(), A.ownerUserId]);
    expect(codeOf(await failure(reverse(approved.id, "ALL")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const cancelled = await createStockDocument(ownerP(), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [ln(x, { targetLocationId: loc, ...qty("1") })] });
    await q("UPDATE public.documents SET status = 'CANCELLED' WHERE id = $1", [cancelled.documentId]);
    expect(codeOf(await failure(reverse(cancelled.documentId as string, "ALL")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    // ters kaydın ters kaydı
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("3") })]);
    const r = await reverse(g.id, "ALL");
    expect(codeOf(await failure(reverse(r.documentId as string, "ALL")))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(reverse(uuid(), "ALL")))).toBe("NOT_FOUND");
  });

  it("izin (reversal.create), istek anahtarı ve yabancı tenant", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("3") })]);
    expect((await failure(reverse(g.id, "ALL", pickerP()))).code).toBe("FORBIDDEN"); // PICKER: reversal.create yok
    expect((await failure(getReversalCapacity({ ...pickerP(), clientKey: undefined } as never, g.id))).code).toBe("FORBIDDEN");
    expect(codeOf(await failure(reverse(g.id, "ALL", ownerP(null))))).toBe("VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED");
    expect(await bal({ item: x, loc })).toBe("3.000000");
    expect(await reversalDocsOf(g.id)).toEqual([]);
  });
});

describe("A-224-1: 200 satır üstü", () => {
  it("201 satır seçmek ya da 201 satırlı belgede ALL TOO_MANY_LINES; 200 satırlık gruplar kullanılır", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    // POSTED 201 satırlı belge (işleme yolu değil, yalnız ters kayıt retini sınamak için): süper kullanıcı fikstürü.
    const docId = uuid();
    const tv = (await q<{ id: string }>("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'STOCK_IN' AND version = 1"))[0]?.id;
    await q(
      "INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by) VALUES ($1,$2,'STOCK_IN',$3,$4,current_date,$5)",
      [A.tenantId, docId, tv, A.warehouseId, A.ownerUserId],
    );
    await q(
      `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
       SELECT $1, gen_random_uuid(), $2, g, $3, $4, 1, 1, 1, $5 FROM generate_series(1, 201) AS g`,
      [A.tenantId, docId, x, A.unitId, loc],
    );
    await q("UPDATE public.documents SET number = $2, status = 'POSTED' WHERE id = $1", [docId, `GRS-9999-${hex(6)}`]);
    expect(codeOf(await failure(reverse(docId, "ALL")))).toBe("VALIDATION_FAILED/TOO_MANY_LINES");
    const ids = (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id = $1 ORDER BY line_no", [docId])).map((r) => r.id);
    expect(codeOf(await failure(reverse(docId, ids.map((lineId) => ({ lineId, quantity: "1" })))))).toBe("VALIDATION_FAILED/TOO_MANY_LINES");
    expect(await reversalDocsOf(docId)).toEqual([]);
  });
});

/** Bakım yolu simülasyonu: süper kullanıcı, ENABLE ORIGIN tetikleyicilerini atlayarak yazar (yalnız fikstür: belgeyi saha kaynağına bağlar). */
async function bypassGuardsUpdate(text: string, params: unknown[]): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SET LOCAL session_replication_role = replica");
    await adm.query(text, params);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

describe("B-1: saha akışından gelen belge (source_kind dolu) ters çevrilmez", () => {
  it.each(["INBOUND_RECEIPT", "SALES_ORDER", "CUSTOMER_RETURN", "COUNT_SESSION", "TASK"])("%s kaynaklı belge → REVERSAL_BLOCKED/SOURCE_LINKED, hiçbir şey yazılmaz", async (kind) => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    await bypassGuardsUpdate("UPDATE public.documents SET source_kind = $2, source_id = $3 WHERE id = $1", [d.id, kind, uuid()]);
    expect((await post(d)).status).toBe("POSTED");
    const e = await failure(reverse(d.id, "ALL"));
    expect(codeOf(e)).toBe("REVERSAL_BLOCKED/SOURCE_LINKED");
    expect(e.httpStatus).toBe(409);
    expect(codeOf(await failure(reverse(d.id, [{ lineId: d.lineIds[0] as string, quantity: "1" }])))).toBe("REVERSAL_BLOCKED/SOURCE_LINKED");
    expect(codeOf(await failure(getReversalCapacity(ownerP(null), d.id)))).toBe("REVERSAL_BLOCKED/SOURCE_LINKED");
    expect(await bal({ item: x, loc })).toBe("10.000000");
    expect(await reversalDocsOf(d.id)).toEqual([]);
    expect(await lineRow(d.lineIds[0] as string)).toMatchObject({ reversed_quantity: "0.000000", reversal_status: "NONE" });
    expect(await auditCount(d.id)).toBe(0);
  });

  it("GERÇEK kabul + kalite onayı: kabul ve onay belgeleri reddedilir; bekleyen karantina, bakiyeler, kabul belgesi ve görevler değişmez", async () => {
    await q("UPDATE public.tenant_settings SET receiving_qc_enabled = true WHERE tenant_id = $1", [A.tenantId]);
    try {
      const x = await mkItem();
      const kabul = await mkLoc("RECEIVING");
      const c = await createInboundReceipt(ownerP(), {
        warehouseId: A.warehouseId,
        supplierRef: "T224-TED",
        lines: [{ itemId: x, unitId: A.unitId, expectedQuantity: "10" }],
      });
      const receiptId = c.documentId as string;
      await openInboundReceipt(ownerP(), { receiptId, expectedVersion: 1 });
      const lineId = (await q<{ id: string }>("SELECT id FROM public.inbound_receipt_lines WHERE receipt_id = $1", [receiptId]))[0]?.id as string;
      const rcv = await receiveGoods(pickerP(), { receiptId, lines: [{ lineId, received: "10", locationId: kabul }] });
      const qc = await approveQuality(ownerP(), { receiptId, lines: [{ lineId, locationId: kabul, quantity: "4" }] }); // 6 hâlâ bekliyor
      expect(rcv.status).toBe("POSTED");
      expect(qc.status).toBe("POSTED");

      /** `pendingQuarantine` ile aynı formül (kabul girişleri − onay çıkışları, kabul satırı kırılımında), bağımsız SQL. */
      const pending = async (): Promise<string> =>
        (await q<{ p: string }>(
          `SELECT COALESCE(sum(CASE WHEN d.kind = 'STOCK_IN' THEN dl.base_quantity ELSE -dl.base_quantity END), 0)::text AS p
             FROM public.document_lines dl JOIN public.documents d ON d.tenant_id = dl.tenant_id AND d.id = dl.document_id
            WHERE d.tenant_id = $1 AND d.status = 'POSTED' AND dl.source_line_id = $2 AND dl.stock_status = 'QUARANTINE'
              AND (d.kind = 'STOCK_IN' OR (d.kind = 'STOCK_MOVE' AND dl.target_stock_status = 'AVAILABLE'))`,
          [A.tenantId, lineId]))[0]?.p as string;
      const snapshot = async () => ({
        pending: await pending(),
        kar: await bal({ item: x, loc: kabul, status: "QUARANTINE" }),
        kul: await bal({ item: x, loc: kabul }),
        receipt: (await q("SELECT status, version FROM public.inbound_receipts WHERE id = $1", [receiptId]))[0],
        receiptLine: (await q("SELECT received_quantity::text AS r, damaged_quantity::text AS d FROM public.inbound_receipt_lines WHERE id = $1", [lineId]))[0],
        tasks: (await q<{ n: string }>("SELECT count(*)::text AS n FROM public.warehouse_tasks WHERE tenant_id = $1 AND source_kind = 'INBOUND_RECEIPT' AND source_id = $2", [A.tenantId, receiptId]))[0]?.n,
        ledger: (await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger l JOIN public.stock_dimensions d ON d.tenant_id=l.tenant_id AND d.id=l.stock_dimension_id WHERE l.tenant_id=$1 AND d.item_id=$2", [A.tenantId, x]))[0]?.n,
      });
      const before = await snapshot();
      expect(before).toMatchObject({ pending: "6.000000", kar: "6.000000", kul: "4.000000" });

      for (const docId of [rcv.documentId as string, qc.documentId as string]) {
        expect(codeOf(await failure(reverse(docId, "ALL")))).toBe("REVERSAL_BLOCKED/SOURCE_LINKED");
        expect(await reversalDocsOf(docId)).toEqual([]);
      }
      expect(await snapshot()).toEqual(before);
      // sayaç sağlam: kalan 6 hâlâ onaylanabilir, fazlası onaylanamaz
      const rest = await approveQuality(ownerP(), { receiptId });
      expect(rest.status).toBe("POSTED");
      expect(await pending()).toBe("0.000000");
      expect(await bal({ item: x, loc: kabul })).toBe("10.000000");
    } finally {
      await q("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1", [A.tenantId]);
    }
  });
});

describe("M-2 / m-2 / m-3: satır bağı, denetim, I-09 miktarı, kapasite", () => {
  it("ters satır asıl satıra source_line_id ile bağlıdır; audit asıl satır kimlikleri ve miktarlarını taşır", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") }), ln(x, { targetLocationId: loc, ...qty("6") })]);
    const r = await reverse(g.id, [{ lineId: g.lineIds[0] as string, quantity: "3" }, { lineId: g.lineIds[1] as string, quantity: "6" }]);
    const rl = await q<{ source_line_id: string; base_quantity: string }>("SELECT source_line_id, base_quantity::text AS base_quantity FROM public.document_lines WHERE document_id = $1 ORDER BY line_no", [r.documentId]);
    expect(rl).toEqual([
      { source_line_id: g.lineIds[0], base_quantity: "3.000000" },
      { source_line_id: g.lineIds[1], base_quantity: "6.000000" },
    ]);
    const cs = (await q<{ change_summary: { lines?: { sourceLineId: string; quantity: string }[] } }>(
      "SELECT change_summary FROM public.audit_logs WHERE tenant_id=$1 AND action='stock_document.reversed' AND entity_id=$2", [A.tenantId, g.id]))[0]?.change_summary;
    expect(cs?.lines).toEqual([
      { sourceLineId: g.lineIds[0], quantity: "3.000000" },
      { sourceLineId: g.lineIds[1], quantity: "6.000000" },
    ]);
  });

  it("çok satırlı belge (70 satır): audit boyut sınırını aşmaz (yalnız sayı), tam bağ ters belge satırlarındadır", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", Array.from({ length: 70 }, () => ln(x, { targetLocationId: loc, ...qty("1") })));
    const r = await reverse(g.id, "ALL");
    expect(r.lines).toHaveLength(70);
    const cs = (await q<{ change_summary: Record<string, unknown> }>("SELECT change_summary FROM public.audit_logs WHERE tenant_id=$1 AND action='stock_document.reversed' AND entity_id=$2", [A.tenantId, g.id]))[0]?.change_summary;
    expect(cs).toMatchObject({ lineCount: 70, linesOmitted: 70 });
    expect(cs).not.toHaveProperty("lines");
    const linked = await q<{ n: string }>("SELECT count(DISTINCT source_line_id)::text AS n FROM public.document_lines WHERE document_id = $1 AND source_line_id IS NOT NULL", [r.documentId]);
    expect(linked[0]?.n).toBe("70");
    expect(await bal({ item: x, loc })).toBe("0.000000");
  });

  it("I-09: kısmi satırda tam bölünüyorsa asıl birim; bölünmüyorsa ürünün temel birimi ve katsayı 1 (0,000001'e zorlama yok)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, unitId: A.boxUnitId, quantity: "34", conversionFactor: "3", baseQuantity: "102" })]);
    const lid = g.lineIds[0] as string;
    const rows = async (docId: unknown) =>
      q<{ unit_id: string; quantity: string; conversion_factor: string; base_quantity: string }>(
        "SELECT unit_id, quantity::text AS quantity, conversion_factor::text AS conversion_factor, base_quantity::text AS base_quantity FROM public.document_lines WHERE document_id = $1", [docId]);
    const a = await reverse(g.id, [{ lineId: lid, quantity: "51" }]); // 51/3 = 17 koli (tam)
    expect(await rows(a.documentId)).toEqual([{ unit_id: A.boxUnitId, quantity: "17.000000", conversion_factor: "3.000000", base_quantity: "51.000000" }]);
    const b = await reverse(g.id, [{ lineId: lid, quantity: "10" }]); // 10/3 = 3,333333 → geri çarpım 9,999999 ≠ 10 → temel birim
    expect(await rows(b.documentId)).toEqual([{ unit_id: A.unitId, quantity: "10.000000", conversion_factor: "1.000000", base_quantity: "10.000000" }]);
    const c = await reverse(g.id, "ALL"); // kalan 41: 41/3 tam değil → temel birim
    expect(await rows(c.documentId)).toEqual([{ unit_id: A.unitId, quantity: "41.000000", conversion_factor: "1.000000", base_quantity: "41.000000" }]);
    expect(await lineRow(lid)).toMatchObject({ reversed_quantity: "102.000000", reversal_status: "FULL" });
    // tüm ters satırlarda base = round(quantity × katsayı, 6) (I-09)
    const bad = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.document_lines l JOIN public.documents d ON d.tenant_id = l.tenant_id AND d.id = l.document_id
        WHERE d.reversal_of_document_id = $1 AND round(l.quantity * l.conversion_factor, 6) <> l.base_quantity`, [g.id]);
    expect(bad[0]?.n).toBe("0");
  });

  it("kapasite aynı boyutu paylaşan satırları birlikte hesaplar (toplam kullanılabilir iki satıra tekrar sayılmaz)", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("5") }), ln(x, { targetLocationId: loc, ...qty("5") })]);
    await mkPosted("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("6") })]); // bakiye 4
    const cap = await getReversalCapacity(ownerP(null), g.id);
    expect(cap.map((c) => c.maxReversible)).toEqual(["4.000000", "0.000000"]);
    expect(cap.every((c) => c.estimated)).toBe(true);
    expect(codeOf(await failure(reverse(g.id, "ALL")))).toBe("REVERSAL_BLOCKED/STOCK_USED");
    await reverse(g.id, [{ lineId: g.lineIds[0] as string, quantity: "4" }]); // tahmin doğrulanır
    expect(await bal({ item: x, loc })).toBe("0.000000");
  });
});

describe("eşzamanlılık (I-15, I-05)", () => {
  it("GERÇEK yarış: ters kayıt(100) ∥ tüketen çıkış(60), 6 tur: tam biri kazanır, bakiye asla negatif olmaz, defter = bakiye", async () => {
    let reversalWon = 0;
    let outWon = 0;
    for (let i = 0; i < 6; i++) {
      const x = await mkItem();
      const loc = await mkLoc();
      const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("100") })]);
      const out = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: loc, ...qty("60") })]);
      const [rv, po] = await Promise.allSettled([reverse(g.id, "ALL"), post(out)]);
      const final = await bal({ item: x, loc });
      expect(await ledgerMatchesBalances(x)).toBe(true);
      if (rv.status === "fulfilled") {
        // ters kayıt kazandı: çıkış stok bulamaz
        expect(po.status).toBe("rejected");
        expect(codeOf((po as PromiseRejectedResult).reason as AppError)).toBe("INSUFFICIENT_STOCK");
        expect(final).toBe("0.000000");
        expect((await docRow(out.id)).status).toBe("APPROVED");
        reversalWon++;
      } else {
        // çıkış kazandı: ters kayıt tüketilmiş stoğu geri alamaz
        expect(po.status).toBe("fulfilled");
        expect(codeOf(rv.reason as AppError)).toBe("REVERSAL_BLOCKED/STOCK_USED");
        expect(final).toBe("40.000000");
        expect(await reversalDocsOf(g.id)).toEqual([]);
        expect(await lineRow(g.lineIds[0] as string)).toMatchObject({ reversed_quantity: "0.000000", reversal_status: "NONE" });
        outWon++;
      }
    }
    expect(reversalWon + outWon).toBe(6);
  });

  it("GERÇEK yarış: aynı belgeye iki eşzamanlı tam ters kayıt (farklı anahtar), 4 tur: yalnız biri yazılır, ikincisi EXCEEDS_REMAINING", async () => {
    for (let i = 0; i < 4; i++) {
      const x = await mkItem();
      const loc = await mkLoc();
      const g = await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("20") })]);
      await mkPosted("STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("20") })]); // bakiye 40: ikinci ters kayıt stok açısından mümkün olurdu
      const res = await Promise.allSettled([reverse(g.id, "ALL"), reverse(g.id, "ALL")]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(codeOf(lost.reason as AppError)).toBe("REVERSAL_BLOCKED/EXCEEDS_REMAINING");
      expect(await bal({ item: x, loc })).toBe("20.000000");
      expect(await lineRow(g.lineIds[0] as string)).toMatchObject({ reversed_quantity: "20.000000", reversal_status: "FULL" });
      expect(await reversalDocsOf(g.id)).toHaveLength(1);
      expect(await ledgerMatchesBalances(x)).toBe(true);
    }
  });
});
