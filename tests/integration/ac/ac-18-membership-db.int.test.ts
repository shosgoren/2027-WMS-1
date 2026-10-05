// AC-18 — bağımsız kabul testi (T-104, qa-verifier). Uygulayıcının T-103 testlerinden bağımsız yazıldı.
// katman: DB — API/dosya/cache/export katmanları T-128, oturum katmanı T-120.
//
// AC-18: "Çıkarılan kullanıcının eski token'ı ile yazma → Ret". DB katmanında karşılığı: üyeliği `REMOVED` (ya da tenant'ı
// `SUSPENDED`/`CLOSING`) olan kullanıcı için `withMembership` + yazma reddedilir ve yazma KALICI OLMAZ; eşzamanlı çıkarma
// ile yazma yarışında çıkarma commit'i yazma transaction'ının doğrulamasından önceyse yazma reddedilir.
//
// Uygulama tarafı yalnızca DATABASE_URL (wms_app, PgBouncer transaction mode) üzerinden `withMembership`. Migration rolü
// (DATABASE_URL_DIRECT) yalnızca durum değişikliği (ayrı bağlantı / ayrı transaction) ve doğrulama okumaları içindir.
// Yarışlar GERÇEK paralel bağlantılarla; beklemeler `pg_blocking_pids` ile KANITLANIR (zamanlamaya güvenilmez).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { MembershipError, createDbClient, withMembership } from "../../../packages/db/src/index.ts";
import type { DbClient } from "../../../packages/db/src/client.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";

const env = readIntEnv(process.env);
const urls = [env.databaseUrl, env.databaseUrlDirect];
const reg = newRegistry();
const open: pg.Client[] = [];
let admin: pg.Client;
let client: DbClient;
let worldSeq = 0;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, urls)}`);
  }
  open.push(c);
  return c;
}

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  client = createDbClient({ url: env.databaseUrl, poolMax: 8, prepare: false });
}, 60_000);

afterAll(async () => {
  try {
    await client?.close();
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(open.map((c) => c.end().catch(() => undefined)));
  }
});

const newWorld = (): Promise<TenantWorld> => seedWorld(admin, reg, `W${++worldSeq}`);

/** withMembership altında tenant_settings.terminology'ye `key` işaretini yazar. `ran`: callback çalıştı mı. */
async function writeMarker(w: TenantWorld, userId: string, key: string, hooks?: { afterWrite?: (pid: number) => Promise<void> }): Promise<{ ran: boolean }> {
  const out = { ran: false };
  await withMembership({ client, userId, tenantId: w.tenantId }, async (tx) => {
    out.ran = true;
    const r = await tx.execute(
      sql`UPDATE public.tenant_settings SET terminology = terminology || jsonb_build_object(${key}::text, true) WHERE tenant_id = ${w.tenantId}::uuid RETURNING tenant_id`,
    );
    if (r.length !== 1) throw new Error(`beklenen 1 satır, ${r.length}`);
    if (hooks?.afterWrite !== undefined) {
      const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      await hooks.afterWrite(Number(pid[0]?.pid));
    }
  });
  return out;
}

async function markers(w: TenantWorld): Promise<string[]> {
  const r = await admin.query<{ k: string[] }>("SELECT array(SELECT jsonb_object_keys(terminology) ORDER BY 1) AS k FROM public.tenant_settings WHERE tenant_id = $1", [w.tenantId]);
  return r.rows[0]?.k ?? [];
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function expectMembershipError(e: unknown, code: string): void {
  expect(e, `MembershipError(${code}) beklenir`).toBeInstanceOf(MembershipError);
  expect((e as MembershipError).code).toBe(code);
}

async function poll(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`zaman asimi: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitUntilBlockedBy(blockerPid: number): Promise<void> {
  const watcher = await connect(env.databaseUrlDirect);
  try {
    await poll(`backend ${blockerPid} bir sorguyu bekletmiyor`, async () => {
      const r = await watcher.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blockerPid]);
      return Number(r.rows[0]?.n) > 0;
    });
  } finally {
    await watcher.end();
  }
}

