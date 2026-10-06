// T-221: rezervasyon komutları (reserve / release / toplama taşıması / STOCK_OUT tüketimi / iptalde serbest bırakma). GERÇEK roller (wms_app, pooler);
// fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile. Beklenen değerler docs/spec/16-stock-effects.md Senaryo A adım 4-7 ve 9-10 (belge eşdeğeri:
// sipariş yerine APPROVED STOCK_OUT belgesi; S1 açık miktarı belge satırında). Fikstürler sentetiktir (G-09).
// Kısmi sevk (adım 7: 3/4) belge eşdeğerinde birebir kurulamaz: rezervasyon sevk belgesi satırına bağlıdır ve belge bütün işlenir (sipariş satırı 3A).
// Bunun yerine: tam sevk (tüketim) + kısmi serbest bırakma (adım 9) + kısmi toplama/bölünen rezervasyon + başka boyutta kalan rezervasyon ayrı senaryolardır.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  approveDocument,
  cancelDocument,
  createStockDocument,
  isReservationExpiryEnabled,
  postDocument,
  readScopedAvailability,
  release,
  reserve,
  type DocumentLineInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { runTenantQuery } from "../../../packages/domain/src/identity/access.ts";
import { newRegistry, seedWorld, mkMembership, mkUser, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let blocker: pg.Client;
let A: TenantWorld;
let wh2: string;
let mgrUserId: string;
let mgrMembershipId: string;

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
/** WAREHOUSE_MANAGER (document.approve + stock.post + stock.view): kapsam testleri. */
const mgrP = (key: string = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: mgrUserId, mfaVerified: true },
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
async function mkItem(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T221 urun',$4,'NONE',0)", [
    A.tenantId, id, `I-${hex(10)}`, A.unitId,
  ]);
  return id;
}
async function mkLoc(kind: "RECEIVING" | "STORAGE" | "STAGING" | "TRANSIT" = "STORAGE", pickBlocked = false, warehouseId = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T221 lok',0,$5,$6)", [
    A.tenantId, id, warehouseId, `L-${hex(10)}`, kind, pickBlocked,
  ]);
  return id;
}
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over,
});
const qty = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });

interface Doc { id: string; version: number; lines: string[] }
const docRow = async (id: string) =>
  (await q<{ status: string; version: number; posting_job_id: string | null }>("SELECT status, version, posting_job_id FROM public.documents WHERE id = $1", [id]))[0] as {
    status: string; version: number; posting_job_id: string | null;
  };
const linesOf = async (docId: string): Promise<string[]> =>
  (await q<{ id: string }>("SELECT id FROM public.document_lines WHERE document_id = $1 ORDER BY line_no", [docId])).map((r) => r.id);

async function mkDraft(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[], warehouseId = A.warehouseId): Promise<Doc> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId, lines });
  const id = c.documentId as string;
  return { id, version: (await docRow(id)).version, lines: await linesOf(id) };
}
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[], warehouseId = A.warehouseId): Promise<Doc> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = await docRow(id);
  expect(v.status).toBe("APPROVED");
  return { id, version: v.version, lines: await linesOf(id) };
}
const post = async (d: Doc, p: StockDocCallParams = ownerP(), moves?: { lineId: string; reservationIds: string[] }[]) =>
  postDocument(p, { documentId: d.id, expectedVersion: (await docRow(d.id)).version, ...(moves === undefined ? {} : { reservationMoves: moves }) });
/** Stoğu yükler: STOCK_IN ile `loc`a n adet. */
async function stock(item: string, loc: string, n: string): Promise<void> {
  await post(await mkApproved("STOCK_IN", [ln(item, { targetLocationId: loc, ...qty(n) })]));
}
const alloc = (loc: string, n: string, extra: Record<string, unknown> = {}) => ({ dimension: { locationId: loc, ...extra }, quantity: n });
const doReserve = (line: string, allocations: ReturnType<typeof alloc>[], p: StockDocCallParams = ownerP(), more: Record<string, unknown> = {}) =>
  reserve(p, { documentLineId: line, allocations, ...more });

