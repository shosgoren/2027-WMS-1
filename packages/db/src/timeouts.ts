// Transaction-local zaman aşımları (T-213 kart eki 1; A-75, ADR-018 §2/§5). Yalnızca `set_config(..., true)` (G-02: oturum düzeyi ayar yok).
// Değerler pozitif tamsayı (ms) ve üst sınırlıdır; doğrulanmamış girdi SQL'e gitmez (değer parametredir).
import { sql } from "drizzle-orm";
import type { TenantTx } from "./client.ts";

/** Üst sınır: 10 dakika (worker belge işleme 120 sn, A-75; daha uzunu yapılandırma hatasıdır). */
export const MAX_TIMEOUT_MS = 600_000;

export interface LocalTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export function assertValidTimeouts(t: LocalTimeouts): void {
  for (const [name, v] of [["lockTimeoutMs", t?.lockTimeoutMs], ["statementTimeoutMs", t?.statementTimeoutMs]] as const) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > MAX_TIMEOUT_MS) {
      throw new RangeError(`${name} must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
    }
  }
}

/** `lock_timeout` ve `statement_timeout` değerlerini bu transaction için kurar. Geçersiz değerde sorgu gönderilmeden `RangeError`. */
export async function setLocalTimeouts(tx: TenantTx, t: LocalTimeouts): Promise<void> {
  assertValidTimeouts(t);
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${`${t.lockTimeoutMs}ms`}, true), set_config('statement_timeout', ${`${t.statementTimeoutMs}ms`}, true)`,
  );
}
