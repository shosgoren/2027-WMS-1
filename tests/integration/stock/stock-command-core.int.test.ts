// T-213: stok komutu çekirdeği (executeStockCommand, idempotency, yeniden deneme, zaman aşımı, belge yaşam döngüsü, numaralama).
// GERÇEK roller: uygulama tarafı yalnızca DATABASE_URL (wms_app, pooler); migration rolü (DATABASE_URL_DIRECT) yalnızca fikstür/engelleyici içindir.
// Fikstürler sentetiktir (G-09). audit_logs değişmez olduğundan test tenant'ları geçici Testcontainers ortamında kalır.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  EMPTY_LOCK_PLAN,
  FeatureDisabledError,
  approveDocument,
  assertNotProcessing,
  cancelDocument,
  createStockDocument,
  executeStockCommand,
  requestHash,
  sqlstateOf,
  updateDraft,
  type DocumentLineInput,
  type StockCommandApplied,
  type StockCommandOutcome,
  type StockCommandPlan,
  type StockCommandResult,
  type StockDocCallParams,
  type StockTimeouts,
} from "../../../packages/domain/src/stock/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let blocker: pg.Client;
let appPg: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let counterUserId: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const uuid = (): string => randomUUID();

const ownerP = (w: TenantWorld, clientKey: string | null = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: w.ownerUserId, mfaVerified: true },
  tenantSlug: w.slug,
  clientKey,
  retry: NO_WAIT,
});
const pickerP = (w: TenantWorld, clientKey: string = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: w.memberUserId, mfaVerified: true },
  tenantSlug: w.slug,
  clientKey,
  retry: NO_WAIT,
});
const counterP = (w: TenantWorld, clientKey: string = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId: counterUserId, mfaVerified: true },
  tenantSlug: w.slug,
  clientKey,
  retry: NO_WAIT,
});

const line = (w: TenantWorld, over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId: w.itemNoneId,
  unitId: w.unitId,
  quantity: "5",
  conversionFactor: "1",
  baseQuantity: "5",
  targetLocationId: w.rootLocationId,
  ...over,
});

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(sqlText, params)).rows;
}
const count = async (sqlText: string, params: unknown[]): Promise<number> => Number((await q<{ n: string }>(sqlText, params))[0]?.n);
const auditCount = (w: TenantWorld, action: string, entityId: string): Promise<number> =>
  count("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = $2 AND entity_id = $3", [w.tenantId, action, entityId]);
const idemRows = (w: TenantWorld, key: string) =>
  q<{ status: string; error_code: string | null; actor_user_id: string }>(
    "SELECT status, error_code, actor_user_id FROM public.idempotency_records WHERE tenant_id = $1 AND client_key = $2",
    [w.tenantId, key],
  );
const docRow = async (id: string) =>
  (await q<{ status: string; version: number; number: string | null; business_date: string; posting_job_id: string | null }>(
    "SELECT status, version, number, business_date::text AS business_date, posting_job_id FROM public.documents WHERE id = $1",
    [id],
  ))[0] as { status: string; version: number; number: string | null; business_date: string; posting_job_id: string | null };

