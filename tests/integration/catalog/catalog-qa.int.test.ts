// T-219 (qa-verifier): katalog ve izlenebilirlik komutları için bağımsız doğrulama. Gerçek wms_app bağlantısı + RLS; fikstür
// migration rolüyle (adm). Veriler sentetik (G-09). Senaryolar: barkod belirsizliği + GS1, izlenebilirlik, taşıma birimi
// döngüsü (ADR-011), dönüşümün belge satırına kopyalanması (I-09), stoklu üründe takip modu değişimi.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { createTenantContext, DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  BarcodeAmbiguousError,
  BarcodeNotFoundError,
  GS,
  addBarcode,
  createHandlingUnit,
  createItem,
  createLot,
  isValidGtin,
  parseGs1,
  registerSerial,
  resolveBarcodeQuery,
  setUnitConversion,
  updateItem,
} from "../../../packages/domain/src/catalog/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex");

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

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
}, 120_000);

afterAll(async () => {
  // Audit append-only: audit yazan tenant'lar kısa ömürlü ortamda kalır (catalog-commands.int.test.ts ile aynı politika);
  // yalnızca bağlantılar kapatılır.
  await adm?.end().catch(() => undefined);
  await app?.close().catch(() => undefined);
}, 60_000);

const as = (w: TenantWorld, userId: string) => ({ db: app, principal: { userId, mfaVerified: true }, tenantSlug: w.slug });
const admin = (w: TenantWorld) => as(w, w.ownerUserId);

async function fail(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "hata bekleniyordu").toBeDefined();
  return err;
}
async function expectApp(p: Promise<unknown>, code: string, detail?: string): Promise<void> {
  const e = await fail(p);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  expect((e as AppError).detail).toBe(detail);
}
async function mkItem(w: TenantWorld, trackingMode: "NONE" | "LOT" | "SERIAL" | "LOT_AND_SERIAL" = "NONE"): Promise<string> {
  return (await createItem(admin(w), { code: `Q${rnd()}`, name: "QA urun", baseUnitId: w.unitId, trackingMode })).itemId;
}
/** Bağımsız GTIN-14 üretici (üretim isValidGtin'ine dayanmaz): 13 rastgele hane + mod-10 kontrol hanesi. */
function gtin14(bad = false): string {
  let body = "";
  for (let i = 0; i < 13; i++) body += String(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1); // 14 haneli: soldan 1. ağırlık 3
  const check = (10 - (sum % 10)) % 10;
  return body + String(bad ? (check + 1) % 10 : check);
}
function chain(e: unknown): string {
  const out: string[] = [];
  for (let c: unknown = e, i = 0; c !== undefined && c !== null && i < 6; i++, c = (c as { cause?: unknown }).cause) out.push(String((c as { message?: unknown }).message));
  return out.join(" | ");
}