async function bal(item: string, loc: string, status = "AVAILABLE"): Promise<{ q: string; r: string }> {
  const r = await q<{ quantity: string; reserved: string }>(
    `SELECT b.quantity::text AS quantity, b.reserved_quantity::text AS reserved FROM public.stock_balances b
       JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
      WHERE s.tenant_id = $1 AND s.item_id = $2 AND s.location_id = $3 AND s.stock_status = $4`,
    [A.tenantId, item, loc, status],
  );
  return { q: r[0]?.quantity ?? "0.000000", r: r[0]?.reserved ?? "0.000000" };
}
/** Fiziksel / rezerve / kullanılabilir (16 kural 5; yalnızca STORAGE|STAGING, AVAILABLE, pick_blocked=false). */
async function triple(item: string): Promise<[string, string, string]> {
  const r = await q<{ phys: string; res: string; av: string }>(
    `SELECT COALESCE(sum(b.quantity),0)::int::text AS phys, COALESCE(sum(b.reserved_quantity),0)::int::text AS res,
            COALESCE(sum(b.quantity - b.reserved_quantity) FILTER (WHERE s.stock_status='AVAILABLE' AND l.kind IN ('STORAGE','STAGING') AND l.pick_blocked = false),0)::int::text AS av
       FROM public.stock_balances b
       JOIN public.stock_dimensions s ON s.tenant_id = b.tenant_id AND s.id = b.stock_dimension_id
       JOIN public.locations l ON l.tenant_id = s.tenant_id AND l.id = s.location_id
      WHERE s.tenant_id = $1 AND s.item_id = $2`,
    [A.tenantId, item],
  );
  const x = r[0] as { phys: string; res: string; av: string };
  return [x.phys, x.res, x.av];
}
const ledgerRows = async (docId: string): Promise<{ quantity: string; reason: string }[]> =>
  q("SELECT quantity::text AS quantity, reason FROM public.stock_ledger WHERE tenant_id=$1 AND document_id=$2 ORDER BY quantity", [A.tenantId, docId]);
const ledgerTotal = async (item: string): Promise<string> =>
  (await q<{ s: string }>("SELECT COALESCE(sum(l.quantity),0)::int::text AS s FROM public.stock_ledger l JOIN public.stock_dimensions s ON s.tenant_id=l.tenant_id AND s.id=l.stock_dimension_id WHERE l.tenant_id=$1 AND s.item_id=$2", [A.tenantId, item]))[0]?.s as string;
interface Rsv { id: string; status: string; quantity: string; location_id: string; document_line_id: string }
const rsvOf = async (lineId: string): Promise<Rsv[]> =>
  q<Rsv>(
    `SELECT r.id, r.status, r.quantity::text AS quantity, s.location_id, r.document_line_id FROM public.reservations r
       JOIN public.stock_dimensions s ON s.tenant_id=r.tenant_id AND s.id=r.stock_dimension_id
      WHERE r.tenant_id=$1 AND r.document_line_id=$2 ORDER BY r.status, r.quantity, r.id`,
    [A.tenantId, lineId],
  );
/** Ürün için: her boyutta reserved_quantity = Σ ACTIVE rezervasyon (ertelenmiş denetimin dışarıdan kanıtı). */
async function reservedMatchesActive(item: string): Promise<boolean> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.reserved_quantity <> COALESCE((SELECT sum(r.quantity) FROM public.reservations r WHERE r.tenant_id=b.tenant_id AND r.stock_dimension_id=b.stock_dimension_id AND r.status='ACTIVE'),0)`,
    [A.tenantId, item]);
  return r[0]?.n === "0";
}
async function ledgerMatchesBalances(item: string): Promise<boolean> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0)`,
    [A.tenantId, item]);
  return r[0]?.n === "0";
}
const auditCount = async (action: string, entityId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE tenant_id=$1 AND action=$2 AND entity_id=$3", [A.tenantId, action, entityId]))[0]?.n);

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  blocker = new pg.Client({ connectionString: env.databaseUrlDirect });
  blocker.on("error", () => undefined);
  await blocker.connect();
  A = await seedWorld(adm, reg, "A221");
  wh2 = uuid();
  await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,'D2','T221 Depo 2')", [A.tenantId, wh2]);
  mgrUserId = await mkUser(adm, reg, "A221mgr");
  mgrMembershipId = await mkMembership(adm, A.tenantId, mgrUserId, { roles: ["WAREHOUSE_MANAGER"] });
}, 120_000);