/** Test komutu: gerçek yürütücü, serbest plan/apply. */
function cmd<I>(
  w: TenantWorld,
  o: {
    key: string | undefined;
    input: I;
    userId?: string;
    commandType?: string;
    permission?: "document.create" | "document.approve" | "stock.post";
    plan?: () => Promise<StockCommandPlan>;
    apply?: () => Promise<StockCommandApplied>;
    timeouts?: StockTimeouts;
    logger?: { info(m: string, f?: Record<string, unknown>): void; error(m: string, f?: Record<string, unknown>): void };
  },
): Promise<StockCommandOutcome> {
  return executeStockCommand<I>({
    db: app,
    principal: { userId: o.userId ?? w.ownerUserId, mfaVerified: true },
    tenantSlug: w.slug,
    commandType: o.commandType ?? "test.stock.noop",
    clientKey: o.key,
    input: o.input,
    permission: o.permission ?? "document.create",
    plan: o.plan ?? (async () => ({ warehouseIds: [w.warehouseId], locks: EMPTY_LOCK_PLAN })),
    apply: async () => (o.apply ?? (async () => ({ result: {}, audit: null })))(),
    retry: NO_WAIT,
    ...(o.timeouts === undefined ? {} : { timeouts: o.timeouts }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
}

/** İşlenmiş (POSTED) belge: DRAFT belge + numara/durum adımı (executeStockCommand numaralama yolu). */
async function mkPostedDoc(w: TenantWorld): Promise<string> {
  const created = await createStockDocument(ownerP(w), { kind: "STOCK_IN", warehouseId: w.warehouseId, lines: [line(w)] });
  const documentId = created.documentId as string;
  const header = await docRow(documentId);
  const out = await executeStockCommand({
    db: app,
    principal: { userId: w.ownerUserId, mfaVerified: true },
    tenantSlug: w.slug,
    commandType: "test.stock.post",
    clientKey: uuid(),
    input: { documentId },
    permission: "stock.post",
    plan: async () => ({ warehouseIds: [w.warehouseId], locks: { ...EMPTY_LOCK_PLAN, document: { id: documentId, expectedVersion: header.version } } }),
    apply: async () => ({
      result: { documentId, status: "POSTED" },
      audit: null,
      numbering: { documentId, kind: "STOCK_IN", businessDate: header.business_date, status: "POSTED" },
    }),
    retry: NO_WAIT,
  });
  expect(out.status).toBe("COMPLETED");
  return documentId;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  blocker = new pg.Client({ connectionString: env.databaseUrlDirect });
  blocker.on("error", () => undefined);
  await blocker.connect();
  appPg = new pg.Client({ connectionString: env.databaseUrl });
  appPg.on("error", () => undefined);
  await appPg.connect();
  A = await seedWorld(adm, reg, "A213");
  B = await seedWorld(adm, reg, "B213");
  counterUserId = await mkUser(adm, reg, "A213 counter");
  await mkMembership(adm, A.tenantId, counterUserId, { roles: ["COUNTER"] });
}, 120_000);

afterEach(async () => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
  delete process.env.STOCK_SERIAL_LOCK_ENABLED;
  await blocker.query("ROLLBACK").catch(() => undefined);
  await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = $1", [A.tenantId]);
});

afterAll(async () => {
  await blocker.end();
  await appPg.end();
  await adm.end();
  await app.close();
}, 60_000);

/** Migration rolüyle, tenant bağlamlı, COMMIT edilmeyen idempotency satırı (ilk isteğin uçuştaki hâli). */
async function holdInFlightKey(w: TenantWorld, commandType: string, clientKey: string): Promise<void> {
  await blocker.query("BEGIN");
  await blocker.query("SELECT set_config('app.current_tenant_id', $1, true)", [w.tenantId]);
  await blocker.query(
    "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash) VALUES ($1, $2, $3, $4, $5)",
    [w.tenantId, commandType, clientKey, w.ownerUserId, "a".repeat(64)],
  );
}

describe("idempotency (I-06, ADR-018 §2-§3)", () => {
  it("aynı anahtar + aynı içerik → aynı sonuç, ikinci audit ve ikinci belge yok", async () => {
    const key = uuid();
    const input = { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] } as const;
    const first = await createStockDocument(ownerP(A, key), input);
    const second = await createStockDocument(ownerP(A, key), input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.documentId).toBe(first.documentId);
    expect(second.lines).toEqual(first.lines);
    expect(await auditCount(A, "stock_document.created", first.documentId as string)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM public.documents WHERE tenant_id = $1 AND id = $2", [A.tenantId, first.documentId])).toBe(1);
    expect(await idemRows(A, key)).toEqual([{ status: "COMPLETED", error_code: null, actor_user_id: A.ownerUserId }]);
  });

  it("aynı anahtar + farklı içerik → IDEMPOTENCY_MISMATCH, yeni belge yok", async () => {
    const key = uuid();
    await createStockDocument(ownerP(A, key), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const before = await count("SELECT count(*) AS n FROM public.documents WHERE tenant_id = $1", [A.tenantId]);
    const e = await failure(createStockDocument(ownerP(A, key), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { quantity: "6", baseQuantity: "6" })] }));
    expect(e.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(e.httpStatus).toBe(409);
    expect(await count("SELECT count(*) AS n FROM public.documents WHERE tenant_id = $1", [A.tenantId])).toBe(before);
  });

  it("aynı anahtar başka kullanıcı → IDEMPOTENCY_MISMATCH ve yanıtta saklı sonuç yok", async () => {
    const key = uuid();
    const input = { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] } as const;
    const first = await createStockDocument(ownerP(A, key), input);
    const e = await failure(createStockDocument(counterP(A, key), input));
    expect(e.code).toBe("IDEMPOTENCY_MISMATCH");
    const body = JSON.stringify(e.toBody());
    expect(body).not.toContain(first.documentId as string);
    expect(e).not.toHaveProperty("result");
    expect((await idemRows(A, key))[0]?.actor_user_id).toBe(A.ownerUserId);
  });

  it("reddedilen istek aynı anahtar + aynı içerikle tekrar → aynı ret kodu (stok sonradan yeterli olsa bile); düzeltilmiş içerik aynı anahtarla → IDEMPOTENCY_MISMATCH", async () => {
    const key = uuid();
    let enough = false;
    let applied = 0;
    const apply = async (): Promise<StockCommandApplied> => {
      applied++;
      if (!enough) throw new AppError("INSUFFICIENT_STOCK");
      return { result: {}, audit: null };
    };
    const e1 = await failure(cmd(A, { key, input: { qty: "5" }, apply }));
    expect(e1.code).toBe("INSUFFICIENT_STOCK");
    expect(await idemRows(A, key)).toEqual([{ status: "REJECTED", error_code: "INSUFFICIENT_STOCK", actor_user_id: A.ownerUserId }]);
    enough = true;
    const e2 = await failure(cmd(A, { key, input: { qty: "5" }, apply }));
    expect(e2.code).toBe("INSUFFICIENT_STOCK");
    expect(applied).toBe(1); // tekrar apply'a hiç ulaşmadı
    const e3 = await failure(cmd(A, { key, input: { qty: "4" }, apply }));
    expect(e3.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await idemRows(A, key)).toHaveLength(1);
    // Yeni anahtarla düzeltilmiş istek başarılı.
    expect((await cmd(A, { key: uuid(), input: { qty: "4" }, apply })).status).toBe("COMPLETED");
  });

  it("ret ayrıntısı (VALIDATION_FAILED/DOCUMENT_STATE) saklanır ve tekrarda aynen döner", async () => {
    const key = uuid();
    const apply = async (): Promise<StockCommandApplied> => {
      throw new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
    };
    const e1 = await failure(cmd(A, { key, input: { a: 1 }, apply }));
    const e2 = await failure(cmd(A, { key, input: { a: 1 }, apply: async () => ({ result: {}, audit: null }) }));
    expect([e1.code, e1.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_STATE"]);
    expect([e2.code, e2.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_STATE"]);
    expect((await idemRows(A, key))[0]?.error_code).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
  });

  it("VERSION_CONFLICT tükenmesinden sonra aynı anahtar yeniden denenir (geçici hata kaydedilmez)", async () => {
    const key = uuid();
    let calls = 0;
    const flaky = async (): Promise<StockCommandApplied> => {
      calls++;
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    };
    const e = await failure(cmd(A, { key, input: { n: 1 }, apply: flaky }));
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(e.retryable).toBe(true);
    expect(calls).toBe(3); // en çok 3 deneme (A-75)
    expect(await idemRows(A, key)).toHaveLength(0);
    const ok = await cmd(A, { key, input: { n: 1 } });
    expect(ok).toMatchObject({ status: "COMPLETED", replayed: false });
    expect((await idemRows(A, key))[0]?.status).toBe("COMPLETED");
  });

  it("anahtarsız → VALIDATION_FAILED/IDEMPOTENCY_KEY_REQUIRED (veritabanına gitmeden)", async () => {
    const e = await failure(createStockDocument(ownerP(A, null), { kind: "STOCK_IN", warehouseId: A.warehouseId }));
    expect([e.code, e.detail]).toEqual(["VALIDATION_FAILED", "IDEMPOTENCY_KEY_REQUIRED"]);
    const e2 = await failure(cmd(A, { key: undefined, input: {} }));
    expect(e2.detail).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("eşzamanlı 10 aynı istek → tek kayıt, tek audit, aynı sonuç", async () => {
    const key = uuid();
    const input = { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] } as const;
    const results = await Promise.all(Array.from({ length: 10 }, () => createStockDocument(ownerP(A, key), input)));
    const ids = new Set(results.map((r) => r.documentId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const id = [...ids][0] as string;
    expect(await auditCount(A, "stock_document.created", id)).toBe(1);
    expect(await idemRows(A, key)).toHaveLength(1);
    expect(await count("SELECT count(*) AS n FROM public.document_lines WHERE tenant_id = $1 AND document_id = $2", [A.tenantId, id])).toBe(1);
  });

  it("aynı anahtarlı ilk istek (uçuşta) kilit beklerken ikincisi lock_timeout ile sınırlı: sınırsız bekleme yok; ilk istek bitince aynı anahtar çalışır", async () => {
    const key = uuid();
    await holdInFlightKey(A, "test.stock.inflight", key);
    const started = Date.now();
    const e = await failure(cmd(A, { key, commandType: "test.stock.inflight", input: { a: 1 }, timeouts: { lockTimeoutMs: 300, statementTimeoutMs: 10_000 } }));
    const elapsed = Date.now() - started;
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(e.retryable).toBe(true);
    expect(sqlstateOf(e)).toBe("55P03");
    // 3 deneme × ~300 ms (+ bağlantı/çözümleme); engelleyici hâlâ açıkken döndü.
    expect(elapsed).toBeLessThan(15_000);
    await blocker.query("ROLLBACK");
    expect((await cmd(A, { key, commandType: "test.stock.inflight", input: { a: 1 } })).status).toBe("COMPLETED");
  });

  it("COMMIT edilmiş IN_PROGRESS kayıt (aynı aktör + özet) → işleniyor, yeniden yazım yok", async () => {
    const key = uuid();
    const input = { doc: "x" };
    await adm.query("BEGIN");
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    await adm.query(
      "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash) VALUES ($1, 'test.stock.noop', $2, $3, $4)",
      [A.tenantId, key, A.ownerUserId, requestHash(input)],
    );
    await adm.query("COMMIT");
    let applied = 0;
    const out = await cmd(A, { key, input, apply: async () => (applied++, { result: {}, audit: null }) });
    expect(out.status).toBe("IN_PROGRESS");
    expect(applied).toBe(0);
  });

  it("ret kaydı yazılamazsa asıl ret döner ve hata loglanır (yutulmaz)", async () => {
    const key = uuid();
    await holdInFlightKey(A, "test.stock.noop", key); // ret kaydının INSERT'i bu satırı bekler → lock_timeout
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const e = await failure(
      cmd(A, {
        key,
        input: { a: 1 },
        plan: async () => {
          throw new AppError("VALIDATION_FAILED"); // idempotency adımından ÖNCE iş kuralı reddi
        },
        timeouts: { lockTimeoutMs: 300, statementTimeoutMs: 10_000 },
        logger: { info: () => undefined, error: (msg, fields) => void logs.push({ msg, ...(fields === undefined ? {} : { fields }) }) },
      }),
    );
    expect(e.code).toBe("VALIDATION_FAILED"); // asıl ret
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe("stock.command.reject_record_failed");
    expect(logs[0]?.fields).toMatchObject({ errorCode: "VALIDATION_FAILED", sqlstate: "55P03" });
  });

  it("yetki reddi (PICKER, document.create yok) → FORBIDDEN ve kaydedilmez", async () => {
    const key = uuid();
    const e = await failure(createStockDocument(pickerP(A, key), { kind: "STOCK_IN", warehouseId: A.warehouseId }));
    expect(e.code).toBe("FORBIDDEN");
    expect(await idemRows(A, key)).toHaveLength(0);
    const e2 = await failure(approveDocument(counterP(A), { documentId: uuid(), expectedVersion: 1 })); // COUNTER: document.approve yok
    expect(e2.code).toBe("FORBIDDEN");
  });

  it("depo kapsamı: kapsam dışı depo → FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE (idempotency'den ÖNCE), kayıt yok", async () => {
    const w2 = uuid();
    await adm.query("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, 'D2-213', 'Depo 2')", [A.tenantId, w2]);
    const membership = (await q<{ id: string }>("SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [A.tenantId, counterUserId]))[0] as { id: string };
    await adm.query("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [A.tenantId, membership.id, w2]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const key = uuid();
    const e = await failure(createStockDocument(counterP(A, key), { kind: "STOCK_IN", warehouseId: A.warehouseId }));
    expect([e.code, e.detail]).toEqual(["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"]);
    expect(await idemRows(A, key)).toHaveLength(0);
    await expect(createStockDocument(counterP(A), { kind: "STOCK_IN", warehouseId: w2 })).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("zaman aşımları withMembership'ten hemen sonra, plan'dan ÖNCE kurulur (A-75: 2 sn / 10 sn) ve transaction-local", async () => {
    let seenInPlan: Record<string, string> | undefined;
    let seenInApply: Record<string, string> | undefined;
    const out = await executeStockCommand({
      db: app,
      principal: { userId: A.ownerUserId, mfaVerified: true },
      tenantSlug: A.slug,
      commandType: "test.stock.timeouts",
      clientKey: uuid(),
      input: {},
      permission: "document.create",
      plan: async (tx) => {
        const rows = (await tx.execute("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s")) as unknown as { l: string; s: string }[];
        seenInPlan = rows[0];
        return { warehouseIds: [A.warehouseId], locks: EMPTY_LOCK_PLAN };
      },
      apply: async (tx) => {
        const rows = (await tx.execute("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s")) as unknown as { l: string; s: string }[];
        seenInApply = rows[0];
        return { result: {}, audit: null };
      },
      retry: NO_WAIT,
    });
    expect(out.status).toBe("COMPLETED");
    expect(seenInPlan).toEqual({ l: "2s", s: "10s" });
    expect(seenInApply).toEqual({ l: "2s", s: "10s" });
  });
});

describe("özellik bayrağı, hata eşlemesi, ürün durumu", () => {
  it("seri planı kapalı bayrakta reddedilir; serisiz yeniden deneme YOK (plan tek kez, apply hiç); 'özellik kapalı' ayrı mesaj; kaydedilmez", async () => {
    delete process.env.STOCK_SERIAL_LOCK_ENABLED;
    const key = uuid();
    let plans = 0;
    let applies = 0;
    const e = await failure(
      cmd(A, {
        key,
        input: { s: 1 },
        plan: async () => {
          plans++;
          return { warehouseIds: [A.warehouseId], locks: { ...EMPTY_LOCK_PLAN, serialIds: [A.serialId] } };
        },
        apply: async () => (applies++, { result: {}, audit: null }),
      }),
    );
    expect(e).toBeInstanceOf(FeatureDisabledError);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toBe("FEATURE_DISABLED");
    expect(e.messageKey).toBe("errors.validation_failed.feature_disabled");
    expect(e.messageKey).not.toBe(new AppError("VALIDATION_FAILED").messageKey);
    expect(plans).toBe(1);
    expect(applies).toBe(0);
    expect(await idemRows(A, key)).toHaveLength(0);
  });

  it("T-256: bayrak açıkken aynı seriyi isteyen eşzamanlı komutlar 30 turda yeniden denemesiz (retry sayacı 0, 40P01 yok) tamamlanır", async () => {
    const old = process.env.STOCK_SERIAL_LOCK_ENABLED;
    process.env.STOCK_SERIAL_LOCK_ENABLED = "true";
    const retries: unknown[] = [];
    const logger = { info: (m: string, f?: Record<string, unknown>) => void (m === "stock.command.retry" && retries.push(f)), error: () => undefined };
    try {
      for (let round = 0; round < 30; round++) {
        const locationId = uuid();
        await adm.query("BEGIN");
        try {
          await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
          await adm.query("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, $4, 'T256 tur', 0, 'STORAGE')", [
            A.tenantId,
            locationId,
            A.warehouseId,
            `T256-${locationId.slice(0, 8)}`,
          ]);
          await adm.query("COMMIT");
        } catch (e) {
          await adm.query("ROLLBACK");
          throw e;
        }
        const one = (stockStatus: "AVAILABLE" | "QUARANTINE") =>
          cmd(A, {
            key: uuid(),
            input: { round, stockStatus },
            logger,
            plan: async () => ({
              warehouseIds: [A.warehouseId],
              locks: { ...EMPTY_LOCK_PLAN, locationIds: [locationId], dimensions: [{ ...dim(A.itemId, locationId, { lotId: A.lotId, serialId: A.serialId }), stockStatus }], serialIds: [A.serialId] },
            }),
          });
        const outcomes = await Promise.all([one("AVAILABLE"), one("QUARANTINE")]);
        expect(outcomes.map((o) => o.status)).toEqual(["COMPLETED", "COMPLETED"]);
      }
      expect(retries).toHaveLength(0);
    } finally {
      if (old === undefined) delete process.env.STOCK_SERIAL_LOCK_ENABLED;
      else process.env.STOCK_SERIAL_LOCK_ENABLED = old;
    }
  }, 120_000);

  it("TRACKING_VIOLATION (23514, ensureDimensions) → AppError TRACKING_VIOLATION 422 ve kalıcı ret", async () => {
    const key = uuid();
    const plan = async (): Promise<StockCommandPlan> => ({
      warehouseIds: [A.warehouseId],
      // LOT_AND_SERIAL ürüne lot/seri verilmez → boyut tetikleyicisi 23514.
      locks: { ...EMPTY_LOCK_PLAN, locationIds: [A.rootLocationId], dimensions: [dim(A.itemId, A.rootLocationId)] },
    });
    const e = await failure(cmd(A, { key, input: { t: 1 }, plan }));
    expect(e.code).toBe("TRACKING_VIOLATION");
    expect(e.httpStatus).toBe(422);
    expect(sqlstateOf(e)).toBe("23514");
    expect((await idemRows(A, key))[0]).toMatchObject({ status: "REJECTED", error_code: "TRACKING_VIOLATION" });
    const again = await failure(cmd(A, { key, input: { t: 1 }, plan }));
    expect(again.code).toBe("TRACKING_VIOLATION");
  });

  it("bileşik FK ihlali (23503, ensureDimensions) → NOT_FOUND ve kaydedilmez", async () => {
    const key = uuid();
    const e = await failure(
      cmd(A, {
        key,
        input: { f: 1 },
        plan: async () => ({
          warehouseIds: [A.warehouseId],
          locks: { ...EMPTY_LOCK_PLAN, locationIds: [A.rootLocationId], dimensions: [dim(A.itemNoneId, A.rootLocationId, { inventoryOwnerId: uuid() })] },
        }),
      }),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(sqlstateOf(e)).toBe("23503");
    expect(await idemRows(A, key)).toHaveLength(0);
  });

  it("ARCHIVED ürün satırı reddedilir (FOR SHARE + ACTIVE denetimi); ACTIVE ürün kabul", async () => {
    const archived = uuid();
    await adm.query(
      "INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, status, archived_at) VALUES ($1, $2, $3, 'Arsiv', $4, 'NONE', 'ARCHIVED', now())",
      [A.tenantId, archived, `ARC-${archived.slice(0, 6)}`, A.unitId],
    );
    const e = await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { itemId: archived })] }));
    expect(e.code).toBe("VALIDATION_FAILED");
    await expect(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] })).resolves.toMatchObject({ status: "DRAFT" });
    // Mevcut olmayan ürün → NOT_FOUND
    expect((await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { itemId: uuid() })] }))).code).toBe("NOT_FOUND");
  });

  it("türetilen sütunlar: açık sütun listeli yazımlar wms_app ile 42501 vermez; varsayılan sütunları listeleyen INSERT (Drizzle insert() biçimi) 42501 verir", async () => {
    const created = await createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A), line(A, { quantity: "2", baseQuantity: "2" })] });
    const history = await q<{ to_status: string; created_xid: string | null; occurred_at: string | null }>(
      "SELECT to_status, created_xid::text AS created_xid, occurred_at::text AS occurred_at FROM public.document_status_history WHERE tenant_id = $1 AND document_id = $2",
      [A.tenantId, created.documentId],
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.to_status).toBe("DRAFT");
    expect(history[0]?.created_xid).not.toBeNull(); // sunucu türetimli (tetikleyici)
    expect(history[0]?.occurred_at).not.toBeNull();
    expect(created.lines).toHaveLength(2);

    await appPg.query("BEGIN");
    try {
      await appPg.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await appPg.query("SAVEPOINT s1");
      let state: string | undefined;
      try {
        await appPg.query(
          "INSERT INTO public.idempotency_records (tenant_id, command_type, client_key, actor_user_id, request_hash, created_at) VALUES ($1, 'x.derived', $2, $3, $4, DEFAULT)",
          [A.tenantId, uuid(), A.ownerUserId, "b".repeat(64)],
        );
      } catch (e) {
        state = (e as { code?: string }).code;
      }
      expect(state).toBe("42501");
    } finally {
      await appPg.query("ROLLBACK");
    }
  });
});

