// T-220 (qa-verifier): özellik testi — rastgele STOCK_IN/OUT/MOVE dizilerinde boyut başına Σ defter = bakiye, hiçbir bakiye < 0,
// toplam fiziksel stok YALNIZCA IN/OUT ile değişir (16-stock-effects §Temel kurallar 3 ve 4). fast-check, SABİT tohum (yeniden üretilebilir).
// Gerçek roller: komutlar wms_app + PgBouncer; gözlem/fikstür DATABASE_URL_DIRECT. Sentetik veri (G-09).
// Oracle yalnızca ret/kabul kararı içindir (kaynak yeterli mi); değişmezler (defter=bakiye, ≥0, toplam) modelden bağımsız SQL ile denetlenir.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { approveDocument, createStockDocument, postDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const SEED = 220_220;
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;

const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const ownerP = (): StockDocCallParams => ({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug, clientKey: uuid(), timeouts: WIDE });
async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}

type Status = "AVAILABLE" | "QUARANTINE";
interface Env { items: string[]; scales: number[]; locs: string[] }
/** 3 ürün (0,1: tam sayı; 2: 3 ondalık), 4 lokasyon. */
async function mkEnv(): Promise<Env> {
  const scales = [0, 0, 3];
  const items: string[] = [];
  for (const sc of scales) {
    const id = uuid();
    await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T220 ozellik',$4,'NONE',$5)", [
      A.tenantId, id, `P-${hex(10)}`, A.unitId, sc,
    ]);
    items.push(id);
  }
  const locs: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = uuid();
    await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T220 lok',0,'STORAGE',false)", [
      A.tenantId, id, A.warehouseId, `L-${hex(10)}`,
    ]);
    locs.push(id);
  }
  return { items, scales, locs };
}
/** Miktar binde birimdir (milli): ürün 2 için gerçek ondalık, diğerleri için 1000'in katı. */
const fmt = (milli: number, scale: number): string => {
  const whole = Math.floor(milli / 1000);
  return scale === 0 ? String(whole) : `${whole}.${String(milli % 1000).padStart(3, "0")}`;
};

type Op =
  | { kind: "STOCK_IN"; item: number; loc: number; status: Status; amt: number }
  | { kind: "STOCK_OUT"; item: number; loc: number; status: Status; amt: number }
  | { kind: "STOCK_MOVE"; item: number; loc: number; to: number; status: Status; amt: number };

const statusArb = fc.constantFrom<Status>("AVAILABLE", "QUARANTINE");
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("STOCK_IN" as const), item: fc.nat(2), loc: fc.nat(3), status: statusArb, amt: fc.integer({ min: 1, max: 12 }) }),
  fc.record({ kind: fc.constant("STOCK_OUT" as const), item: fc.nat(2), loc: fc.nat(3), status: statusArb, amt: fc.integer({ min: 1, max: 12 }) }),
  fc
    .record({ kind: fc.constant("STOCK_MOVE" as const), item: fc.nat(2), loc: fc.nat(3), off: fc.integer({ min: 1, max: 3 }), status: statusArb, amt: fc.integer({ min: 1, max: 12 }) })
    .map((o) => ({ kind: o.kind, item: o.item, loc: o.loc, to: (o.loc + o.off) % 4, status: o.status, amt: o.amt })),
);
/** Ürün 2'de miktar kesirli (binde); diğerlerinde tam sayı (amt × 1000 milli). */
const milliOf = (op: Op, scale: number, frac: number): number => (scale === 0 ? op.amt * 1000 : op.amt * 1000 + frac);

function lineOf(e: Env, op: Op, milli: number): DocumentLineInput {
  const s = fmt(milli, e.scales[op.item] as number);
  const base: DocumentLineInput = { itemId: e.items[op.item] as string, unitId: A.unitId, quantity: s, conversionFactor: "1", baseQuantity: s, stockStatus: op.status };
  if (op.kind === "STOCK_IN") return { ...base, targetLocationId: e.locs[op.loc] as string };
  if (op.kind === "STOCK_OUT") return { ...base, sourceLocationId: e.locs[op.loc] as string };
  return { ...base, sourceLocationId: e.locs[op.loc] as string, targetLocationId: e.locs[op.to] as string };
}

async function createApproved(op: Op, line: DocumentLineInput): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(ownerP(), { kind: op.kind, warehouseId: A.warehouseId, lines: [line] });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [id]))[0];
  return { id, version: Number(v?.version) };
}

