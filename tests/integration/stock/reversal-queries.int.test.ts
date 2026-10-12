// T-333: listMyRecentDocuments ("Yanlış bir şey yaptım" okuması). GERÇEK roller (wms_app, pooler); fikstür/gözlem yalnızca DATABASE_URL_DIRECT ile.
// Kendi/başkasının belgesi, tenant izolasyonu, depo kapsamı, kısmi ters kayıt kalanı ve engel bayrakları. Fikstürler sentetiktir (G-09).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  approveDocument,
  createStockDocument,
  listMyRecentDocuments,
  postDocument,
  reverseDocument,
  type DocumentLineInput,
  type StockDocCallParams,
} from "../../../packages/domain/src/stock/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let mgrUserId: string;
let mgrMembershipId: string;
let wh2: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const hex = (n: number): string => uuid().replaceAll("-", "").slice(0, n);

const writeP = (userId: string, key: string | null = uuid()): StockDocCallParams => ({
  db: app,
  principal: { userId, mfaVerified: true },
  tenantSlug: A.slug,
  clientKey: key,
  retry: NO_WAIT,
  timeouts: WIDE,
});
const ownerP = (key: string | null = uuid()) => writeP(A.ownerUserId, key);
const mgrP = (key: string | null = uuid()) => writeP(mgrUserId, key);
const readP = (userId: string, tenantSlug = A.slug) => ({ db: app, principal: { userId, mfaVerified: true }, tenantSlug });

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await adm.query<T>(text, params)).rows;
}
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const codeOf = (e: AppError): string => (e.detail === undefined ? e.code : `${e.code}/${e.detail}`);

async function mkItem(): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T333 urun',$4,'NONE',0)", [A.tenantId, id, `I-${hex(10)}`, A.unitId]);
  return id;
}
async function mkLoc(warehouseId: string = A.warehouseId): Promise<string> {
  const id = uuid();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T333 lok',0,'STORAGE',false)", [
    A.tenantId, id, warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
const ln = (itemId: string, over: Partial<DocumentLineInput>): DocumentLineInput => ({ itemId, unitId: A.unitId, quantity: "1", conversionFactor: "1", baseQuantity: "1", ...over });
const qty = (n: string): Partial<DocumentLineInput> => ({ quantity: n, baseQuantity: n });

interface Doc { id: string; lineIds: string[] }
async function mkPosted(p: () => StockDocCallParams, kind: "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE", lines: DocumentLineInput[], warehouseId: string = A.warehouseId): Promise<Doc> {
  const c = await createStockDocument(p(), { kind, warehouseId, lines });
  const id = c.documentId as string;
  await approveDocument(p(), { documentId: id, expectedVersion: 1 });
  const version = Number((await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [id]))[0]?.version);
  expect((await postDocument(p(), { documentId: id, expectedVersion: version })).status).toBe("POSTED");
  return { id, lineIds: (c.lines ?? []).map((l) => l.lineId) };
}
async function bypassGuardsUpdate(text: string, params: unknown[]): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SET LOCAL session_replication_role = replica");
    await adm.query(text, params);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
const idsOf = async (userId: string, limit?: number, slug = A.slug) =>
  (await listMyRecentDocuments(readP(userId, slug), limit === undefined ? {} : { limit })).documents.map((d) => d.documentId);

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A333");
  B = await seedWorld(adm, reg, "B333");
  mgrUserId = await mkUser(adm, reg, "A333 mgr");
  mgrMembershipId = await mkMembership(adm, A.tenantId, mgrUserId, { roles: ["WAREHOUSE_MANAGER"] });
  wh2 = uuid();
  await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,'D2','T333 Depo 2')", [A.tenantId, wh2]);
}, 120_000);