const dim = (itemId: string, locationId: string, over: Partial<{ lotId: string | null; serialId: string | null; inventoryOwnerId: string | null; handlingUnitId: string | null }> = {}) => ({
  itemId,
  locationId,
  lotId: null,
  serialId: null,
  stockStatus: "AVAILABLE" as const,
  inventoryOwnerId: null,
  handlingUnitId: null,
  ...over,
});

describe("belge yaşam döngüsü (DRAFT → APPROVED → POSTED | CANCELLED)", () => {
  it("oluştur → güncelle (sürüm) → onayla → iptal; her geçiş durum geçmişi + audit; tür sürümü v1 sistem kimliği (I-11, A-79)", async () => {
    const created = await createStockDocument(ownerP(A), { kind: "STOCK_MOVE", warehouseId: A.warehouseId, reason: "ilk", lines: [line(A, { sourceLocationId: A.childLocationId })] });
    const id = created.documentId as string;
    const row0 = await docRow(id);
    expect(row0).toMatchObject({ status: "DRAFT", version: 1, number: null });
    const tv = await q<{ tenant_id: string | null; key: string; version: number }>(
      "SELECT v.tenant_id, v.key, v.version FROM public.documents d JOIN public.document_type_versions v ON v.id = d.type_version_id WHERE d.id = $1",
      [id],
    );
    expect(tv[0]).toMatchObject({ tenant_id: null, key: "STOCK_MOVE", version: 1 });

    const upd = await updateDraft(ownerP(A), { documentId: id, expectedVersion: 1, reason: "ikinci", lines: [line(A), line(A, { quantity: "3", baseQuantity: "3" })] });
    expect(upd.lines).toHaveLength(2);
    expect((await docRow(id)).version).toBe(2);
    expect(await count("SELECT count(*) AS n FROM public.document_lines WHERE tenant_id = $1 AND document_id = $2", [A.tenantId, id])).toBe(2);

    const stale = await failure(updateDraft(ownerP(A), { documentId: id, expectedVersion: 1, reason: "x" }));
    expect(stale.code).toBe("VERSION_CONFLICT");
    expect(stale.retryable).toBe(false);

    const approved = await approveDocument(ownerP(A), { documentId: id, expectedVersion: 2 });
    expect(approved.status).toBe("APPROVED");
    expect(await auditCount(A, "stock_document.approved", id)).toBe(1);

    const cancelled = await cancelDocument(ownerP(A), { documentId: id, expectedVersion: 3, reason: "vazgeçildi" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(await auditCount(A, "stock_document.cancelled", id)).toBe(1);
    expect(await auditCount(A, "stock_document.created", id)).toBe(1);

    const hist = await q<{ from_status: string | null; to_status: string; actor_user_id: string | null }>(
      "SELECT from_status, to_status, actor_user_id FROM public.document_status_history WHERE tenant_id = $1 AND document_id = $2 ORDER BY occurred_at, to_status",
      [A.tenantId, id],
    );
    expect(hist.map((h) => `${h.from_status ?? "-"}>${h.to_status}`).sort()).toEqual(["->DRAFT", "APPROVED>CANCELLED", "DRAFT>APPROVED"].sort());
    expect(hist.every((h) => h.actor_user_id === A.ownerUserId)).toBe(true);

    // Sonlanmış belge salt okunur.
    expect((await failure(approveDocument(ownerP(A), { documentId: id, expectedVersion: 4 }))).detail).toBe("DOCUMENT_STATE");
    expect((await failure(cancelDocument(ownerP(A), { documentId: id, expectedVersion: 4 }))).detail).toBe("DOCUMENT_STATE");
    expect((await failure(updateDraft(ownerP(A), { documentId: id, expectedVersion: 4, reason: "z" }))).detail).toBe("DOCUMENT_STATE");
    expect(await auditCount(A, "stock_document.updated", id)).toBe(1); // yalnızca başarılı updateDraft
  });

  it("satır sayısı > 2.000 → VALIDATION_FAILED/DOCUMENT_TOO_LARGE; tam 2.000 satır kabul", async () => {
    const many = Array.from({ length: 2001 }, () => line(A));
    const e = await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: many }));
    expect([e.code, e.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_TOO_LARGE"]);
    const ok = await createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: many.slice(0, 2000) });
    expect(ok.lines).toHaveLength(2000);
  }, 60_000);

  it("boş belge onaylanamaz; geçersiz girdiler veritabanına gitmeden reddedilir", async () => {
    const created = await createStockDocument(ownerP(A), { kind: "STOCK_OUT", warehouseId: A.warehouseId });
    expect((await failure(approveDocument(ownerP(A), { documentId: created.documentId as string, expectedVersion: 1 }))).code).toBe("VALIDATION_FAILED");
    for (const bad of [
      { kind: "REVERSAL", warehouseId: A.warehouseId },
      { kind: "STOCK_IN", warehouseId: "x" },
      { kind: "STOCK_IN", warehouseId: A.warehouseId, businessDate: "2026-02-30" },
      { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { quantity: "1e3" })] },
      { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { quantity: "0", baseQuantity: "0" })] },
    ]) {
      expect((await failure(createStockDocument(ownerP(A), bad as never))).code).toBe("VALIDATION_FAILED");
    }
    // base_quantity ≠ quantity × factor
    expect((await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { baseQuantity: "6" })] }))).code).toBe("VALIDATION_FAILED");
    // gelecek iş tarihi (A-71)
    expect((await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, businessDate: "2999-01-01" }))).code).toBe("VALIDATION_FAILED");
  });

  it("POSTED belge iptali → DOCUMENT_STATE (onay/düzenleme de)", async () => {
    const id = await mkPostedDoc(A);
    const row = await docRow(id);
    expect(row.status).toBe("POSTED");
    expect(row.number).toMatch(/^GRS-\d{4}-\d{6}$/);
    const c = await failure(cancelDocument(ownerP(A), { documentId: id, expectedVersion: row.version }));
    expect([c.code, c.detail]).toEqual(["VALIDATION_FAILED", "DOCUMENT_STATE"]);
    expect((await failure(approveDocument(ownerP(A), { documentId: id, expectedVersion: row.version }))).detail).toBe("DOCUMENT_STATE");
    expect((await failure(updateDraft(ownerP(A), { documentId: id, expectedVersion: row.version, reason: "x" }))).detail).toBe("DOCUMENT_STATE");
    expect((await docRow(id)).status).toBe("POSTED");
  });

  it("posting_job_id doluyken iptal/onay/düzenleme → DOCUMENT_STATE (işleme kilidi, M-6); iptal normalde izinli APPROVED belgede bile", async () => {
    const created = await createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const id = created.documentId as string;
    await approveDocument(ownerP(A), { documentId: id, expectedVersion: 1 });
    await adm.query("BEGIN");
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    await adm.query("UPDATE public.documents SET posting_job_id = $2, posting_requested_by = $3 WHERE id = $1", [id, uuid(), A.ownerUserId]);
    await adm.query("COMMIT");
    const row = await docRow(id);
    expect(row.posting_job_id).not.toBeNull();
    for (const [name, p] of [
      ["cancel", () => cancelDocument(ownerP(A), { documentId: id, expectedVersion: row.version })],
      ["approve", () => approveDocument(ownerP(A), { documentId: id, expectedVersion: row.version })],
      ["update", () => updateDraft(ownerP(A), { documentId: id, expectedVersion: row.version, reason: "x" })],
    ] as const) {
      const e = await failure(p());
      expect([name, e.code, e.detail]).toEqual([name, "VALIDATION_FAILED", "DOCUMENT_STATE"]);
    }
    expect((await docRow(id)).status).toBe("APPROVED");
    expect(() => assertNotProcessing({ postingJobId: uuid() })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" }));
    expect(() => assertNotProcessing({ postingJobId: null })).not.toThrow();
  });

  it("eşzamanlı düzenlemeler (başlık önce kilitlenir): tam biri başarılı, diğerleri VERSION_CONFLICT; kilit yükseltme deadlock'u (40P01/INTERNAL) yok", async () => {
    const created = await createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const id = created.documentId as string;
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        updateDraft(ownerP(A), { documentId: id, expectedVersion: 1, lines: [line(A, { quantity: String(i + 1), baseQuantity: String(i + 1) })] }),
      ),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect((s.reason as AppError).code).toBe("VERSION_CONFLICT");
        expect((s.reason as AppError).retryable).toBe(false);
      }
    }
    expect(await count("SELECT count(*) AS n FROM public.document_lines WHERE tenant_id = $1 AND document_id = $2", [A.tenantId, id])).toBe(1);
    expect((await docRow(id)).version).toBe(2);
  });
});