afterEach(async () => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
  delete process.env.RESERVATION_EXPIRY_ENABLED;
  await blocker.query("ROLLBACK").catch(() => undefined);
  await q("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id=$1 AND membership_id = ANY($2::uuid[])", [A.tenantId, [mgrMembershipId, A.memberMembershipId]]);
});

afterAll(async () => {
  await blocker.end();
  await adm.end();
  await app.close();
}, 60_000);

describe("Senaryo A adım 4-7 ve 9-10 (belge eşdeğeri)", () => {
  it("adım 4-7: S1 (4) → rezervasyon 4 R-01'e → toplama 4 SEVK'e (rezervasyon malla taşınır) → sevk tüketir; her adımda fiziksel/rezerve/kullanılabilir 16 ile birebir", async () => {
    const x = await mkItem();
    const kabul = await mkLoc("RECEIVING");
    const r01 = await mkLoc("STORAGE");
    const sevk = await mkLoc("STAGING");
    await stock(x, kabul, "10");
    await post(await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: kabul, targetLocationId: r01, ...qty("10") })])); // adım 1-3 eşdeğeri
    expect(await triple(x)).toEqual(["10", "0", "10"]);

    // adım 4: S1 oluşur (talep = APPROVED STOCK_OUT satırı, 4; kaynak SEVK)
    const s1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: sevk, ...qty("4") })]);
    expect(await triple(x)).toEqual(["10", "0", "10"]);
    const ledgerBefore = await ledgerTotal(x);

    // adım 5: rezervasyon 4 → R-01·KUL; defter satırı YOK (kural 2)
    const r5 = await doReserve(s1.lines[0] as string, [alloc(r01, "4")]);
    expect(r5.replayed).toBe(false);
    expect(await triple(x)).toEqual(["10", "4", "6"]);
    expect(await ledgerTotal(x)).toBe(ledgerBefore);
    expect((await ledgerRows(s1.id)).length).toBe(0);
    expect((await bal(x, r01)).r).toBe("4.000000");
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity, r.location_id])).toEqual([["ACTIVE", "4.000000", r01]]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await auditCount("reservation.created", s1.id)).toBe(1);

    // adım 6: toplama 4 R-01 → SEVK; rezervasyon 4 SEVK·KUL'a taşınır (fiziksel toplam değişmez, kural 3)
    const pick = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: r01, targetLocationId: sevk, ...qty("4") })]);
    await post(pick, ownerP(), [{ lineId: pick.lines[0] as string, reservationIds: r5.reservationIds as string[] }]);
    expect((await bal(x, r01))).toEqual({ q: "6.000000", r: "0.000000" });
    expect((await bal(x, sevk))).toEqual({ q: "4.000000", r: "4.000000" });
    expect(await triple(x)).toEqual(["10", "4", "6"]);
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity, r.location_id])).toEqual([["ACTIVE", "4.000000", sevk]]);
    expect((await ledgerRows(pick.id)).map((r) => r.quantity)).toEqual(["-4.000000", "4.000000"]);
    expect(await reservedMatchesActive(x)).toBe(true);

    // adım 7: sevk — rezervasyondan tüketilir (yeterlilik quantity − (reserved − kendi rezervasyonu)); aynı çıkış iki kez yazılmaz
    const key = uuid();
    const shipVersion = (await docRow(s1.id)).version;
    const shipped = await postDocument(ownerP(key), { documentId: s1.id, expectedVersion: shipVersion });
    expect(shipped.reservationIds?.length).toBe(1);
    expect(await triple(x)).toEqual(["6", "0", "6"]);
    expect((await bal(x, sevk))).toEqual({ q: "0.000000", r: "0.000000" });
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity])).toEqual([["CONSUMED", "4.000000"]]);
    expect((await ledgerRows(s1.id)).map((r) => [r.quantity, r.reason])).toEqual([["-4.000000", "SHIPMENT"]]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await ledgerMatchesBalances(x)).toBe(true);
    // idempotency: aynı anahtar saklı sonucu döner; yeni anahtarla ikinci sevk DOCUMENT_STATE (POSTED); defter tek satır
    expect((await postDocument(ownerP(key), { documentId: s1.id, expectedVersion: shipVersion })).replayed).toBe(true);
    expect(codeOf(await failure(post(s1)))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect((await ledgerRows(s1.id)).length).toBe(1);
  });

  it("adım 9-10: kalan 1'in serbest bırakılması (mal SEVK'te → needsPutaway) → geri yerleştirme SEVK→R-01; iptal kalanı bırakır, Σ ACTIVE = reserved", async () => {
    const x = await mkItem();
    const r01 = await mkLoc("STORAGE");
    const sevk = await mkLoc("STAGING");
    await stock(x, r01, "10");
    const s1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: sevk, ...qty("4") })]);
    const rs = await doReserve(s1.lines[0] as string, [alloc(r01, "4")]);
    const pick = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: r01, targetLocationId: sevk, ...qty("4") })]);
    await post(pick, ownerP(), [{ lineId: pick.lines[0] as string, reservationIds: rs.reservationIds as string[] }]);
    expect(await triple(x)).toEqual(["10", "4", "6"]);

    // adım 9: kısmi serbest bırakma 1; fiziksel stok yerinde (kural 7); mal STAGING'te → needsPutaway
    const key = uuid();
    const rel = await release(ownerP(key), { documentLineId: s1.lines[0] as string, quantity: "1" });
    expect(rel.needsPutaway).toBe(true);
    expect(await triple(x)).toEqual(["10", "3", "7"]);
    expect((await bal(x, sevk))).toEqual({ q: "4.000000", r: "3.000000" });
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity])).toEqual([["ACTIVE", "3.000000"], ["RELEASED", "1.000000"]]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await auditCount("reservation.released", s1.id)).toBe(1);
    const again = await release(ownerP(key), { documentLineId: s1.lines[0] as string, quantity: "1" });
    expect(again.replayed).toBe(true);
    expect(again.needsPutaway).toBe(true);
    expect(await triple(x)).toEqual(["10", "3", "7"]);

    // adım 10: geri yerleştirme SEVK → R-01 (1; serbest kalan mal)
    await post(await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: sevk, targetLocationId: r01, ...qty("1") })]));
    expect((await bal(x, sevk))).toEqual({ q: "3.000000", r: "3.000000" });
    expect((await bal(x, r01)).q).toBe("7.000000");
    expect(await triple(x)).toEqual(["10", "3", "7"]);

    // iptal: kalan 3 aynı transaction'da bırakılır; Σ ACTIVE = reserved (ertelenmiş denetim tetiklenmez)
    const cancelled = await cancelDocument(ownerP(), { documentId: s1.id, expectedVersion: (await docRow(s1.id)).version });
    expect(cancelled.status).toBe("CANCELLED");
    expect(await triple(x)).toEqual(["10", "0", "10"]);
    expect((await rsvOf(s1.lines[0] as string)).map((r) => r.status).sort()).toEqual(["RELEASED", "RELEASED"]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await ledgerMatchesBalances(x)).toBe(true);
    expect(await auditCount("reservation.released", s1.id)).toBe(1); // iptal kendi audit'iyle (stock_document.cancelled) kayıtlıdır
    expect(await auditCount("stock_document.cancelled", s1.id)).toBe(1);
  });

  it("kısmi toplama: rezervasyon bölünür (kalan kaynakta, taşınan hedefte); kısmi tüketim: satırın başka boyutundaki rezervasyon ACTIVE kalır", async () => {
    const x = await mkItem();
    const r01 = await mkLoc("STORAGE");
    const sevk = await mkLoc("STAGING");
    await stock(x, r01, "9");
    const s1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: sevk, ...qty("4") })]);
    const rs = await doReserve(s1.lines[0] as string, [alloc(r01, "4")]);
    const pick = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: r01, targetLocationId: sevk, ...qty("3") })]);
    await post(pick, ownerP(), [{ lineId: pick.lines[0] as string, reservationIds: rs.reservationIds as string[] }]);
    expect((await bal(x, r01))).toEqual({ q: "6.000000", r: "1.000000" });
    expect((await bal(x, sevk))).toEqual({ q: "3.000000", r: "3.000000" });
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity, r.location_id])).toEqual([["ACTIVE", "1.000000", r01], ["ACTIVE", "3.000000", sevk]]);
    expect(await triple(x)).toEqual(["9", "4", "5"]);
    expect(await reservedMatchesActive(x)).toBe(true);

    // sevk 4 (kaynak SEVK: 3 + 1 serbest stok girişi): yalnızca SEVK'teki 3 tüketilir; R-01'deki 1 ACTIVE kalır
    await stock(x, sevk, "1");
    const shipped = await post(s1);
    expect(shipped.reservationIds?.length).toBe(1);
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.quantity, r.location_id])).toEqual([["ACTIVE", "1.000000", r01], ["CONSUMED", "3.000000", sevk]]);
    expect(await triple(x)).toEqual(["6", "1", "5"]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await ledgerMatchesBalances(x)).toBe(true);
    // kalan bırakılır (POSTED belgenin artık ACTIVE rezervasyonu da bırakılabilir; A-221-1)
    const rel = await release(ownerP(), { documentLineId: s1.lines[0] as string });
    expect(rel.needsPutaway).toBe(false); // R-01 STORAGE
    expect(await triple(x)).toEqual(["6", "0", "6"]);
  });
});