const setMembershipRemoved = (c: pg.Client, w: TenantWorld): Promise<unknown> =>
  c.query("UPDATE public.tenant_memberships SET status = 'REMOVED', removed_at = now() WHERE id = $1", [w.memberMembershipId]);
const setTenantStatus = (c: pg.Client, w: TenantWorld, status: string): Promise<unknown> =>
  c.query("UPDATE public.tenants SET status = $2 WHERE id = $1", [w.tenantId, status]);

describe("AC-18 DB — çıkarılmış üyelik / askıdaki tenant yazamaz", () => {
  it("@AC-18 kontrol: ACTIVE üye withMembership ile yazar ve yazma kalıcıdır", async () => {
    const w = await newWorld();
    const r = await writeMarker(w, w.memberUserId, "control");
    expect(r.ran).toBe(true);
    expect(await markers(w)).toEqual(["control"]);
  });

  it("@AC-18 üyelik REMOVED (ayrı transaction, commit) → withMembership + yazma FORBIDDEN; callback çalışmaz; yazma kalıcı değil", async () => {
    const w = await newWorld();
    await setMembershipRemoved(admin, w);
    const out = { ran: false };
    const e = await rejection(
      writeMarker(w, w.memberUserId, "after-removal").then((r) => {
        out.ran = r.ran;
      }),
    );
    expectMembershipError(e, "FORBIDDEN");
    expect(out.ran).toBe(false);
    expect(await markers(w)).toEqual([]);
    // Başka üye (sahip) etkilenmez: reddin nedeni yalnızca çıkarılan üyelik.
    expect((await writeMarker(w, w.ownerUserId, "owner-ok")).ran).toBe(true);
    expect(await markers(w)).toEqual(["owner-ok"]);
  });

  it("@AC-18 REMOVED üyelik: birden çok eşzamanlı yazma denemesinin hepsi FORBIDDEN, hiçbiri kalıcı değil", async () => {
    const w = await newWorld();
    await setMembershipRemoved(admin, w);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => rejection(writeMarker(w, w.memberUserId, `burst-${i}`))));
    for (const e of results) expectMembershipError(e, "FORBIDDEN");
    expect(await markers(w)).toEqual([]);
  });

  it("@AC-18 tenant SUSPENDED → TENANT_SUSPENDED; CLOSING → TENANT_CLOSING; yazma kalıcı değil; ACTIVE'e dönünce yazılır", async () => {
    const w = await newWorld();
    await setTenantStatus(admin, w, "SUSPENDED");
    expectMembershipError(await rejection(writeMarker(w, w.memberUserId, "suspended")), "TENANT_SUSPENDED");
    expectMembershipError(await rejection(writeMarker(w, w.ownerUserId, "suspended-owner")), "TENANT_SUSPENDED");
    await setTenantStatus(admin, w, "CLOSING");
    expectMembershipError(await rejection(writeMarker(w, w.memberUserId, "closing")), "TENANT_CLOSING");
    expect(await markers(w)).toEqual([]);
    await setTenantStatus(admin, w, "ACTIVE");
    expect((await writeMarker(w, w.memberUserId, "reactivated")).ran).toBe(true);
    expect(await markers(w)).toEqual(["reactivated"]);
  });

  it("@AC-18 başka tenant'ın üyesi (B üyesi, A için) ve hiç üyeliği olmayan kullanıcı → FORBIDDEN", async () => {
    const a = await newWorld();
    const b = await newWorld();
    expectMembershipError(await rejection(writeMarker(a, b.ownerUserId, "cross")), "FORBIDDEN");
    expectMembershipError(await rejection(writeMarker(a, "00000000-0000-4000-8000-0000000000aa", "ghost")), "FORBIDDEN");
    expect(await markers(a)).toEqual([]);
    expect(await markers(b)).toEqual([]);
  });

  it("@AC-18 yarış: çıkarma açık transaction'da (commit öncesi) → yazma bekler (kanıtlı); çıkarma commit → yazma FORBIDDEN, kalıcı değil", async () => {
    const w = await newWorld();
    const remover = await connect(env.databaseUrlDirect);
    await remover.query("BEGIN");
    try {
      await setMembershipRemoved(remover, w);
      const pid = Number((await remover.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const writer = rejection(writeMarker(w, w.memberUserId, "raced"));
      await waitUntilBlockedBy(pid); // yazma, çıkarmanın commit'ini bekliyor
      await remover.query("COMMIT");
      expectMembershipError(await writer, "FORBIDDEN");
    } finally {
      await remover.query("ROLLBACK").catch(() => undefined);
    }
    expect(await markers(w)).toEqual([]);
  });

  it("@AC-18 yarış: tenant askıya alma açık transaction'da → yazma bekler (kanıtlı); commit → TENANT_SUSPENDED, kalıcı değil", async () => {
    const w = await newWorld();
    const suspender = await connect(env.databaseUrlDirect);
    await suspender.query("BEGIN");
    try {
      await setTenantStatus(suspender, w, "SUSPENDED");
      const pid = Number((await suspender.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const writer = rejection(writeMarker(w, w.memberUserId, "raced-suspend"));
      await waitUntilBlockedBy(pid);
      await suspender.query("COMMIT");
      expectMembershipError(await writer, "TENANT_SUSPENDED");
    } finally {
      await suspender.query("ROLLBACK").catch(() => undefined);
    }
    expect(await markers(w)).toEqual([]);
  });

  it("@AC-18 yarış (ters sıra): yazma önce doğrulamayı geçip transaction'ı açık tutar → çıkarma bekler (kanıtlı); yazma kalıcı olur; sonraki yazma FORBIDDEN", async () => {
    const w = await newWorld();
    const remover = await connect(env.databaseUrlDirect);
    let removal: Promise<unknown> | undefined;
    const writer = writeMarker(w, w.memberUserId, "before-removal", {
      afterWrite: async (writerPid) => {
        removal = setMembershipRemoved(remover, w);
        await waitUntilBlockedBy(writerPid); // çıkarma, yazma transaction'ının bitmesini bekliyor
      },
    });
    expect((await writer).ran).toBe(true);
    await removal;
    expect(await markers(w)).toEqual(["before-removal"]);
    expectMembershipError(await rejection(writeMarker(w, w.memberUserId, "after-removal")), "FORBIDDEN");
    expect(await markers(w)).toEqual(["before-removal"]);
  });

  it("@AC-18 yarış: eşzamanlı çıkarma + 16 yazıcı → her sonuç ya başarı ya FORBIDDEN; kalıcı işaretler tam olarak başarılar; çıkarma sonrası yazma yok", async () => {
    const w = await newWorld();
    const remover = await connect(env.databaseUrlDirect);
    const writers = Array.from({ length: 16 }, (_, i) =>
      writeMarker(w, w.memberUserId, `w${i}`).then(
        () => ({ i, ok: true as const }),
        (e: unknown) => ({ i, ok: false as const, e }),
      ),
    );
    const removal = setMembershipRemoved(remover, w);
    const results = await Promise.all([...writers, removal.then(() => undefined)]);
    const outcomes = results.filter((r): r is { i: number; ok: true } | { i: number; ok: false; e: unknown } => r !== undefined);
    const succeeded = outcomes.filter((o) => o.ok).map((o) => `w${o.i}`).sort();
    for (const o of outcomes) {
      if (!o.ok) expectMembershipError(o.e, "FORBIDDEN");
    }
    expect(await markers(w)).toEqual(succeeded);
    // Çıkarma commit edildi: bundan sonra hiçbir yazma geçmez.
    const late = await Promise.all(Array.from({ length: 8 }, (_, i) => rejection(writeMarker(w, w.memberUserId, `late${i}`))));
    for (const e of late) expectMembershipError(e, "FORBIDDEN");
    expect(await markers(w)).toEqual(succeeded);
  });
});
