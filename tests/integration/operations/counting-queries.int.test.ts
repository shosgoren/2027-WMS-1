// T-316a: sayım okuma sorguları (listCountSessions / getCountSession). Gerçek wms_app bağlantısı + RLS; fikstür yalnızca DATABASE_URL_DIRECT ile (sentetik, G-09).
// Kör sayım anahtar düzeyinde sınanır: `field` kipinde referans/fark anahtarı HİÇ yoktur (null değil). Bağımsız kanıt: sayım yazma kuralları counting.int.test.ts'te.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withSystemTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  COUNT_LIST_LIMIT_MAX,
  approveCount,
  cancelCount,
  findAbandonedCounts,
  getCountSession,
  listCountSessions,
  recordCount,
  startCount,
  submitCount,
  type CountSessionCursor,
  type CountSessionView,
} from "../../../packages/domain/src/operations/index.ts";
import { approveDocument, createStockDocument, postDocument, type DocumentLineInput, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { createWarehouse, setMembershipWarehouseScopes } from "../../../packages/domain/src/warehouse/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let MGR: { userId: string; membershipId: string };
let COUNTER: { userId: string; membershipId: string };
let otherWh: string;

const NO_WAIT = { sleep: async () => undefined } as const;
const hex = (n: number): string => randomUUID().replaceAll("-", "").slice(0, n);
const as = (w: TenantWorld, userId: string) => ({ db: app, principal: { userId, mfaVerified: true }, tenantSlug: w.slug });
const owner = (w: TenantWorld) => as(w, w.ownerUserId);
const mgr = () => as(A, MGR.userId);
const counter = () => as(A, COUNTER.userId);
const picker = () => as(A, A.memberUserId);
const cmd = (w: TenantWorld, userId = w.ownerUserId): StockDocCallParams => ({ ...as(w, userId), clientKey: randomUUID(), retry: NO_WAIT });

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

async function mkItem(w: TenantWorld, scale = 0): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T316a urun',$4,'NONE',$5)", [
    w.tenantId, id, `I-${hex(10)}`, w.unitId, scale,
  ]);
  return id;
}
async function mkLoc(w: TenantWorld, warehouseId = w.warehouseId): Promise<string> {
  const id = randomUUID();
  await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,'T316a lok',0,'STORAGE')", [
    w.tenantId, id, warehouseId, `L-${hex(10)}`,
  ]);
  return id;
}
async function stockIn(w: TenantWorld, item: string, loc: string, qty: string): Promise<void> {
  const line: DocumentLineInput = { itemId: item, unitId: w.unitId, quantity: qty, conversionFactor: "1", baseQuantity: qty, targetLocationId: loc, stockStatus: "AVAILABLE" };
  const c = await createStockDocument(cmd(w), { kind: "STOCK_IN", warehouseId: w.warehouseId, lines: [line] });
  const id = c.documentId as string;
  await approveDocument(cmd(w), { documentId: id, expectedVersion: 1 });
  const v = (await q<{ version: number }>("SELECT version FROM public.documents WHERE id = $1", [id]))[0] as { version: number };
  await postDocument(cmd(w), { documentId: id, expectedVersion: v.version });
}
async function start(w: TenantWorld, locs: string[], blind?: boolean, warehouseId = w.warehouseId): Promise<string> {
  return (await startCount(cmd(w), { warehouseId, locationIds: locs, ...(blind === undefined ? {} : { blind }) })).sessionId;
}
/** Nesne ağacındaki TÜM anahtar adları (iç içe dahil). */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

