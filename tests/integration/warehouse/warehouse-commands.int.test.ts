// T-205: depo/lokasyon komutları + depo kapsamı denetimi (A-45, A-68, A-77, A-83, A-86). Gerçek wms_app bağlantısı + RLS.
// Fikstürler sentetik (G-09). audit_logs değişmez olduğundan test tenant'ları geçici Testcontainers ortamında kalır.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  archiveLocation,
  archiveWarehouse,
  assertWarehouseInScope,
  createLocation,
  createWarehouse,
  findLocationByCode,
  getLocationTree,
  listWarehouses,
  renameLocation,
  renameWarehouse,
  setLocationKind,
  setMembershipWarehouseScopes,
} from "../../../packages/domain/src/warehouse/index.ts";
import { runTenantCommand } from "../../../packages/domain/src/identity/access.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

const admin = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const uniq = (p: string): string => `${p}${randomUUID().slice(0, 8)}`;
async function auditCount(tenantId: string, action: string, entityId: string): Promise<number> {
  const r = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = $2 AND entity_id = $3", [tenantId, action, entityId]);
  return Number(r.rows[0]?.n);
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A205");
  B = await seedWorld(adm, reg, "B205");
}, 120_000);

afterEach(() => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
});

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("warehouse commands", () => {
  it("creates, renames, lists and archives a warehouse with audit rows", async () => {
    const code = uniq("w-");
    const { warehouseId } = await createWarehouse(admin(A), { code: ` ${code} `, name: " Ana Depo " });
    expect(await auditCount(A.tenantId, "warehouse.created", warehouseId)).toBe(1);
    const listed = await listWarehouses(admin(A));
    const row = listed.items.find((w) => w.id === warehouseId);
    expect(row).toMatchObject({ code: code.toUpperCase(), name: "Ana Depo", status: "ACTIVE" });

    expect(await renameWarehouse(admin(A), { warehouseId, name: "Yeni Ad" })).toEqual({ changed: true });
    expect(await renameWarehouse(admin(A), { warehouseId, name: "Yeni Ad" })).toEqual({ changed: false });
    expect(await auditCount(A.tenantId, "warehouse.updated", warehouseId)).toBe(1);

    expect(await archiveWarehouse(admin(A), { warehouseId })).toEqual({ archived: true });
    expect(await archiveWarehouse(admin(A), { warehouseId })).toEqual({ archived: false });
    expect(await auditCount(A.tenantId, "warehouse.archived", warehouseId)).toBe(1);
    expect((await listWarehouses(admin(A))).items.some((w) => w.id === warehouseId)).toBe(false);
    expect((await listWarehouses(admin(A), { includeArchived: true })).items.some((w) => w.id === warehouseId)).toBe(true);
  });

  it("rejects a duplicate code (also under concurrency) with VALIDATION_FAILED/CODE_TAKEN", async () => {
    const code = uniq("dup-");
    await createWarehouse(admin(A), { code, name: "x" });
    const e = await failure(createWarehouse(admin(A), { code: code.toUpperCase(), name: "y" }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toBe("CODE_TAKEN");
    const race = uniq("race-");
    const res = await Promise.allSettled([createWarehouse(admin(A), { code: race, name: "1" }), createWarehouse(admin(A), { code: race, name: "2" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as AppError).detail).toBe("CODE_TAKEN");
  });

  it("same code is allowed in a different tenant (tenant-scoped uniqueness)", async () => {
    const code = uniq("same-");
    await createWarehouse(admin(A), { code, name: "a" });
    await expect(createWarehouse(admin(B), { code, name: "b" })).resolves.toBeDefined();
  });

  it("PICKER cannot write (settings.manage) but can read", async () => {
    expect((await failure(createWarehouse(picker(A), { code: uniq("p-"), name: "n" }))).code).toBe("FORBIDDEN");
    expect((await failure(createLocation(picker(A), { warehouseId: A.warehouseId, code: uniq("p-"), name: "n", kind: "STORAGE" }))).code).toBe("FORBIDDEN");
    expect((await failure(archiveLocation(picker(A), { locationId: A.childLocationId }))).code).toBe("FORBIDDEN");
    expect((await failure(setMembershipWarehouseScopes(picker(A), { membershipId: A.memberMembershipId, warehouseIds: [] }))).code).toBe("FORBIDDEN");
    expect((await listWarehouses(picker(A))).items.length).toBeGreaterThan(0);
    expect((await getLocationTree(picker(A), { warehouseId: A.warehouseId })).items.length).toBe(2);
  });

  it("rejects invalid input without touching the database", async () => {
    expect((await failure(createWarehouse(admin(A), { code: "  ", name: "n" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(renameWarehouse(admin(A), { warehouseId: "nope", name: "n" }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(renameWarehouse(admin(A), { warehouseId: randomUUID(), name: "n" }))).code).toBe("NOT_FOUND");
  });

  it("archive is IN_USE while active locations or positive stock exist", async () => {
    const e = await failure(archiveWarehouse(admin(A), { warehouseId: A.warehouseId }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.detail).toBe("IN_USE");
  });
});

describe("location commands", () => {
  it("builds a tree with depth = parent + 1, lock rows and audit", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("t-"), name: "Agac" });
    const root = await createLocation(admin(A), { warehouseId, code: "z1", name: "Bolge", kind: "RECEIVING" });
    expect(root.depth).toBe(0);
    const shelf = await createLocation(admin(A), { warehouseId, parentId: root.locationId, code: "r1", name: "Raf", kind: "STORAGE" });
    const slot = await createLocation(admin(A), { warehouseId, parentId: shelf.locationId, code: "g1", name: "Goz", kind: "STORAGE" });
    expect([shelf.depth, slot.depth]).toEqual([1, 2]);
    expect(await auditCount(A.tenantId, "location.created", slot.locationId)).toBe(1);
    const locks = await adm.query("SELECT 1 FROM public.location_count_locks WHERE location_id = ANY($1::uuid[]) AND status = 'IDLE'", [[root.locationId, shelf.locationId, slot.locationId]]);
    expect(locks.rowCount).toBe(3);

    const tree = await getLocationTree(admin(A), { warehouseId });
    expect(tree.items.map((l) => [l.code, l.depth])).toEqual([["Z1", 0], ["R1", 1], ["G1", 2]]);
    // keyset sayfalama: OFFSET yok, imleç (depth, code, id)
    const p1 = await getLocationTree(admin(A), { warehouseId, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await getLocationTree(admin(A), { warehouseId, limit: 2, after: p1.next! });
    expect(p2.items.map((l) => l.code)).toEqual(["G1"]);
    expect(p2.next).toBeNull();

    const found = await findLocationByCode(admin(A), { warehouseId, code: " r1 " });
    expect(found?.id).toBe(shelf.locationId);
    expect(await findLocationByCode(admin(A), { warehouseId, code: "yok" })).toBeNull();
  });

  it("rejects duplicate code (CODE_TAKEN), TRANSIT under a parent and invalid parents (PARENT_INVALID)", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("v-"), name: "V" });
    const root = await createLocation(admin(A), { warehouseId, code: "k1", name: "Kok", kind: "STORAGE" });
    expect((await failure(createLocation(admin(A), { warehouseId, code: "K1", name: "x", kind: "STORAGE" }))).detail).toBe("CODE_TAKEN");
    expect((await failure(createLocation(admin(A), { warehouseId, parentId: root.locationId, code: "t1", name: "x", kind: "TRANSIT" }))).detail).toBe("PARENT_INVALID");
    await expect(createLocation(admin(A), { warehouseId, code: "t1", name: "Transit", kind: "TRANSIT" })).resolves.toBeDefined();
    // ebeveyn başka depoda
    const other = await createWarehouse(admin(A), { code: uniq("o-"), name: "O" });
    expect((await failure(createLocation(admin(A), { warehouseId: other.warehouseId, parentId: root.locationId, code: "c1", name: "x", kind: "STORAGE" }))).detail).toBe("PARENT_INVALID");
    // ebeveyn yok
    expect((await failure(createLocation(admin(A), { warehouseId, parentId: randomUUID(), code: "c2", name: "x", kind: "STORAGE" }))).detail).toBe("PARENT_INVALID");
    // arşivli ebeveyn
    const leaf = await createLocation(admin(A), { warehouseId, code: "a1", name: "A", kind: "STORAGE" });
    await archiveLocation(admin(A), { locationId: leaf.locationId });
    expect((await failure(createLocation(admin(A), { warehouseId, parentId: leaf.locationId, code: "c3", name: "x", kind: "STORAGE" }))).detail).toBe("PARENT_INVALID");
    expect((await failure(createLocation(admin(A), { warehouseId: randomUUID(), code: "c4", name: "x", kind: "STORAGE" }))).code).toBe("NOT_FOUND");
  });

  it("archives bottom-up; the lock row stays; archived warehouse accepts no new location", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("a-"), name: "A" });
    const root = await createLocation(admin(A), { warehouseId, code: "x1", name: "X", kind: "STORAGE" });
    const child = await createLocation(admin(A), { warehouseId, parentId: root.locationId, code: "x2", name: "Y", kind: "STORAGE" });
    expect((await failure(archiveLocation(admin(A), { locationId: root.locationId }))).detail).toBe("IN_USE");
    expect(await archiveLocation(admin(A), { locationId: child.locationId })).toEqual({ archived: true });
    expect(await archiveLocation(admin(A), { locationId: child.locationId })).toEqual({ archived: false });
    expect(await archiveLocation(admin(A), { locationId: root.locationId })).toEqual({ archived: true });
    const lock = await adm.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1", [root.locationId]);
    expect(lock.rowCount).toBe(1);
    expect(await auditCount(A.tenantId, "location.archived", root.locationId)).toBe(1);
    expect((await failure(renameLocation(admin(A), { locationId: root.locationId, name: "Z" }))).code).toBe("VALIDATION_FAILED");
    await expect(archiveWarehouse(admin(A), { warehouseId })).resolves.toEqual({ archived: true });
    expect((await failure(createLocation(admin(A), { warehouseId, code: "n1", name: "N", kind: "STORAGE" }))).code).toBe("VALIDATION_FAILED");
  });

  it("blocks archive and kind change while positive stock exists (IN_USE); rename still works", async () => {
    // fikstür: A.dimensionId (10 adet) kökte, seri boyutu (1 adet) çocukta
    expect((await failure(archiveLocation(admin(A), { locationId: A.childLocationId }))).detail).toBe("IN_USE");
    expect((await failure(setLocationKind(admin(A), { locationId: A.childLocationId, kind: "STAGING" }))).detail).toBe("IN_USE");
    expect(await renameLocation(admin(A), { locationId: A.childLocationId, name: "Raf 1b" })).toEqual({ changed: true });
    expect(await auditCount(A.tenantId, "location.updated", A.childLocationId)).toBe(1);
  });

  it("changes kind only at zero balance and never to TRANSIT under a parent", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("k-"), name: "K" });
    const root = await createLocation(admin(A), { warehouseId, code: "q1", name: "Q", kind: "STORAGE" });
    const child = await createLocation(admin(A), { warehouseId, parentId: root.locationId, code: "q2", name: "Q2", kind: "STORAGE" });
    expect(await setLocationKind(admin(A), { locationId: root.locationId, kind: "STAGING" })).toEqual({ changed: true });
    expect(await setLocationKind(admin(A), { locationId: root.locationId, kind: "STAGING" })).toEqual({ changed: false });
    expect(await setLocationKind(admin(A), { locationId: root.locationId, kind: "TRANSIT" })).toEqual({ changed: true });
    expect((await failure(setLocationKind(admin(A), { locationId: child.locationId, kind: "TRANSIT" }))).detail).toBe("PARENT_INVALID");
    expect((await failure(setLocationKind(admin(A), { locationId: child.locationId, kind: "BOGUS" as never }))).code).toBe("VALIDATION_FAILED");
  });

  it("does not expose tenant A cards to tenant B and denies A's user on B's slug", async () => {
    const code = uniq("iso-");
    const wh = await createWarehouse(admin(A), { code, name: "Gizli" });
    const loc = await createLocation(admin(A), { warehouseId: wh.warehouseId, code: "s1", name: "S", kind: "STORAGE" });
    expect((await listWarehouses(admin(B))).items.some((w) => w.id === wh.warehouseId)).toBe(false);
    expect((await getLocationTree(admin(B), { warehouseId: wh.warehouseId })).items).toEqual([]);
    expect(await findLocationByCode(admin(B), { warehouseId: wh.warehouseId, code: "s1" })).toBeNull();
    expect((await failure(archiveLocation(admin(B), { locationId: loc.locationId }))).code).toBe("NOT_FOUND");
    expect((await failure(renameWarehouse(admin(B), { warehouseId: wh.warehouseId, name: "x" }))).code).toBe("NOT_FOUND");
    expect((await failure(createLocation(admin(B), { warehouseId: wh.warehouseId, code: "s2", name: "x", kind: "STORAGE" }))).code).toBe("NOT_FOUND");
    expect((await failure(listWarehouses({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: B.slug }))).code).toBe("NOT_FOUND");
  });
});