describe("kural 5: sevke uygun olmayan stok rezerve edilemez; tahsis sınırları", () => {
  it("RECEIVING lokasyonu, QUARANTINE, DAMAGED durumu ve pick_blocked lokasyon → INSUFFICIENT_STOCK; hiçbir şey yazılmaz", async () => {
    const x = await mkItem();
    const kabul = await mkLoc("RECEIVING");
    const store = await mkLoc("STORAGE");
    const blockedLoc = await mkLoc("STORAGE", true);
    await stock(x, kabul, "5");
    await stock(x, blockedLoc, "5");
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, stockStatus: "QUARANTINE", ...qty("5") })]));
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store, stockStatus: "DAMAGED", ...qty("5") })]));
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    const line = s.lines[0] as string;
    const before = await triple(x);
    for (const a of [alloc(kabul, "2"), alloc(store, "2", { stockStatus: "QUARANTINE" }), alloc(store, "2", { stockStatus: "DAMAGED" }), alloc(blockedLoc, "2")]) {
      expect(codeOf(await failure(doReserve(line, [a])))).toBe("INSUFFICIENT_STOCK");
    }
    expect((await rsvOf(line)).length).toBe(0);
    expect(await triple(x)).toEqual(before);
    expect(await reservedMatchesActive(x)).toBe(true);
  });

  it("yetersiz kullanılabilir (3 var, 4 istenen) INSUFFICIENT_STOCK; satır üst sınırı ve belge durumu denetlenir", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "3");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    const line = s.lines[0] as string;
    expect(codeOf(await failure(doReserve(line, [alloc(store, "4")])))).toBe("INSUFFICIENT_STOCK");
    await stock(x, store, "10");
    expect(codeOf(await failure(doReserve(line, [alloc(store, "5")])))).toBe("VALIDATION_FAILED"); // satır 4'ü aşar
    await doReserve(line, [alloc(store, "3")]);
    expect(codeOf(await failure(doReserve(line, [alloc(store, "2")])))).toBe("VALIDATION_FAILED"); // 3 + 2 > 4
    await doReserve(line, [alloc(store, "1")]); // tam 4
    expect(await triple(x)).toEqual(["13", "4", "9"]);
    // DRAFT belge ve STOCK_IN belge satırı rezerve edilemez
    const draft = await mkDraft("STOCK_OUT", [ln(x, { sourceLocationId: store })]);
    expect(codeOf(await failure(doReserve(draft.lines[0] as string, [alloc(store, "1")])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    const inDoc = await mkApproved("STOCK_IN", [ln(x, { targetLocationId: store })]);
    expect(codeOf(await failure(doReserve(inDoc.lines[0] as string, [alloc(store, "1")])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(doReserve(uuid(), [alloc(store, "1")])))).toBe("NOT_FOUND");
    expect(await reservedMatchesActive(x)).toBe(true);
  });

  it("taşıma hedefi kural 5'e uymuyorsa (RECEIVING) ve rezervasyon kaynak boyutta değilse toplama reddedilir; hiçbir şey yazılmaz", async () => {
    const x = await mkItem();
    const r01 = await mkLoc("STORAGE");
    const kabul = await mkLoc("RECEIVING");
    const sevk = await mkLoc("STAGING");
    await stock(x, r01, "6");
    const s1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: sevk, ...qty("4") })]);
    const rs = await doReserve(s1.lines[0] as string, [alloc(r01, "4")]);
    const toReceiving = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: r01, targetLocationId: kabul, ...qty("4") })]);
    expect(codeOf(await failure(post(toReceiving, ownerP(), [{ lineId: toReceiving.lines[0] as string, reservationIds: rs.reservationIds as string[] }])))).toBe("INSUFFICIENT_STOCK");
    expect((await docRow(toReceiving.id)).status).toBe("APPROVED");
    const wrongSource = await mkApproved("STOCK_MOVE", [ln(x, { sourceLocationId: sevk, targetLocationId: r01, ...qty("1") })]);
    await stock(x, sevk, "1");
    expect(codeOf(await failure(post(wrongSource, ownerP(), [{ lineId: wrongSource.lines[0] as string, reservationIds: rs.reservationIds as string[] }])))).toBe("VALIDATION_FAILED");
    expect(await triple(x)).toEqual(["7", "4", "3"]);
    expect((await rsvOf(s1.lines[0] as string)).map((r) => [r.status, r.location_id])).toEqual([["ACTIVE", r01]]);
    expect(await reservedMatchesActive(x)).toBe(true);
  });

  it("A-76: expires_at yazılabilir (gelecek), geçmiş ret; otomatik süre aşımı bayrağı varsayılan KAPALI", async () => {
    expect(isReservationExpiryEnabled(process.env)).toBe(false);
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "5");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    const line = s.lines[0] as string;
    expect(codeOf(await failure(doReserve(line, [alloc(store, "1")], ownerP(), { expiresAt: "2020-01-01T00:00:00Z" })))).toBe("VALIDATION_FAILED");
    const when = new Date(Date.now() + 3_600_000).toISOString();
    await doReserve(line, [alloc(store, "1")], ownerP(), { expiresAt: when });
    const row = await q<{ e: string }>("SELECT expires_at::text AS e FROM public.reservations WHERE tenant_id=$1 AND document_line_id=$2", [A.tenantId, line]);
    expect(new Date(row[0]?.e as string).toISOString()).toBe(when);
    // bayrak kapalıyken kaydın ACTIVE kalması (süre aşımı işi yok): hiçbir komut onu kendiliğinden kapatmaz
    expect((await rsvOf(line))[0]?.status).toBe("ACTIVE");
  });
});