const FIELD_LINE_KEYS = ["counted", "id", "itemCode", "itemId", "itemName", "locationId", "quantityScale", "stockStatus", "unitCode", "unitName"];
const SESSION_KEYS = ["abandoned", "blind", "id", "locationCount", "startedAt", "startedBy", "status", "warehouseCode", "warehouseId", "warehouseName"];

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A316a");
  B = await seedWorld(adm, reg, "B316a");
  const m = await mkUser(adm, reg, "A316a manager");
  MGR = { userId: m, membershipId: await mkMembership(adm, A.tenantId, m, { roles: ["WAREHOUSE_MANAGER"] }) };
  const c = await mkUser(adm, reg, "A316a counter");
  COUNTER = { userId: c, membershipId: await mkMembership(adm, A.tenantId, c, { roles: ["COUNTER"] }) };
  otherWh = (await createWarehouse(owner(A), { code: `s${hex(8)}`, name: "T316a ikinci depo" })).warehouseId;
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("kör sayım sunucuda zorlanır (anahtar düzeyi)", () => {
  it("field kipi: satırda referans/fark anahtarı YOK (null değil, hiç yok); review kipi referans/sayılan/fark metin döner", async () => {
    const X = await mkItem(A);
    for (const blind of [true, false]) {
      const sid = await start(A, [await mkLocWithStock(X, "7")], blind);
      await recordCount(cmd(A, COUNTER.userId), { sessionId: sid, lines: (await lineLocs(sid)).map((l) => ({ locationId: l.location_id, itemId: l.item_id, countedQuantity: "6" })) });
      for (const who of [counter(), picker(), mgr(), owner(A)]) {
        const d = await getCountSession(who, { sessionId: sid, view: "field" });
        expect(d.view).toBe("field");
        expect(d.lines.length).toBeGreaterThan(0);
        for (const line of d.lines) expect(Object.keys(line).sort(), "satır anahtarları beyaz liste").toEqual(FIELD_LINE_KEYS);
        expect(Object.keys(d.session).sort()).toEqual(SESSION_KEYS);
        const keys = allKeys(d);
        for (const forbidden of ["reference", "referenceQuantity", "reference_quantity", "difference", "diff", "systemQuantity", "stockDimensionId"]) expect(keys.has(forbidden), forbidden).toBe(false);
        expect(d.lines.every((l) => l.counted === "6.000000")).toBe(true);
        expect(JSON.stringify(d)).not.toMatch(/7\.000000/); // sistem miktarı (7) hiçbir yerde geçmez
      }
      const r = await getCountSession(mgr(), { sessionId: sid, view: "review" });
      expect(r.view).toBe("review");
      expect(Object.keys(r.lines[0] as object).sort()).toEqual([...FIELD_LINE_KEYS, "difference", "reference"].sort());
      expect(r.lines.map((l) => [l.reference, l.counted, l.difference])).toEqual([["7.000000", "6.000000", "-1.000000"]]);
    }
  });

  it("sayılmamış satır: field counted=null; review difference=null; sayılan referanstan fazlaysa işaret +", async () => {
    const X = await mkItem(A);
    const L = await mkLoc(A);
    await stockIn(A, X, L, "4");
    const sid = await start(A, [L]);
    expect((await getCountSession(counter(), { sessionId: sid, view: "field" })).lines.map((l) => l.counted)).toEqual([null]);
    expect((await getCountSession(owner(A), { sessionId: sid, view: "review" })).lines.map((l) => [l.reference, l.counted, l.difference])).toEqual([["4.000000", null, null]]);
    await recordCount(cmd(A, COUNTER.userId), { sessionId: sid, lines: [{ locationId: L, itemId: X, countedQuantity: "9" }] });
    expect((await getCountSession(owner(A), { sessionId: sid, view: "review" })).lines.map((l) => l.difference)).toEqual(["5.000000"]);
  });

  it("review kipi count_diff.approve ister: COUNTER ve PICKER FORBIDDEN (oturum varlığından önce; var olmayan kimlikte de aynı); geçersiz kip/kimlik VALIDATION_FAILED", async () => {
    const X = await mkItem(A);
    const L = await mkLoc(A);
    await stockIn(A, X, L, "2");
    const sid = await start(A, [L]);
    for (const who of [counter(), picker()]) {
      expect(codeOf(await failure(getCountSession(who, { sessionId: sid, view: "review" })))).toBe("FORBIDDEN");
      expect(codeOf(await failure(getCountSession(who, { sessionId: randomUUID(), view: "review" })))).toBe("FORBIDDEN");
    }
    expect((await getCountSession(mgr(), { sessionId: sid, view: "review" })).view).toBe("review");
    expect(codeOf(await failure(getCountSession(owner(A), { sessionId: sid, view: "x" as never })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(getCountSession(owner(A), { sessionId: "nope", view: "field" })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await failure(getCountSession({ db: app, principal: null, tenantSlug: A.slug }, { sessionId: sid, view: "field" })))).toBe("UNAUTHENTICATED");
  });
});

// Yardımcılar: ikinci test bloğunda tekrar eden fikstür (blind=false/true için ayrı lokasyon + sistem stoku 7).
async function mkLocWithStock(item: string, qty: string): Promise<string> {
  const loc = await mkLoc(A);
  await stockIn(A, item, loc, qty);
  return loc;
}
const lineLocs = (sid: string) => q<{ location_id: string; item_id: string }>("SELECT location_id, item_id FROM public.count_session_lines WHERE session_id = $1", [sid]);

describe("NOT_FOUND tekdüzeliği: yok / başka tenant / kapsam dışı", () => {
  it("başka tenant ve olmayan kimlik aynı NOT_FOUND; liste başka tenant'ı göstermez", async () => {
    const bLoc = await mkLoc(B);
    const bSid = await start(B, [bLoc]);
    const missing = await failure(getCountSession(owner(A), { sessionId: randomUUID(), view: "field" }));
    const foreign = await failure(getCountSession(owner(A), { sessionId: bSid, view: "field" }));
    const foreignReview = await failure(getCountSession(owner(A), { sessionId: bSid, view: "review" }));
    expect(codeOf(missing)).toBe("NOT_FOUND");
    for (const e of [foreign, foreignReview]) {
      expect(codeOf(e)).toBe(codeOf(missing));
      expect(e.message).toBe(missing.message);
    }
    expect((await listCountSessions(owner(A), { limit: COUNT_LIST_LIMIT_MAX })).items.some((s) => s.id === bSid)).toBe(false);
    expect((await listCountSessions(owner(B), { limit: COUNT_LIST_LIMIT_MAX })).items.map((s) => s.id)).toContain(bSid);
    // A'nın üyesi B'nin slug'ıyla: üyelik yok.
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain((await failure(listCountSessions({ ...as(A, A.ownerUserId), tenantSlug: B.slug }))).code);
  });

  it("kapsam dışı depo: liste süzer, tekil okuma (field ve review) aynı NOT_FOUND; bayrak kapalıyken görünür", async () => {
    const X = await mkItem(A);
    const inLoc = await mkLoc(A);
    const outLoc = await mkLoc(A, otherWh);
    await stockIn(A, X, inLoc, "1");
    const inSid = await start(A, [inLoc]);
    const outSid = await start(A, [outLoc], undefined, otherWh);
    await setMembershipWarehouseScopes(cmd(A), { membershipId: MGR.membershipId, warehouseIds: [A.warehouseId] });
    const prev = process.env.WAREHOUSE_SCOPE_ENABLED;
    try {
      delete process.env.WAREHOUSE_SCOPE_ENABLED;
      expect((await getCountSession(mgr(), { sessionId: outSid, view: "review" })).session.id).toBe(outSid);
      process.env.WAREHOUSE_SCOPE_ENABLED = "true";
      const listed = (await listCountSessions(mgr(), { limit: COUNT_LIST_LIMIT_MAX })).items.map((s) => s.id);
      expect(listed).toContain(inSid);
      expect(listed).not.toContain(outSid);
      const missing = await failure(getCountSession(mgr(), { sessionId: randomUUID(), view: "field" }));
      for (const view of ["field", "review"] as const) {
        const e = await failure(getCountSession(mgr(), { sessionId: outSid, view }));
        expect(codeOf(e)).toBe("NOT_FOUND");
        expect(e.message).toBe(missing.message);
        expect((await getCountSession(mgr(), { sessionId: inSid, view })).session.id).toBe(inSid);
      }
      // Kapsamdan muaf yönetici (TENANT_ADMIN) görür.
      expect((await listCountSessions(owner(A), { limit: COUNT_LIST_LIMIT_MAX })).items.map((s) => s.id)).toContain(outSid);
    } finally {
      if (prev === undefined) delete process.env.WAREHOUSE_SCOPE_ENABLED;
      else process.env.WAREHOUSE_SCOPE_ENABLED = prev;
      await setMembershipWarehouseScopes(cmd(A), { membershipId: MGR.membershipId, all: true });
    }
  });
});

describe("terk bayrağı findAbandonedCounts ile tutarlı (tek eşik kaynağı)", () => {
  it("liste ve ayrıntıdaki abandoned, findAbandonedCounts kümesiyle birebir; tenant eşiği değişince birlikte değişir", async () => {
    const L1 = await mkLoc(A);
    const L2 = await mkLoc(A);
    const fresh = await start(A, [L1]);
    const old = await start(A, [L2]);
    const check = () => withSystemTenant(app, A.tenantId, "stock.count.abandon.check", (tx) => findAbandonedCounts(tx, A.tenantId));
    const flags = async (): Promise<Map<string, boolean>> => new Map((await listCountSessions(owner(A), { limit: COUNT_LIST_LIMIT_MAX })).items.map((s) => [s.id, s.abandoned]));
    const consistent = async (): Promise<void> => {
      const abandoned = new Set((await check()).map((a) => a.sessionId));
      const f = await flags();
      for (const [id, flag] of f) expect(flag, id).toBe(abandoned.has(id));
      for (const id of [fresh, old]) expect((await getCountSession(owner(A), { sessionId: id, view: "field" })).session.abandoned).toBe(abandoned.has(id));
    };
    await consistent();
    expect((await flags()).get(old)).toBe(false);
    await q("UPDATE public.location_count_locks SET locked_at = now() - interval '9 hours' WHERE location_id = $1", [L2]);
    await consistent();
    const f9 = await flags();
    expect(f9.get(fresh)).toBe(false);
    expect(f9.get(old)).toBe(true);
    // Tenant eşiği 12 saat: 9 saatlik oturum artık terk değil (bayrak eşikle birlikte değişir).
    await q("UPDATE public.tenant_settings SET count_abandon_hours = 12 WHERE tenant_id = $1", [A.tenantId]);
    try {
      await consistent();
      expect((await flags()).get(old)).toBe(false);
    } finally {
      await q("UPDATE public.tenant_settings SET count_abandon_hours = 8 WHERE tenant_id = $1", [A.tenantId]);
    }
    // Yalnız COUNTING kilitli oturum terk olabilir: iptalden sonra bayrak kalkar.
    await cancelCount(cmd(A), { sessionId: old, reason: "T316a terk iptali" });
    await consistent();
    expect((await flags()).get(old)).toBe(false);
  });
});

describe("listCountSessions: alanlar, süzgeç, sayfalama", () => {
  it("satır alanları: durum, depo, lokasyon sayısı, başlama zamanı (µs), başlatan; ayrıntıda kilitli lokasyonlar", async () => {
    const X = await mkItem(A);
    const L1 = await mkLoc(A);
    const L2 = await mkLoc(A); // stoksuz: satırı yok, kilitli
    await stockIn(A, X, L1, "5");
    const sid = await start(A, [L1, L2]);
    const s = (await listCountSessions(owner(A), { limit: COUNT_LIST_LIMIT_MAX })).items.find((x) => x.id === sid) as CountSessionView;
    expect(s).toMatchObject({ status: "COUNTING", warehouseId: A.warehouseId, blind: true, locationCount: 2, abandoned: false, startedBy: { membershipId: A.ownerMembershipId } });
    expect(s.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(typeof s.startedBy.name).toBe("string");
    const d = await getCountSession(owner(A), { sessionId: sid, view: "field" });
    expect(d.locations.map((l) => [l.id, l.locked]).sort()).toEqual([[L1, true], [L2, true]].sort());
    expect(d.session.locationCount).toBe(2);
    // İptalden sonra kilit yok; satırı olan lokasyon kalır (kapalı oturumda yalnız satırlar bilinir: A-316a-1).
    await cancelCount(cmd(A), { sessionId: sid, reason: "T316a kapanis" });
    const closed = await getCountSession(owner(A), { sessionId: sid, view: "field" });
    expect(closed.session.status).toBe("CANCELLED");
    expect(closed.locations).toEqual([expect.objectContaining({ id: L1, locked: false })]);
  });

  it("durum süzgeci ve keyset sayfalama: yeniden eskiye, kopya/atlama yok; geçersiz limit/imleç/durum VALIDATION_FAILED", async () => {
    const X = await mkItem(A);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const L = await mkLoc(A);
      await stockIn(A, X, L, "1");
      made.push(await start(A, [L]));
    }
    // Biri SUBMITTED yapılır.
    const first = made[0] as string;
    const fl = (await lineLocs(first))[0] as { location_id: string; item_id: string };
    await recordCount(cmd(A, COUNTER.userId), { sessionId: first, lines: [{ locationId: fl.location_id, itemId: fl.item_id, countedQuantity: "1" }] });
    await submitCount(cmd(A, COUNTER.userId), { sessionId: first });
    await approveCount(cmd(A, MGR.userId), { sessionId: first });

    const all: CountSessionView[] = [];
    let after: CountSessionCursor | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const p = await listCountSessions(owner(A), { limit: 2, ...(after === undefined ? {} : { afterKey: after }) });
      expect(p.items.length).toBeLessThanOrEqual(2);
      all.push(...p.items);
      if (p.next === null) break;
      expect(p.items.length).toBe(2);
      after = p.next;
    }
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size, "kopya yok").toBe(ids.length);
    for (const id of made) expect(ids).toContain(id);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1] as CountSessionView;
      const b = all[i] as CountSessionView;
      expect(a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.id > b.id), "started_at DESC, id DESC").toBe(true);
    }
    // Tam liste tek sayfayla aynı sırada.
    expect((await listCountSessions(owner(A), { limit: COUNT_LIST_LIMIT_MAX })).items.map((s) => s.id).slice(0, ids.length)).toEqual(ids.slice(0, COUNT_LIST_LIMIT_MAX));

    const approved = (await listCountSessions(owner(A), { status: "APPROVED", limit: COUNT_LIST_LIMIT_MAX })).items;
    expect(approved.map((s) => s.id)).toContain(first);
    expect(approved.every((s) => s.status === "APPROVED")).toBe(true);
    expect((await listCountSessions(owner(A), { status: "COUNTING", limit: COUNT_LIST_LIMIT_MAX })).items.some((s) => s.id === first)).toBe(false);

    const bad = (input: Parameters<typeof listCountSessions>[1]) => failure(listCountSessions(owner(A), input)).then(codeOf);
    for (const limit of [0, -1, 1.5, COUNT_LIST_LIMIT_MAX + 1, Number.NaN]) expect(await bad({ limit })).toBe("VALIDATION_FAILED");
    expect(await bad({ status: "BOGUS" as never })).toBe("VALIDATION_FAILED");
    expect(await bad({ afterKey: { startedAt: "2026-01-01", id: randomUUID() } })).toBe("VALIDATION_FAILED");
    expect(await bad({ afterKey: { startedAt: "2026-13-45T00:00:00.000000Z", id: randomUUID() } })).toBe("VALIDATION_FAILED");
    expect(await bad({ afterKey: { startedAt: "2026-01-01T00:00:00.000000Z", id: "x" } })).toBe("VALIDATION_FAILED");
  });
});
