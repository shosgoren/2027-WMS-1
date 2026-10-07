// Adaptör birimi (T-281): iş türü başına `expireInSeconds` tablosu ve süresi dolan iş kurtarma SQL'i. DB'siz; gerçek davranış
// tests/integration/queue/crash-recovery.int.test.ts'te.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { JOB_TYPES } from "@wms/shared/queue";
import { QUEUE_EXPIRE_SECONDS, requeueExpiredJobs, type TenantTx } from "./index.ts";

describe("QUEUE_EXPIRE_SECONDS", () => {
  it("her iş türü için pozitif, açık bir süre tanımlıdır", () => {
    for (const t of JOB_TYPES) expect(QUEUE_EXPIRE_SECONDS[t], t).toBeGreaterThan(0);
    expect(Object.keys(QUEUE_EXPIRE_SECONDS).sort()).toEqual([...JOB_TYPES].sort());
  });

  it("stock.document.post 900 sn kalır (MFA penceresi bu değerden türetilir)", () => {
    expect(QUEUE_EXPIRE_SECONDS["stock.document.post"]).toBe(900);
  });
});

describe("requeueExpiredJobs", () => {
  it("tek, dar UPDATE: yalnızca süresi dolan active satırlar; yalnız state/start_after/completed_on/heartbeat_on/output yazılır", async () => {
    const seen: string[] = [];
    const tx = {
      execute: (q: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        seen.push(new PgDialect().sqlToQuery(q).sql);
        return Promise.resolve([
          { id: "a", type: "email.send", state: "retry" },
          { id: "b", type: "demo.reseed", state: "failed" },
        ]);
      },
    } as unknown as Pick<TenantTx, "execute">;
    const r = await requeueExpiredJobs(tx);
    expect(r).toEqual({ requeued: [{ id: "a", type: "email.send" }], exhausted: [{ id: "b", type: "demo.reseed" }] });
    expect(seen).toHaveLength(1);
    const text = seen[0] as string;
    expect(text).toMatch(/UPDATE "pgboss"\.job/);
    expect(text).toMatch(/WHERE state = 'active' AND \(started_on \+ expire_seconds \* interval '1 second'\) < "pgboss"\.job_now\(\)/);
    expect(text).toMatch(/retry_count < retry_limit/);
    const assigned = text.slice(text.indexOf("job"), text.indexOf(" WHERE ")).split(/\n/).slice(1);
    const written = assigned.map((l) => /^\s*(?:[A-Za-z]+\s+)?(\w+) = /.exec(l)?.[1]).filter((c) => c !== undefined);
    expect(written).toEqual(["state", "start_after", "completed_on", "heartbeat_on", "output"]);
  });
});