describe("numaralama (A-70, A-05)", () => {
  it("50 eşzamanlı belge → numara tekrarı yok, aralıksız ve biçim <önek>-<YYYY>-<6 hane>", async () => {
    const typeVersion = (await q<{ id: string }>("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'STOCK_OUT' AND version = 1"))[0] as { id: string };
    const date = "2026-03-15";
    const run = async (): Promise<string> => {
      const documentId = uuid();
      const out = await executeStockCommand<{ documentId: string }, StockCommandResult>({
        db: app,
        principal: { userId: A.ownerUserId, mfaVerified: true },
        tenantSlug: A.slug,
        commandType: "test.stock.number",
        clientKey: uuid(),
        input: { documentId },
        permission: "document.create",
        plan: async () => ({ warehouseIds: [A.warehouseId], locks: EMPTY_LOCK_PLAN }),
        apply: async (tx) => {
          await tx.execute(
            `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, created_by)
             VALUES ('${A.tenantId}', '${documentId}', 'STOCK_OUT', '${typeVersion.id}', '${A.warehouseId}', '${date}', '${A.ownerUserId}')`,
          );
          return { result: { documentId, status: "DRAFT" }, audit: null, numbering: { documentId, kind: "STOCK_OUT", businessDate: date } };
        },
        retry: NO_WAIT,
      });
      if (out.status !== "COMPLETED") throw new Error("expected COMPLETED");
      return out.result.documentNumber as string;
    };
    const numbers = await Promise.all(Array.from({ length: 50 }, run));
    expect(new Set(numbers).size).toBe(50);
    for (const n of numbers) expect(n).toMatch(/^CKS-2026-\d{6,}$/);
    const seqs = numbers.map((n) => Number(n.split("-")[2])).sort((a, b) => a - b);
    expect((seqs[49] as number) - (seqs[0] as number)).toBe(49); // aralıksız (başarılı transaction'larda boşluk yok)
    const stored = await q<{ number: string }>("SELECT number FROM public.documents WHERE tenant_id = $1 AND kind = 'STOCK_OUT' AND number = ANY($2::text[])", [A.tenantId, numbers]);
    expect(stored).toHaveLength(50);
  }, 120_000);
});

