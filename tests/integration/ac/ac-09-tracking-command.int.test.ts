// T-220 (qa-verifier): AC-09 — seri takipli ürün iki lokasyona yazılamaz. katman: komut (DB katmanı T-233: ac-09-db-serial.int.test.ts).
// Bağımsız doğrulama: gerçek roller (wms_app + PgBouncer), kilitler `STOCK_SERIAL_LOCK_ENABLED=true` (A-121/Q-56). Sentetik veri (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  approveDocument,
  createStockDocument,
  postDocument,
  type DocumentLineInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let R01: string;
let R02: string;
let R03: string;
let savedFlag: string | undefined;

const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const ownerP = (key: string = uuid()): StockDocCallParams => ({
  db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug, clientKey: key, timeouts: WIDE,
});
async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function mkSerialItem(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T220 seri urun',$4,'SERIAL',0)", [
    A.tenantId, id, `S-${hex(10)}`, A.unitId,
  ]);
  return id;
}
async function mkSerial(itemId: string): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id) VALUES ($1,$2,$3,$4,NULL)", [A.tenantId, id, itemId, `SN-${hex(10)}`]);
  return id;
}
async function mkLoc(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T220 lok',0,'STORAGE',false)", [
    A.tenantId, id, A.warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (itemId: string, serialId: string, over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", serialId, ...over,
});
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [id]))[0];
  return { id, version: Number(v?.version) };
}
const post = (d: { id: string; version: number }) => postDocument(ownerP(), { documentId: d.id, expectedVersion: d.version });
const qtyN = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });
async function positives(serial: string): Promise<{ loc: string; q: string }[]> {
  return q(
    `SELECT s.location_id AS loc, b.quantity::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.serial_id=$2 AND b.quantity > 0`, [A.tenantId, serial]);
}
const ledgerCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE document_id=$1", [docId]))[0]?.n);
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("ret beklenirdi ama kabul edildi");
}
const mismatches = async (item: string): Promise<number> =>
  Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0)`,
    [A.tenantId, item]))[0]?.n);
async function race<T>(fns: ReadonlyArray<() => Promise<T>>): Promise<Array<{ ok: true } | { ok: false; code: string }>> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = fns.map(async (f) => {
    await gate;
    try {
      await f();
      return { ok: true as const };
    } catch (e) {
      if (e instanceof AppError) return { ok: false as const, code: e.code };
      throw e;
    }
  });
  await new Promise((r) => setTimeout(r, 20));
  release();
  return Promise.all(runs);
}

beforeAll(async () => {
  savedFlag = process.env.STOCK_SERIAL_LOCK_ENABLED;
  process.env.STOCK_SERIAL_LOCK_ENABLED = "true";
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A220C");
  R01 = await mkLoc();
  R02 = await mkLoc();
  R03 = await mkLoc();
}, 120_000);

afterAll(async () => {
  if (savedFlag === undefined) delete process.env.STOCK_SERIAL_LOCK_ENABLED;
  else process.env.STOCK_SERIAL_LOCK_ENABLED = savedFlag;
  await adm.end();
  await app.close();
}, 60_000);

describe("AC-09 seri takip — komut katmanı (T-220)", () => {
  it("@AC-09 S1 R-01'de iken S1'i R-02'ye STOCK_IN → TRACKING_VIOLATION; S1 hâlâ yalnız R-01'de, reddedilen belgenin defter satırı yok", async () => {
    const x = await mkSerialItem();
    const s1 = await mkSerial(x);
    await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]));
    expect(await positives(s1)).toEqual([{ loc: R01, q: "1.000000" }]);
    const dup = await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R02 })]);
    expect((await failure(post(dup))).code).toBe("TRACKING_VIOLATION");
    expect(await ledgerCount(dup.id)).toBe(0);
    expect(await positives(s1)).toEqual([{ loc: R01, q: "1.000000" }]);
    expect(await mismatches(x)).toBe(0);
  });

  it("@AC-09 S1 için miktar 2 (giriş ve taşıma) → TRACKING_VIOLATION; stok değişmez", async () => {
    const x = await mkSerialItem();
    const s1 = await mkSerial(x);
    const s2 = await mkSerial(x);
    const two = await mkApproved("STOCK_IN", [ln(x, s2, { targetLocationId: R01, ...qtyN("2") })]);
    expect((await failure(post(two))).code).toBe("TRACKING_VIOLATION");
    expect(await positives(s2)).toEqual([]);
    await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]));
    const mv2 = await mkApproved("STOCK_MOVE", [ln(x, s1, { sourceLocationId: R01, targetLocationId: R02, ...qtyN("2") })]);
    expect((await failure(post(mv2))).code).toBe("TRACKING_VIOLATION");
    expect(await positives(s1)).toEqual([{ loc: R01, q: "1.000000" }]);
    expect(await ledgerCount(mv2.id)).toBe(0);
    expect(await mismatches(x)).toBe(0);
  });

  it("@AC-09 STOCK_MOVE R-01→R-02 kabul edilir ve S1 tek lokasyonda kalır (hedefte 1, kaynakta 0)", async () => {
    const x = await mkSerialItem();
    const s1 = await mkSerial(x);
    await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]));
    const mv = await mkApproved("STOCK_MOVE", [ln(x, s1, { sourceLocationId: R01, targetLocationId: R02 })]);
    expect((await post(mv)).status).toBe("POSTED");
    expect(await positives(s1)).toEqual([{ loc: R02, q: "1.000000" }]);
    expect(await ledgerCount(mv.id)).toBe(2);
    expect(await mismatches(x)).toBe(0);
  });

  it("@AC-09 çıkıştan sonra seri yeniden girilebilir (yaşam döngüsü); tek pozitif konum kuralı korunur", async () => {
    const x = await mkSerialItem();
    const s1 = await mkSerial(x);
    await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]));
    await post(await mkApproved("STOCK_OUT", [ln(x, s1, { sourceLocationId: R01 })]));
    expect(await positives(s1)).toEqual([]);
    await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R03 })]));
    expect(await positives(s1)).toEqual([{ loc: R03, q: "1.000000" }]);
    expect(await mismatches(x)).toBe(0);
  });

  it("@AC-09 eşzamanlı: aynı yeni seriyi iki lokasyona aynı anda STOCK_IN → tam biri POSTED, diğeri TRACKING_VIOLATION; tek pozitif konum (15 tur)", async () => {
    for (let round = 0; round < 15; round++) {
      const x = await mkSerialItem();
      const s1 = await mkSerial(x);
      const a = await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]);
      const b = await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R02 })]);
      const res = await race([() => post(a), () => post(b)]);
      expect(res.filter((r) => r.ok).length, `tur ${round}: ${JSON.stringify(res)}`).toBe(1);
      expect(res.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code)), `tur ${round}`).toEqual(["TRACKING_VIOLATION"]);
      expect(await positives(s1), `tur ${round}`).toHaveLength(1);
      expect(await mismatches(x)).toBe(0);
    }
  }, 120_000);

  it("@AC-09 eşzamanlı: S1 R-01'de iken MOVE R-01→R-02 ile STOCK_IN→R-03 yarışı → giriş her zaman TRACKING_VIOLATION, taşıma POSTED, tek pozitif konum R-02 (15 tur)", async () => {
    for (let round = 0; round < 15; round++) {
      const x = await mkSerialItem();
      const s1 = await mkSerial(x);
      await post(await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R01 })]));
      const mv = await mkApproved("STOCK_MOVE", [ln(x, s1, { sourceLocationId: R01, targetLocationId: R02 })]);
      const dup = await mkApproved("STOCK_IN", [ln(x, s1, { targetLocationId: R03 })]);
      const res = await race([() => post(mv), () => post(dup)]);
      expect(res, `tur ${round}`).toEqual([{ ok: true }, { ok: false, code: "TRACKING_VIOLATION" }]);
      expect(await positives(s1), `tur ${round}`).toEqual([{ loc: R02, q: "1.000000" }]);
      expect(await mismatches(x)).toBe(0);
    }
  }, 120_000);
});
