// T-215 (qa-verifier): depo/lokasyon komutlarının uygulayıcıdan bağımsız doğrulaması. Gerçek `wms_app` bağlantısı + RLS; kurulum
// (stok fikstürü, kapsam satırı) migration rolüyle. Fikstürler sentetik (G-09). Kanıtlar:
//   1. Her lokasyon tam bir sayım kilidi satırıyla doğar (50 eşzamanlı createLocation; geri alma; yarış/çakışma sonrası yetim yok)
//   2. `IN_USE`: pozitif bakiye (spec 16 §Uçtan uca senaryo: 10 - 3 + 1 - 1 = 7), aktif alt lokasyon, setLocationKind
//   3. Yetki (A-68): WAREHOUSE_MANAGER / PICKER / READ_ONLY / COUNTER yazamaz, `stock.view` ile okur
//   4. Depo kapsamı (A-77): bayrak kapalı = kapsam satırları yok sayılır; açık = yalnızca listelenenler; TENANT_ADMIN her zaman tümü
//   5. Özellik: rastgele defter dizileri için Σ defter == bakiye ve arşiv `IN_USE` <=> bakiye > 0
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../../../packages/domain/node_modules/drizzle-orm/index.js";
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
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
const users: Record<"admin" | "manager" | "picker" | "counter" | "readOnly", { userId: string; membershipId: string }> = {} as never;

const call = (w: TenantWorld, who: keyof typeof users) => ({
  db: app,
  principal: { userId: who === "admin" ? w.ownerUserId : users[who].userId, mfaVerified: true },
  tenantSlug: w.slug,
});
const admin = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const uniq = (p: string): string => `${p}${randomBytes(4).toString("hex")}`;

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}

