// T-212: lot, seri, taşıma birimi kart komutları. Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Audit append-only: audit yazan tenant'lar kısa ömürlü ortamda kalır (catalog-commands.int.test.ts ile aynı politika).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../../packages/db/src/migrate.ts";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { createTenantContext, DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { archiveItem, createItem } from "../../../packages/domain/src/catalog/items.ts";
import { createLot, findLot, listLots } from "../../../packages/domain/src/catalog/lots.ts";
import { registerSerial } from "../../../packages/domain/src/catalog/serials.ts";
import { createHandlingUnit, getHandlingUnitTree } from "../../../packages/domain/src/catalog/handling-units.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rnd = (): string => randomBytes(4).toString("hex");

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let readOnlyUserId: string;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  A = await seedWorld(adm, reg, "A");
  B = await seedWorld(adm, reg, "B");
  readOnlyUserId = await mkUser(adm, reg, "A readonly");
  await mkMembership(adm, A.tenantId, readOnlyUserId, { roles: ["READ_ONLY"] });
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 120_000);

const as = (w: TenantWorld, userId: string) => ({ db: app, principal: { userId, mfaVerified: true }, tenantSlug: w.slug });
const admin = (w: TenantWorld) => as(w, w.ownerUserId);
const picker = (w: TenantWorld) => as(w, w.memberUserId);
const readOnly = () => as(A, readOnlyUserId);

async function fail(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}
const expectFail = async (p: Promise<unknown>, code: string, detail?: string): Promise<void> => {
  const e = await fail(p);
  expect(e.code).toBe(code);
  expect(e.detail).toBe(detail);
};