describe("barkod belirsizliği (A-69) ve tenant izolasyonu", () => {
  it("aynı barkod iki üründe -> BARCODE_AMBIGUOUS; adaylar yalnızca A tenant'ının kayıtları; B'de aynı barkod A'yı etkilemez", async () => {
    const code = `AMB${rnd()}`;
    const a1 = await mkItem(A);
    const a2 = await mkItem(A);
    const b1 = await mkItem(B);
    await addBarcode(admin(A), { itemId: a1, barcode: code });
    await addBarcode(admin(A), { itemId: a2, barcode: code });
    await addBarcode(admin(B), { itemId: b1, barcode: code });

    const err = await fail(resolveBarcodeQuery(admin(A), code));
    expect(err).toBeInstanceOf(BarcodeAmbiguousError);
    const amb = err as BarcodeAmbiguousError;
    expect(amb.code).toBe("VALIDATION_FAILED");
    expect(amb.detail).toBe("BARCODE_AMBIGUOUS");
    expect(amb.candidates.map((c) => c.itemId).sort()).toEqual([a1, a2].sort());
    expect(amb.candidates.map((c) => c.itemId)).not.toContain(b1);
    expect(JSON.stringify(amb.candidates)).not.toContain(B.tenantId);

    // B tarafı: yalnızca B'nin tek kaydı -> belirsizlik yok, B'nin ürününe çözülür (A'nın iki kaydı sızmaz).
    const resolvedB = await resolveBarcodeQuery(admin(B), code);
    expect(resolvedB.itemId).toBe(b1);

    // A'ya özgü olmayan barkod: A, B'nin kaydını göremez -> NOT_FOUND.
    const onlyB = `ONB${rnd()}`;
    await addBarcode(admin(B), { itemId: b1, barcode: onlyB });
    const nf = await fail(resolveBarcodeQuery(admin(A), onlyB));
    expect(nf).toBeInstanceOf(BarcodeNotFoundError);
    expect((nf as AppError).code).toBe("NOT_FOUND");
  });

  it("yazma tarafı çapraz tenant: A'nın slug'ında B'nin itemId/unitId'si ile addBarcode/setUnitConversion -> NOT_FOUND ve B'de değişiklik yok", async () => {
    const aItem = await mkItem(A);
    const before = (await adm.query("SELECT (SELECT count(*) FROM public.item_barcodes WHERE tenant_id = $1)::int AS bc, (SELECT count(*) FROM public.unit_conversions WHERE tenant_id = $1)::int AS uc", [B.tenantId])).rows[0];
    await expectApp(addBarcode(admin(A), { itemId: B.itemId, barcode: `X${rnd()}` }), "NOT_FOUND");
    await expectApp(addBarcode(admin(A), { itemId: aItem, unitId: B.boxUnitId, barcode: `X${rnd()}` }), "NOT_FOUND");
    await expectApp(setUnitConversion(admin(A), { itemId: B.itemId, unitId: A.boxUnitId, factor: "5" }), "NOT_FOUND");
    await expectApp(setUnitConversion(admin(A), { itemId: aItem, unitId: B.boxUnitId, factor: "5" }), "NOT_FOUND");
    const after = (await adm.query("SELECT (SELECT count(*) FROM public.item_barcodes WHERE tenant_id = $1)::int AS bc, (SELECT count(*) FROM public.unit_conversions WHERE tenant_id = $1)::int AS uc", [B.tenantId])).rows[0];
    expect(after).toEqual(before);
  });

  it("resolveBarcode başka tenant kimliğiyle (A bağlamı, B tenantId) -> NOT_FOUND: RLS + tenant filtresi", async () => {
    const code = `RLS${rnd()}`;
    const b1 = await mkItem(B);
    await addBarcode(admin(B), { itemId: b1, barcode: code });
    const { resolveBarcode } = await import("../../../packages/domain/src/catalog/barcodes.ts");
    const e = await fail(
      withTenant(createTenantContext(app, A.tenantId), (tx) => resolveBarcode(tx as unknown as Parameters<typeof resolveBarcode>[0], B.tenantId, code)),
    );
    expect((e as AppError).code).toBe("NOT_FOUND");
  });

  it("A-69 ince ayar: aynı ürün + aynı birim + aynı barkod ikinci kez eklenemez (CODE_TAKEN); sessizce ilk ürüne atanmaz", async () => {
    const code = `DUP${rnd()}`;
    const a1 = await mkItem(A);
    await addBarcode(admin(A), { itemId: a1, barcode: code });
    await expectApp(addBarcode(admin(A), { itemId: a1, barcode: code }), "VALIDATION_FAILED", "CODE_TAKEN");
    const a2 = await mkItem(A);
    await addBarcode(admin(A), { itemId: a2, barcode: code }); // farklı ürün serbest -> belirsizlik
    expect(await fail(resolveBarcodeQuery(admin(A), code))).toBeInstanceOf(BarcodeAmbiguousError);
  });
});