/** Tenant'ın tüm lokasyonlarının kilit satırı sayıları (invariant: her lokasyon için tam 1 satır). */
async function lockInvariant(tenantId: string): Promise<{ locations: number; locks: number; idle: number; withoutLock: number; withoutLocation: number }> {
  const r = await adm.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM public.locations WHERE tenant_id = $1) AS locations,
            (SELECT count(*) FROM public.location_count_locks WHERE tenant_id = $1) AS locks,
            (SELECT count(*) FROM public.location_count_locks WHERE tenant_id = $1 AND status = 'IDLE') AS idle,
            (SELECT count(*) FROM public.locations l WHERE l.tenant_id = $1
               AND NOT EXISTS (SELECT 1 FROM public.location_count_locks k WHERE k.location_id = l.id)) AS without_lock,
            (SELECT count(*) FROM public.location_count_locks k WHERE k.tenant_id = $1
               AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = k.location_id)) AS without_location`,
    [tenantId],
  );
  const x = r.rows[0]!;
  return { locations: Number(x.locations), locks: Number(x.locks), idle: Number(x.idle), withoutLock: Number(x.without_lock), withoutLocation: Number(x.without_location) };
}

/**
 * Stok fikstürü (migration rolü, defter + bakiye AYNI transaction, tenant bağlamıyla — ertelenmiş mutlak denetim ister).
 * `entries` işaretli defter satırlarıdır (spec 16 kural 1); bakiye = Σ. Boyut `NONE` izlemeli ürünün bu lokasyondaki boyutudur.
 */
async function seedStock(w: TenantWorld, locationId: string, entries: readonly number[]): Promise<string> {
  const dim = randomUUID();
  const total = entries.reduce((a, b) => a + b, 0);
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [w.tenantId]);
    await adm.query("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id) VALUES ($1, $2, $3, $4, NULL, NULL)", [
      w.tenantId,
      dim,
      w.itemNoneId,
      locationId,
    ]);
    for (const q of entries) {
      await adm.query(
        `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'T215 fikstur', '2026-01-15', $7)`,
        [w.tenantId, randomUUID(), w.documentId, w.documentLineNoneId, dim, q, w.ownerUserId],
      );
    }
    await adm.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, $2, $3, 0)", [w.tenantId, dim, total]);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
  return dim;
}

/** Defter satırı ekler ve bakiyeyi aynı transaction'da yeni toplama çeker (hareket). */
async function postLedger(w: TenantWorld, dim: string, qty: number): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [w.tenantId]);
    await adm.query(
      `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'T215 hareket', '2026-01-16', $7)`,
      [w.tenantId, randomUUID(), w.documentId, w.documentLineNoneId, dim, qty, w.ownerUserId],
    );
    await adm.query("UPDATE public.stock_balances SET quantity = quantity + $3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [w.tenantId, dim, qty]);
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
}

async function ledgerVsBalance(dim: string): Promise<{ ledger: number; balance: number }> {
  const r = await adm.query<{ ledger: string; balance: string }>(
    `SELECT (SELECT COALESCE(sum(quantity), 0) FROM public.stock_ledger WHERE stock_dimension_id = $1) AS ledger,
            (SELECT quantity FROM public.stock_balances WHERE stock_dimension_id = $1) AS balance`,
    [dim],
  );
  return { ledger: Number(r.rows[0]!.ledger), balance: Number(r.rows[0]!.balance) };
}

async function mkRole(w: TenantWorld, tag: string, role: string): Promise<{ userId: string; membershipId: string }> {
  const userId = await mkUser(adm, reg, tag);
  const membershipId = await mkMembership(adm, w.tenantId, userId, { roles: [role] });
  return { userId, membershipId };
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A215q");
  B = await seedWorld(adm, reg, "B215q");
  users.manager = await mkRole(A, "mgr215", "WAREHOUSE_MANAGER");
  users.picker = { userId: A.memberUserId, membershipId: A.memberMembershipId };
  users.counter = await mkRole(A, "cnt215", "COUNTER");
  users.readOnly = await mkRole(A, "ro215", "READ_ONLY");
  users.admin = { userId: A.ownerUserId, membershipId: A.ownerMembershipId };
}, 180_000);

afterEach(async () => {
  delete process.env.WAREHOUSE_SCOPE_ENABLED;
  await adm.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = ANY($1::uuid[])", [[A.tenantId, B.tenantId]]);
});

afterAll(async () => {
  await adm?.end().catch(() => undefined);
  await app?.close().catch(() => undefined);
}, 60_000);

describe("sayım kilidi satırı (spec 06 §Sayım kilidi yaşam döngüsü: satır önceden vardır)", () => {
  it("50 eşzamanlı createLocation -> 50 lokasyon ve 50 IDLE kilit satırı; kilit satırları boş (count_session_id/locked_by NULL)", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("c50-"), name: "Esli" });
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => createLocation(admin(A), { warehouseId, code: `L${String(i).padStart(2, "0")}`, name: `Lok ${i}`, kind: "STORAGE" })),
    );
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 50 }, () => "fulfilled"));
    const ids = results.map((r) => (r as PromiseFulfilledResult<{ locationId: string }>).value.locationId);
    expect(new Set(ids).size).toBe(50);
    const locs = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.locations WHERE warehouse_id = $1", [warehouseId]);
    expect(Number(locs.rows[0]!.n)).toBe(50);
    const locks = await adm.query<{ status: string; count_session_id: string | null; locked_by: string | null; locked_at: Date | null }>(
      "SELECT status, count_session_id, locked_by, locked_at FROM public.location_count_locks WHERE location_id = ANY($1::uuid[])",
      [ids],
    );
    expect(locks.rows).toHaveLength(50);
    for (const row of locks.rows) expect(row).toEqual({ status: "IDLE", count_session_id: null, locked_by: null, locked_at: null });
    const inv = await lockInvariant(A.tenantId);
    expect(inv.withoutLock).toBe(0);
    expect(inv.withoutLocation).toBe(0);
    expect(inv.locks).toBe(inv.locations);
    expect(inv.idle).toBe(inv.locks);
  });

  it("aynı kodla 20 eşzamanlı createLocation -> tam 1 başarı (19 CODE_TAKEN); yetim/eksik kilit satırı yok", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("dup-"), name: "Dup" });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => createLocation(admin(A), { warehouseId, code: "SAME", name: "x", kind: "STORAGE" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) expect(((r as PromiseRejectedResult).reason as AppError).detail).toBe("CODE_TAKEN");
    const n = await adm.query<{ n: string }>(
      "SELECT count(*) AS n FROM public.location_count_locks k JOIN public.locations l ON l.id = k.location_id WHERE l.warehouse_id = $1",
      [warehouseId],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
    const inv = await lockInvariant(A.tenantId);
    expect(inv.withoutLock).toBe(0);
    expect(inv.withoutLocation).toBe(0);
  });

  it("tetikleyici sonrası transaction geri alınırsa lokasyon da kilit satırı da yoktur (wms_app yolu ve migration rolü)", async () => {
    // wms_app: komut içinde ham INSERT (tetikleyici kilit satırını yaratır), aynı transaction'da kilit satırı GÖRÜNÜR, sonra hata -> ROLLBACK.
    const id = randomUUID();
    let seenInside = -1;
    const boom = new Error("rollback-after-trigger");
    const err = await runTenantCommand({ ...admin(A), permission: "settings.manage" }, async (tx, m) => {
      await tx.execute(
        sql`INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
            VALUES (${m.tenantId}::uuid, ${id}::uuid, ${A.warehouseId}::uuid, NULL, ${uniq("RB")}, 'rb', 0, 'STORAGE')`,
      );
      const r = await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM public.location_count_locks WHERE location_id = ${id}::uuid`);
      seenInside = Number(r[0]!.n);
      throw boom;
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // Erişim katmanı beklenmeyen hatayı maskeler (INTERNAL); asıl kanıt: kilit satırı içeride görüldü (seenInside) ve dışarıda yok.
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL");
    expect(seenInside).toBe(1);
    expect((await adm.query("SELECT 1 FROM public.locations WHERE id = $1", [id])).rowCount).toBe(0);
    expect((await adm.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1", [id])).rowCount).toBe(0);

    // migration rolü (tetikleyici hangi rolle çalışırsa çalışsın aynı atomiklik).
    const id2 = randomUUID();
    await adm.query("BEGIN");
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    await adm.query("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, $4, 'rb', 0, 'STORAGE')", [
      A.tenantId,
      id2,
      A.warehouseId,
      uniq("RB"),
    ]);
    expect((await adm.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1", [id2])).rowCount).toBe(1);
    await adm.query("ROLLBACK");
    expect((await adm.query("SELECT 1 FROM public.locations WHERE id = $1", [id2])).rowCount).toBe(0);
    expect((await adm.query("SELECT 1 FROM public.location_count_locks WHERE location_id = $1", [id2])).rowCount).toBe(0);
  });

  it("arşivleme kilit satırını silmez ve durumunu değiştirmez (IDLE kalır); arşivli lokasyon yine tam 1 satıra sahiptir", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("ar-"), name: "Ar" });
    const loc = await createLocation(admin(A), { warehouseId, code: "A1", name: "A", kind: "STORAGE" });
    await archiveLocation(admin(A), { locationId: loc.locationId });
    const k = await adm.query<{ status: string }>("SELECT status FROM public.location_count_locks WHERE location_id = $1", [loc.locationId]);
    expect(k.rows).toEqual([{ status: "IDLE" }]);
  });
});

