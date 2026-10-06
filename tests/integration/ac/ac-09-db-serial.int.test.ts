// katman: DB (komut katmanı T-220) — AC-09 yalnızca DB katmanı: seri tekilliği CHECK + kısmi tekil indeks. TRACKING_VIOLATION
// hata kodu ve komut davranışı T-220'de kanıtlanır; bu dosya kısmi kapıdır (değerlendirme T-132/T-220).
//
// AC-09: "Seri takipli ürün iki lokasyona → TRACKING_VIOLATION". Bağımsız doğrulama (T-233, qa-verifier); uygulayıcı testine
// dayanmaz. Kaynak: ADR-017 §3 (seri boyutunda quantity ∈ {0,1}; UNIQUE (tenant_id, serial_id) WHERE quantity > 0; aynı
// transaction'da önce kaynak azaltılır, sonra hedef artırılır).
//
// Uygulama rolü wms_app (DATABASE_URL, PgBouncer transaction mode); migration rolü yalnızca fikstür. Sentetik veri (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const SERIAL_QTY_CHK = "stock_balances_serial_qty_chk";
const SERIAL_POSITIVE_KEY = "stock_balances_serial_positive_key";

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
/** Aynı seri (A.serialId), kök lokasyonda ikinci boyut (kalıcı, bakiyesiz); ilk boyut A.serialDimensionId (alt lokasyon, miktar 1). */
let targetDim: string;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [url])}`);
  }
  clients.push(c);
  return c;
}

type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string | undefined; message: string; constraint: string | undefined };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;

async function asApp(tenantId: string, work: (q: Q) => Promise<unknown>, end: "commit" | "rollback" = "rollback"): Promise<Attempt> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await app.query(sql, p);
      return last;
    });
    await app.query(end === "commit" ? "COMMIT" : "ROLLBACK");
    return { ok: true, rows: last?.rows ?? [] };
  } catch (e) {
    const err = e as { code?: string; message?: string; constraint?: string };
    await app.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: err.code, message: String(err.message), constraint: err.constraint };
  }
}

function expectFail(r: Attempt, code: string, constraint: string, label: string): void {
  expect(r.ok, `${label}: ret beklenirdi ama kabul edildi`).toBe(false);
  if (!r.ok) {
    expect(r.code, `${label}: ${r.message}`).toBe(code);
    expect(r.constraint, `${label}: ${r.message}`).toBe(constraint);
  }
}

const SQL_LEDGER = `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
   VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 't233', '2026-02-01')`;
/** Belge satırı boyutun ürünüyle aynı olmalı: seri boyutları LOT_AND_SERIAL ürünün satırı, A.dimensionId NONE ürünün satırı. */
const ledger = (q: Q, dim: string, qty: number): Promise<pg.QueryResult> =>
  q(SQL_LEDGER, [A.tenantId, A.documentId, dim === A.dimensionId ? A.documentLineNoneId : A.documentLineId, dim, qty]);
const setQty = (q: Q, dim: string, qty: number): Promise<pg.QueryResult> =>
  q("UPDATE public.stock_balances SET quantity = $3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [A.tenantId, dim, qty]);
const insBal = (q: Q, dim: string, qty: number): Promise<pg.QueryResult> =>
  q("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, $2, $3, 0)", [A.tenantId, dim, qty]);
const insSerialDim = (q: Q, loc: string, status: string): Promise<pg.QueryResult> =>
  q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id, stock_status) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    A.tenantId, randomUUID(), A.itemId, loc, A.lotId, A.serialId, status,
  ]);
const positiveCount = async (): Promise<number> => {
  const r = await asApp(A.tenantId, async (q) => q("SELECT count(*)::int AS n FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id WHERE d.serial_id = $1 AND b.quantity > 0", [A.serialId]));
  return r.ok ? ((r.rows[0] as { n: number }).n) : -1;
};

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
  targetDim = randomUUID();
  const r = await asApp(
    A.tenantId,
    async (q) => {
      await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id) VALUES ($1, $2, $3, $4, $5, $6)", [A.tenantId, targetDim, A.itemId, A.rootLocationId, A.lotId, A.serialId]);
    },
    "commit",
  );
  if (!r.ok) throw new Error(`hedef boyut kurulamadı: ${r.message}`);
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("AC-09 (DB katmanı): seri miktarı", () => {
  it("@AC-09 seri boyutunda bakiye miktarı 2 → CHECK reddi (INSERT ve UPDATE); 1 ve 0 kabul", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledger(q, targetDim, 2); await insBal(q, targetDim, 2); }), CHECK_VIOLATION, SERIAL_QTY_CHK, "INSERT 2");
    expectFail(await asApp(A.tenantId, async (q) => { await setQty(q, A.serialDimensionId, 2); }), CHECK_VIOLATION, SERIAL_QTY_CHK, "UPDATE 1→2");
    expectFail(await asApp(A.tenantId, async (q) => { await setQty(q, A.serialDimensionId, 1.5); }), CHECK_VIOLATION, SERIAL_QTY_CHK, "UPDATE 1→1.5");
    // Kontroller: miktar 0 ve 1 CHECK'i geçer (mevcut seri bakiyesi 1; sıfırlama kabul).
    const ok0 = await asApp(A.tenantId, async (q) => { await ledger(q, A.serialDimensionId, -1); await setQty(q, A.serialDimensionId, 0); await q("SET CONSTRAINTS ALL IMMEDIATE"); });
    expect(ok0.ok, JSON.stringify(ok0)).toBe(true);
  });

  it("@AC-09 seri boyutunda miktar 2 defter toplamıyla tutarlı olsa bile reddedilir (defter +2 ve bakiye 2)", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledger(q, A.serialDimensionId, 1); await setQty(q, A.serialDimensionId, 2); }, "commit"), CHECK_VIOLATION, SERIAL_QTY_CHK, "tutarlı 2");
  });

  it("kontrol: seri OLMAYAN boyutta miktar 2 serbest (CHECK yalnız seri boyutuna uygulanır)", async () => {
    const r = await asApp(A.tenantId, async (q) => { await ledger(q, A.dimensionId, 2); await setQty(q, A.dimensionId, 12); await q("SET CONSTRAINTS ALL IMMEDIATE"); });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("AC-09 (DB katmanı): aynı seri iki yerde pozitif olamaz", () => {
  it("@AC-09 aynı seri iki lokasyonda pozitif (INSERT yolu) → tekil indeks reddi", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledger(q, targetDim, 1); await insBal(q, targetDim, 1); }), UNIQUE_VIOLATION, SERIAL_POSITIVE_KEY, "INSERT");
  });

  it("@AC-09 aynı seri ikinci boyutta UPDATE ile pozitife çekilirse (0→1) → tekil indeks reddi", async () => {
    const r = await asApp(A.tenantId, async (q) => {
      await insBal(q, targetDim, 0);
      await ledger(q, targetDim, 1);
      await setQty(q, targetDim, 1);
    });
    expectFail(r, UNIQUE_VIOLATION, SERIAL_POSITIVE_KEY, "UPDATE");
  });

  it("@AC-09 farklı durum veya aynı lokasyondaki ikinci boyut da aynı seriyi pozitif tutamaz", async () => {
    for (const [loc, status] of [[A.childLocationId, "QUARANTINE"], [A.rootLocationId, "DAMAGED"], [A.childLocationId, "BLOCKED"]] as const) {
      const r = await asApp(A.tenantId, async (q) => {
        const d = randomUUID();
        await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id, stock_status) VALUES ($1, $2, $3, $4, $5, $6, $7)", [A.tenantId, d, A.itemId, loc, A.lotId, A.serialId, status]);
        await ledger(q, d, 1);
        await insBal(q, d, 1);
      });
      expectFail(r, UNIQUE_VIOLATION, SERIAL_POSITIVE_KEY, `${loc === A.childLocationId ? "alt" : "kök"} ${status}`);
    }
    // Aynı lot/ürün ama FARKLI seri bağımsızdır (kontrol): yeni seri aynı anda pozitif olabilir.
  });

  it("@AC-09 sıra: önce hedef artırılırsa ret; önce kaynak azaltılıp sonra hedef artırılırsa kabul (ADR-017 §3)", async () => {
    expect(await positiveCount()).toBe(1);
    // Yanlış sıra: hedef önce.
    const wrong = await asApp(A.tenantId, async (q) => {
      await ledger(q, targetDim, 1);
      await insBal(q, targetDim, 1);
      await ledger(q, A.serialDimensionId, -1);
      await setQty(q, A.serialDimensionId, 0);
    });
    expectFail(wrong, UNIQUE_VIOLATION, SERIAL_POSITIVE_KEY, "hedef önce");

    // Doğru sıra: kaynak önce; gerçek COMMIT (ertelenmiş mutlak denetim de geçer).
    const move = (from: string, to: string, toHasBalance: boolean) => async (q: Q): Promise<void> => {
      await ledger(q, from, -1);
      await setQty(q, from, 0);
      await ledger(q, to, 1);
      if (toHasBalance) await setQty(q, to, 1);
      else await insBal(q, to, 1);
    };
    const there = await asApp(A.tenantId, move(A.serialDimensionId, targetDim, false), "commit");
    expect(there.ok, JSON.stringify(there)).toBe(true);
    expect(await positiveCount()).toBe(1);
    const state = await asApp(A.tenantId, async (q) => q("SELECT stock_dimension_id::text AS id, quantity::text AS q FROM public.stock_balances WHERE stock_dimension_id = ANY($1::uuid[]) ORDER BY 1", [[A.serialDimensionId, targetDim]]));
    expect(state.ok && new Map(state.rows.map((x) => [x.id as string, x.q as string]))).toEqual(new Map([[A.serialDimensionId, "0.000000"], [targetDim, "1.000000"]]));
    // Aynı sırayla geri taşıma (hedefin bakiye satırı artık var).
    const back = await asApp(A.tenantId, move(targetDim, A.serialDimensionId, true), "commit");
    expect(back.ok, JSON.stringify(back)).toBe(true);
    expect(await positiveCount()).toBe(1);
  });

  it("@AC-09 taşıma tutarsız (kaynak azaltılıp hedef artırılmadan commit) → defter-bakiye denetimi yine de tutar; seri yok olmaz", async () => {
    // Kaynak sıfırlanır ve hedef artırılmazsa bakiye ile defter tutarlı, seri hiçbir yerde pozitif değildir: şema bunu reddetmez
    // (stok kaybı komut katmanı kuralıdır); burada yalnızca tekil indeksin yanlış-pozitif üretmediği doğrulanır.
    const r = await asApp(A.tenantId, async (q) => { await ledger(q, A.serialDimensionId, -1); await setQty(q, A.serialDimensionId, 0); await q("SET CONSTRAINTS ALL IMMEDIATE"); });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await positiveCount()).toBe(1);
  });

  it("@AC-09 B tenant'ının aynı biçimli serisi A'nın pozitif seri kısıtını etkilemez; B bağlamından A serisi boyutu kurulamaz", async () => {
    // B kendi serisini (farklı kimlik) pozitif tutar (fikstür); A tarafındaki sayı değişmez.
    const bSeen = await asApp(B.tenantId, async (q) => q("SELECT count(*)::int AS n FROM public.stock_balances WHERE quantity > 0 AND stock_dimension_id = $1", [B.serialDimensionId]));
    expect(bSeen.ok && bSeen.rows[0]).toEqual({ n: 1 });
    const cross = await asApp(B.tenantId, async (q) => { await insSerialDim(q, A.rootLocationId, "AVAILABLE"); });
    expect(cross.ok).toBe(false);
  });
});