/** A-145: ikinci depo + lokasyonu (migration rolüyle). */
async function mkWarehouseWithLocation(w: TenantWorld): Promise<{ warehouseId: string; locationId: string }> {
  const warehouseId = uuid();
  const locationId = uuid();
  const tag = warehouseId.slice(0, 6).toUpperCase();
  await adm.query("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, 'Depo X')", [w.tenantId, warehouseId, `W${tag}`]);
  await adm.query(
    "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, 'Z1', 'Bolge', 0, 'STORAGE')",
    [w.tenantId, locationId, warehouseId],
  );
  return { warehouseId, locationId };
}
async function scopeCounter(w: TenantWorld, warehouseIds: string[]): Promise<void> {
  const m = (await q<{ id: string }>("SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [w.tenantId, counterUserId]))[0] as { id: string };
  for (const wh of warehouseIds) {
    await adm.query("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [w.tenantId, m.id, wh]);
  }
}

describe("A-145: satır lokasyonları belge deposunda olmalı", () => {
  it("kapsam dışı depodaki lokasyon → FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE (kapsam açık; create ve update)", async () => {
    const w2 = await mkWarehouseWithLocation(A);
    await scopeCounter(A, [A.warehouseId]); // belge deposu kapsamda, w2 değil
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const e = await failure(createStockDocument(counterP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { targetLocationId: w2.locationId })] }));
    expect([e.code, e.detail]).toEqual(["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"]);
    const ok = await createStockDocument(counterP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const e2 = await failure(updateDraft(counterP(A), { documentId: ok.documentId as string, expectedVersion: 1, lines: [line(A, { targetLocationId: w2.locationId })] }));
    expect([e2.code, e2.detail]).toEqual(["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"]);
  });

  it("kapsam içi ama başka depodaki lokasyon → LOCATION_WAREHOUSE_MISMATCH (create, update satırları, update depo değişimi)", async () => {
    const w2 = await mkWarehouseWithLocation(A);
    await scopeCounter(A, [A.warehouseId, w2.warehouseId]);
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const mismatch = (e: AppError) => [e.code, e.detail];
    const e1 = await failure(createStockDocument(counterP(A), { kind: "STOCK_MOVE", warehouseId: A.warehouseId, lines: [line(A, { sourceLocationId: w2.locationId })] }));
    expect(mismatch(e1)).toEqual(["VALIDATION_FAILED", "LOCATION_WAREHOUSE_MISMATCH"]);
    const doc = await createStockDocument(counterP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const id = doc.documentId as string;
    const e2 = await failure(updateDraft(counterP(A), { documentId: id, expectedVersion: 1, lines: [line(A, { targetLocationId: w2.locationId })] }));
    expect(mismatch(e2)).toEqual(["VALIDATION_FAILED", "LOCATION_WAREHOUSE_MISMATCH"]);
    // Depo değişir, satırlar korunur: mevcut satırlar eski depoda kalacağından ret.
    const e3 = await failure(updateDraft(counterP(A), { documentId: id, expectedVersion: 1, warehouseId: w2.warehouseId }));
    expect(mismatch(e3)).toEqual(["VALIDATION_FAILED", "LOCATION_WAREHOUSE_MISMATCH"]);
    expect((await docRow(id)).version).toBe(1);
    // Aynı depodaki lokasyon geçer; satırlarla birlikte depo da taşınabilir.
    await expect(updateDraft(counterP(A), { documentId: id, expectedVersion: 1, warehouseId: w2.warehouseId, lines: [line(A, { targetLocationId: w2.locationId })] })).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("var olmayan ya da başka tenant'a ait lokasyon → NOT_FOUND (varlık sızdırmaz)", async () => {
    for (const locationId of [uuid(), B.rootLocationId]) {
      const e = await failure(createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A, { targetLocationId: locationId })] }));
      expect(e.code).toBe("NOT_FOUND");
    }
  });
});