describe("IN_USE kuralları", () => {
  it("spec 16 senaryosu: +10 -3 +1 -1 = 7 -> arşiv ve setLocationKind IN_USE; yeniden adlandırma serbest; defter toplamı == bakiye == 7", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("us-"), name: "Us" });
    const loc = await createLocation(admin(A), { warehouseId, code: "S1", name: "S", kind: "STORAGE" });
    const dim = await seedStock(A, loc.locationId, [10, -3, 1, -1]);
    expect(await ledgerVsBalance(dim)).toEqual({ ledger: 7, balance: 7 });
    const e1 = await failure(archiveLocation(admin(A), { locationId: loc.locationId }));
    expect([e1.code, e1.detail]).toEqual(["VALIDATION_FAILED", "IN_USE"]);
    const e2 = await failure(setLocationKind(admin(A), { locationId: loc.locationId, kind: "STAGING" }));
    expect([e2.code, e2.detail]).toEqual(["VALIDATION_FAILED", "IN_USE"]);
    const e3 = await failure(archiveWarehouse(admin(A), { warehouseId }));
    expect([e3.code, e3.detail]).toEqual(["VALIDATION_FAILED", "IN_USE"]);
    expect(await renameLocation(admin(A), { locationId: loc.locationId, name: "S yeni" })).toEqual({ changed: true });
    const st = await adm.query<{ status: string; kind: string }>("SELECT status, kind FROM public.locations WHERE id = $1", [loc.locationId]);
    expect(st.rows).toEqual([{ status: "ACTIVE", kind: "STORAGE" }]);
  });

  it("spec 16 kural 3 (yer değişimi = -/+ çifti): tamamı hedefe taşınınca kaynak arşivlenir, hedef IN_USE kalır", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("mv-"), name: "Mv" });
    const src = await createLocation(admin(A), { warehouseId, code: "SRC", name: "S", kind: "STORAGE" });
    const dst = await createLocation(admin(A), { warehouseId, code: "DST", name: "D", kind: "STORAGE" });
    const dSrc = await seedStock(A, src.locationId, [10]);
    const dDst = await seedStock(A, dst.locationId, [5]);
    expect((await failure(archiveLocation(admin(A), { locationId: src.locationId }))).detail).toBe("IN_USE");
    await postLedger(A, dSrc, -10);
    await postLedger(A, dDst, 10);
    expect(await ledgerVsBalance(dSrc)).toEqual({ ledger: 0, balance: 0 });
    expect(await ledgerVsBalance(dDst)).toEqual({ ledger: 15, balance: 15 });
    expect(await archiveLocation(admin(A), { locationId: src.locationId })).toEqual({ archived: true });
    expect((await failure(archiveLocation(admin(A), { locationId: dst.locationId }))).detail).toBe("IN_USE");
  });

  it("aktif alt lokasyonu olan ebeveynin arşivi IN_USE; çocuk arşivlenince ebeveyn arşivlenir; arşivli ebeveyn altında yeni çocuk PARENT_INVALID", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("pc-"), name: "Pc" });
    const parent = await createLocation(admin(A), { warehouseId, code: "P", name: "P", kind: "STORAGE" });
    const child = await createLocation(admin(A), { warehouseId, parentId: parent.locationId, code: "C", name: "C", kind: "STORAGE" });
    const e = await failure(archiveLocation(admin(A), { locationId: parent.locationId }));
    expect([e.code, e.detail]).toEqual(["VALIDATION_FAILED", "IN_USE"]);
    expect(await archiveLocation(admin(A), { locationId: child.locationId })).toEqual({ archived: true });
    expect(await archiveLocation(admin(A), { locationId: parent.locationId })).toEqual({ archived: true });
    const e2 = await failure(createLocation(admin(A), { warehouseId, parentId: parent.locationId, code: "C2", name: "C", kind: "STORAGE" }));
    expect([e2.code, e2.detail]).toEqual(["VALIDATION_FAILED", "PARENT_INVALID"]);
  });

  it("özellik: rastgele defter dizileri için Σ defter == bakiye ve (arşiv IN_USE <=> bakiye > 0); setLocationKind aynı kurala uyar", async () => {
    const seed = randomBytes(4).readUInt32LE(0);
    let s = seed;
    const rand = (): number => {
      // mulberry32: yeniden üretilebilir; tohum başarısızlık mesajında.
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("pr-"), name: "Pr" });
    for (let i = 0; i < 12; i++) {
      const entries: number[] = [];
      let run = 0;
      const n = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < n; k++) {
        const out = run > 0 && rand() < 0.5;
        const q = out ? -(1 + Math.floor(rand() * run)) : 1 + Math.floor(rand() * 9);
        entries.push(q);
        run += q;
      }
      const loc = await createLocation(admin(A), { warehouseId, code: `P${i}`, name: "P", kind: "STORAGE" });
      const dim = await seedStock(A, loc.locationId, entries);
      const tag = `seed=${seed} i=${i} entries=${JSON.stringify(entries)}`;
      expect(await ledgerVsBalance(dim), tag).toEqual({ ledger: run, balance: run });
      const kindErr = await setLocationKind(admin(A), { locationId: loc.locationId, kind: "STAGING" }).then(
        () => null,
        (e: unknown) => e as AppError,
      );
      if (run > 0) {
        expect(kindErr?.detail, tag).toBe("IN_USE");
        const e = await failure(archiveLocation(admin(A), { locationId: loc.locationId }));
        expect([e.code, e.detail], tag).toEqual(["VALIDATION_FAILED", "IN_USE"]);
      } else {
        // bakiye 0: kind değişimi başarılı (hata yok) ve arşiv serbest.
        expect(kindErr, tag).toBeNull();
        expect(await archiveLocation(admin(A), { locationId: loc.locationId }), tag).toEqual({ archived: true });
      }
    }
  });
});