describe("warehouse scope (A-77, flag WAREHOUSE_SCOPE_ENABLED)", () => {
  async function newWarehouse(): Promise<string> {
    return (await createWarehouse(admin(A), { code: uniq("sc-"), name: "Kapsam" })).warehouseId;
  }
  async function check(w: TenantWorld, who: "owner" | "member", ids: string[]): Promise<void> {
    const principal = { userId: who === "owner" ? w.ownerUserId : w.memberUserId, mfaVerified: true };
    await runTenantCommand({ db: app, principal, tenantSlug: w.slug, permission: "stock.view" }, (tx, m) => assertWarehouseInScope(tx, m, ids));
  }

  it("flag off (default): scope rows are ignored, everything is reachable", async () => {
    const other = await newWarehouse();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });
    await expect(check(A, "member", [other])).resolves.toBeUndefined();
    expect((await getLocationTree(picker(A), { warehouseId: other })).items).toEqual([]);
    expect((await listWarehouses(picker(A))).items.some((w) => w.id === other)).toBe(true);
  });

  it("flag on: admin always passes; no scope rows = all; rows restrict to the listed warehouses", async () => {
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const other = await newWarehouse();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [] });
    await expect(check(A, "member", [other, A.warehouseId])).resolves.toBeUndefined();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });
    await expect(check(A, "member", [A.warehouseId])).resolves.toBeUndefined();
    const e = await failure(check(A, "member", [A.warehouseId, other]));
    expect(e.code).toBe("FORBIDDEN");
    expect(e.detail).toBe("WAREHOUSE_OUT_OF_SCOPE");
    expect((await failure(getLocationTree(picker(A), { warehouseId: other }))).detail).toBe("WAREHOUSE_OUT_OF_SCOPE");
    expect((await listWarehouses(picker(A))).items.map((w) => w.id)).toEqual([A.warehouseId]);
    // TENANT_ADMIN kapsam satırı olsa da geçer
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.ownerMembershipId, warehouseIds: [A.warehouseId] });
    await expect(check(A, "owner", [other])).resolves.toBeUndefined();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.ownerMembershipId, warehouseIds: [] });
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [] });
  });

  it("setMembershipWarehouseScopes validates targets, replaces rows and audits; cross-tenant ids are rejected", async () => {
    const w = await newWarehouse();
    expect(await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [w, w, A.warehouseId] })).toEqual({ warehouseIds: [A.warehouseId, w].sort() });
    expect(await auditCount(A.tenantId, "warehouse_scope.changed", A.memberMembershipId)).toBeGreaterThan(0);
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [B.warehouseId] }))).code).toBe("NOT_FOUND");
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: B.memberMembershipId, warehouseIds: [] }))).code).toBe("NOT_FOUND");
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: "x", warehouseIds: [] }))).code).toBe("VALIDATION_FAILED");
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [] });
    const rows = await adm.query("SELECT 1 FROM public.membership_warehouse_scopes WHERE membership_id = $1", [A.memberMembershipId]);
    expect(rows.rowCount).toBe(0);
  });
});