describe("GS1", () => {
  it("geçersiz kontrol haneli GTIN -> ayrıştırma reddi; çözümleme NOT_FOUND (gs1Reason) ve depodaki aynı gövdeli geçerli barkoda atanmaz", async () => {
    const good = gtin14();
    const bad = good.slice(0, 13) + String((Number(good[13]) + 1) % 10);
    expect(isValidGtin(good)).toBe(true);
    expect(isValidGtin(bad)).toBe(false);
    expect(parseGs1(`01${bad}`)).toEqual({ ok: false, reason: "INVALID_GTIN_CHECK_DIGIT" });
    expect(parseGs1(`]C101${bad}`)).toEqual({ ok: false, reason: "INVALID_GTIN_CHECK_DIGIT" });
    const item = await mkItem(A);
    await addBarcode(admin(A), { itemId: item, barcode: good }); // geçerli GTIN-14 depoda
    const e = await fail(resolveBarcodeQuery(admin(A), `]C101${bad}`));
    expect(e).toBeInstanceOf(BarcodeNotFoundError);
    expect((e as BarcodeNotFoundError).gs1Reason).toBe("INVALID_GTIN_CHECK_DIGIT");
    // Olumlu kontrol: geçerli GTIN aynı biçimde çözülür.
    const ok = await resolveBarcodeQuery(admin(A), `]C101${good}`);
    expect(ok.itemId).toBe(item);
    // Geçerli GTIN içeren GS1 dizgisi ham barkod olarak KAYDEDİLEMEZ (addBarcode reddi).
    await expectApp(addBarcode(admin(A), { itemId: item, barcode: `01${good}` }), "VALIDATION_FAILED");
  });

  it("FNC1'siz değişken uzunluklu son alan doğru okunur; ayraçlı ara alan ayrılır; sonda ayraç yutmaz", async () => {
    const g = gtin14();
    const r1 = parseGs1(`01${g}10LOT-7`);
    expect(r1).toMatchObject({ ok: true, gtin: g, lot: "LOT-7", hasFnc1: false });
    const r2 = parseGs1(`01${g}21SER9`);
    expect(r2).toMatchObject({ ok: true, gtin: g, serial: "SER9" });
    const r3 = parseGs1(`01${g}10AB1${GS}21XY2`);
    expect(r3).toMatchObject({ ok: true, gtin: g, lot: "AB1", serial: "XY2", hasFnc1: true });
    const r4 = parseGs1(`01${g}17261231`);
    expect(r4).toMatchObject({ ok: true, expiryDate: "2026-12-31" });
    // Değişken alan 20 karakteri aşarsa (FNC1 yok, sonuna kadar okunur) reddedilir: sessiz kesme yok.
    expect(parseGs1(`01${g}10${"A".repeat(21)}`)).toEqual({ ok: false, reason: "MALFORMED" });
    // Uçtan uca: değişken uzunluklu lot çözümlemede kaybolmaz.
    const item = await mkItem(A);
    await addBarcode(admin(A), { itemId: item, barcode: g });
    const res = await resolveBarcodeQuery(admin(A), `01${g}10LOT-7`);
    expect(res.itemId).toBe(item);
    expect(res.gs1?.lot).toBe("LOT-7");
  });
});

