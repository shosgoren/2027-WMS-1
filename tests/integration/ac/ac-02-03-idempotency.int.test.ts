// T-220 (qa-verifier): AC-02 (stok isteği kolu) ve AC-03 (commit sonrası yanıt kaybı) — idempotency. Bağımsız doğrulama.
// GERÇEK roller: komutlar wms_app + PgBouncer; fikstür/gözlem yalnızca DATABASE_URL_DIRECT. ADR-018 §1-§4. Sentetik veri (G-09).
// Worker olayı kolu (AC-02 ikinci yarısı) ac-02-worker-event.int.test.ts'tedir; burada yalnızca stok komutu.
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
let A: TenantWorld;
let B: TenantWorld;
let R01: string;

const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const NO_WAIT = { sleep: async () => undefined } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);
const callAs = (w: TenantWorld, userId: string, key: string | null, db: DbClient = app): StockDocCallParams => ({
  db, principal: { userId, mfaVerified: true }, tenantSlug: w.slug, clientKey: key, timeouts: WIDE, retry: NO_WAIT,
});
const ownerP = (key: string | null = uuid(), db: DbClient = app): StockDocCallParams => callAs(A, A.ownerUserId, key, db);

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function mkItem(w: TenantWorld = A): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T220 urun',$4,'NONE',0)", [
    w.tenantId, id, `Q-${hex(10)}`, w.unitId,
  ]);
  return id;
}
async function mkLoc(w: TenantWorld = A): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T220 lok',0,'STORAGE',false)", [
    w.tenantId, id, w.warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (w: TenantWorld, itemId: string, n: string, over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  itemId, unitId: w.unitId, quantity: n, conversionFactor: "1", baseQuantity: n, ...over,
});
async function mkApproved(kind: "STOCK_IN" | "STOCK_OUT", lines: DocumentLineInput[], w: TenantWorld = A): Promise<{ id: string; version: number }> {
  const c = await createStockDocument(callAs(w, w.ownerUserId, uuid()), { kind, warehouseId: w.warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(callAs(w, w.ownerUserId, uuid()), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [id]))[0];
  return { id, version: Number(v?.version) };
}
const bal = async (w: TenantWorld, item: string, loc: string): Promise<string> =>
  (await q<{ quantity: string }>(
    `SELECT b.quantity::text AS quantity FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'`, [w.tenantId, item, loc]))[0]?.quantity ?? "0.000000";
const ledgerCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.stock_ledger WHERE document_id=$1", [docId]))[0]?.n);
const auditCount = async (docId: string): Promise<number> =>
  Number((await q<{ n: string }>("SELECT count(*)::text AS n FROM public.audit_logs WHERE action='stock_document.posted' AND entity_id=$1", [docId]))[0]?.n);
const docRow = async (id: string) =>
  (await q<{ status: string; number: string | null }>("SELECT status, number FROM public.documents WHERE id=$1", [id]))[0] as { status: string; number: string | null };
const idemRows = async (w: TenantWorld, key: string) =>
  q<{ status: string; error_code: string | null }>("SELECT status, error_code FROM public.idempotency_records WHERE tenant_id=$1 AND client_key=$2", [w.tenantId, key]);
const mismatches = async (w: TenantWorld, item: string): Promise<number> =>
  Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id
      WHERE s.tenant_id=$1 AND s.item_id=$2
        AND b.quantity <> COALESCE((SELECT sum(l.quantity) FROM public.stock_ledger l WHERE l.tenant_id=b.tenant_id AND l.stock_dimension_id=b.stock_dimension_id),0)`,
    [w.tenantId, item]))[0]?.n);

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("ret beklenirdi ama kabul edildi");
}
const codeOf = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);
type Posted = Awaited<ReturnType<typeof postDocument>>;
const strip = (r: Posted): Record<string, unknown> => ({ documentId: r.documentId, status: r.status, lines: r.lines, documentNumber: r.documentNumber });

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A220B");
  B = await seedWorld(adm, reg, "B220B");
  R01 = await mkLoc(A);
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("AC-02 aynı stok isteği tekrarı (T-220)", () => {
  it("@AC-02 aynı clientKey + aynı içerik 10 kez (5'i eşzamanlı): tek defter kümesi, tek audit, tek bakiye etkisi; her yanıt aynı belge numarası/sonucu, tam biri replayed=false", async () => {
    const x = await mkItem();
    const doc = await mkApproved("STOCK_IN", [ln(A, x, "10", { targetLocationId: R01 })]);
    const key = uuid();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const concurrent = Array.from({ length: 5 }, async () => {
      await gate;
      return postDocument(ownerP(key), { documentId: doc.id, expectedVersion: doc.version });
    });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const firstFive = await Promise.all(concurrent);
    const lastFive: Posted[] = [];
    for (let i = 0; i < 5; i++) lastFive.push(await postDocument(ownerP(key), { documentId: doc.id, expectedVersion: doc.version }));
    const all = [...firstFive, ...lastFive];
    expect(all).toHaveLength(10);
    expect(all.filter((r) => !r.replayed)).toHaveLength(1);
    expect(all.slice(5).every((r) => r.replayed)).toBe(true);
    const first = strip(all[0] as Posted);
    expect(first.status).toBe("POSTED");
    expect(first.documentNumber).toBeTruthy();
    for (const r of all) expect(strip(r)).toEqual(first);
    expect((await docRow(doc.id)).number).toBe(first.documentNumber);
    expect(await ledgerCount(doc.id)).toBe(1);
    expect(await auditCount(doc.id)).toBe(1);
    expect(await bal(A, x, R01)).toBe("10.000000");
    expect((await idemRows(A, key)).map((r) => r.status)).toEqual(["COMPLETED"]);
    expect(await mismatches(A, x)).toBe(0);
  });

  it("@AC-02 aynı anahtar + farklı içerik (başka belge / başka sürüm) → IDEMPOTENCY_MISMATCH; ikinci belge etkisiz; özgün tekrar hâlâ özgün sonucu döner", async () => {
    const x = await mkItem();
    const d1 = await mkApproved("STOCK_IN", [ln(A, x, "10", { targetLocationId: R01 })]);
    const d2 = await mkApproved("STOCK_IN", [ln(A, x, "20", { targetLocationId: R01 })]);
    const key = uuid();
    const r1 = await postDocument(ownerP(key), { documentId: d1.id, expectedVersion: d1.version });
    const e1 = await failure(postDocument(ownerP(key), { documentId: d2.id, expectedVersion: d2.version }));
    expect(e1.code).toBe("IDEMPOTENCY_MISMATCH");
    const e2 = await failure(postDocument(ownerP(key), { documentId: d1.id, expectedVersion: d1.version + 1 }));
    expect(e2.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await ledgerCount(d2.id)).toBe(0);
    expect((await docRow(d2.id)).status).toBe("APPROVED");
    expect(await bal(A, x, R01)).toBe("10.000000");
    const again = await postDocument(ownerP(key), { documentId: d1.id, expectedVersion: d1.version });
    expect(again.replayed).toBe(true);
    expect(strip(again)).toEqual(strip(r1));
    expect((await idemRows(A, key))).toHaveLength(1);
  });

  it("@AC-02 aynı anahtar + başka kullanıcı → IDEMPOTENCY_MISMATCH; saklı sonuç (belge no/kimlik) hatada sızmaz", async () => {
    const x = await mkItem();
    const d = await mkApproved("STOCK_IN", [ln(A, x, "4", { targetLocationId: R01 })]);
    const key = uuid();
    const r = await postDocument(ownerP(key), { documentId: d.id, expectedVersion: d.version });
    const e = await failure(postDocument(callAs(A, A.memberUserId, key), { documentId: d.id, expectedVersion: d.version }));
    expect(e.code).toBe("IDEMPOTENCY_MISMATCH");
    const dump = JSON.stringify({ e, message: e.message, detail: e.detail, cause: String(e.cause ?? "") });
    expect(dump).not.toContain(d.id);
    expect(dump).not.toContain(String(r.documentNumber));
    expect(await auditCount(d.id)).toBe(1);
    expect(await ledgerCount(d.id)).toBe(1);
  });

  it("@AC-02 tenant sızıntısı: aynı clientKey başka tenant'ta bağımsızdır; B kullanıcısı A belgesine erişemez (NOT_FOUND) ve A'nın saklı sonucunu alamaz", async () => {
    const key = uuid();
    const xa = await mkItem(A);
    const da = await mkApproved("STOCK_IN", [ln(A, xa, "6", { targetLocationId: R01 })], A);
    const ra = await postDocument(ownerP(key), { documentId: da.id, expectedVersion: da.version });
    // B, A'nın belge kimliğiyle + aynı anahtarla: sonuç sızmaz
    const leak = await failure(postDocument(callAs(B, B.ownerUserId, key), { documentId: da.id, expectedVersion: da.version }));
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(leak.code);
    expect(JSON.stringify({ leak, m: leak.message })).not.toContain(String(ra.documentNumber));
    // B kendi belgesiyle aynı anahtarı kullanır: A'nın kaydı çakışma yaratmaz, B kendi sonucunu alır
    const xb = await mkItem(B);
    const locB = await mkLoc(B);
    const db = await mkApproved("STOCK_IN", [ln(B, xb, "9", { targetLocationId: locB })], B);
    const rb = await postDocument(callAs(B, B.ownerUserId, key), { documentId: db.id, expectedVersion: db.version });
    expect(rb.documentId).toBe(db.id);
    expect(rb.replayed).toBe(false);
    expect(await bal(B, xb, locB)).toBe("9.000000");
    expect(await bal(A, xa, R01)).toBe("6.000000");
    expect(await idemRows(A, key)).toHaveLength(1);
    expect(await idemRows(B, key)).toHaveLength(1);
  });

  it("@AC-02 ret tekrarı (ADR-018 §3): yetersiz stokla ret → stok eklense de aynı anahtar+içerik aynı INSUFFICIENT_STOCK, defter değişmez; düzeltilmiş içerik aynı anahtarla IDEMPOTENCY_MISMATCH; yeni anahtar işlenir", async () => {
    const x = await mkItem();
    const seed = await mkApproved("STOCK_IN", [ln(A, x, "3", { targetLocationId: R01 })]);
    await postDocument(ownerP(), { documentId: seed.id, expectedVersion: seed.version });
    const out7 = await mkApproved("STOCK_OUT", [ln(A, x, "7", { sourceLocationId: R01 })]);
    const key = uuid();
    const rej = await failure(postDocument(ownerP(key), { documentId: out7.id, expectedVersion: out7.version }));
    expect(rej.code).toBe("INSUFFICIENT_STOCK");
    expect((await idemRows(A, key)).map((r) => [r.status, r.error_code])).toEqual([["REJECTED", "INSUFFICIENT_STOCK"]]);
    // stok bu arada eklenir (13)
    const more = await mkApproved("STOCK_IN", [ln(A, x, "10", { targetLocationId: R01 })]);
    await postDocument(ownerP(), { documentId: more.id, expectedVersion: more.version });
    expect(await bal(A, x, R01)).toBe("13.000000");
    // aynı anahtar + aynı içerik: aynı ret; çıkış gerçekleşmez
    const again = await failure(postDocument(ownerP(key), { documentId: out7.id, expectedVersion: out7.version }));
    expect(codeOf(again)).toBe(codeOf(rej));
    expect(await bal(A, x, R01)).toBe("13.000000");
    expect(await ledgerCount(out7.id)).toBe(0);
    expect((await docRow(out7.id)).status).toBe("APPROVED");
    // düzeltilmiş miktar (yeni belge) + eski anahtar → MISMATCH
    const out2 = await mkApproved("STOCK_OUT", [ln(A, x, "2", { sourceLocationId: R01 })]);
    const mm = await failure(postDocument(ownerP(key), { documentId: out2.id, expectedVersion: out2.version }));
    expect(mm.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await ledgerCount(out2.id)).toBe(0);
    // yeni anahtar + aynı belge → işlenir
    const ok = await postDocument(ownerP(), { documentId: out7.id, expectedVersion: out7.version });
    expect(ok.status).toBe("POSTED");
    expect(await bal(A, x, R01)).toBe("6.000000");
    expect(await mismatches(A, x)).toBe(0);
  });

  it("@AC-02 eşzamanlı aynı anahtarlı İKİ ret: tek REJECTED kaydı, ikisi de aynı kodu alır", async () => {
    const x = await mkItem();
    const out = await mkApproved("STOCK_OUT", [ln(A, x, "5", { sourceLocationId: R01 })]);
    const key = uuid();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = Array.from({ length: 4 }, async () => {
      await gate;
      return failure(postDocument(ownerP(key), { documentId: out.id, expectedVersion: out.version }));
    });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const errs = await Promise.all(calls);
    expect(errs.map(codeOf)).toEqual(Array(4).fill("INSUFFICIENT_STOCK"));
    expect(await idemRows(A, key)).toHaveLength(1);
    expect(await ledgerCount(out.id)).toBe(0);
  });

  it("@AC-02 anahtar yok/geçersiz → VALIDATION_FAILED, etkisiz (A-73)", async () => {
    const x = await mkItem();
    const d = await mkApproved("STOCK_IN", [ln(A, x, "1", { targetLocationId: R01 })]);
    for (const bad of [null, "", "not-a-uuid"]) {
      const e = await failure(postDocument(ownerP(bad), { documentId: d.id, expectedVersion: d.version }));
      expect(e.code, String(bad)).toBe("VALIDATION_FAILED");
    }
    expect(await ledgerCount(d.id)).toBe(0);
    expect((await docRow(d.id)).status).toBe("APPROVED");
  });
});

describe("AC-03 commit sonrası yanıt kaybı (T-220)", () => {
  const lossyClient = (): DbClient => createDbClient({ url: env.databaseUrl, poolMax: 2, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });

  it("@AC-03 komut commit eder, istemci havuzu yanıt gelmeden kapanır (sonuç atılır) → aynı anahtarla yeniden istek önceki sonucu döner, ikinci hareket/audit/numara yok", async () => {
    const x = await mkItem();
    const d = await mkApproved("STOCK_IN", [ln(A, x, "8", { targetLocationId: R01 })]);
    const key = uuid();
    const lossy = lossyClient();
    let lost: Posted | undefined;
    try {
      lost = await postDocument(ownerP(key, lossy), { documentId: d.id, expectedVersion: d.version });
    } finally {
      await lossy.close(); // yanıt istemciye ulaşmadan bağlantı kesilir: `lost` çağırana asla iletilmemiş sayılır
    }
    const afterLoss = await docRow(d.id);
    expect(afterLoss.status).toBe("POSTED"); // commit gerçekleşmişti
    const retry = await postDocument(ownerP(key), { documentId: d.id, expectedVersion: d.version });
    expect(retry.replayed).toBe(true);
    expect(retry.documentNumber).toBe(afterLoss.number);
    expect(retry.documentNumber).toBe(lost?.documentNumber);
    expect(strip(retry)).toEqual(strip(lost as Posted));
    expect(await ledgerCount(d.id)).toBe(1);
    expect(await auditCount(d.id)).toBe(1);
    expect(await bal(A, x, R01)).toBe("8.000000");
    expect(await mismatches(A, x)).toBe(0);
    // yeni anahtarla aynı belge: bayat sürüm VERSION_CONFLICT, güncel sürüm DOCUMENT_STATE; ikisi de çift hareket üretmez
    const stale = await failure(postDocument(ownerP(), { documentId: d.id, expectedVersion: d.version }));
    expect(stale.code).toBe("VERSION_CONFLICT");
    const cur = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [d.id]))[0];
    const dup = await failure(postDocument(ownerP(), { documentId: d.id, expectedVersion: Number(cur?.version) }));
    expect(codeOf(dup)).toBe("VALIDATION_FAILED/DOCUMENT_STATE");
    expect(await ledgerCount(d.id)).toBe(1);
    expect(await bal(A, x, R01)).toBe("8.000000");
  });

  it("@AC-03 komut sürerken istemci havuzu kapatılır (yanıt atılır), aynı anahtarla yeniden istek: her turda tam bir etki (12 tur, değişen zamanlama)", async () => {
    for (let round = 0; round < 12; round++) {
      const x = await mkItem();
      const d = await mkApproved("STOCK_IN", [ln(A, x, "5", { targetLocationId: R01 })]);
      const key = uuid();
      const lossy = lossyClient();
      const run = postDocument(ownerP(key, lossy), { documentId: d.id, expectedVersion: d.version }).then(
        () => "ok",
        (e: unknown) => (e instanceof AppError ? e.code : "ERR"),
      );
      await new Promise((r) => setTimeout(r, round * 9));
      await lossy.close(); // sürmekte olan komut sırasında havuz kapanır; sonuç çağırana iletilmemiş sayılır
      await run;
      const final = await postDocument(ownerP(key), { documentId: d.id, expectedVersion: d.version });
      expect(final.status, `tur ${round}`).toBe("POSTED");
      expect(await ledgerCount(d.id), `tur ${round}`).toBe(1);
      expect(await auditCount(d.id), `tur ${round}`).toBe(1);
      expect(await bal(A, x, R01), `tur ${round}`).toBe("5.000000");
      expect((await idemRows(A, key)).map((r) => r.status), `tur ${round}`).toEqual(["COMPLETED"]);
    }
  }, 120_000);

  it("@AC-03 ret yanıtı kaybolur → aynı anahtarla tekrar aynı ret kodunu döner (REJECTED kaydı), stok sonradan eklense de çıkış gerçekleşmez", async () => {
    const x = await mkItem();
    const out = await mkApproved("STOCK_OUT", [ln(A, x, "4", { sourceLocationId: R01 })]);
    const key = uuid();
    const lossy = lossyClient();
    let first: AppError;
    try {
      first = await failure(postDocument(ownerP(key, lossy), { documentId: out.id, expectedVersion: out.version }));
    } finally {
      await lossy.close();
    }
    expect(first.code).toBe("INSUFFICIENT_STOCK");
    expect((await idemRows(A, key)).map((r) => [r.status, r.error_code])).toEqual([["REJECTED", "INSUFFICIENT_STOCK"]]);
    const inDoc = await mkApproved("STOCK_IN", [ln(A, x, "100", { targetLocationId: R01 })]);
    await postDocument(ownerP(), { documentId: inDoc.id, expectedVersion: inDoc.version });
    const again = await failure(postDocument(ownerP(key), { documentId: out.id, expectedVersion: out.version }));
    expect(codeOf(again)).toBe(codeOf(first));
    expect(await ledgerCount(out.id)).toBe(0);
    expect(await bal(A, x, R01)).toBe("100.000000");
    expect(await mismatches(A, x)).toBe(0);
  });
});