describe("eşzamanlılık ve kilit (ADR-009, I-04, I-15)", () => {
  it("iki eşzamanlı tahsis aynı son stoğa: biri INSUFFICIENT_STOCK, rezerve 1 (6 tur)", async () => {
    for (let round = 0; round < 6; round++) {
      const x = await mkItem();
      const store = await mkLoc("STORAGE");
      await stock(x, store, "1");
      const d1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store })]);
      const d2 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store })]);
      const results = await Promise.allSettled([doReserve(d1.lines[0] as string, [alloc(store, "1")]), doReserve(d2.lines[0] as string, [alloc(store, "1")])]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(bad.length).toBe(1);
      expect(codeOf(bad[0]?.reason as AppError)).toBe("INSUFFICIENT_STOCK");
      expect(await triple(x)).toEqual(["1", "1", "0"]);
      expect(await reservedMatchesActive(x)).toBe(true);
    }
  }, 120_000);

  it("KAPI: bakiye satırı başka işlemde kilitliyken tahsis kilitte BEKLER (acquireStockLocks bakiye kilidi), açılınca tamamlanır", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "3");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT 1 FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
        WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 FOR UPDATE OF b`,
      [A.tenantId, x, store],
    );
    let settled = false;
    const pending = doReserve(s.lines[0] as string, [alloc(store, "2")]).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(settled).toBe(false);
    await blocker.query("COMMIT");
    await pending;
    expect(await triple(x)).toEqual(["3", "2", "1"]);
  });

  it("serbest bırakma ∥ tahsis aynı boyutta: sonuç her iki sırada da tutarlı (Σ ACTIVE = reserved)", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "4");
    const d1 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    const d2 = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    await doReserve(d1.lines[0] as string, [alloc(store, "4")]);
    const results = await Promise.allSettled([release(ownerP(), { documentLineId: d1.lines[0] as string }), doReserve(d2.lines[0] as string, [alloc(store, "4")])]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(await reservedMatchesActive(x)).toBe(true);
    const [, res] = await triple(x);
    expect(res === "0" || res === "4").toBe(true);
  });
});

describe("işleme kilidi (M-6) ve belge durumu", () => {
  it("posting_job_id dolu belgede reserve / release / iptal → DOCUMENT_STATE; hiçbir şey yazılmaz", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "8");
    const busy = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    const held = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    await doReserve(held.lines[0] as string, [alloc(store, "4")]);
    for (const d of [busy, held]) {
      await q("UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [d.id, uuid(), A.ownerUserId]);
    }
    expect(codeOf(await failure(doReserve(busy.lines[0] as string, [alloc(store, "1")])))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(release(ownerP(), { documentLineId: held.lines[0] as string })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(codeOf(await failure(cancelDocument(ownerP(), { documentId: held.id, expectedVersion: (await docRow(held.id)).version })))).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await triple(x)).toEqual(["8", "4", "4"]);
    expect((await rsvOf(held.lines[0] as string)).map((r) => r.status)).toEqual(["ACTIVE"]);
    expect((await docRow(held.id)).status).toBe("APPROVED");
    expect(await reservedMatchesActive(x)).toBe(true);
  });

  it("iptal sonrası Σ ACTIVE = reserved_quantity; birden çok satır ve boyut; aynı anahtar saklı sonucu döner; DRAFT iptali rezervasyonsuz geçer", async () => {
    const x = await mkItem();
    const y = await mkItem();
    const a = await mkLoc("STORAGE");
    const b = await mkLoc("STAGING");
    await stock(x, a, "5");
    await stock(x, b, "5");
    await stock(y, a, "5");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: a, ...qty("4") }), ln(y, { sourceLocationId: a, ...qty("2") })]);
    await doReserve(s.lines[0] as string, [alloc(a, "2"), alloc(b, "2")]);
    await doReserve(s.lines[1] as string, [alloc(a, "2")]);
    expect(await triple(x)).toEqual(["10", "4", "6"]);
    expect(await triple(y)).toEqual(["5", "2", "3"]);
    const key = uuid();
    const version = (await docRow(s.id)).version;
    const c1 = await cancelDocument(ownerP(key), { documentId: s.id, expectedVersion: version });
    expect(c1.reservationIds?.length).toBe(3);
    expect(await triple(x)).toEqual(["10", "0", "10"]);
    expect(await triple(y)).toEqual(["5", "0", "5"]);
    expect(await reservedMatchesActive(x)).toBe(true);
    expect(await reservedMatchesActive(y)).toBe(true);
    expect((await cancelDocument(ownerP(key), { documentId: s.id, expectedVersion: version })).replayed).toBe(true);
    const draft = await mkDraft("STOCK_OUT", [ln(x, { sourceLocationId: a })]);
    expect((await cancelDocument(ownerP(), { documentId: draft.id, expectedVersion: draft.version })).status).toBe("CANCELLED");
  });

  it("serbest bırakma girdisi: reservationId ile kısmi; fazla miktar, kapalı rezervasyon ve belirsiz seçici VALIDATION_FAILED; yetkisiz rol FORBIDDEN", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "6");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("4") })]);
    const r = await doReserve(s.lines[0] as string, [alloc(store, "4")]);
    const id = (r.reservationIds as string[])[0] as string;
    expect(codeOf(await failure(release(ownerP(), { reservationId: id, quantity: "5" })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(release(ownerP(), { reservationId: id, documentLineId: s.lines[0] as string })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(release(ownerP(), {})))).toBe("VALIDATION_FAILED");
    expect((await release(ownerP(), { reservationId: id, quantity: "1" })).needsPutaway).toBe(false);
    expect(await triple(x)).toEqual(["6", "3", "3"]);
    expect((await release(ownerP(), { reservationId: id })).needsPutaway).toBe(false);
    expect(await triple(x)).toEqual(["6", "0", "6"]);
    expect(codeOf(await failure(release(ownerP(), { reservationId: id })))).toBe("VALIDATION_FAILED"); // artık ACTIVE değil
    expect((await failure(release(ownerP(), { reservationId: uuid() }))).code).toBe("NOT_FOUND");
    expect((await failure(doReserve(s.lines[0] as string, [alloc(store, "1")], pickerP()))).code).toBe("FORBIDDEN"); // PICKER document.approve yok
    expect((await failure(release(pickerP(), { reservationId: id }))).code).toBe("FORBIDDEN");
    expect(await reservedMatchesActive(x)).toBe(true);
  });
});

describe("depo kapsamı (MINOR-1) ve A-145", () => {
  it("kapsam dışı depoda reserve / release FORBIDDEN (WAREHOUSE_OUT_OF_SCOPE); kapsamdaki üye geçer", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    await stock(x, store, "5");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    const held = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    await doReserve(held.lines[0] as string, [alloc(store, "2")]);
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembershipId, wh2]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const e1 = await failure(doReserve(s.lines[0] as string, [alloc(store, "1")], mgrP()));
    expect(codeOf(e1)).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(codeOf(await failure(release(mgrP(), { documentLineId: held.lines[0] as string })))).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(await triple(x)).toEqual(["5", "2", "3"]);
    expect((await rsvOf(s.lines[0] as string)).length).toBe(0);
    // kapsama depo A eklenince aynı komutlar geçer
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembershipId, A.warehouseId]);
    await doReserve(s.lines[0] as string, [alloc(store, "1")], mgrP());
    await release(mgrP(), { documentLineId: held.lines[0] as string });
    expect(await triple(x)).toEqual(["5", "1", "4"]);
  });

  it("tahsis lokasyonu kapsam dışı depodaysa FORBIDDEN; kapsam yokken belgenin deposunda değilse LOCATION_WAREHOUSE_MISMATCH (A-145)", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    const other = await mkLoc("STORAGE", false, wh2);
    await stock(x, store, "5");
    const s = await mkApproved("STOCK_OUT", [ln(x, { sourceLocationId: store, ...qty("2") })]);
    // A-145: başka depodaki lokasyona tahsis (kapsam kapalı) → depo uyuşmazlığı
    expect(codeOf(await failure(doReserve(s.lines[0] as string, [alloc(other, "1")])))).toBe("VALIDATION_FAILED/LOCATION_WAREHOUSE_MISMATCH");
    // kapsam: üye yalnızca A deposuna kapsamlı; tahsis lokasyonu depo 2'de → plan lokasyon depolarını kapsama sokar
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembershipId, A.warehouseId]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    expect(codeOf(await failure(doReserve(s.lines[0] as string, [alloc(other, "1")], mgrP())))).toBe("FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE");
    expect(await triple(x)).toEqual(["5", "0", "5"]);
    expect((await rsvOf(s.lines[0] as string)).length).toBe(0);
  });

  it("readScopedAvailability: kapsam dışı depo satırlarını süzer, kapsam dışı lokasyon filtresi NOT_FOUND; kısıtsız/kapalı bayrakta tüm satırlar", async () => {
    const x = await mkItem();
    const store = await mkLoc("STORAGE");
    const other = await mkLoc("STORAGE", false, wh2);
    await stock(x, store, "5");
    await post(await mkApproved("STOCK_IN", [ln(x, { targetLocationId: other, ...qty("3") })], wh2));
    const read = (p: StockDocCallParams, filter: { itemId: string; locationId?: string }) =>
      runTenantQuery({ ...p, permission: "stock.view" }, (tx, m) => readScopedAvailability(tx, m, filter));
    // bayrak kapalı: ikisi de görünür
    expect((await read(mgrP(), { itemId: x })).map((r) => r.locationId).sort()).toEqual([store, other].sort());
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembershipId, wh2]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    expect((await read(mgrP(), { itemId: x })).map((r) => [r.locationId, r.available])).toEqual([[other, "3.000000"]]); // depo A süzülür
    expect((await failure(read(mgrP(), { itemId: x, locationId: store }))).code).toBe("NOT_FOUND");
    expect((await read(mgrP(), { itemId: x, locationId: other })).length).toBe(1);
    // TENANT_ADMIN kısıtsızdır
    expect((await read(ownerP(), { itemId: x })).length).toBe(2);
  });
});