describe("izlenebilirlik", () => {
  it("NONE ürüne lot/seri -> TRACKING_VIOLATION; ürün içi seri tekrarı ret, farklı üründe kabul (A-72)", async () => {
    const none = await mkItem(A, "NONE");
    await expectApp(createLot(admin(A), { itemId: none, lotCode: `L${rnd()}` }), "TRACKING_VIOLATION");
    await expectApp(registerSerial(admin(A), { itemId: none, serialNo: `S${rnd()}` }), "TRACKING_VIOLATION");
    const s1 = await mkItem(A, "SERIAL");
    const s2 = await mkItem(A, "SERIAL");
    const no = `S${rnd()}`;
    await registerSerial(admin(A), { itemId: s1, serialNo: no });
    await expectApp(registerSerial(admin(A), { itemId: s1, serialNo: no }), "TRACKING_VIOLATION");
    await registerSerial(admin(A), { itemId: s2, serialNo: no });
    const n = (await adm.query("SELECT count(*)::int AS n FROM public.serials WHERE tenant_id = $1 AND serial_no = $2", [A.tenantId, no])).rows[0] as { n: number };
    expect(n.n).toBe(2);
    // B tenant'ında aynı numara bağımsız serbest.
    const sb = await mkItem(B, "SERIAL");
    await registerSerial(admin(B), { itemId: sb, serialNo: no });
  });

  it("eşzamanlı (gerçek paralel bağlantı) aynı ürün+aynı seri: tam bir kayıt, diğeri TRACKING_VIOLATION", async () => {
    for (let i = 0; i < 4; i++) {
      const s = await mkItem(A, "SERIAL");
      const no = `S${rnd()}`;
      const res = await Promise.allSettled([1, 2, 3].map(() => registerSerial(admin(A), { itemId: s, serialNo: no })));
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of res) if (r.status === "rejected") expect((r.reason as AppError).code).toBe("TRACKING_VIOLATION");
    }
  });

  it("taşıma birimi döngüsü (ADR-011): kendi-kendine, 2 ve 3 halka wms_app + RLS altında HANDLING_UNIT_CYCLE; ebeveyn değişmez", async () => {
    const p = await createHandlingUnit(admin(A), { kind: "PALET", code: `P${rnd()}` });
    const k = await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: p.handlingUnitId });
    const k2 = await createHandlingUnit(admin(A), { kind: "KOLI", code: `K${rnd()}`, parentId: k.handlingUnitId });
    const upd = (id: string, parent: string): Promise<unknown> =>
      withTenant(createTenantContext(app, A.tenantId), (tx) =>
        tx.execute(sql`UPDATE public.handling_units SET parent_id = ${parent}::uuid WHERE tenant_id = ${A.tenantId}::uuid AND id = ${id}::uuid`),
      );
    for (const [id, parent] of [
      [p.handlingUnitId, p.handlingUnitId],
      [p.handlingUnitId, k.handlingUnitId],
      [p.handlingUnitId, k2.handlingUnitId],
      [k.handlingUnitId, k2.handlingUnitId],
    ] as const) {
      expect(chain(await fail(upd(id, parent))), `${id} -> ${parent}`).toMatch(/HANDLING_UNIT_CYCLE/);
    }
    const rows = (await adm.query("SELECT id, parent_id FROM public.handling_units WHERE id = ANY($1)", [[p.handlingUnitId, k.handlingUnitId, k2.handlingUnitId]])).rows as { id: string; parent_id: string | null }[];
    const parentOf = Object.fromEntries(rows.map((r) => [r.id, r.parent_id]));
    expect(parentOf).toEqual({ [p.handlingUnitId]: null, [k.handlingUnitId]: p.handlingUnitId, [k2.handlingUnitId]: k.handlingUnitId });
    // Olumlu kontrol: döngü olmayan yeniden bağlama geçer (testin her güncellemeyi reddetmediğinin kanıtı).
    await upd(k2.handlingUnitId, p.handlingUnitId);
  });

  it("stoklu üründe takip modu değişimi -> IN_USE (fikstür: migration rolüyle defter + bakiye); defter toplamı == bakiye ve değişmez", async () => {
    const item = await mkItem(A, "NONE");
    const dim = randomUUID();
    const line = randomUUID();
    const lineNo = 500 + Math.floor(Math.random() * 100000);
    await adm.query("BEGIN");
    try {
      await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await adm.query(
        `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
         VALUES ($1, $2, $3, $4, $5, $6, 7, 1, 7, $7)`,
        [A.tenantId, line, A.documentId, lineNo, item, A.unitId, A.rootLocationId],
      );
      await adm.query("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id) VALUES ($1, $2, $3, $4, NULL, NULL)", [A.tenantId, dim, item, A.rootLocationId]);
      await adm.query(
        `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, actor_user_id)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, 7, 'T219 fikstur', '2026-01-15', $5)`,
        [A.tenantId, A.documentId, line, dim, A.ownerUserId],
      );
      await adm.query("INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, $2, 7, 0)", [A.tenantId, dim]);
      await adm.query("COMMIT");
    } catch (e) {
      await adm.query("ROLLBACK");
      throw e;
    }
    const snapshot = async (): Promise<unknown> => {
      const it = (await adm.query("SELECT tracking_mode, quantity_scale, base_unit_id FROM public.items WHERE id = $1", [item])).rows;
      const led = (await adm.query("SELECT COALESCE(sum(quantity), 0)::text AS s FROM public.stock_ledger WHERE stock_dimension_id = $1", [dim])).rows[0] as { s: string };
      const bal = (await adm.query("SELECT quantity::text AS q FROM public.stock_balances WHERE stock_dimension_id = $1", [dim])).rows[0] as { q: string };
      return { it, ledger: Number(led.s), balance: Number(bal.q) };
    };
    const before = await snapshot();
    expect(before).toMatchObject({ ledger: 7, balance: 7 });
    for (const trackingMode of ["LOT", "SERIAL", "LOT_AND_SERIAL"] as const) {
      await expectApp(updateItem(admin(A), { itemId: item, trackingMode }), "VALIDATION_FAILED", "IN_USE");
    }
    await expectApp(updateItem(admin(A), { itemId: item, quantityScale: 3 }), "VALIDATION_FAILED", "IN_USE");
    expect(await snapshot()).toEqual(before);
    // Seri boyutu olan seed ürünü (LOT_AND_SERIAL -> NONE) de aynı.
    await expectApp(updateItem(admin(A), { itemId: A.itemId, trackingMode: "NONE" }), "VALIDATION_FAILED", "IN_USE");
    // Aynı modu yinelemek değişiklik değildir (no-op): hata yok.
    await expect(updateItem(admin(A), { itemId: item, trackingMode: "NONE" })).resolves.toMatchObject({ itemId: item, changed: false });
  });
});

