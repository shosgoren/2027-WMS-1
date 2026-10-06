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

afterEach(async () => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
  // Kapsam satırları testten bağımsız temizlenir (başarısız test sonraki testi etkilemesin).
  await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]);
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
    expect((await failure(setMembershipWarehouseScopes(picker(A), { membershipId: A.memberMembershipId, all: true }))).code).toBe("FORBIDDEN");
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
    expect((await failure(getLocationTree(admin(B), { warehouseId: wh.warehouseId }))).code).toBe("NOT_FOUND");
    expect((await failure(findLocationByCode(admin(B), { warehouseId: wh.warehouseId, code: "s1" }))).code).toBe("NOT_FOUND");
    expect((await failure(archiveLocation(admin(B), { locationId: loc.locationId }))).code).toBe("NOT_FOUND");
    expect((await failure(renameWarehouse(admin(B), { warehouseId: wh.warehouseId, name: "x" }))).code).toBe("NOT_FOUND");
    expect((await failure(createLocation(admin(B), { warehouseId: wh.warehouseId, code: "s2", name: "x", kind: "STORAGE" }))).code).toBe("NOT_FOUND");
    expect((await failure(listWarehouses({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: B.slug }))).code).toBe("NOT_FOUND");
  });
});

describe("review fixes (T-205 inceleme)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("A-100: archiveLocation is IN_USE while a count is running (COUNTING)", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("cn-"), name: "C" });
    const loc = await createLocation(admin(A), { warehouseId, code: "c1", name: "C", kind: "STORAGE" });
    await adm.query(
      "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = $1",
      [loc.locationId, randomUUID(), A.ownerMembershipId],
    );
    expect((await failure(archiveLocation(admin(A), { locationId: loc.locationId }))).detail).toBe("IN_USE");
    await adm.query("UPDATE public.location_count_locks SET status = 'IDLE', count_session_id = NULL, locked_at = NULL, locked_by = NULL WHERE location_id = $1", [loc.locationId]);
    expect(await archiveLocation(admin(A), { locationId: loc.locationId })).toEqual({ archived: true });
  });

  it("audit change_summary never carries a code key", async () => {
    const wh = await createWarehouse(admin(A), { code: uniq("au-"), name: "Au" });
    const loc = await createLocation(admin(A), { warehouseId: wh.warehouseId, code: "au1", name: "Au1", kind: "STORAGE" });
    const r = await adm.query<{ change_summary: Record<string, unknown> }>(
      "SELECT change_summary FROM public.audit_logs WHERE tenant_id = $1 AND entity_id = ANY($2::text[])",
      [A.tenantId, [wh.warehouseId, loc.locationId]],
    );
    expect(r.rows.length).toBe(2);
    for (const row of r.rows) expect(Object.keys(row.change_summary).some((k) => k.toLowerCase().includes("code"))).toBe(false);
  });

  it("cursor values beyond depth/code limits are VALIDATION_FAILED (not 500)", async () => {
    const id = randomUUID();
    expect((await failure(getLocationTree(admin(A), { warehouseId: A.warehouseId, after: { depth: 40000, code: "A", id } }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(getLocationTree(admin(A), { warehouseId: A.warehouseId, after: { depth: 0, code: "A".repeat(65), id } }))).code).toBe("VALIDATION_FAILED");
  });

  it("scope command is closed in a demo tenant (M9)", async () => {
    const userId = (await adm.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T205 demo', $1) RETURNING id", [`t205-${randomUUID().slice(0, 8)}@example.test`])).rows[0]!.id;
    const tenantId = randomUUID();
    const slug = `t205-demo-${randomUUID().slice(0, 8)}`;
    await adm.query("INSERT INTO public.tenants (id, slug, name, status, is_demo) VALUES ($1, $2, 'T205 demo', 'ACTIVE', true)", [tenantId, slug]);
    const m = (await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', true) RETURNING id", [tenantId, userId])).rows[0]!.id;
    await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, 'TENANT_ADMIN')", [tenantId, m]);
    const e = await failure(setMembershipWarehouseScopes({ db: app, principal: { userId, mfaVerified: false }, tenantSlug: slug }, { membershipId: m, all: true }));
    expect(e.code).toBe("FORBIDDEN");
  });

  async function activeUnderArchived(warehouseId: string): Promise<number> {
    const r = await adm.query<{ n: string }>(
      `SELECT count(*) AS n FROM public.locations c
         LEFT JOIN public.locations p ON p.id = c.parent_id
         JOIN public.warehouses w ON w.id = c.warehouse_id
        WHERE c.warehouse_id = $1 AND c.status = 'ACTIVE' AND (p.status = 'ARCHIVED' OR w.status = 'ARCHIVED')`,
      [warehouseId],
    );
    return Number(r.rows[0]?.n);
  }

  it("race archiveLocation(parent) vs createLocation(child): exactly one wins, no active child under an archived parent", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("r1-"), name: "R" });
    for (let i = 0; i < 12; i++) {
      const parent = await createLocation(admin(A), { warehouseId, code: `p${i}`, name: "P", kind: "STORAGE" });
      const calls = [
        () => archiveLocation(admin(A), { locationId: parent.locationId }),
        () => createLocation(admin(A), { warehouseId, parentId: parent.locationId, code: `c${i}`, name: "C", kind: "STORAGE" }),
      ];
      if (i % 2 === 1) calls.reverse();
      if (i % 3 === 0) await sleep(0);
      const res = await Promise.allSettled(calls.map((f) => f()));
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((rej.reason as AppError).detail === "IN_USE" || (rej.reason as AppError).detail === "PARENT_INVALID").toBe(true);
      expect(await activeUnderArchived(warehouseId)).toBe(0);
    }
  });

  it("race archiveWarehouse vs createLocation: exactly one wins, no active location in an archived warehouse", async () => {
    for (let i = 0; i < 12; i++) {
      const { warehouseId } = await createWarehouse(admin(A), { code: uniq("r2-"), name: "R" });
      const calls = [
        () => archiveWarehouse(admin(A), { warehouseId }),
        () => createLocation(admin(A), { warehouseId, code: "n1", name: "N", kind: "STORAGE" }),
      ];
      if (i % 2 === 1) calls.reverse();
      const res = await Promise.allSettled(calls.map((f) => f()));
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await activeUnderArchived(warehouseId)).toBe(0);
    }
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
    expect(await findLocationByCode(picker(A), { warehouseId: other, code: "yok" })).toBeNull();
    expect((await listWarehouses(picker(A))).items.some((w) => w.id === other)).toBe(true);
  });

  it("flag on: admin always passes; no scope rows = all; rows restrict to the listed warehouses", async () => {
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    const other = await newWarehouse();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, all: true });
    await expect(check(A, "member", [other, A.warehouseId])).resolves.toBeUndefined();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId] });
    await expect(check(A, "member", [A.warehouseId])).resolves.toBeUndefined();
    const e = await failure(check(A, "member", [A.warehouseId, other]));
    expect(e.code).toBe("FORBIDDEN");
    expect(e.detail).toBe("WAREHOUSE_OUT_OF_SCOPE");
    // kapsam dışı kart/okuma: varlık sızmaz → NOT_FOUND (var olmayan depoyla aynı yanıt)
    expect((await failure(getLocationTree(picker(A), { warehouseId: other }))).code).toBe("NOT_FOUND");
    expect((await failure(findLocationByCode(picker(A), { warehouseId: other, code: "x" }))).code).toBe("NOT_FOUND");
    expect((await failure(getLocationTree(picker(A), { warehouseId: randomUUID() }))).code).toBe("NOT_FOUND");
    expect((await listWarehouses(picker(A))).items.map((w) => w.id)).toEqual([A.warehouseId]);
    // TENANT_ADMIN kapsam satırı olsa da geçer
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.ownerMembershipId, warehouseIds: [A.warehouseId] });
    await expect(check(A, "owner", [other])).resolves.toBeUndefined();
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.ownerMembershipId, all: true });
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, all: true });
  });

  it("setMembershipWarehouseScopes validates targets, replaces rows and audits; cross-tenant ids are rejected", async () => {
    const w = await newWarehouse();
    expect(await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [w, w, A.warehouseId] })).toEqual({
      changed: true,
      all: false,
      warehouseIds: [A.warehouseId, w].sort(),
    });
    // aynı liste → changed:false, yeni audit yok
    const n1 = await auditCount(A.tenantId, "warehouse_scope.changed", A.memberMembershipId);
    expect((await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [A.warehouseId, w] })).changed).toBe(false);
    expect(await auditCount(A.tenantId, "warehouse_scope.changed", A.memberMembershipId)).toBe(n1);
    // belirsiz girdiler: boş liste, ikisi birden, hiçbiri
    for (const bad of [{ warehouseIds: [] }, { all: true, warehouseIds: [w] }, {}]) {
      expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, ...bad } as never))).code).toBe("VALIDATION_FAILED");
    }
    expect(await auditCount(A.tenantId, "warehouse_scope.changed", A.memberMembershipId)).toBeGreaterThan(0);
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, warehouseIds: [B.warehouseId] }))).code).toBe("NOT_FOUND");
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: B.memberMembershipId, all: true }))).code).toBe("NOT_FOUND");
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: "x", all: true }))).code).toBe("VALIDATION_FAILED");
    await setMembershipWarehouseScopes(admin(A), { membershipId: A.memberMembershipId, all: true });
    const rows = await adm.query("SELECT 1 FROM public.membership_warehouse_scopes WHERE membership_id = $1", [A.memberMembershipId]);
    expect(rows.rowCount).toBe(0);
  });
});
