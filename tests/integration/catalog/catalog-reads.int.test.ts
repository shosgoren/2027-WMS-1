// T-240: katalog okuma komutları (searchItems, listItemConversions, listItemBarcodes, itemInUse). Gerçek wms_app bağlantısı + RLS;
// fikstürler sentetik (G-09). Migration rolü yalnızca kurulum/doğrulama içindir (audit append-only: tenant'lar temizlenmez).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { addBarcode } from "../../../packages/domain/src/catalog/barcodes.ts";
import { archiveItem, createItem } from "../../../packages/domain/src/catalog/items.ts";
import { itemInUse, listItemBarcodes, listItemConversions, searchItems } from "../../../packages/domain/src/catalog/reads.ts";
import { setUnitConversion } from "../../../packages/domain/src/catalog/units.ts";
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
let noRoleUserId: string;
let strangerUserId: string;

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
  readOnlyUserId = await mkUser(adm, reg, "ro");
  await mkMembership(adm, A.tenantId, readOnlyUserId, { roles: ["READ_ONLY"] });
  noRoleUserId = await mkUser(adm, reg, "norole");
  await mkMembership(adm, A.tenantId, noRoleUserId, { roles: [] }); // üye ama hiçbir rolü yok → hiçbir izni yok
  strangerUserId = await mkUser(adm, reg, "stranger"); // A'da üyeliği yok
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

async function mkItems(w: TenantWorld, prefix: string, n: number, name = "Ürün"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const { itemId } = await createItem(admin(w), { code: `${prefix}-${String(i).padStart(2, "0")}`, name: `${name} ${i}`, baseUnitId: w.unitId });
    ids.push(itemId);
  }
  return ids;
}

async function walk(w: ReturnType<typeof admin>, q: string, limit: number, status?: "ACTIVE" | "ARCHIVED"): Promise<{ codes: string[]; pages: number[] }> {
  const codes: string[] = [];
  const pages: number[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const r = await searchItems(w, { q, limit, ...(after === undefined ? {} : { after }), ...(status === undefined ? {} : { status }) });
    codes.push(...r.items.map((i) => i.code));
    pages.push(r.items.length);
    if (r.nextCursor === null) return { codes, pages };
    after = r.nextCursor;
  }
  throw new Error("sayfalama bitmedi");
}

