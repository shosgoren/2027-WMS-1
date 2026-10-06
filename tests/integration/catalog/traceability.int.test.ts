// T-212: lot, seri, taşıma birimi kart komutları. Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
// Audit append-only: audit yazan tenant'lar kısa ömürlü ortamda kalır (catalog-commands.int.test.ts ile aynı politika).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { archiveItem, createItem } from "../../../packages/domain/src/catalog/items.ts";
import { createLot, findLot, listLots } from "../../../packages/domain/src/catalog/lots.ts";
import { registerSerial } from "../../../packages/domain/src/catalog/serials.ts";
import { createHandlingUnit, getHandlingUnitTree } from "../../../packages/domain/src/catalog/handling-units.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
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

  it("arşiv ile lot oluşturma yarışı: kilitlenme yok; arşivli ürüne lot açılmaz", async () => {
    for (let i = 0; i < 5; i++) {
      const item = await mkItem(A, "LOT");
      const [lot, arch] = await Promise.allSettled([createLot(admin(A), { itemId: item, lotCode: `R${rnd()}` }), archiveItem(admin(A), { itemId: item })]);
      expect(arch.status).toBe("fulfilled");
      if (lot.status === "rejected") {
        expect(lot.reason).toBeInstanceOf(AppError);
        expect((lot.reason as AppError).code).toBe("VALIDATION_FAILED");
      }
      const n = await adm.query("SELECT count(*)::int AS n FROM public.lots WHERE item_id = $1", [item]);
      expect((n.rows[0] as { n: number }).n).toBe(lot.status === "fulfilled" ? 1 : 0);
      await expectFail(createLot(admin(A), { itemId: item, lotCode: `R${rnd()}` }), "VALIDATION_FAILED");
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

  it("tenant geneli kapsam bayrağı açıkken ürünler arası tekrar reddedilir (Q-39)", async () => {
    const s1 = await mkItem(A, "SERIAL");
    const s2 = await mkItem(A, "SERIAL");
    const no = `S${rnd()}`;
    await registerSerial(admin(A), { itemId: s1, serialNo: no }, { serialScopeTenant: true });
    await expectFail(registerSerial(admin(A), { itemId: s2, serialNo: no }, { serialScopeTenant: true }), "TRACKING_VIOLATION");
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
});