describe("A-146: iptal izni durumdan türer", () => {
  it("COUNTER (create var, approve yok) DRAFT'ı iptal eder; APPROVED'ı iptal edemez (FORBIDDEN, belge ve audit değişmez)", async () => {
    const draft = await createStockDocument(counterP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    await expect(cancelDocument(counterP(A), { documentId: draft.documentId as string, expectedVersion: 1 })).resolves.toMatchObject({ status: "CANCELLED" });

    const doc = await createStockDocument(ownerP(A), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [line(A)] });
    const id = doc.documentId as string;
    await approveDocument(ownerP(A), { documentId: id, expectedVersion: 1 });
    const before = await docRow(id);
    const key = uuid();
    const e = await failure(cancelDocument(counterP(A, key), { documentId: id, expectedVersion: before.version }));
    expect(e.code).toBe("FORBIDDEN");
    expect(await docRow(id)).toEqual(before);
    expect(await auditCount(A, "stock_document.cancelled", id)).toBe(0);
    expect(await idemRows(A, key)).toHaveLength(0); // yetki reddi kaydedilmez
    // approve izni olan iptal edebilir.
    await expect(cancelDocument(ownerP(A), { documentId: id, expectedVersion: before.version })).resolves.toMatchObject({ status: "CANCELLED" });
  });
});
