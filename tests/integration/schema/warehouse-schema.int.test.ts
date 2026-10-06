// Depo/lokasyon şeması (T-202, I-03, ADR-017 §2, 06 §Sayım kilidi yaşam döngüsü). GERÇEK rollerle: uygulama rolü wms_app
// (DATABASE_URL, pooler); migration rolü yalnızca fikstür kurulumu/temizliği ve katalog okuması içindir.
// Sentetik veri: rastgele UUID/kodlar (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const OPS = "wms_ops";
const NEW_TABLES = ["warehouses", "locations", "location_count_locks", "membership_warehouse_scopes"] as const;

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [url])}`);
  }
  clients.push(c);
  return c;
}

type Attempt = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; code: string | undefined; message: string };

/** Migration rolüyle (tablo sahibi; FORCE RLS tenant bağlamı ister) ROLLBACK'li deneme: UPDATE'in tetikleyici hatasını döndürür. */
async function ownerUpdateError(tenantId: string, sql: string, p: unknown[]): Promise<{ code?: string; message?: string } | undefined> {
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await admin.query(sql, p);
    return undefined;
  } catch (e) {
    return e as { code?: string; message?: string };
  } finally {
    await admin.query("ROLLBACK");
  }
}

/** wms_app, tenant bağlamı transaction-local (G-02); daima ROLLBACK (kalıcı değişiklik yok). */
async function inTenant(tenantId: string, work: (q: (sql: string, p?: unknown[]) => Promise<pg.QueryResult>) => Promise<unknown>): Promise<Attempt> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await app.query(sql, p);
      return last;
    });
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: String(err.message) };
  } finally {
    await app.query("ROLLBACK");
  }
}

async function one(tenantId: string, sql: string, p: unknown[] = []): Promise<Attempt> {
  return inTenant(tenantId, async (q) => q(sql, p));
}

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-202 lokasyon + sayım kilidi satırı", () => {
  it("lokasyon eklemek aynı transaction'da IDLE kilit satırını üretir (wms_app, tetikleyici yolu)", async () => {
    const id = randomUUID();
    const r = await inTenant(A.tenantId, async (q) => {
      await q(
        `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
         VALUES ($1, $2, $3, $4, $5, 'Goz', 2, 'STORAGE')`,
        [A.tenantId, id, A.warehouseId, A.childLocationId, `G-${randomBytes(4).toString("hex")}`],
      );
      const lock = await q("SELECT status, count_session_id, locked_at, locked_by FROM public.location_count_locks WHERE location_id = $1", [id]);
      expect(lock.rows).toEqual([{ status: "IDLE", count_session_id: null, locked_at: null, locked_by: null }]);
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("fikstür lokasyonlarının her biri tam bir kilit satırına sahip", async () => {
    const r = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.locations l
        WHERE l.tenant_id = ANY($1::uuid[])
          AND (SELECT count(*) FROM public.location_count_locks k WHERE k.location_id = l.id AND k.tenant_id = l.tenant_id) <> 1`,
      [[A.tenantId, B.tenantId]],
    );
    expect(r.rows[0]?.n).toBe("0");
  });

  it("wms_app kilit satırına doğrudan INSERT: yalnızca (tenant_id, location_id); durum sütunları yazılamaz", async () => {
    const denied = await one(
      A.tenantId,
      "INSERT INTO public.location_count_locks (tenant_id, location_id, status, count_session_id, locked_at, locked_by) VALUES ($1, $2, 'COUNTING', $3, now(), $4)",
      [A.tenantId, randomUUID(), randomUUID(), A.ownerMembershipId],
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("kilit satırı durum güncellemesi (COUNTING/IDLE) CHECK ile tutarlı; tutarsız durum reddedilir", async () => {
    const sess = A.countSessionId;
    const ok = await inTenant(A.tenantId, async (q) => {
      await q(
        "UPDATE public.location_count_locks SET status = 'COUNTING', count_session_id = $2, locked_at = now(), locked_by = $3 WHERE location_id = $1",
        [A.childLocationId, sess, A.ownerMembershipId],
      );
      await q("UPDATE public.location_count_locks SET status = 'IDLE', count_session_id = NULL, locked_at = NULL, locked_by = NULL WHERE location_id = $1", [A.childLocationId]);
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const bad = await one(A.tenantId, "UPDATE public.location_count_locks SET status = 'COUNTING' WHERE location_id = $1", [A.childLocationId]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(CHECK_VIOLATION);
  });
});

describe("T-202 ağaç bütünlüğü", () => {
  it("başka depodaki ebeveyn FK ile reddedilir", async () => {
    const wh2 = randomUUID();
    const r = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, $3, 'Ikinci')", [A.tenantId, wh2, `W-${randomBytes(3).toString("hex")}`]);
      await q(
        "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'X1', 'x', 1, 'STORAGE')",
        [A.tenantId, randomUUID(), wh2, A.rootLocationId],
      );
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FK_VIOLATION);
  });

  it("başka tenant'ın deposu/ebeveyni: RLS altında görünmez → FK reddi", async () => {
    const r = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'Y1', 'y', 1, 'STORAGE')",
      [A.tenantId, randomUUID(), A.warehouseId, B.rootLocationId],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FK_VIOLATION);
  });

  it("tenant uyuşmazlığı (T-235): A bağlamında B anahtarlı INSERT ebeveyn denetimine girmeden RLS politikasıyla 42501 reddedilir", async () => {
    // Var olmayan ebeveyn + tutarsız depth: tetikleyici uyuşmazlıkta erken döner; ebeveyn hatası (23503/23514) değil politika konuşur.
    const r = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'M1', 'm', 9, 'STORAGE')",
      [B.tenantId, randomUUID(), B.warehouseId, randomUUID()],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(r.message).toMatch(/new row violates row-level security policy/);
    }
    // Aynı tenant içinde ebeveyn fail-closed aynen sürer (T-202 MAJOR-1): uyuşmazlık değil, bu yüzden 23503.
    const same = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'M2', 'm', 1, 'STORAGE')",
      [A.tenantId, randomUUID(), A.warehouseId, randomUUID()],
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.code).toBe(FK_VIOLATION);
  });

  it("tenant uyuşmazlığı (T-235): ret kaynağı politikadır — tetikleyici kapalıyken de 42501; tetikleyici gövdesi 42501 üretmez", async () => {
    const sql =
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, NULL, $4, 'm', 0, 'STORAGE')";
    await admin.query("BEGIN");
    try {
      await admin.query("ALTER TABLE public.locations DISABLE TRIGGER locations_check_depth");
      await admin.query("SET LOCAL ROLE wms_app");
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      let err: { code?: string; message?: string } | undefined;
      try {
        await admin.query(sql, [B.tenantId, randomUUID(), B.warehouseId, `T-${randomBytes(3).toString("hex")}`]);
      } catch (e) {
        err = e as { code?: string; message?: string };
      }
      expect(err?.code, "tetikleyici kapalıyken B anahtarlı INSERT").toBe(INSUFFICIENT_PRIVILEGE);
      expect(err?.message).toMatch(/new row violates row-level security policy/);
    } finally {
      await admin.query("ROLLBACK");
    }
    const def = await admin.query<{ d: string }>("SELECT pg_get_functiondef('public.locations_check_depth()'::regprocedure) AS d");
    expect(def.rows[0]?.d).not.toMatch(/ERRCODE = '42501'/);
    // Bağlamsız wms_app INSERT yine RLS ile reddedilir (tetikleyicinin bağlamsız dalı değişmedi).
    const noCtx = await app.query("BEGIN").then(async () => {
      try {
        await app.query(sql, [A.tenantId, randomUUID(), A.warehouseId, `T-${randomBytes(3).toString("hex")}`]);
        return undefined;
      } catch (e) {
        return e as { code?: string; message?: string };
      } finally {
        await app.query("ROLLBACK");
      }
    });
    expect(noCtx?.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(noCtx?.message).toMatch(/row-level security/);
    // RLS'i aşan rol (migration rolü: süper kullanıcı/BYPASSRLS) + eskimiş A bağlamı + B anahtarlı satır: politika koruma sağlamaz,
    // bu yüzden tetikleyici erken dönmez; ebeveyn/depth denetimleri çalışır (T-202 MAJOR-1 yolları kapalı kalır).
    const role = await admin.query<{ s: boolean; b: boolean }>("SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]?.s === true || role.rows[0]?.b === true, "admin RLS'i aşan rol olmalı").toBe(true);
    const byp = async (parent: string | null, depth: number): Promise<{ code?: string; message?: string } | undefined> => {
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
        await admin.query(
          "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, $5, 'b', $6, 'STORAGE')",
          [B.tenantId, randomUUID(), B.warehouseId, parent, `T-${randomBytes(3).toString("hex")}`, depth],
        );
        return undefined;
      } catch (e) {
        return e as { code?: string; message?: string };
      } finally {
        await admin.query("ROLLBACK");
      }
    };
    expect((await byp(randomUUID(), 1))?.code, "bypass: var olmayan ebeveyn").toBe(FK_VIOLATION);
    expect((await byp(null, 3))?.code, "bypass: kök depth ≠ 0").toBe(CHECK_VIOLATION);
    expect((await byp(B.rootLocationId, 7))?.code, "bypass: depth ≠ ebeveyn+1").toBe(CHECK_VIOLATION);
    // UPDATE: tenant_id sütun yetkisi wms_app'te yok → 42501; B satırı A bağlamında 0 etkilenir (USING).
    const upd = await one(A.tenantId, "UPDATE public.locations SET tenant_id = $2 WHERE id = $1", [A.childLocationId, B.tenantId]);
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("parent_id / warehouse_id / tenant_id / depth güncellemesi reddedilir (tetikleyici)", async () => {
    for (const set of [
      "parent_id = NULL",
      `parent_id = '${randomUUID()}'`,
      `warehouse_id = '${randomUUID()}'`,
      "depth = 5",
    ]) {
      // Sütun yetkisi yoksa 42501, tetikleyici sahibi (migration rolü) ile de ret: ikisi birlikte doğrulanır.
      const viaApp = await one(A.tenantId, `UPDATE public.locations SET ${set} WHERE id = $1`, [A.childLocationId]);
      expect(viaApp.ok, set).toBe(false);
      if (!viaApp.ok) expect(viaApp.code, set).toBe(INSUFFICIENT_PRIVILEGE);
      const err = await ownerUpdateError(A.tenantId, `UPDATE public.locations SET ${set} WHERE id = $1`, [A.childLocationId]);
      expect(err?.code, set).toBe(CHECK_VIOLATION);
      expect(err?.message, set).toMatch(/değiştirilemez/);
    }
    const tenantErr = await ownerUpdateError(B.tenantId, "UPDATE public.locations SET tenant_id = $2 WHERE id = $1", [B.childLocationId, A.tenantId]);
    expect(tenantErr?.code).toBe(CHECK_VIOLATION);
    expect(tenantErr?.message).toMatch(/değiştirilemez/);
  });

  it("çok satırlı INSERT: çocuk ebeveynden önce gelirse reddedilir; kökler önce gelirse kabul edilir", async () => {
    const root = randomUUID();
    const child = randomUUID();
    const childFirst = await one(
      A.tenantId,
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       VALUES ($1, $3, $2, $4, 'M2', 'c', 1, 'STORAGE'), ($1, $4, $2, NULL, 'M1', 'r', 0, 'STORAGE')`,
      [A.tenantId, A.warehouseId, child, root],
    );
    expect(childFirst.ok).toBe(false);
    if (!childFirst.ok) expect(childFirst.code).toBe(FK_VIOLATION);
    const rootFirst = await one(
      A.tenantId,
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       VALUES ($1, $4, $2, NULL, 'M1', 'r', 0, 'STORAGE'), ($1, $3, $2, $4, 'M2', 'c', 1, 'STORAGE')`,
      [A.tenantId, A.warehouseId, child, root],
    );
    expect(rootFirst.ok, JSON.stringify(rootFirst)).toBe(true);
  });

  it("döngü kurulamaz: iki satır birbirine ebeveyn (aynı ifade) ve keyfi depth reddedilir", async () => {
    const x = randomUUID();
    const y = randomUUID();
    const cyc = await one(
      A.tenantId,
      `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
       VALUES ($1, $3, $2, $4, 'C1', 'x', 1, 'STORAGE'), ($1, $4, $2, $3, 'C2', 'y', 2, 'STORAGE')`,
      [A.tenantId, A.warehouseId, x, y],
    );
    expect(cyc.ok).toBe(false);
    if (!cyc.ok) expect(cyc.code).toBe(FK_VIOLATION);
    // Aynı denemenin migration rolüyle (tablo sahibi) de reddedildiği: bekçi rol bağımsızdır.
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await expect(
        admin.query(
          `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
           VALUES ($1, $3, $2, $4, 'C1', 'x', 7, 'STORAGE'), ($1, $4, $2, $3, 'C2', 'y', 9, 'STORAGE')`,
          [A.tenantId, A.warehouseId, x, y],
        ),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("self-parent reddedilir (CHECK); yanlış depth reddedilir", async () => {
    const id = randomUUID();
    const self = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $2, 'S1', 's', 1, 'STORAGE')",
      [A.tenantId, id, A.warehouseId],
    );
    expect(self.ok).toBe(false);
    if (!self.ok) expect([CHECK_VIOLATION, FK_VIOLATION]).toContain(self.code);
    const badDepth = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $4, 'S2', 's', 5, 'STORAGE')",
      [A.tenantId, randomUUID(), A.warehouseId, A.rootLocationId],
    );
    expect(badDepth.ok).toBe(false);
    if (!badDepth.ok) expect(badDepth.code).toBe(CHECK_VIOLATION);
    // Self-parent CHECK'i kendi başına (FK'den bağımsız): migration rolüyle.
    await admin.query("BEGIN");
    try {
      await expect(
        admin.query(
          "INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1, $2, $3, $2, 'S3', 's', 1, 'STORAGE')",
          [A.tenantId, id, A.warehouseId],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "locations_parent_not_self_chk" });
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("kind ve status değer kümeleri CHECK ile sınırlı", async () => {
    const r = await one(
      A.tenantId,
      "INSERT INTO public.locations (tenant_id, id, warehouse_id, code, name, depth, kind) VALUES ($1, $2, $3, 'K1', 'k', 0, 'BOGUS')",
      [A.tenantId, randomUUID(), A.warehouseId],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(CHECK_VIOLATION);
  });
});

describe("T-202 silme yasağı, yetkiler ve RLS", () => {
  it("wms_app lokasyon / kilit / depo DELETE: yetki hatası", async () => {
    for (const t of ["locations", "location_count_locks", "warehouses"]) {
      const r = await one(A.tenantId, `DELETE FROM public.${t}`);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.code, t).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("wms_ops yeni tablolarda hiçbir yetki taşımaz (0009 deseni: yalnızca mevcut yazma yolu tabloları)", async () => {
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [OPS]);
    expect(role.rowCount, "wms_ops rolü yok (0009 önkoşulu; sessiz geçiş yok)").toBe(1);
    for (const t of NEW_TABLES) {
      const r = await admin.query<{ p: boolean }>("SELECT has_any_column_privilege($1, ('public.' || $2)::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS p", [OPS, t]);
      expect(r.rows[0]?.p, t).toBe(false);
      const d = await admin.query<{ p: boolean }>("SELECT has_table_privilege($1, ('public.' || $2)::regclass, 'DELETE, TRUNCATE') AS p", [OPS, t]);
      expect(d.rows[0]?.p, t).toBe(false);
    }
  });

  it("dört tabloda ENABLE + FORCE RLS, tenant politikası USING + WITH CHECK, PUBLIC yetkisi yok", async () => {
    for (const t of NEW_TABLES) {
      const c = await admin.query(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS pol,
                (SELECT p.polpermissive AND p.polcmd = '*' AND p.polroles = '{0}'::oid[] FROM pg_policy p WHERE p.polrelid = c.oid LIMIT 1) AS shape,
                (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid LIMIT 1) AS qual,
                (SELECT pg_get_expr(p.polwithcheck, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid LIMIT 1) AS chk,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0) AS pub
           FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass`,
        [t],
      );
      const row = c.rows[0] as { rls: boolean; forced: boolean; pol: string; shape: boolean; qual: string | null; chk: string | null; pub: boolean };
      expect(row.pub, t).toBe(false);
      expect(row.rls, t).toBe(true);
      expect(row.forced, t).toBe(true);
      expect(row.pol, t).toBe("1");
      expect(row.shape, `${t}: politika PERMISSIVE, FOR ALL, TO PUBLIC (polroles={0}) olmalı`).toBe(true);
      const tenantEq = /^\(tenant_id = \(NULLIF\((?:pg_catalog\.)?current_setting\('app\.current_tenant_id'::text, true\), ''::text\)\)::uuid\)$/;
      expect(row.qual, t).toMatch(tenantEq);
      expect(row.chk, t).toMatch(tenantEq);
    }
  });

  it("çapraz tenant: A bağlamı B'nin depo/lokasyon/kilit/kapsam satırını görmez, yazamaz", async () => {
    for (const t of NEW_TABLES) {
      const seen = await one(A.tenantId, `SELECT count(*)::int AS n FROM public.${t} WHERE tenant_id = $1`, [B.tenantId]);
      expect(seen.ok && seen.rows[0]?.n, t).toBe(0);
    }
    const w = await one(A.tenantId, "INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, 'ZZ', 'zz')", [B.tenantId, randomUUID()]);
    expect(w.ok).toBe(false);
    if (!w.ok) {
      expect(w.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(w.message).toMatch(/row-level security/);
    }
    // Yazma: B satırlarına UPDATE / DELETE A bağlamında 0 satır etkiler (RLS USING).
    const updLock = await one(A.tenantId, "UPDATE public.location_count_locks SET status = status WHERE location_id = $1", [B.childLocationId]);
    expect(updLock.ok && updLock.rowCount, "kilit UPDATE").toBe(0);
    const updLoc = await one(A.tenantId, "UPDATE public.locations SET name = name WHERE id = $1", [B.childLocationId]);
    expect(updLoc.ok && updLoc.rowCount, "lokasyon UPDATE").toBe(0);
    const updWh = await one(A.tenantId, "UPDATE public.warehouses SET name = name WHERE id = $1", [B.warehouseId]);
    expect(updWh.ok && updWh.rowCount, "depo UPDATE").toBe(0);
    const delScope = await one(A.tenantId, "DELETE FROM public.membership_warehouse_scopes WHERE membership_id = $1", [B.ownerMembershipId]);
    expect(delScope.ok && delScope.rowCount, "kapsam DELETE").toBe(0);
    const none = await app.query("SELECT count(*)::int AS n FROM public.locations");
    expect(none.rows[0]?.n).toBe(0); // bağlamsız → 0 satır
  });

  it("depo kapsamı: başka tenant üyeliği/deposu bileşik FK ile reddedilir; kendi tenant'ında ekleme+silme çalışır", async () => {
    const crossMember = await one(A.tenantId, "INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [
      A.tenantId,
      B.ownerMembershipId,
      A.warehouseId,
    ]);
    expect(crossMember.ok).toBe(false);
    if (!crossMember.ok) expect(crossMember.code).toBe(FK_VIOLATION);
    const crossWh = await one(A.tenantId, "INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [
      A.tenantId,
      A.memberMembershipId,
      B.warehouseId,
    ]);
    expect(crossWh.ok).toBe(false);
    if (!crossWh.ok) expect(crossWh.code).toBe(FK_VIOLATION);
    const okIns = await inTenant(A.tenantId, async (q) => {
      await q("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [A.tenantId, A.memberMembershipId, A.warehouseId]);
      const del = await q("DELETE FROM public.membership_warehouse_scopes WHERE membership_id = $1", [A.memberMembershipId]);
      expect(del.rowCount).toBe(1);
    });
    expect(okIns.ok, JSON.stringify(okIns)).toBe(true);
  });

  it("arşiv: status ARCHIVED ⇔ archived_at dolu", async () => {
    const bad = await one(A.tenantId, "UPDATE public.warehouses SET status = 'ARCHIVED' WHERE id = $1", [A.warehouseId]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(CHECK_VIOLATION);
    const good = await one(A.tenantId, "UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [A.childLocationId]);
    expect(good.ok, JSON.stringify(good)).toBe(true);
  });
});
