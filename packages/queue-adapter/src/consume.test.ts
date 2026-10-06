// `consumeOnce` / `deliverExternalOnce` birim testleri (sahte transaction; gerçek PG davranışı
// `tests/integration/queue/consume-once.int.test.ts`'te).
import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { QueueError } from "@wms/shared/queue";
import { consumeOnce, deliverExternalOnce, type ExternalOnceContext } from "./consume.ts";
import type { TenantTx } from "./index.ts";

const T1 = randomUUID();
const T2 = randomUUID();

function fakeStore() {
  const rows = new Set<string>();
  const tenantOf = (scope: string): string | null => (scope === "platform" ? null : scope);
  const state = { failInsert: false, statements: [] as string[] };
  const tx = (scope: string): TenantTx =>
    ({
      execute: (q: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const built = new PgDialect().sqlToQuery(q);
        state.statements.push(built.sql);
        if (/current_setting/i.test(built.sql)) return Promise.resolve([{ tenant_id: tenantOf(scope) }]);
        const params = built.params as string[];
        const [consumer, eventId] = params.length === 3 ? [params[1], params[2]] : [params[0], params[1]];
        if (params.length === 3 && params[0] !== tenantOf(scope)) return Promise.reject(new Error("tenant mismatch"));
        const key = `${scope}|${consumer}|${eventId}`;
        if (/^\s*INSERT INTO processed_events/i.test(built.sql)) {
          if (state.failInsert) return Promise.reject(new Error("insert failed"));
          if (rows.has(key)) return Promise.resolve([]);
          rows.add(key);
          return Promise.resolve([{ one: 1 }]);
        }
        return Promise.resolve(rows.has(key) ? [{ one: 1 }] : []);
      },
    }) as unknown as TenantTx;
  return { rows, state, tx };
}

function ctxFor(store: ReturnType<typeof fakeStore>, opts: { hasTenant: boolean; scope: string; jobId?: string }): ExternalOnceContext {
  const run = <R>(fn: (tx: unknown) => Promise<R>) => fn(store.tx(opts.scope));
  return { jobId: opts.jobId ?? randomUUID(), hasTenant: opts.hasTenant, inTenant: run, inPlatform: run };
}

describe("consumeOnce", () => {
  it("ikinci çağrıda fn çalışmaz; ilkinde sonuç döner", async () => {
    const s = fakeStore();
    const id = randomUUID();
    const fn = vi.fn(() => Promise.resolve("etki"));
    expect(await consumeOnce(s.tx(T1), "c", id, fn)).toEqual({ applied: true, result: "etki" });
    expect(await consumeOnce(s.tx(T1), "c", id, fn)).toEqual({ applied: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("tenant kimliği SQL parametresi değil bağlamdan türer; farklı bağlam ve farklı tüketici ayrı etkidir", async () => {
    const s = fakeStore();
    const id = randomUUID();
    const fn = vi.fn(() => Promise.resolve());
    await consumeOnce(s.tx(T1), "c", id, fn);
    await consumeOnce(s.tx(T2), "c", id, fn);
    await consumeOnce(s.tx(T1), "d", id, fn);
    expect(fn).toHaveBeenCalledTimes(3);
    // INSERT'in tenant_id parametresi bağlam okumasından gelir (kimlik çağıran parametresi değil).
    expect(s.state.statements.filter((q) => /current_setting/i.test(q))).toHaveLength(3);
  });
  it("fn hata fırlatırsa hata aynen yayılır", async () => {
    const s = fakeStore();
    await expect(consumeOnce(s.tx(T1), "c", randomUUID(), () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
  it("geçersiz olay kimliği / tüketici adı VALIDATION_FAILED; veritabanına sorgu gitmez", async () => {
    const s = fakeStore();
    const fn = vi.fn(() => Promise.resolve());
    for (const [consumer, id] of [["c", "not-uuid"], ["", randomUUID()], ["  ", randomUUID()], ["x".repeat(201), randomUUID()]] as const) {
      const err = await consumeOnce(s.tx(T1), consumer, id, fn).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QueueError);
      expect((err as QueueError).code).toBe("VALIDATION_FAILED");
    }
    expect(s.state.statements).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("deliverExternalOnce", () => {
  it("ilk teslimde anahtar = jobId ile çağırır; ikincide çağırmaz", async () => {
    const s = fakeStore();
    const ctx = ctxFor(s, { hasTenant: false, scope: "platform" });
    const call = vi.fn<(k: string) => Promise<void>>().mockResolvedValue(undefined);
    expect(await deliverExternalOnce(ctx, "email.send", call)).toBe(true);
    expect(await deliverExternalOnce(ctx, "email.send", call)).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(ctx.jobId);
  });
  it("çağrı hatasında satır yazılmaz ve hata yayılır", async () => {
    const s = fakeStore();
    const ctx = ctxFor(s, { hasTenant: true, scope: T1 });
    await expect(deliverExternalOnce(ctx, "email.send", () => Promise.reject(new Error("ağ")))).rejects.toThrow("ağ");
    expect(s.rows.size).toBe(0);
  });
  it("çağrı başarılı + satır yazımı başarısız → hata; yeniden teslimde aynı anahtarla yeniden çağrı", async () => {
    const s = fakeStore();
    const ctx = ctxFor(s, { hasTenant: true, scope: T1 });
    const call = vi.fn<(k: string) => Promise<void>>().mockResolvedValue(undefined);
    s.state.failInsert = true;
    await expect(deliverExternalOnce(ctx, "email.send", call)).rejects.toThrow("insert failed");
    s.state.failInsert = false;
    expect(await deliverExternalOnce(ctx, "email.send", call)).toBe(true);
    expect(call.mock.calls.map((c) => c[0])).toEqual([ctx.jobId, ctx.jobId]);
  });
  it("tenant işi inTenant'ı, platform işi inPlatform'u kullanır", async () => {
    const s = fakeStore();
    const t = ctxFor(s, { hasTenant: true, scope: T1 });
    const p = ctxFor(s, { hasTenant: false, scope: "platform" });
    const tSpy = vi.spyOn(t, "inTenant");
    const pSpy = vi.spyOn(p, "inPlatform");
    const tPlat = vi.spyOn(t, "inPlatform");
    await deliverExternalOnce(t, "c", () => Promise.resolve());
    await deliverExternalOnce(p, "c", () => Promise.resolve());
    expect(tSpy).toHaveBeenCalledTimes(2);
    expect(pSpy).toHaveBeenCalledTimes(2);
    expect(tPlat).not.toHaveBeenCalled();
  });
});
