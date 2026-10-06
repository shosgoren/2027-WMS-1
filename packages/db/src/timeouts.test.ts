// setLocalTimeouts birim testi: sahte tx ile SQL biçimi ve doğrulama (ağ yok).
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { TenantTx } from "./client.ts";
import { MAX_TIMEOUT_MS, setLocalTimeouts } from "./timeouts.ts";

function fakeTx() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: vi.fn(async (q: SQL) => {
      const b = new PgDialect().sqlToQuery(q);
      queries.push({ sql: b.sql, params: b.params });
      return [];
    }),
  } as unknown as TenantTx;
  return { tx, queries };
}

describe("setLocalTimeouts", () => {
  it("yalnızca transaction-local set_config (true) ve değerler parametre", async () => {
    const { tx, queries } = fakeTx();
    await setLocalTimeouts(tx, { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toMatch(/set_config\('lock_timeout', \$1, true\).*set_config\('statement_timeout', \$2, true\)/);
    expect(queries[0]?.sql).not.toMatch(/\bSET\s+(LOCAL|SESSION)/i);
    expect(queries[0]?.params).toEqual(["2000ms", "10000ms"]);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1, "5" as unknown as number, undefined as unknown as number])(
    "geçersiz değer %s sorgusuz reddedilir",
    async (bad) => {
      for (const t of [{ lockTimeoutMs: bad, statementTimeoutMs: 1000 }, { lockTimeoutMs: 1000, statementTimeoutMs: bad }]) {
        const { tx, queries } = fakeTx();
        await expect(setLocalTimeouts(tx, t)).rejects.toBeInstanceOf(RangeError);
        expect(queries).toHaveLength(0);
      }
    },
  );
  it("üst sınır dahil kabul edilir", async () => {
    const { tx } = fakeTx();
    await expect(setLocalTimeouts(tx, { lockTimeoutMs: MAX_TIMEOUT_MS, statementTimeoutMs: MAX_TIMEOUT_MS })).resolves.toBeUndefined();
  });
});