describe("dönüşüm katsayısı belge satırına kopyalanır (I-09)", () => {
  it("kart katsayısı sonradan değişse de belge satırındaki conversion_factor/base_quantity değişmez; yeni katsayı kanonik dizgi", async () => {
    const item = await mkItem(A, "NONE");
    await setUnitConversion(admin(A), { itemId: item, unitId: A.boxUnitId, factor: "12.50" });
    const line = randomUUID();
    const lineNo = 100000 + Math.floor(Math.random() * 100000);
    await adm.query(
      `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, 2, 12.5, 25, $7)`,
      [A.tenantId, line, A.documentId, lineNo, item, A.boxUnitId, A.rootLocationId],
    );
    const res = await setUnitConversion(admin(A), { itemId: item, unitId: A.boxUnitId, factor: "24" });
    expect(res.factor).toBe("24");
    const cardRow = (await adm.query("SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE tenant_id = $1 AND item_id = $2 AND unit_id = $3", [A.tenantId, item, A.boxUnitId])).rows[0] as { f: string };
    expect(Number(cardRow.f)).toBe(24);
    const l = (await adm.query("SELECT conversion_factor::text AS cf, base_quantity::text AS bq FROM public.document_lines WHERE id = $1", [line])).rows[0] as { cf: string; bq: string };
    expect(Number(l.cf)).toBe(12.5);
    expect(Number(l.bq)).toBe(25);
    // Float/negatif/aşırı ondalık katsayı ve temel birim için dönüşüm reddedilir; kart değişmez.
    await expectApp(setUnitConversion(admin(A), { itemId: item, unitId: A.boxUnitId, factor: "0.1234567" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    await expectApp(setUnitConversion(admin(A), { itemId: item, unitId: A.boxUnitId, factor: "1e2" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    await expectApp(setUnitConversion(admin(A), { itemId: item, unitId: A.boxUnitId, factor: "-3" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    await expectApp(setUnitConversion(admin(A), { itemId: item, unitId: A.unitId, factor: "2" }), "VALIDATION_FAILED", "UNIT_CONVERSION_INVALID");
    const cardRow2 = (await adm.query("SELECT to_base_factor::text AS f FROM public.unit_conversions WHERE tenant_id = $1 AND item_id = $2 AND unit_id = $3", [A.tenantId, item, A.boxUnitId])).rows[0] as { f: string };
    expect(Number(cardRow2.f)).toBe(24);
  });
});
