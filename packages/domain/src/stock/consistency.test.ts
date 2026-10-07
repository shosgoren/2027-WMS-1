// T-225 birim: parça sınırları, fark sınıflandırması, toplayıcı sınırı, koşu akışı (DB'siz sahte tx). Gerçek karşılaştırma: tests/integration/stock/consistency-job.int.test.ts.
import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { AccessTx } from "../identity/access.ts";
import {
  CONSISTENCY_CHUNK_SIZE,
  CONSISTENCY_FINDINGS_MAX,
  ConsistencyAccumulator,
  NIL_UUID,
  checkDimensionChunk,
  checkLocationLockChunk,
  checkSerialChunk,
} from "./consistency.ts";
import { runConsistencyCheck, type ConsistencyCheckContext } from "./jobs.ts";

const dialect = new PgDialect();
const TENANT = randomUUID();

type Handler = (text: string, params: unknown[]) => unknown[] | undefined;
/** Sahte tx: her `execute` SQL metnini ve parametrelerini kaydeder; `handler` satır döndürür. */
function fakeTx(handler: Handler): { tx: AccessTx; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (q: Parameters<InstanceType<typeof PgDialect>["sqlToQuery"]>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(q);
      calls.push({ text, params });
      if (/^\s*SELECT nullif\(/i.test(text)) return [{ tenant_id: TENANT }]; // currentTenantId sorgusu
      return handler(text, params) ?? [];
    },
  } as unknown as AccessTx;
  return { tx, calls };
}

describe("parça sorguları: tek ifade, keyset, sınır", () => {
  it("(a)+(b) tek SQL ifadesidir; after ve limit parametredir; yazma yok", async () => {
    const { tx, calls } = fakeTx(() => [{ checked: 0, last: null, qty_bad: 0, res_bad: 0, qty_ids: null, res_ids: null }]);
    await checkDimensionChunk(tx, TENANT, NIL_UUID);
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toMatch(/stock_ledger/);
    expect(text).toMatch(/stock_balances/);
    expect(text).toMatch(/reservations/);
    expect(text).toMatch(/status = 'ACTIVE'/);
    expect(text).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(text).not.toMatch(/\bfor\s+(update|share)\b/i);
    expect(params).toContain(NIL_UUID);
    expect(params).toContain(CONSISTENCY_CHUNK_SIZE);
  });

  it("(a)/(b) farkı ayrı sınıflandırılır; bulgu yalnız kimlik + tür", async () => {
    const d1 = randomUUID();
    const d2 = randomUUID();
    const { tx } = fakeTx(() => [{ checked: 5, last: d2, qty_bad: 1, res_bad: 1, qty_ids: [d1], res_ids: [d2] }]);
    const r = await checkDimensionChunk(tx, TENANT, NIL_UUID);
    expect(r.checked).toBe(5);
    expect(r.last).toBe(d2);
    expect(r.mismatchesByCheck).toEqual({ a: 1, b: 1 });
    expect(r.samples).toEqual([
      { check: "a", id: d1 },
      { check: "b", id: d2 },
    ]);
  });

  it("(c) eksik kilit satırı sayılır", async () => {
    const l = randomUUID();
    const { tx, calls } = fakeTx(() => [{ checked: 3, last: l, bad: 1, ids: [l] }]);
    const r = await checkLocationLockChunk(tx, TENANT, NIL_UUID);
    expect(calls).toHaveLength(1);
    expect(r.mismatchesByCheck).toEqual({ c: 1 });
    expect(r.samples).toEqual([{ check: "c", id: l }]);
  });

  it("(d) yalnız ihlalli seriler döner; sayı = satır sayısı; boşsa last null", async () => {
    const s = randomUUID();
    const { tx } = fakeTx(() => [{ serial_key: s }]);
    const r = await checkSerialChunk(tx, TENANT, NIL_UUID);
    expect(r).toMatchObject({ checked: 1, last: s, mismatchesByCheck: { d: 1 } });
    const empty = await checkSerialChunk(fakeTx(() => []).tx, TENANT, NIL_UUID);
    expect(empty).toMatchObject({ checked: 0, last: null, mismatchesByCheck: { d: 0 } });
  });

  it("parça sınırı 1.000'dir", () => {
    expect(CONSISTENCY_CHUNK_SIZE).toBe(1000);
  });
});

describe("toplayıcı", () => {
  it("bulgular ≤ 100 ile sınırlanır, sayı toplamı korur; yalnız boyut parçaları denetlenen boyutu artırır", () => {
    const acc = new ConsistencyAccumulator();
    const many = Array.from({ length: 80 }, () => ({ check: "a" as const, id: randomUUID() }));
    acc.add("dimensions", { checked: 1000, last: randomUUID(), mismatchesByCheck: { a: 80, b: 0 }, samples: many });
    acc.add("dimensions", { checked: 10, last: randomUUID(), mismatchesByCheck: { a: 80, b: 0 }, samples: many });
    acc.add("locks", { checked: 7, last: randomUUID(), mismatchesByCheck: { c: 2 }, samples: [] });
    const r = acc.report();
    expect(r.checkedDimensions).toBe(1010);
    expect(r.mismatchCount).toBe(162);
    expect(r.findings).toHaveLength(CONSISTENCY_FINDINGS_MAX);
  });

  it("temiz veri → 0 fark", () => {
    const acc = new ConsistencyAccumulator();
    acc.add("dimensions", { checked: 3, last: randomUUID(), mismatchesByCheck: { a: 0, b: 0 }, samples: [] });
    expect(acc.report()).toEqual({ checkedDimensions: 3, mismatchCount: 0, findings: [] });
  });
});