describe("searchItems", () => {
  it("keyset: sayfa sınırı, sıra ve tam kapsama; limit=toplam ise nextCursor null; sayfalar arasında eklenen kayıt yinelenme yaratmaz", async () => {
    const p = `K${rnd()}`;
    await mkItems(A, p, 5);
    const expected = [1, 2, 3, 4, 5].map((i) => `${p}-0${i}`);
    const w = await walk(admin(A), p, 2);
    expect(w).toEqual({ codes: expected, pages: [2, 2, 1] });
    expect((await walk(admin(A), p, 5)).pages).toEqual([5]);
    expect((await walk(admin(A), p, 100)).codes).toEqual(expected);
    // İlk sayfa alındıktan sonra imleçten ÖNCE ve SONRA kayıt eklenir: önceki kayıt görünmez, sonraki bir kez görünür.
    const first = await searchItems(admin(A), { q: p, limit: 2 });
    expect(first.items.map((i) => i.code)).toEqual([`${p}-01`, `${p}-02`]);
    await createItem(admin(A), { code: `${p}-00`, name: "Önce", baseUnitId: A.unitId });
    await createItem(admin(A), { code: `${p}-025`, name: "Arada", baseUnitId: A.unitId });
    const second = await searchItems(admin(A), { q: p, limit: 100, after: first.nextCursor as string });
    expect(second).toEqual({ items: second.items, nextCursor: null });
    expect(second.items.map((i) => i.code)).toEqual([`${p}-025`, `${p}-03`, `${p}-04`, `${p}-05`]);
  });

  it("q: kod/ad önekli (büyük-küçük harf duyarsız), % ve _ joker değil, barkod tam eşleşme; durum filtresi", async () => {
    const p = `S${rnd()}`;
    const [i1, i2] = await mkItems(A, p, 2, `Vida${p}`);
    expect((await searchItems(admin(A), { q: p.toLowerCase() })).items.map((i) => i.id)).toEqual([i1, i2]);
    expect((await searchItems(admin(A), { q: `vida${p}`.toUpperCase() })).items.map((i) => i.id)).toEqual([i1, i2]);
    expect((await searchItems(admin(A), { q: `${p}%` })).items).toEqual([]);
    expect((await searchItems(admin(A), { q: `${p.slice(0, 3)}_` })).items).toEqual([]);
    expect((await searchItems(admin(A), { q: p.slice(1) })).items).toEqual([]); // önek, içerme değil
    const bc = `8${rnd()}${rnd()}`;
    await addBarcode(admin(A), { itemId: i2 as string, barcode: bc });
    expect((await searchItems(admin(A), { q: bc })).items.map((i) => i.id)).toEqual([i2]);
    expect((await searchItems(admin(A), { q: bc.slice(0, -1) })).items).toEqual([]); // barkod tam eşleşme
    await archiveItem(admin(A), { itemId: i1 as string });
    expect((await searchItems(admin(A), { q: p, status: "ARCHIVED" })).items.map((i) => i.id)).toEqual([i1]);
    expect((await searchItems(admin(A), { q: p, status: "ACTIVE" })).items.map((i) => i.id)).toEqual([i2]);
    expect((await searchItems(admin(A), { q: p })).items.map((i) => i.id)).toEqual([i1, i2]);
  });

  it("tenant sızıntısı yok: B'nin araması A'nın ürünlerini görmez; A'nın imleci B'de A verisi döndürmez", async () => {
    const p = `T${rnd()}`;
    await mkItems(A, p, 3);
    expect((await searchItems(admin(B), { q: p })).items).toEqual([]);
    const cur = (await searchItems(admin(A), { q: p, limit: 1 })).nextCursor as string;
    expect((await searchItems(admin(B), { q: p, after: cur })).items).toEqual([]);
    const all = await searchItems(admin(B), { limit: 100 });
    expect(all.items.some((i) => i.code.startsWith(p))).toBe(false);
  });

  it("izin: READ_ONLY ve PICKER okur; rolsüz üye FORBIDDEN, üye olmayan NOT_FOUND; geçersiz girdi VALIDATION_FAILED", async () => {
    const p = `P${rnd()}`;
    await mkItems(A, p, 1);
    expect((await searchItems(readOnly(), { q: p })).items.map((i) => i.code)).toEqual([`${p}-01`]);
    expect((await searchItems(picker(A), { q: p })).items.map((i) => i.code)).toEqual([`${p}-01`]);
    await expectFail(searchItems(as(A, noRoleUserId), { q: p }), "FORBIDDEN");
    await expectFail(searchItems(as(A, strangerUserId), { q: p }), "NOT_FOUND"); // üye olmayana tenant varlığı sızmaz
    await expectFail(searchItems(admin(A), { limit: 101 }), "VALIDATION_FAILED");
    await expectFail(searchItems(admin(A), { after: "bozuk" }), "VALIDATION_FAILED");
  });
});