afterEach(() => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
});

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("listMyRecentDocuments (T-333)", () => {
  it("yalnız kendi POSTED belgeleri, yeniden eskiye; satır alanları ve kısmi ters kayıt kalanı", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const first = await mkPosted(ownerP, "STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("100") })]);
    const second = await mkPosted(ownerP, "STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("7") })]);
    // DRAFT ve APPROVED listelenmez
    await createStockDocument(ownerP(), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [ln(x, { targetLocationId: loc, ...qty("1") })] });
    const appr = await createStockDocument(ownerP(), { kind: "STOCK_IN", warehouseId: A.warehouseId, lines: [ln(x, { targetLocationId: loc, ...qty("1") })] });
    await approveDocument(ownerP(), { documentId: appr.documentId as string, expectedVersion: 1 });

    const ids = await idsOf(A.ownerUserId);
    expect(ids.slice(0, 2)).toEqual([second.id, first.id]);
    expect(ids).not.toContain(appr.documentId);
    expect(ids).not.toContain(A.documentId); // tohumlanan DRAFT belge

    const res = await listMyRecentDocuments(readP(A.ownerUserId));
    expect(res.timeZone).toBe("Europe/Istanbul");
    const d1 = res.documents.find((d) => d.documentId === first.id);
    expect(d1).toMatchObject({ kind: "STOCK_IN", warehouseId: A.warehouseId, blocked: null });
    expect(d1?.number).toMatch(/^GRS-\d{4}-\d{6}$/);
    expect(d1?.createdAt).toBeInstanceOf(Date);
    expect(d1?.lines).toEqual([
      {
        lineId: first.lineIds[0],
        lineNo: 1,
        itemCode: expect.stringMatching(/^I-/),
        itemName: "T333 urun",
        quantity: "100.000000",
        unitCode: "ADET",
        baseQuantity: "100.000000",
        baseUnitCode: "ADET",
        reversedQuantity: "0.000000",
        remaining: "100.000000",
        sourceLocationCode: null,
        targetLocationCode: expect.stringMatching(/^L-/),
      },
    ]);

    // kısmi ters kayıt: 40 → kalan 60; REVERSAL belgesi listede yok
    const rev = await reverseDocument(ownerP(), { documentId: first.id, lines: [{ lineId: first.lineIds[0] as string, quantity: "40" }], reason: "Yanlış giriş" });
    const after = await listMyRecentDocuments(readP(A.ownerUserId));
    const d1b = after.documents.find((d) => d.documentId === first.id);
    expect(d1b?.lines[0]).toMatchObject({ reversedQuantity: "40.000000", remaining: "60.000000" });
    expect(d1b?.blocked).toBeNull();
    expect(after.documents.map((d) => d.documentId)).not.toContain(rev.documentId);

    // tamamı kapanınca FULLY_REVERSED
    await reverseDocument(ownerP(), { documentId: first.id, lines: "ALL", reason: "Kalanı da geri al" });
    const full = (await listMyRecentDocuments(readP(A.ownerUserId))).documents.find((d) => d.documentId === first.id);
    expect(full?.lines[0]).toMatchObject({ reversedQuantity: "100.000000", remaining: "0.000000" });
    expect(full?.blocked).toBe("FULLY_REVERSED");
  });

  it("başkasının belgesi görünmez; reversal.create yoksa FORBIDDEN", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const mine = await mkPosted(mgrP, "STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("3") })]);
    expect(await idsOf(mgrUserId)).toContain(mine.id);
    expect(await idsOf(A.ownerUserId)).not.toContain(mine.id);
    expect(await idsOf(mgrUserId)).not.toContain(A.documentId);
    const e = await failure(listMyRecentDocuments(readP(A.memberUserId))); // PICKER
    expect(e.code).toBe("FORBIDDEN");
  });

  it("başka tenant ve olmayan tenant aynı NOT_FOUND; B kendi tenant'ında A'nın belgesini görmez", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const d = await mkPosted(ownerP, "STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("2") })]);
    const cross = await failure(listMyRecentDocuments(readP(B.ownerUserId, A.slug)));
    const missing = await failure(listMyRecentDocuments(readP(B.ownerUserId, `yok-${hex(8)}`)));
    expect(codeOf(cross)).toBe("NOT_FOUND");
    expect(codeOf(missing)).toBe(codeOf(cross));
    expect(await idsOf(B.ownerUserId, undefined, B.slug)).not.toContain(d.id);
    expect(await idsOf(B.ownerUserId, undefined, B.slug)).toEqual([]);
  });

  it("depo kapsamı: kapsam dışı depodaki belge görünmez (bayrak açıkken)", async () => {
    const x = await mkItem();
    const l1 = await mkLoc();
    const l2 = await mkLoc(wh2);
    const inWh1 = await mkPosted(mgrP, "STOCK_IN", [ln(x, { targetLocationId: l1, ...qty("1") })]);
    const inWh2 = await mkPosted(mgrP, "STOCK_IN", [ln(x, { targetLocationId: l2, ...qty("1") })], wh2);
    expect(await idsOf(mgrUserId)).toEqual(expect.arrayContaining([inWh1.id, inWh2.id]));
    await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1,$2,$3)", [A.tenantId, mgrMembershipId, wh2]);
    try {
      process.env.WAREHOUSE_SCOPE_ENABLED = "true";
      const ids = await idsOf(mgrUserId);
      expect(ids).toContain(inWh2.id);
      expect(ids).not.toContain(inWh1.id);
    } finally {
      delete process.env.WAREHOUSE_SCOPE_ENABLED;
      await q("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = $1 AND membership_id = $2", [A.tenantId, mgrMembershipId]);
    }
  });

  it("engel bayrakları: SOURCE_LINKED ve STATUS_CHANGE", async () => {
    const x = await mkItem();
    const loc = await mkLoc();
    const linked = await mkPosted(ownerP, "STOCK_IN", [ln(x, { targetLocationId: loc, ...qty("10") })]);
    await bypassGuardsUpdate("UPDATE public.documents SET source_kind = 'TASK', source_id = $2 WHERE id = $1", [linked.id, uuid()]);
    const sm = await mkPosted(ownerP, "STOCK_MOVE", [ln(x, { sourceLocationId: loc, targetLocationId: loc, targetStockStatus: "QUARANTINE", ...qty("5") })]);
    const docs = (await listMyRecentDocuments(readP(A.ownerUserId))).documents;
    expect(docs.find((d) => d.documentId === linked.id)?.blocked).toBe("SOURCE_LINKED");
    expect(docs.find((d) => d.documentId === sm.id)?.blocked).toBe("STATUS_CHANGE");
  });

  it("limit: 1..50 dışı VALIDATION_FAILED; limit uygulanır", async () => {
    for (const bad of [0, 51, 1.5, Number.NaN]) {
      expect((await failure(listMyRecentDocuments(readP(A.ownerUserId), { limit: bad }))).code).toBe("VALIDATION_FAILED");
    }
    expect(await idsOf(A.ownerUserId, 1)).toHaveLength(1);
  });
});