describe("yetki (A-68): kart yazma settings.manage ister, okuma stock.view", () => {
  it("WAREHOUSE_MANAGER, PICKER, COUNTER, READ_ONLY: her yazma FORBIDDEN ve veritabanı/denetim değişmez; yönetici aynı çağrıyı yapabilir", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("pm-"), name: "Pm" });
    const loc = await createLocation(admin(A), { warehouseId, code: "PM1", name: "P", kind: "STORAGE" });
    const snap = async () => ({
      w: (await adm.query("SELECT id, code, name, status FROM public.warehouses WHERE tenant_id = $1 ORDER BY id", [A.tenantId])).rows,
      l: (await adm.query("SELECT id, code, name, kind, status FROM public.locations WHERE tenant_id = $1 ORDER BY id", [A.tenantId])).rows,
      s: (await adm.query("SELECT membership_id, warehouse_id FROM public.membership_warehouse_scopes WHERE tenant_id = $1 ORDER BY 1, 2", [A.tenantId])).rows,
      a: (await adm.query("SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = $1", [A.tenantId])).rows,
    });
    const before = await snap();
    for (const who of ["manager", "picker", "counter", "readOnly"] as const) {
      const p = call(A, who);
      const writes: Array<[string, () => Promise<unknown>]> = [
        ["createWarehouse", () => createWarehouse(p, { code: uniq("x-"), name: "x" })],
        ["renameWarehouse", () => renameWarehouse(p, { warehouseId, name: "x" })],
        ["archiveWarehouse", () => archiveWarehouse(p, { warehouseId })],
        ["createLocation", () => createLocation(p, { warehouseId, code: uniq("X"), name: "x", kind: "STORAGE" })],
        ["renameLocation", () => renameLocation(p, { locationId: loc.locationId, name: "x" })],
        ["setLocationKind", () => setLocationKind(p, { locationId: loc.locationId, kind: "STAGING" })],
        ["archiveLocation", () => archiveLocation(p, { locationId: loc.locationId })],
        ["setMembershipWarehouseScopes", () => setMembershipWarehouseScopes(p, { membershipId: A.memberMembershipId, all: true })],
      ];
      for (const [name, pr] of writes) expect((await failure(pr())).code, `${who} ${name}`).toBe("FORBIDDEN");
    }
    expect(await snap()).toEqual(before);
    // olumlu kontrol: yönetici aynı yazmayı yapabilir
    expect(await renameLocation(admin(A), { locationId: loc.locationId, name: "P yeni" })).toEqual({ changed: true });
  });

  it("okuma stock.view ile serbest: READ_ONLY / PICKER / COUNTER / WAREHOUSE_MANAGER listeler, ağaç ve kod aramasını okur", async () => {
    const { warehouseId } = await createWarehouse(admin(A), { code: uniq("rd-"), name: "Rd" });
    const loc = await createLocation(admin(A), { warehouseId, code: "RD1", name: "R", kind: "STORAGE" });
    for (const who of ["manager", "picker", "counter", "readOnly"] as const) {
      const p = call(A, who);
      expect((await listWarehouses(p)).items.some((w) => w.id === warehouseId), who).toBe(true);
      expect((await getLocationTree(p, { warehouseId })).items.map((l) => l.id), who).toEqual([loc.locationId]);
      expect((await findLocationByCode(p, { warehouseId, code: "rd1" }))?.id, who).toBe(loc.locationId);
    }
  });

  it("başka tenant'ın slug'ında yetkisiz: A'nın yöneticisi B slug'ında hiçbir okuma/yazma yapamaz (NOT_FOUND), B'nin kartı görünmez", async () => {
    const cross = { db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: B.slug };
    expect((await failure(listWarehouses(cross))).code).toBe("NOT_FOUND");
    expect((await failure(createWarehouse(cross, { code: uniq("x-"), name: "x" }))).code).toBe("NOT_FOUND");
    expect((await failure(getLocationTree(admin(A), { warehouseId: B.warehouseId }))).code).toBe("NOT_FOUND");
    expect((await failure(archiveLocation(admin(A), { locationId: B.childLocationId }))).code).toBe("NOT_FOUND");
    const st = await adm.query<{ status: string }>("SELECT status FROM public.locations WHERE id = $1", [B.childLocationId]);
    expect(st.rows).toEqual([{ status: "ACTIVE" }]);
  });
});