describe("runConsistencyCheck akışı", () => {
  const logger = () => ({ info: vi.fn(), error: vi.fn() });
  /** Her `inTenant` çağrısı ayrı sahte tx alır (ayrı kısa transaction). */
  function ctxWith(handler: Handler, onTx?: (n: number) => void) {
    const txs: ReturnType<typeof fakeTx>[] = [];
    const ctx = {
      jobId: randomUUID(),
      type: "stock.consistency.check",
      hasTenant: true,
      actorUserId: null,
      payload: {},
      inTenant: async <R>(fn: (tx: AccessTx) => Promise<R>): Promise<R> => {
        onTx?.(txs.length);
        const f = fakeTx(handler);
        txs.push(f);
        return fn(f.tx);
      },
      inPlatform: vi.fn(),
    } as unknown as ConsistencyCheckContext;
    return { ctx, txs };
  }
  const clean: Handler = (text) => {
    if (text.includes("stock_dimensions")) return [{ checked: 0, last: null, qty_bad: 0, res_bad: 0, qty_ids: null, res_ids: null }];
    if (text.includes("location_count_locks")) return [{ checked: 0, last: null, bad: 0, ids: null }];
    return [];
  };

  it("her parça ayrı transaction: önce salt-okur ayarı, tek denetim ifadesi; son transaction'da sonuç yazılır", async () => {
    const consumeOnce = vi.fn(async (_tx: unknown, _c: string, _e: string, fn: (tx: AccessTx) => Promise<unknown>) => ({ applied: true as const, result: await fn(_tx as AccessTx) }));
    const log = logger();
    const { ctx, txs } = ctxWith(clean);
    const out = await runConsistencyCheck({ consumeOnce: consumeOnce as never, logger: log }, ctx);
    expect(out).toMatchObject({ status: "OK", applied: true });
    // 3 denetim parçası (boyut, kilit, seri) + 1 son transaction
    expect(txs).toHaveLength(4);
    for (const t of txs.slice(0, 3)) {
      expect(t.calls[0]!.text).toContain("transaction_read_only");
      expect(t.calls.filter((c) => /stock_balances|stock_dimensions|locations/.test(c.text))).toHaveLength(1);
      expect(t.calls.some((c) => /\b(insert|update|delete)\b/i.test(c.text))).toBe(false);
    }
    expect(consumeOnce).toHaveBeenCalledTimes(1);
    expect(consumeOnce.mock.calls[0]![2]).toBe(ctx.jobId);
    const inserts = txs[3]!.calls.filter((c) => /insert into/i.test(c.text));
    expect(inserts.map((c) => /stock_consistency_runs/.test(c.text))).toEqual([true, false]);
    expect(inserts[1]!.text).toContain("stock_consistency_signals");
    expect(log.info).toHaveBeenCalledWith("stock.consistency.ok", expect.objectContaining({ tenantId: TENANT }));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("fark → MISMATCH, level=error log; defter/bakiye yazılmaz", async () => {
    const id = randomUUID();
    const consumeOnce = vi.fn(async (tx: AccessTx, _c: string, _e: string, fn: (tx: AccessTx) => Promise<unknown>) => ({ applied: true as const, result: await fn(tx) }));
    const log = logger();
    const handler: Handler = (text, p) =>
      text.includes("stock_dimensions") ? [{ checked: 1, last: id, qty_bad: 1, res_bad: 0, qty_ids: [id], res_ids: null }] : clean(text, p);
    const { ctx, txs } = ctxWith(handler);
    const out = await runConsistencyCheck({ consumeOnce: consumeOnce as never, logger: log }, ctx);
    expect(out.status).toBe("MISMATCH");
    expect(out.report.mismatchCount).toBe(1);
    expect(log.error).toHaveBeenCalledWith("stock.consistency.mismatch", { jobId: ctx.jobId, tenantId: TENANT, count: 1 });
    const all = txs.flatMap((t) => t.calls.map((c) => c.text)).join("\n");
    expect(all).not.toMatch(/(insert\s+into|update|delete\s+from)\s+(public\.)?(stock_ledger|stock_balances|reservations|location_count_locks|stock_dimensions)\b/i);
  });

  it("denetim ortasında hata → koşu satırı yazılmaz, FAILED sinyali ayrı transaction'da, hata yayılır, error log", async () => {
    const consumeOnce = vi.fn();
    const log = logger();
    let thrown = false;
    const { ctx, txs } = ctxWith(clean, (n) => {
      if (n === 1 && !thrown) {
        thrown = true;
        throw new Error("boom"); // 2. parça (kilit denetimi) başlamadan çöker; FAILED sinyali yazımı çalışır
      }
    });
    await expect(runConsistencyCheck({ consumeOnce: consumeOnce as never, logger: log }, ctx)).rejects.toThrow("boom");
    expect(consumeOnce).not.toHaveBeenCalled();
    const texts = txs.flatMap((t) => t.calls.map((c) => c.text)).join("\n");
    expect(texts).not.toContain("stock_consistency_runs");
    expect(texts).toContain("'FAILED'");
    expect(log.error).toHaveBeenCalledWith("stock.consistency.failed", expect.objectContaining({ jobId: ctx.jobId, signalled: true }));
  });

  it("yeniden teslim (consumeOnce applied:false) → yinelenen alarm/log yok", async () => {
    const consumeOnce = vi.fn(async () => ({ applied: false as const }));
    const log = logger();
    const { ctx } = ctxWith(clean);
    const out = await runConsistencyCheck({ consumeOnce: consumeOnce as never, logger: log }, ctx);
    expect(out.applied).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("stock.consistency.already_processed", { jobId: ctx.jobId });
  });
});