/** Arşiv sürerken (ürün satırı adm ile FOR UPDATE kilitli) komut bekler; arşiv commit olunca ACTIVE denetimi kilitten SONRA reddeder. */
async function archivedWhileWaiting(itemId: string, run: () => Promise<unknown>): Promise<AppError> {
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT 1 FROM public.items WHERE id = $1 FOR UPDATE", [itemId]);
    let settled = false;
    const p = run().then(
      () => {
        settled = true;
        return undefined;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    await delay(500);
    expect(settled).toBe(false); // komut ürün satırında bekliyor (FOR SHARE)
    await adm.query("UPDATE public.items SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [itemId]);
    await adm.query("COMMIT");
    const err = await p;
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
}

async function mkItem(w: TenantWorld, trackingMode: "NONE" | "LOT" | "SERIAL" | "LOT_AND_SERIAL"): Promise<string> {
  return (await createItem(admin(w), { code: `T${rnd()}`, name: "İzlenebilirlik", baseUnitId: w.unitId, trackingMode })).itemId;
}

describe("lot", () => {
  it("NONE/SERIAL ürüne lot → TRACKING_VIOLATION; LOT ürüne açılır; tekrar CODE_TAKEN; tarih kuralları", async () => {
    const none = await mkItem(A, "NONE");
    const serial = await mkItem(A, "SERIAL");
    const lotItem = await mkItem(A, "LOT");
    await expectFail(createLot(admin(A), { itemId: none, lotCode: `L${rnd()}` }), "TRACKING_VIOLATION");
    await expectFail(createLot(admin(A), { itemId: serial, lotCode: `L${rnd()}` }), "TRACKING_VIOLATION");
    const lotCode = `L${rnd()}`;
    const { lotId } = await createLot(admin(A), { itemId: lotItem, lotCode, productionDate: "2026-01-10", expiryDate: "2027-01-10", supplierLot: "SUP-1" });
    expect(await findLot(picker(A), { lotId })).toEqual({
      id: lotId,
      itemId: lotItem,
      lotCode,
      productionDate: "2026-01-10",
      expiryDate: "2027-01-10",
      supplierLot: "SUP-1",
    });
    await expectFail(createLot(admin(A), { itemId: lotItem, lotCode }), "VALIDATION_FAILED", "CODE_TAKEN");
    await expectFail(createLot(admin(A), { itemId: lotItem, lotCode: `L${rnd()}`, productionDate: "2026-02-01", expiryDate: "2026-01-01" }), "VALIDATION_FAILED");
    await expectFail(createLot(admin(A), { itemId: lotItem, lotCode: `L${rnd()}`, expiryDate: "2026-02-30" }), "VALIDATION_FAILED");
    await expectFail(createLot(admin(A), { itemId: lotItem, lotCode: `L${rnd()}`, expiryDate: "2026-01-01T00:00:00Z" }), "VALIDATION_FAILED");
    const audit = await adm.query("SELECT change_summary FROM public.audit_logs WHERE tenant_id = $1 AND action = 'lot.created' AND entity_id = $2", [A.tenantId, lotId]);
    expect(JSON.stringify(audit.rows[0])).not.toContain(lotCode);
  });

  it("Unicode NFC: ayrışık ve bileşik biçim aynı lot kodudur", async () => {
    const lotItem = await mkItem(A, "LOT");
    const base = rnd();
    await createLot(admin(A), { itemId: lotItem, lotCode: `${base}é` });
    await expectFail(createLot(admin(A), { itemId: lotItem, lotCode: `${base}é` }), "VALIDATION_FAILED", "CODE_TAKEN");
  });

  it("listLots keyset sayfalar; başka tenant ürünü NOT_FOUND; B'nin lotu A'dan görünmez", async () => {
    const lotItem = await mkItem(A, "LOT");
    for (const c of ["c", "a", "b"]) await createLot(admin(A), { itemId: lotItem, lotCode: `${c}-${rnd()}` });
    const p1 = await listLots(picker(A), { itemId: lotItem, limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listLots(picker(A), { itemId: lotItem, limit: 2, after: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((l) => l.lotCode[0])).toEqual(["a", "b", "c"]);
    await expectFail(listLots(picker(A), { itemId: B.itemId }), "NOT_FOUND");
    await expectFail(listLots(picker(A), { itemId: lotItem, limit: 0 }), "VALIDATION_FAILED");
    const bItem = await mkItem(B, "LOT");
    const { lotId: bLot } = await createLot(admin(B), { itemId: bItem, lotCode: `L${rnd()}` });
    await expectFail(findLot(admin(A), { lotId: bLot }), "NOT_FOUND");
    await expectFail(createLot(admin(A), { itemId: bItem, lotCode: `L${rnd()}` }), "NOT_FOUND");
    await expectFail(findLot(admin(A), { lotId: randomUUID() }), "NOT_FOUND");
  });

  it("PICKER ve READ_ONLY ile oluşturma → FORBIDDEN (document.create yok)", async () => {
    const lotItem = await mkItem(A, "LOT");
    await expectFail(createLot(readOnly(), { itemId: lotItem, lotCode: `L${rnd()}` }), "FORBIDDEN");
    await expectFail(createLot(picker(A), { itemId: lotItem, lotCode: `L${rnd()}` }), "FORBIDDEN");
    expect((await listLots(readOnly(), { itemId: lotItem })).items).toEqual([]); // okuma stock.view
  });

  it("lot ↔ archiveItem: arşiv commit olmadan createLot bekler, sonra reddedilir; lot satırı oluşmaz", async () => {
    const item = await mkItem(A, "LOT");
    const code = `R${rnd()}`;
    const err = await archivedWhileWaiting(item, () => createLot(admin(A), { itemId: item, lotCode: code }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await adm.query("SELECT 1 FROM public.lots WHERE item_id = $1", [item])).rowCount).toBe(0);
  });

  it("paralel createLot ∥ archiveItem: kilitlenme/INTERNAL yok; hata yalnızca VALIDATION_FAILED", async () => {
    // Bu test FOR SHARE'i ayırt etmez; ayırt edici kanıt yukarıdaki kapılı testtir.
    for (let i = 0; i < 5; i++) {
      const item = await mkItem(A, "LOT");
      const [lot, arch] = await Promise.allSettled([createLot(admin(A), { itemId: item, lotCode: `R${rnd()}` }), archiveItem(admin(A), { itemId: item })]);
      expect(arch.status).toBe("fulfilled");
      if (lot.status === "rejected") expect((lot.reason as AppError).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("seri", () => {
  it("NONE/LOT ürüne seri → TRACKING_VIOLATION; aynı seri tekrar → TRACKING_VIOLATION; başka üründe aynı no serbest (A-72)", async () => {
    const none = await mkItem(A, "NONE");
    const lotOnly = await mkItem(A, "LOT");
    const s1 = await mkItem(A, "SERIAL");
    const s2 = await mkItem(A, "SERIAL");
    await expectFail(registerSerial(admin(A), { itemId: none, serialNo: `S${rnd()}` }), "TRACKING_VIOLATION");
    await expectFail(registerSerial(admin(A), { itemId: lotOnly, serialNo: `S${rnd()}` }), "TRACKING_VIOLATION");
    const no = `S${rnd()}`;
    await registerSerial(admin(A), { itemId: s1, serialNo: no });
    await expectFail(registerSerial(admin(A), { itemId: s1, serialNo: no }), "TRACKING_VIOLATION");
    await registerSerial(admin(A), { itemId: s2, serialNo: no });
    // SERIAL ürüne lot verilemez.
    const lotItem = await mkItem(A, "LOT");
    const { lotId } = await createLot(admin(A), { itemId: lotItem, lotCode: `L${rnd()}` });
    await expectFail(registerSerial(admin(A), { itemId: s1, serialNo: `S${rnd()}`, lotId }), "TRACKING_VIOLATION");
    await expectFail(registerSerial(readOnly(), { itemId: s1, serialNo: `S${rnd()}` }), "FORBIDDEN");
    await expectFail(registerSerial(admin(A), { itemId: B.itemId, serialNo: `S${rnd()}` }), "NOT_FOUND");
  });

  it("LOT_AND_SERIAL: lot zorunlu, aynı ürünün lotu; eşzamanlı aynı seri tek kayıt", async () => {
    const ls = await mkItem(A, "LOT_AND_SERIAL");
    const other = await mkItem(A, "LOT_AND_SERIAL");
    const { lotId } = await createLot(admin(A), { itemId: ls, lotCode: `L${rnd()}` });
    const { lotId: otherLot } = await createLot(admin(A), { itemId: other, lotCode: `L${rnd()}` });
    await expectFail(registerSerial(admin(A), { itemId: ls, serialNo: `S${rnd()}` }), "TRACKING_VIOLATION");
    await expectFail(registerSerial(admin(A), { itemId: ls, serialNo: `S${rnd()}`, lotId: otherLot }), "NOT_FOUND");
    const no = `S${rnd()}`;
    const res = await Promise.allSettled([registerSerial(admin(A), { itemId: ls, serialNo: no, lotId }), registerSerial(admin(A), { itemId: ls, serialNo: no, lotId })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as AppError).code).toBe("TRACKING_VIOLATION");
  });

  it("registerSerial ↔ archiveItem: arşiv commit olmadan bekler, sonra reddedilir; seri oluşmaz", async () => {
    const item = await mkItem(A, "SERIAL");
    const err = await archivedWhileWaiting(item, () => registerSerial(admin(A), { itemId: item, serialNo: `S${rnd()}` }));
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await adm.query("SELECT 1 FROM public.serials WHERE item_id = $1", [item])).rowCount).toBe(0);
  });

  describe("tenant geneli kapsam bayrağı (sunucu yapılandırmasından enjekte; Q-39, Q-59)", () => {
    const ON = { env: { SERIAL_SCOPE_TENANT_ENABLED: "true" } } as const;
    const countByNo = async (no: string, w: TenantWorld = A): Promise<number | null> => (await adm.query("SELECT 1 FROM public.serials WHERE tenant_id = $1 AND serial_no = $2", [w.tenantId, no])).rowCount;

    it("indeks yokken bayrak açık: VALIDATION_FAILED, seri oluşmaz (fail-closed)", async () => {
      const s1 = await mkItem(A, "SERIAL");
      const no = `S${rnd()}`;
      await expectFail(registerSerial(admin(A), { itemId: s1, serialNo: no }, ON), "VALIDATION_FAILED");
      expect(await countByNo(no)).toBe(0);
    });

    it("yalnızca tenant_id+serial_no sütunlu, geçerli tekil indeks kabul edilir; yanlış sütun/tekil olmayan indeks yetmez", async () => {
      const s1 = await mkItem(A, "SERIAL");
      const wrong = `serials_t239w_${rnd()}`;
      await adm.query(`CREATE UNIQUE INDEX ${wrong} ON public.serials (tenant_id, lot_id, serial_no)`);
      const plain = `serials_t239p_${rnd()}`;
      await adm.query(`CREATE INDEX ${plain} ON public.serials (tenant_id, serial_no)`);
      try {
        await expectFail(registerSerial(admin(A), { itemId: s1, serialNo: `S${rnd()}` }, ON), "VALIDATION_FAILED");
      } finally {
        await adm.query(`DROP INDEX IF EXISTS public.${wrong}`);
        await adm.query(`DROP INDEX IF EXISTS public.${plain}`);
      }
    });

    it("bayrak istemci girdisinden açılamaz: girdide fazladan alan VALIDATION_FAILED; config yoksa kapalı", async () => {
      const s1 = await mkItem(A, "SERIAL");
      const s2 = await mkItem(A, "SERIAL");
      const no = `S${rnd()}`;
      const forged = { itemId: s1, serialNo: `S${rnd()}`, SERIAL_SCOPE_TENANT_ENABLED: "true", env: { SERIAL_SCOPE_TENANT_ENABLED: "true" } } as unknown as Parameters<typeof registerSerial>[1];
      await expectFail(registerSerial(admin(A), forged), "VALIDATION_FAILED");
      await registerSerial(admin(A), { itemId: s1, serialNo: no });
      await registerSerial(admin(A), { itemId: s2, serialNo: no }, {});
      expect(await countByNo(no)).toBe(2);
    });

    it("kapalıyken ürünler arası aynı seri serbest; 'false'/'1'/'TRUE' da kapalı", async () => {
      for (const v of ["1", "false", "TRUE", ""]) {
        const s1 = await mkItem(A, "SERIAL");
        const s2 = await mkItem(A, "SERIAL");
        const no = `S${rnd()}`;
        await registerSerial(admin(A), { itemId: s1, serialNo: no }, { env: { SERIAL_SCOPE_TENANT_ENABLED: v } });
        await registerSerial(admin(A), { itemId: s2, serialNo: no }, { env: { SERIAL_SCOPE_TENANT_ENABLED: v } });
        expect(await countByNo(no)).toBe(2);
      }
    });

    it("kısmi indeks (tenant'a özel ya da ilgisiz koşullu) bayrak açıkken yeterli DEĞİL: VALIDATION_FAILED (indpred)", async () => {
      const s1 = await mkItem(A, "SERIAL");
      const empty = await seedWorld(adm, reg, "D");
      const tenantIdx = `serials_t239t_${rnd()}`;
      const otherIdx = `serials_t239o_${rnd()}`;
      // Tenant'a özel kısmi indeks: A bu indeksin kapsamında değil, ama A için de açık bayrak geçmemeli.
      await adm.query(`CREATE UNIQUE INDEX ${tenantIdx} ON public.serials (tenant_id, serial_no) WHERE tenant_id = '${empty.tenantId}'`);
      try {
        for (const w of [A, empty]) {
          const item = w === A ? s1 : await mkItem(w, "SERIAL");
          const no = `S${rnd()}`;
          await expectFail(registerSerial(admin(w), { itemId: item, serialNo: no }, ON), "VALIDATION_FAILED");
          expect(await countByNo(no, w)).toBe(0);
        }
        await adm.query(`CREATE UNIQUE INDEX ${otherIdx} ON public.serials (tenant_id, serial_no) WHERE serial_no LIKE 'T239X%'`);
        const no = `S${rnd()}`;
        await expectFail(registerSerial(admin(A), { itemId: s1, serialNo: no }, ON), "VALIDATION_FAILED");
        expect(await countByNo(no)).toBe(0);
      } finally {
        await adm.query(`DROP INDEX IF EXISTS public.${tenantIdx}`);
        await adm.query(`DROP INDEX IF EXISTS public.${otherIdx}`);
      }
    });

    describe("indeks varken", () => {
      // Ana veritabanında önceki testler ürünler arası kopya seri bıraktığından tam UNIQUE (tenant_id, serial_no)
      // kurulamaz; olumlu yol geçici, temiz bir veritabanında koşar (veri silinmez, diğer testlerin varsayımı bozulmaz).
      const scratch = `wms_t239_${rnd()}`;
      const urlFor = (u: string, db: string, creds?: string): string => {
        const x = new URL(u);
        x.pathname = `/${db}`;
        if (creds !== undefined) {
          const c = new URL(creds);
          x.username = c.username;
          x.password = c.password;
        }
        return x.toString();
      };
      let sApp: DbClient;
      let sAdm: pg.Client;
      let C: TenantWorld;
      const sAdmin = () => ({ db: sApp, principal: { userId: C.ownerUserId, mfaVerified: true }, tenantSlug: C.slug });
      const sItem = async (): Promise<string> => (await createItem(sAdmin(), { code: `T${rnd()}`, name: "İzlenebilirlik", baseUnitId: C.unitId, trackingMode: "SERIAL" })).itemId;
      const sCount = async (no: string): Promise<number | null> => (await sAdm.query("SELECT 1 FROM public.serials WHERE tenant_id = $1 AND serial_no = $2", [C.tenantId, no])).rowCount;
      // Kurulum/temizlik hataları yutulmaz ve URL/kimlik bilgisi sızdırmadan raporlanır (G-07, G-09; harness redactErrorChain).
      const secrets = (): string[] => [env.databaseUrl, env.databaseUrlDirect];
      beforeAll(async () => {
        try {
          await adm.query(`CREATE DATABASE ${scratch}`);
          await migrateUp({ url: urlFor(env.databaseUrlDirect, scratch) });
          sAdm = new pg.Client({ connectionString: urlFor(env.databaseUrlDirect, scratch) });
          sAdm.on("error", () => undefined);
          await sAdm.connect();
          // wms_app doğrudan (pooler yalnızca ana veritabanını bilir); kimlik bilgisi app URL'sinden.
          sApp = createDbClient({ url: urlFor(env.databaseUrlDirect, scratch, env.databaseUrl), poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: DB_CLIENT_SETTINGS.prepare });
          C = await seedWorld(sAdm, newRegistry(), "C");
          await sAdm.query("CREATE UNIQUE INDEX serials_tenant_serial_no_t239 ON public.serials (tenant_id, serial_no)");
        } catch (e) {
          throw new Error(`geçici veritabanı (${scratch}) kurulumu başarısız: ${redactErrorChain(e, secrets())}`);
        }
      }, 120_000);
      afterAll(async () => {
        const failures: string[] = [];
        if (sApp !== undefined) await sApp.close().catch((e: unknown) => failures.push(`app close: ${redactErrorChain(e, secrets())}`));
        if (sAdm !== undefined) await sAdm.end().catch((e: unknown) => failures.push(`admin end: ${redactErrorChain(e, secrets())}`));
        await adm.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch((e: unknown) => failures.push(`DROP DATABASE ${scratch}: ${redactErrorChain(e, secrets())}`));
        // Yetim geçici veritabanı sessizce kalmaz: temizlik hatası testi kırmızıya çevirir.
        if (failures.length > 0) throw new Error(`geçici veritabanı temizliği başarısız: ${failures.join("; ")}`);
      }, 60_000);

      it("açıkken ardışık ürünler arası tekrar TRACKING_VIOLATION", async () => {
        const s1 = await sItem();
        const s2 = await sItem();
        const no = `S${rnd()}`;
        await registerSerial(sAdmin(), { itemId: s1, serialNo: no }, ON);
        await expectFail(registerSerial(sAdmin(), { itemId: s2, serialNo: no }, ON), "TRACKING_VIOLATION");
        expect(await sCount(no)).toBe(1);
      });

      it("açıkken iki farklı ürün için aynı serialNo eşzamanlı: yalnızca biri başarılı", async () => {
        for (let i = 0; i < 8; i++) {
          const s1 = await sItem();
          const s2 = await sItem();
          const no = `S${rnd()}`;
          const res = await Promise.allSettled([registerSerial(sAdmin(), { itemId: s1, serialNo: no }, ON), registerSerial(sAdmin(), { itemId: s2, serialNo: no }, ON)]);
          expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
          const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
          expect((rej.reason as AppError).code).toBe("TRACKING_VIOLATION");
        }
      });

      it("kapılı: advisory kilit tutulurken registerSerial bekler (kilit kaldırılırsa kırmızı)", async () => {
        const item = await sItem();
        const no = `S${rnd()}`;
        await sAdm.query("BEGIN");
        try {
          await sAdm.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`serial:${C.tenantId}:${no}`]);
          let settled = false;
          const p = registerSerial(sAdmin(), { itemId: item, serialNo: no }, ON).then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await delay(500);
          expect(settled).toBe(false);
          await sAdm.query("COMMIT");
          await p;
        } catch (e) {
          await sAdm.query("ROLLBACK");
          throw e;
        }
      });
    });
  });
});

describe("taşıma birimi", () => {
  it("oluşturma, iç içe ağaç, kod tekrarı, konum/ebeveyn tutarlılığı, tenant izolasyonu", async () => {
    const pal = await createHandlingUnit(admin(A), { kind: "PALET", code: `P${rnd()}`, locationId: A.rootLocationId });
    const koliCode = `K${rnd()}`;
    const koli = await createHandlingUnit(admin(A), { kind: "KOLI", code: koliCode, parentId: pal.handlingUnitId });
    const tree = await getHandlingUnitTree(picker(A), { rootId: pal.handlingUnitId });
    expect(tree.map((n) => [n.id, n.depth, n.locationId])).toEqual([
      [pal.handlingUnitId, 0, A.rootLocationId],
      [koli.handlingUnitId, 1, A.rootLocationId], // konumu ebeveynden devralır
    ]);
    await expectFail(createHandlingUnit(admin(A), { kind: "KOLI", code: koliCode }), "VALIDATION_FAILED", "CODE_TAKEN");
    await expectFail(
      createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: pal.handlingUnitId, locationId: A.childLocationId }),
      "VALIDATION_FAILED",
      "PARENT_INVALID",
    );
    // Ebeveynin konumu yoksa çocuğa konum verilemez; kapalı/boşaltılmış ebeveyn reddedilir.
    const noLoc = await createHandlingUnit(admin(A), { kind: "PALET", code: `P${rnd()}` });
    await expectFail(createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: noLoc.handlingUnitId, locationId: A.rootLocationId }), "VALIDATION_FAILED", "PARENT_INVALID");
    await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: noLoc.handlingUnitId }); // konumsuz çocuk serbest
    for (const st of ["CLOSED", "EMPTIED"]) {
      await adm.query("UPDATE public.handling_units SET status = $1 WHERE id = $2", [st, noLoc.handlingUnitId]);
      await expectFail(createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: noLoc.handlingUnitId }), "VALIDATION_FAILED", "PARENT_INVALID");
    }
    // @ts-expect-error geçersiz tür çalışma zamanında reddedilir
    await expectFail(createHandlingUnit(admin(A), { kind: "SEPET", code: `K${rnd()}` }), "VALIDATION_FAILED");
    await expectFail(createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: B.handlingUnitId }), "NOT_FOUND");
    await expectFail(createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, locationId: B.rootLocationId }), "NOT_FOUND");
    await expectFail(getHandlingUnitTree(admin(A), { rootId: B.handlingUnitId }), "NOT_FOUND");
    await expectFail(createHandlingUnit(readOnly(), { kind: "KOLI", code: `K${rnd()}` }), "FORBIDDEN");
    await expectFail(createHandlingUnit(picker(A), { kind: "KOLI", code: `K${rnd()}` }), "FORBIDDEN");
    // Aynı kod başka tenant'ta serbest.
    await createHandlingUnit(admin(B), { kind: "KOLI", code: koliCode });
  });

  it("palet→koli→palet döngüsü DB tetikleyicisinde HANDLING_UNIT_CYCLE ile reddedilir (nest komutu yok; A-89)", async () => {
    const p = await createHandlingUnit(admin(A), { kind: "PALET", code: `P${rnd()}` });
    const k = await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: p.handlingUnitId });
    await expect(adm.query("UPDATE public.handling_units SET parent_id = $1 WHERE id = $2", [k.handlingUnitId, p.handlingUnitId])).rejects.toThrow(/HANDLING_UNIT_CYCLE/);
    const after = await adm.query("SELECT parent_id FROM public.handling_units WHERE id = $1", [p.handlingUnitId]);
    expect((after.rows[0] as { parent_id: string | null }).parent_id).toBeNull();
  });

  it("döngü wms_app + withTenant (RLS altında) bağlamında da HANDLING_UNIT_CYCLE ile reddedilir; kendi-kendine ve 3 halka dahil", async () => {
    const p = await createHandlingUnit(admin(A), { kind: "PALET", code: `P${rnd()}` });
    const k = await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: p.handlingUnitId });
    const k2 = await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: k.handlingUnitId });
    const chain = (e: unknown): string => {
      const out: string[] = [];
      for (let c: unknown = e, i = 0; c !== undefined && c !== null && i < 6; i++, c = (c as { cause?: unknown }).cause) out.push(String((c as { message?: unknown }).message));
      return out.join(" | ");
    };
    const upd = (id: string, parent: string): Promise<unknown> =>
      withTenant(createTenantContext(app, A.tenantId), (tx) =>
        tx.execute(sql`UPDATE public.handling_units SET parent_id = ${parent}::uuid WHERE tenant_id = ${A.tenantId}::uuid AND id = ${id}::uuid`),
      );
    for (const [id, parent] of [
      [p.handlingUnitId, k.handlingUnitId],
      [p.handlingUnitId, k2.handlingUnitId],
    ] as const) {
      const err = await upd(id, parent).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      expect(chain(err)).toMatch(/HANDLING_UNIT_CYCLE/);
    }
    const after = await adm.query("SELECT parent_id FROM public.handling_units WHERE id = $1", [p.handlingUnitId]);
    expect((after.rows[0] as { parent_id: string | null }).parent_id).toBeNull();
  });
});
