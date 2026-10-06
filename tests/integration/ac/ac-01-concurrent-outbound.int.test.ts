// T-220 (qa-verifier): AC-01 — eşzamanlı çıkışta negatif stok yok. Bağımsız doğrulama; uygulayıcı testlerine dayanmaz.
// GERÇEK roller: komutlar wms_app + PgBouncer havuzunda AYRI bağlantılardan; fikstür/gözlem yalnızca DATABASE_URL_DIRECT.
// Beklenen değerler 16-stock-effects §Temel kurallar 1/3/4 ve ACCEPTANCE AC-01 (10 stok, iki eşzamanlı 7 çıkış → en fazla biri). Sentetik veri (G-09).
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
let sampler: pg.Client;
let A: TenantWorld;
let R01: string;
let R02: string;

const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const ownerP = (key: string = uuid()): StockDocCallParams => ({
  db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug, clientKey: key, timeouts: WIDE,
});

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function mkItem(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T220 urun',$4,'NONE',0)", [
    A.tenantId, id, `Q-${hex(10)}`, A.unitId,
  ]);
  return id;
}
async function mkLoc(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T220 lok',0,'STORAGE',false)", [
    A.tenantId, id, A.warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (itemId: string, n: string, over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId, unitId: A.unitId, quantity: n, conversionFactor: "1", baseQuantity: n, ...over,
});
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[]): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(ownerP(), { kind, warehouseId: A.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(ownerP(), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [id]))[0];
  return { id, version: Number(v?.version) };
}
const post = (d: { id: string; version: number }) => postDocument(ownerP(), { documentId: d.id, expectedVersion: d.version });
const seedStock = async (item: string, loc: string, n: string): Promise<void> => {
  await post(await mkApproved("STOCK_IN", [ln(item, n, { targetLocationId: loc })]));
};
const bal = async (item: string, loc: string): Promise<string> =>
  (await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'`, [A.tenantId, item, loc]))[0]?.quantity ?? "0.000000";
/** Boyut başına Σ defter ≠ bakiye olan satır sayısı (item bazlı). */
const mismatches = async (item: string): Promise<number> =>
  Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0)`,
    [A.tenantId, item]))[0]?.n);
const ledgerCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE tenant_id=$1 AND document_id=$2", [A.tenantId, docId]))[0]?.n);
const docStatus = async (id: string): Promise<string> => (await q<{ status: string }>("SELECT status FROM public.documents WHERE id=$1", [id]))[0]?.status as string;

type Settled = { ok: true } | { ok: false; code: string; detail: string | undefined };
async function settle(p: Promise<unknown>): Promise<Settled> {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, detail: e.detail };
    throw e;
  }
}
/** Tüm çağrıları AYNI ANDA başlatır (bariyer): hepsi hazır olunca tek seferde bırakılır. */
async function race<T>(fns: ReadonlyArray<() => Promise<T>>): Promise<Settled[]> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runs = fns.map(async (f) => {
    await gate;
    return settle(f());
  });
  await new Promise((r) => setTimeout(r, 20));
  release();
  return Promise.all(runs);
}
/** Yarış boyunca COMMIT edilmiş negatif bakiye gözlemi (ayrı doğrudan bağlantı). */
function watchNegatives(): { stop: () => Promise<number>; samples: () => number } {
  let stopped = false;
  let negatives = 0;
  let n = 0;
  const loop = (async () => {
    while (!stopped) {
      const r = await sampler.query("SELECT count(*)::int AS c FROM public.stock_balances WHERE tenant_id=$1 AND quantity < 0", [A.tenantId]);
      negatives += Number(r.rows[0]?.c);
      n += 1;
    }
  })();
  return { stop: async () => ((stopped = true), await loop, negatives), samples: () => n };
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  sampler = new pg.Client({ connectionString: env.databaseUrlDirect });
  sampler.on("error", () => undefined);
  await sampler.connect();
  A = await seedWorld(adm, reg, "A220A");
  R01 = await mkLoc();
  R02 = await mkLoc();
}, 120_000);

afterAll(async () => {
  await sampler.end();
  await adm.end();
  await app.close();
}, 60_000);

describe("AC-01 eşzamanlı çıkış (T-220)", () => {
  it("@AC-01 10 stoktan iki ayrı bağlantıdan eşzamanlı 7'lik çıkış: 50 turun her birinde tam biri POSTED, diğeri INSUFFICIENT_STOCK; bakiye 3, hiç negatif yok, defter = bakiye", async () => {
    expect(DB_CLIENT_SETTINGS.poolMax).toBeGreaterThanOrEqual(2);
    const watch = watchNegatives();
    for (let round = 0; round < 50; round++) {
      const x = await mkItem();
      await seedStock(x, R01, "10");
      const o1 = await mkApproved("STOCK_OUT", [ln(x, "7", { sourceLocationId: R01 })]);
      const o2 = await mkApproved("STOCK_OUT", [ln(x, "7", { sourceLocationId: R01 })]);
      const res = await race([() => post(o1), () => post(o2)]);
      const okCount = res.filter((r) => r.ok).length;
      const rejected = res.filter((r) => !r.ok);
      expect(okCount, `tur ${round}: sonuçlar ${JSON.stringify(res)}`).toBe(1);
      expect(rejected.map((r) => (r.ok ? "" : r.code)), `tur ${round}`).toEqual(["INSUFFICIENT_STOCK"]);
      expect(await bal(x, R01), `tur ${round}`).toBe("3.000000");
      expect(await mismatches(x), `tur ${round}: defter toplamı ≠ bakiye`).toBe(0);
      const statuses = [await docStatus(o1.id), await docStatus(o2.id)].sort();
      expect(statuses, `tur ${round}`).toEqual(["APPROVED", "POSTED"]);
      // kaybeden belgenin defter satırı yok; kazananın tam bir satırı var
      expect((await ledgerCount(o1.id)) + (await ledgerCount(o2.id)), `tur ${round}`).toBe(1);
    }
    const negatives = await watch.stop();
    expect(watch.samples()).toBeGreaterThan(0);
    expect(negatives, "yarış sırasında commit edilmiş negatif bakiye gözlendi").toBe(0);
  }, 240_000);

  it("@AC-01 10 stoktan 3'lük 8 eşzamanlı çıkış: tam 3'ü POSTED, 5'i INSUFFICIENT_STOCK; kalan 1; defter = bakiye (20 tur)", async () => {
    for (let round = 0; round < 20; round++) {
      const x = await mkItem();
      await seedStock(x, R01, "10");
      const docs = await Promise.all(Array.from({ length: 8 }, () => mkApproved("STOCK_OUT", [ln(x, "3", { sourceLocationId: R01 })])));
      const res = await race(docs.map((d) => () => post(d)));
      expect(res.filter((r) => r.ok).length, `tur ${round}: ${JSON.stringify(res)}`).toBe(3);
      expect(res.filter((r) => !r.ok).every((r) => !r.ok && r.code === "INSUFFICIENT_STOCK"), `tur ${round}: ${JSON.stringify(res)}`).toBe(true);
      expect(await bal(x, R01), `tur ${round}`).toBe("1.000000");
      expect(await mismatches(x)).toBe(0);
    }
  }, 240_000);

  it("@AC-01 çok satırlı çıkış tümü-ya-da-hiç: iki eşzamanlı belge aynı iki boyutu ters sırada ister; en fazla biri POSTED, kısmi etki yok", async () => {
    for (let round = 0; round < 15; round++) {
      const x = await mkItem();
      const y = await mkItem();
      await seedStock(x, R01, "5");
      await seedStock(y, R01, "5");
      const d1 = await mkApproved("STOCK_OUT", [ln(x, "4", { sourceLocationId: R01 }), ln(y, "4", { sourceLocationId: R01 })]);
      const d2 = await mkApproved("STOCK_OUT", [ln(y, "4", { sourceLocationId: R01 }), ln(x, "4", { sourceLocationId: R01 })]);
      const res = await race([() => post(d1), () => post(d2)]);
      expect(res.filter((r) => r.ok).length, `tur ${round}: ${JSON.stringify(res)}`).toBe(1);
      expect(res.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code)), `tur ${round}`).toEqual(["INSUFFICIENT_STOCK"]);
      expect([await bal(x, R01), await bal(y, R01)], `tur ${round}`).toEqual(["1.000000", "1.000000"]);
      expect(await mismatches(x)).toBe(0);
      expect(await mismatches(y)).toBe(0);
    }
  }, 240_000);

  it("@AC-01 ters sıralı kilitler: R01→R02 ve R02→R01 eşzamanlı taşıma — kilitlenme (40P01) istemciye sızmaz, ikisi de POSTED, toplam korunur", async () => {
    for (let round = 0; round < 25; round++) {
      const x = await mkItem();
      await seedStock(x, R01, "10");
      await seedStock(x, R02, "10");
      const m1 = await mkApproved("STOCK_MOVE", [ln(x, "4", { sourceLocationId: R01, targetLocationId: R02 })]);
      const m2 = await mkApproved("STOCK_MOVE", [ln(x, "6", { sourceLocationId: R02, targetLocationId: R01 })]);
      const res = await race([() => post(m1), () => post(m2)]);
      expect(res, `tur ${round}`).toEqual([{ ok: true }, { ok: true }]);
      // R01: 10 - 4 + 6 = 12; R02: 10 + 4 - 6 = 8; fiziksel toplam 20 (kural 3: taşıma toplamı değiştirmez)
      expect([await bal(x, R01), await bal(x, R02)], `tur ${round}`).toEqual(["12.000000", "8.000000"]);
      expect(await mismatches(x)).toBe(0);
    }
  }, 240_000);

  it("@AC-01 ters sıralı kilitler, kısıtlı stok: R01=5,R02=5; eşzamanlı 8'lik R01→R02 ve R02→R01 taşımaları (ikisi de yetersiz) — negatif yok, defter = bakiye, toplam 10", async () => {
    const watch = watchNegatives();
    for (let round = 0; round < 25; round++) {
      const x = await mkItem();
      await seedStock(x, R01, "5");
      await seedStock(x, R02, "5");
      const m1 = await mkApproved("STOCK_MOVE", [ln(x, "8", { sourceLocationId: R01, targetLocationId: R02 })]);
      const m2 = await mkApproved("STOCK_MOVE", [ln(x, "8", { sourceLocationId: R02, targetLocationId: R01 })]);
      const res = await race([() => post(m1), () => post(m2)]);
      for (const r of res) if (!r.ok) expect(r.code, `tur ${round}`).toBe("INSUFFICIENT_STOCK");
      expect(res.filter((r) => r.ok).length, `tur ${round}: ${JSON.stringify(res)}`).toBe(0); // her ikisi de 8 > 5 kaynak: hiçbiri başarılı olamaz
      const [b1, b2] = [Number(await bal(x, R01)), Number(await bal(x, R02))];
      expect(b1).toBeGreaterThanOrEqual(0);
      expect(b2).toBeGreaterThanOrEqual(0);
      expect(b1 + b2, `tur ${round}`).toBe(10);
      expect(await mismatches(x)).toBe(0);
    }
    expect(await watch.stop()).toBe(0);
  }, 240_000);
  it("@AC-01 kanonik kilit sırası (deterministik): yüksek anahtarlı bakiye satırı dışarıdan tutulurken MOVE belgesi düşük anahtarlıyı ZATEN kilitlemiş olmalı (artan sıra), serbest bırakınca POSTED (10 tur)", async () => {
    for (let round = 0; round < 10; round++) {
      const x = await mkItem();
      await seedStock(x, R01, "50");
      await seedStock(x, R02, "50");
      const dims = await q<{ id: string }>(
        `SELECT s.id FROM public.stock_dimensions s WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.stock_status='AVAILABLE' AND s.location_id = ANY($3::uuid[])`,
        [A.tenantId, x, [R01, R02]],
      );
      expect(dims).toHaveLength(2);
      const ids = dims.map((d) => d.id.toLowerCase()).sort();
      const [low, high] = ids as [string, string];
      const [from, to] = round % 2 === 0 ? [R01, R02] : [R02, R01];
      const mv = await mkApproved("STOCK_MOVE", [ln(x, "1", { sourceLocationId: from, targetLocationId: to })]);
      await adm.query("BEGIN");
      let pending: Promise<Settled> | undefined;
      try {
        await adm.query("SELECT 1 FROM public.stock_balances WHERE tenant_id=$1 AND stock_dimension_id=$2 FOR UPDATE", [A.tenantId, high]);
        pending = settle(post(mv));
        // komut yüksek anahtarlı satırda Lock beklemesine girene dek bekle
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          const w = await sampler.query("SELECT 1 FROM pg_stat_activity WHERE usename='wms_app' AND wait_event_type='Lock'");
          waiting = (w.rowCount ?? 0) > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting, `tur ${round}: komut kilit beklemesine girmedi`).toBe(true);
        // düşük anahtarlı satır komut tarafından tutuluyor mu? (NOWAIT: tutuluyorsa 55P03)
        await sampler.query("BEGIN");
        let held: string | undefined;
        try {
          await sampler.query("SELECT 1 FROM public.stock_balances WHERE tenant_id=$1 AND stock_dimension_id=$2 FOR UPDATE NOWAIT", [A.tenantId, low]);
          held = "SERBEST";
        } catch (e) {
          held = (e as { code?: string }).code;
        } finally {
          await sampler.query("ROLLBACK");
        }
        expect(held, `tur ${round}: düşük anahtarlı satır, yüksek anahtarlıyı beklerken kilitli olmalı`).toBe("55P03");
      } finally {
        await adm.query("ROLLBACK");
      }
      expect(await pending, `tur ${round}`).toEqual({ ok: true });
      expect(await mismatches(x)).toBe(0);
    }
  }, 120_000);
});