describe("depo kapsamı (A-77, WAREHOUSE_SCOPE_ENABLED)", () => {
  async function scopedWorld(): Promise<{ w1: string; w2: string }> {
    const w1 = (await createWarehouse(admin(A), { code: uniq("s1-"), name: "S1" })).warehouseId;
    const w2 = (await createWarehouse(admin(A), { code: uniq("s2-"), name: "S2" })).warehouseId;
    await adm.query("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [A.tenantId, users.picker.membershipId, w1]);
    return { w1, w2 };
  }
  const inScope = (who: keyof typeof users, ids: string[]): Promise<void> =>
    runTenantCommand({ ...call(A, who), permission: "stock.view" }, (tx, m) => assertWarehouseInScope(tx, m, ids));

  it("bayrak tanımsız/kapalı değerler: kapsam satırı olan PICKER tüm depoları görür ve her depo kapsamda sayılır", async () => {
    const { w1, w2 } = await scopedWorld();
    for (const v of [undefined, "false", "0", "", "yes", "enabled"]) {
      if (v === undefined) delete process.env.WAREHOUSE_SCOPE_ENABLED;
      else process.env.WAREHOUSE_SCOPE_ENABLED = v;
      const ids = (await listWarehouses(call(A, "picker"))).items.map((w) => w.id);
      expect(ids.includes(w1) && ids.includes(w2), `flag=${String(v)}`).toBe(true);
      await expect(inScope("picker", [w1, w2])).resolves.toBeUndefined();
      expect((await getLocationTree(call(A, "picker"), { warehouseId: w2 })).items, `flag=${String(v)}`).toEqual([]);
    }
  });

  it("bayrak açık (true/1/TRUE): PICKER yalnızca kapsamındaki depoyu görür; kapsam dışı depo -> FORBIDDEN/WAREHOUSE_OUT_OF_SCOPE (stok komutu), NOT_FOUND (kart okuma)", async () => {
    const { w1, w2 } = await scopedWorld();
    for (const v of ["true", "1", "TRUE"]) {
      process.env.WAREHOUSE_SCOPE_ENABLED = v;
      expect((await listWarehouses(call(A, "picker"))).items.map((w) => w.id), v).toEqual([w1]);
      await expect(inScope("picker", [w1])).resolves.toBeUndefined();
      const e = await failure(inScope("picker", [w2]));
      expect([e.code, e.detail], v).toEqual(["FORBIDDEN", "WAREHOUSE_OUT_OF_SCOPE"]);
      // kısmen kapsam dışı küme de reddedilir
      expect((await failure(inScope("picker", [w1, w2]))).detail, v).toBe("WAREHOUSE_OUT_OF_SCOPE");
      expect((await failure(getLocationTree(call(A, "picker"), { warehouseId: w2 }))).code, v).toBe("NOT_FOUND");
      expect((await failure(findLocationByCode(call(A, "picker"), { warehouseId: w2, code: "x" }))).code, v).toBe("NOT_FOUND");
    }
  });

  it("bayrak açık: TENANT_ADMIN kapsam satırı olsa bile her depoyu görür; kapsam satırı olmayan üye (A-77 fail-open kuralı) tüm depoları görür", async () => {
    const { w1, w2 } = await scopedWorld();
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    await adm.query("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [A.tenantId, users.admin.membershipId, w1]);
    await expect(inScope("admin", [w1, w2, A.warehouseId])).resolves.toBeUndefined();
    const adminIds = (await listWarehouses(call(A, "admin"))).items.map((w) => w.id);
    expect(adminIds.includes(w1) && adminIds.includes(w2)).toBe(true);
    // satırsız READ_ONLY üye: tüm depolar (bilinen risk A-77/MINOR-8; davranış kaydı)
    await expect(inScope("readOnly", [w1, w2])).resolves.toBeUndefined();
    expect((await listWarehouses(call(A, "readOnly"))).items.some((w) => w.id === w2)).toBe(true);
  });

  it("bayrak açık: kapsam yalnızca üyeliğe bağlıdır — başka üyenin kapsam satırı PICKER'ı etkilemez; B tenant'ının deposu hiçbir durumda kapsamda sayılmaz", async () => {
    const { w1 } = await scopedWorld();
    process.env.WAREHOUSE_SCOPE_ENABLED = "true";
    await expect(inScope("counter", [w1, A.warehouseId])).resolves.toBeUndefined();
    expect((await failure(inScope("picker", [A.warehouseId]))).detail).toBe("WAREHOUSE_OUT_OF_SCOPE");
    expect((await failure(inScope("picker", [B.warehouseId]))).detail).toBe("WAREHOUSE_OUT_OF_SCOPE");
    // wms_app, B'nin kapsam satırını yazamaz: A yöneticisi B üyeliği için komut verirse NOT_FOUND
    expect((await failure(setMembershipWarehouseScopes(admin(A), { membershipId: B.memberMembershipId, warehouseIds: [w1] }))).code).toBe("NOT_FOUND");
    const rows = await adm.query("SELECT 1 FROM public.membership_warehouse_scopes WHERE membership_id = $1", [B.memberMembershipId]);
    expect(rows.rowCount).toBe(0);
  });
});