describe("listItemConversions / listItemBarcodes", () => {
  it("dönüşümler kanonik decimal metin olarak döner; yeni ürün boş", async () => {
    const [id] = await mkItems(A, `C${rnd()}`, 1);
    expect(await listItemConversions(readOnly(), id as string)).toEqual([]);
    await setUnitConversion(admin(A), { itemId: id as string, unitId: A.boxUnitId, factor: "12.500000" });
    const rows = await listItemConversions(readOnly(), id as string);
    expect(rows.map((r) => ({ unitId: r.unitId, factor: r.factor }))).toEqual([{ unitId: A.boxUnitId, factor: "12.5" }]);
  });

  it("barkodlar: birim + miktar (koli barkodunda adet katsayıdan gelir, miktar \"1\"); birimsiz barkod temel birimi, miktarsız \"1\" gösterir; ambiguous yalnız aynı tenant'ta başka ACTIVE üründe kayıtlıysa", async () => {
    const [x, y] = await mkItems(A, `B${rnd()}`, 2);
    const [bItem] = await mkItems(B, `B${rnd()}`, 1);
    const shared = `9${rnd()}${rnd()}`;
    const solo = `7${rnd()}${rnd()}`;
    await addBarcode(admin(A), { itemId: x as string, barcode: shared });
    await setUnitConversion(admin(A), { itemId: y as string, unitId: A.boxUnitId, factor: "12" }); // K-1: koli barkodu önce katsayı ister
    await addBarcode(admin(A), { itemId: y as string, barcode: shared, unitId: A.boxUnitId });
    await addBarcode(admin(A), { itemId: x as string, barcode: solo });
    await addBarcode(admin(B), { itemId: bItem as string, barcode: solo }); // başka tenant aynı barkod: A'yı etkilemez
    const xs = await listItemBarcodes(readOnly(), x as string);
    expect(xs.map((r) => ({ barcode: r.barcode, unitId: r.unitId, quantity: r.quantity, ambiguous: r.ambiguous })).sort((a, b) => a.barcode.localeCompare(b.barcode))).toEqual(
      [
        { barcode: solo, unitId: A.unitId, quantity: "1", ambiguous: false },
        { barcode: shared, unitId: A.unitId, quantity: "1", ambiguous: true },
      ].sort((a, b) => a.barcode.localeCompare(b.barcode)),
    );
    const ys = await listItemBarcodes(admin(A), y as string);
    expect(ys.map((r) => ({ barcode: r.barcode, unitId: r.unitId, quantity: r.quantity, ambiguous: r.ambiguous }))).toEqual([
      { barcode: shared, unitId: A.boxUnitId, quantity: "1", ambiguous: true },
    ]);
    // Diğer ürün arşivlenince (çözümleme onu görmez) belirsizlik kalkar.
    await archiveItem(admin(A), { itemId: y as string });
    expect((await listItemBarcodes(admin(A), x as string)).every((r) => !r.ambiguous)).toBe(true);
  });

  it("tenant ve izin: başka tenant ürünü NOT_FOUND (yok olanla aynı), rolsüz üye FORBIDDEN, üye olmayan NOT_FOUND, UUID olmayan VALIDATION_FAILED", async () => {
    const [id] = await mkItems(A, `N${rnd()}`, 1);
    const missing = randomUUID();
    for (const fn of [listItemConversions, listItemBarcodes, itemInUse] as const) {
      await expectFail(fn(admin(B), id as string), "NOT_FOUND");
      await expectFail(fn(admin(A), missing), "NOT_FOUND");
      await expectFail(fn(as(A, noRoleUserId), id as string), "FORBIDDEN");
      await expectFail(fn(as(A, strangerUserId), id as string), "NOT_FOUND");
      await expectFail(fn(admin(A), "nope"), "VALIDATION_FAILED");
    }
  });
});

describe("itemInUse", () => {
  it("archiveItem ile aynı sonuç: stoklu/rezervasyonlu ürün true ve IN_USE; boş ürün false ve arşivlenir", async () => {
    for (const itemId of [A.itemNoneId, A.itemId]) {
      expect(await itemInUse(readOnly(), itemId)).toBe(true);
      await expectFail(archiveItem(admin(A), { itemId }), "VALIDATION_FAILED", "IN_USE");
    }
    const [fresh] = await mkItems(A, `U${rnd()}`, 1);
    expect(await itemInUse(readOnly(), fresh as string)).toBe(false);
    expect(await archiveItem(admin(A), { itemId: fresh as string })).toEqual({ itemId: fresh, changed: true });
  });
});

describe("okumalar yazmaz", () => {
  it("tüm okumalardan önce ve sonra ürün/barkod/dönüşüm/audit sayıları aynı", async () => {
    const snap = async () =>
      (
        await adm.query(
          `SELECT (SELECT count(*) FROM public.items WHERE tenant_id = $1)::int AS items,
                  (SELECT count(*) FROM public.item_barcodes WHERE tenant_id = $1)::int AS barcodes,
                  (SELECT count(*) FROM public.unit_conversions WHERE tenant_id = $1)::int AS conversions,
                  (SELECT count(*) FROM public.audit_logs WHERE tenant_id = $1)::int AS audits,
                  (SELECT count(*) FROM public.stock_ledger WHERE tenant_id = $1)::int AS ledger`,
          [A.tenantId],
        )
      ).rows[0];
    const before = await snap();
    await searchItems(admin(A), { limit: 100 });
    await listItemConversions(admin(A), A.itemNoneId);
    await listItemBarcodes(admin(A), A.itemNoneId);
    await itemInUse(admin(A), A.itemNoneId);
    expect(await snap()).toEqual(before);
  });
});