/** Modelden bağımsız SQL değişmezleri (ürün kümesi için). Binde birim tam sayı olarak döner. */
async function invariants(items: readonly string[]): Promise<{ dims: Map<string, number>; physical: Map<string, number>; mismatch: number; negative: number }> {
  const rows = await q<{ item_id: string; loc: string; st: string; bal: string }>(
    `SELECT s.item_id, s.location_id AS loc, s.stock_status AS st, round(b.quantity * 1000)::bigint::text AS bal
       FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id = ANY($2::uuid[])`, [A.tenantId, items]);
  const dims = new Map<string, number>();
  const physical = new Map<string, number>();
  let negative = 0;
  for (const r of rows) {
    const v = Number(r.bal);
    if (v < 0) negative += 1;
    if (v !== 0) dims.set(`${r.item_id}|${r.loc}|${r.st}`, v);
    physical.set(r.item_id, (physical.get(r.item_id) ?? 0) + v);
  }
  // Σ defter = bakiye: iki yönlü (bakiyesi olmayan ama defteri olan boyut da yakalanır).
  const mm = await q<{ n: string }>(
    `WITH l AS (SELECT sl.stock_dimension_id AS d, sum(sl.quantity) AS q FROM public.stock_ledger sl JOIN public.stock_dimensions s ON s.tenant_id=sl.tenant_id AND s.id=sl.stock_dimension_id
                 WHERE sl.tenant_id=$1 AND s.item_id = ANY($2::uuid[]) GROUP BY 1),
          b AS (SELECT bb.stock_dimension_id AS d, bb.quantity AS q FROM public.stock_balances bb JOIN public.stock_dimensions s ON s.tenant_id=bb.tenant_id AND s.id=bb.stock_dimension_id
                 WHERE bb.tenant_id=$1 AND s.item_id = ANY($2::uuid[]))
     SELECT count(*)::text AS n FROM l FULL OUTER JOIN b ON l.d = b.d WHERE COALESCE(l.q,0) <> COALESCE(b.q,0)`, [A.tenantId, items]);
  return { dims, physical, mismatch: Number(mm[0]?.n), negative };
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A220D");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("defter toplamı = bakiye (özellik testi, T-220)", () => {
  it("rastgele ardışık IN/OUT/MOVE dizileri (3 ürün, 4 lokasyon, 2 durum): her adımdan sonra Σ defter = bakiye, bakiye ≥ 0, kabul/ret modele uyar, toplam yalnızca IN/OUT ile değişir (tohum 220220)", async () => {
    let executed = 0;
    let rejectedCount = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(opArb, fc.integer({ min: 0, max: 999 })), { minLength: 1, maxLength: 14 }), async (steps) => {
        const e = await mkEnv();
        const model = new Map<string, number>(); // item|loc|status → milli
        const total = new Map<string, number>(); // item → milli
        for (const [op, frac] of steps) {
          const scale = e.scales[op.item] as number;
          const milli = milliOf(op, scale, scale === 0 ? 0 : frac === 0 ? 1 : frac);
          const itemId = e.items[op.item] as string;
          const src = `${itemId}|${e.locs[op.loc]}|${op.status}`;
          const dst = op.kind === "STOCK_MOVE" ? `${itemId}|${e.locs[op.to]}|${op.status}` : src;
          const enough = op.kind === "STOCK_IN" || (model.get(src) ?? 0) >= milli;
          const physicalBefore = total.get(itemId) ?? 0;
          const doc = await createApproved(op, lineOf(e, op, milli));
          executed += 1;
          let outcome: string;
          try {
            outcome = (await postDocument(ownerP(), { documentId: doc.id, expectedVersion: doc.version })).status ?? "NO_STATUS";
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            outcome = err.code;
          }
          if (enough) {
            expect(outcome, `${op.kind} ${JSON.stringify(op)} milli=${milli}`).toBe("POSTED");
            if (op.kind === "STOCK_IN") {
              model.set(dst, (model.get(dst) ?? 0) + milli);
              total.set(itemId, physicalBefore + milli);
            } else if (op.kind === "STOCK_OUT") {
              model.set(src, (model.get(src) ?? 0) - milli);
              total.set(itemId, physicalBefore - milli);
            } else {
              model.set(src, (model.get(src) ?? 0) - milli);
              model.set(dst, (model.get(dst) ?? 0) + milli);
            }
          } else {
            rejectedCount += 1;
            expect(outcome, `${op.kind} ${JSON.stringify(op)} milli=${milli}`).toBe("INSUFFICIENT_STOCK");
            const st = (await q<{ status: string }>("SELECT status FROM public.documents WHERE id=$1", [doc.id]))[0]?.status;
            expect(st).toBe("APPROVED");
          }
          const inv = await invariants(e.items);
          expect(inv.mismatch, "Σ defter ≠ bakiye").toBe(0);
          expect(inv.negative, "negatif bakiye").toBe(0);
          const expectedDims = new Map([...model].filter(([, v]) => v !== 0));
          expect(Object.fromEntries(inv.dims)).toEqual(Object.fromEntries(expectedDims));
          for (const it of e.items) expect(inv.physical.get(it) ?? 0, `fiziksel toplam ${it}`).toBe(total.get(it) ?? 0);
        }
      }),
      { seed: SEED, numRuns: 24, endOnFailure: false },
    );
    expect(executed).toBeGreaterThan(100);
    expect(rejectedCount).toBeGreaterThan(0); // tohum retleri de üretiyor (özellik yalnızca mutlu yolu sınamıyor)
  }, 600_000);

  it("rastgele EŞZAMANLI IN/OUT/MOVE grupları (aynı 2 lokasyon, 1 ürün): sonuçlar yalnız POSTED/INSUFFICIENT_STOCK, defter = bakiye, bakiye ≥ 0, toplam = başlangıç + ΣIN − ΣOUT(POSTED) (tohum 220220)", async () => {
    const batchArb = fc.array(
      fc.array(
        fc.record({
          kind: fc.constantFrom("STOCK_IN" as const, "STOCK_OUT" as const, "STOCK_MOVE" as const, "STOCK_OUT" as const, "STOCK_MOVE" as const),
          from: fc.nat(1),
          amt: fc.integer({ min: 1, max: 9 }),
        }),
        { minLength: 2, maxLength: 5 },
      ),
      { minLength: 1, maxLength: 3 },
    );
    let batches = 0;
    let rejections = 0;
    await fc.assert(
      fc.asyncProperty(batchArb, async (plan) => {
        const e = await mkEnv();
        const item = e.items[0] as string;
        const seedOp: Op = { kind: "STOCK_IN", item: 0, loc: 0, status: "AVAILABLE", amt: 10 };
        const sd = await createApproved(seedOp, lineOf(e, seedOp, 10_000));
        await postDocument(ownerP(), { documentId: sd.id, expectedVersion: sd.version });
        let expectedTotal = 10_000;
        for (const batch of plan) {
          batches += 1;
          const docs = await Promise.all(
            batch.map(async (b) => {
              const op: Op =
                b.kind === "STOCK_MOVE"
                  ? { kind: "STOCK_MOVE", item: 0, loc: b.from, to: 1 - b.from, status: "AVAILABLE", amt: b.amt }
                  : { kind: b.kind, item: 0, loc: b.from, status: "AVAILABLE", amt: b.amt };
              // lokasyon indeksleri 0/1: e.locs'un ilk ikisi
              return { op, doc: await createApproved(op, lineOf(e, op, b.amt * 1000)) };
            }),
          );
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          const runs = docs.map(async ({ op, doc }) => {
            await gate;
            try {
              await postDocument(ownerP(), { documentId: doc.id, expectedVersion: doc.version });
              return { op, code: "POSTED" };
            } catch (err) {
              if (!(err instanceof AppError)) throw err;
              return { op, code: err.code };
            }
          });
          await new Promise((r) => setTimeout(r, 15));
          release();
          const results = await Promise.all(runs);
          for (const r of results) {
            expect(["POSTED", "INSUFFICIENT_STOCK"], `beklenmeyen sonuç ${r.code} (${JSON.stringify(r.op)})`).toContain(r.code);
            if (r.code === "INSUFFICIENT_STOCK") rejections += 1;
            if (r.code === "POSTED" && r.op.kind === "STOCK_IN") expectedTotal += r.op.amt * 1000;
            if (r.code === "POSTED" && r.op.kind === "STOCK_OUT") expectedTotal -= r.op.amt * 1000;
          }
          const inv = await invariants([item]);
          expect(inv.mismatch, "Σ defter ≠ bakiye").toBe(0);
          expect(inv.negative, "negatif bakiye").toBe(0);
          expect(inv.physical.get(item) ?? 0).toBe(expectedTotal);
        }
      }),
      { seed: SEED, numRuns: 14, endOnFailure: false },
    );
    expect(batches).toBeGreaterThan(10);
    expect(rejections).toBeGreaterThan(0);
  }, 600_000);
});
