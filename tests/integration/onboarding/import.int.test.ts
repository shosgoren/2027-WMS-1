// T-289: açılış verisi içe aktarma — ürünler (koli/barkod) ve açılış stoku. Gerçek wms_app + RLS; yalnız domain komutları.
// Kabul: başarılı içe aktarma → defter = bakiye; aynı dosya ikinci kez → ek hareket yok; hatalı satır → hiçbir şey yazılmaz;
// yetkisiz → FORBIDDEN; başka tenant izolasyonu. Fikstürler sentetik (G-09); audit değişmez olduğundan veri geçici ortamda kalır.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { createLocation, createWarehouse } from "../../../packages/domain/src/warehouse/index.ts";
import { IMPORT_CHUNK_SIZE, applyImportChunk, previewImport, linesDigestOf, stockClientKey, type ChunkReport, type ImportCallParams } from "../../../packages/domain/src/onboarding/index.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

const asAdmin = (w: TenantWorld): ImportCallParams => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug, requestId: randomUUID() });
const asPicker = (w: TenantWorld): ImportCallParams => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });
const NO_DIGEST = "0".repeat(64);
const pfx = (): string => `Z${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}
const num = async (text: string, args: unknown[]): Promise<number> => Number(((await adm.query<{ n: string }>(text, args)).rows[0] as { n: string }).n);
const countItems = (w: TenantWorld, p: string) => num("SELECT count(*) AS n FROM public.items WHERE tenant_id = $1 AND code LIKE $2", [w.tenantId, `${p}%`]);
const countLedger = (w: TenantWorld, p: string) =>
  num("SELECT count(*) AS n FROM public.stock_ledger l JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id WHERE l.tenant_id = $1 AND i.code LIKE $2", [w.tenantId, `${p}%`]);
const countAudit = (w: TenantWorld, action: string) => num("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = $2", [w.tenantId, action]);

/** Tüm parçaları sırayla uygular (istemci döngüsünün aynısı); raporları döndürür. */
async function applyAll(params: () => ImportCallParams, text: string): Promise<ChunkReport[]> {
  const pv = await previewImport(params(), text);
  expect(pv.issueTotal).toBe(0);
  const out: ChunkReport[] = [];
  for (let c = 0; c < pv.chunkCount; c++) {
    const r = await applyImportChunk(params(), { text, chunk: c, digest: pv.digest });
    out.push(r);
    if (!r.complete) break;
  }
  return out;
}

async function newShelf(w: TenantWorld, code: string): Promise<string> {
  return (await createLocation({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug }, { warehouseId: w.warehouseId, code, name: code, kind: "STORAGE" })).locationId;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A289");
  B = await seedWorld(adm, reg, "B289");
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("ürünler (koli ve barkod)", () => {
  it("önizleme hiçbir şey yazmaz; uygulama ürün, koli katsayısı ve barkodları yazar; ikinci yükleme ek kayıt/audit üretmez", async () => {
    const p = pfx();
    const csv = [
      "kod;ad;temel birim;koli içi adet;adet barkodu;koli barkodu",
      `${p}-1;Vida M6;ADET;12;${p}B1;${p}K1`,
      `${p}-2;Somun;;;${p}B2;`,
      `${p}-3;Pul;adet;24;;${p}K3`,
    ].join("\r\n");
    const pv = await previewImport(asAdmin(A), `﻿${csv}`);
    expect(pv).toMatchObject({ kind: "PRODUCTS", rowCount: 3, issueTotal: 0, chunkCount: 1, products: { create: 3, existing: 0, packs: 2, barcodes: 4, willCreatePackUnit: false } });
    expect(await countItems(A, p)).toBe(0); // önizleme yazmadı

    const reports = await applyAll(() => asAdmin(A), csv);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.counts).toMatchObject({ CREATED: 3, FAILED: 0 });
    expect(await countItems(A, p)).toBe(3);

    const conv = await adm.query<{ code: string; f: string }>(
      "SELECT i.code, c.to_base_factor::text AS f FROM public.unit_conversions c JOIN public.items i ON i.tenant_id = c.tenant_id AND i.id = c.item_id WHERE c.tenant_id = $1 AND i.code LIKE $2 ORDER BY i.code",
      [A.tenantId, `${p}%`],
    );
    expect(conv.rows.map((r) => [r.code, Number(r.f)])).toEqual([[`${p}-1`, 12], [`${p}-3`, 24]]);
    const bc = await adm.query<{ barcode: string; unit_id: string | null; quantity: string | null }>(
      "SELECT b.barcode, b.unit_id, b.quantity::text AS quantity FROM public.item_barcodes b WHERE b.tenant_id = $1 AND b.barcode LIKE $2 ORDER BY b.barcode",
      [A.tenantId, `${p}%`],
    );
    // K-1: koli barkodunda ayrı miktar yok (adet katsayıdan gelir); adet barkodunda birim yok (temel birim).
    expect(bc.rows.map((r) => [r.barcode, r.unit_id, r.quantity])).toEqual([
      [`${p}B1`, null, null],
      [`${p}B2`, null, null],
      [`${p}K1`, A.boxUnitId, null],
      [`${p}K3`, A.boxUnitId, null],
    ]);

    // Aynı dosya ikinci kez: ek ürün/dönüşüm/barkod/audit yok.
    const auditBefore = [await countAudit(A, "item.created"), await countAudit(A, "item_barcode.added"), await countAudit(A, "unit_conversion.set")];
    const second = await applyAll(() => asAdmin(A), csv);
    expect(second[0]?.counts).toMatchObject({ UNCHANGED: 3, CREATED: 0, UPDATED: 0, FAILED: 0 });
    expect(await countItems(A, p)).toBe(3);
    expect([await countAudit(A, "item.created"), await countAudit(A, "item_barcode.added"), await countAudit(A, "unit_conversion.set")]).toEqual(auditBefore);
    expect((await previewImport(asAdmin(A), csv)).products).toMatchObject({ create: 0, existing: 3 });
  });

  it("hatalı satır: önizleme satır/sütun ile bildirir, uygulama VALIDATION_FAILED ve HİÇBİR şey yazılmaz (geçerli satırlar da)", async () => {
    const p = pfx();
    const csv = ["kod;ad;temel birim;koli içi adet;adet barkodu;koli barkodu", `${p}-1;İyi;;;;`, `${p}-2;;;;;`, `${p}-3;Kesirli koli;;12,5;;`, `${p}-1;Mükerrer;;;;`].join("\n");
    const pv = await previewImport(asAdmin(A), csv);
    expect(pv.issues.map((i) => `${i.row}:${i.column}:${i.code}`)).toEqual(["3:ad:NAME_MISSING", "4:koli içi adet:PACK_QTY_FRACTIONAL", "5:kod:CODE_DUPLICATE_FILE"]);
    expect(pv.chunkCount).toBe(0);
    expect((await failure(applyImportChunk(asAdmin(A), { text: csv, chunk: 0, digest: NO_DIGEST }))).code).toBe("VALIDATION_FAILED");
    expect(await countItems(A, p)).toBe(0);
  });

  it("sistemde başka ürüne ait barkod ve çelişen koli katsayısı reddedilir (sessiz değişiklik yok)", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad;koli içi adet;adet barkodu\n${p}-1;Bir;12;${p}X`);
    const pv = await previewImport(asAdmin(A), `kod;ad;koli içi adet;adet barkodu\n${p}-2;İki;;${p}X\n${p}-1;Bir;24;`);
    expect(pv.issues.map((i) => `${i.row}:${i.column}:${i.code}`)).toEqual(["2:adet barkodu:BARCODE_TAKEN", "3:koli içi adet:PACK_QTY_CONFLICT"]);
  });

  it("200+ satır parçalanır; ikinci yükleme tüm parçalarda değişiklik üretmez", async () => {
    const p = pfx();
    const n = IMPORT_CHUNK_SIZE * 2 + 5;
    const csv = ["kod,ad", ...Array.from({ length: n }, (_, i) => `${p}-${i},Ürün ${i}`)].join("\n");
    const first = await applyAll(() => asAdmin(A), csv);
    expect(first.map((r) => r.rows.length)).toEqual([IMPORT_CHUNK_SIZE, IMPORT_CHUNK_SIZE, 5]);
    expect(await countItems(A, p)).toBe(n);
    const second = await applyAll(() => asAdmin(A), csv);
    expect(second.every((r) => r.counts.UNCHANGED === r.rows.length)).toBe(true);
    expect(await countItems(A, p)).toBe(n);
  }, 120_000);
});

describe("açılış stoku", () => {
  it("uygulama STOCK_IN yazar (defter = bakiye); aynı dosya ikinci kez ek defter satırı üretmez", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir\n${p}-2;İki\n${p}-3;Üç`);
    const s1 = `${p}-R1`;
    const s2 = `${p}-R2`;
    await newShelf(A, s1);
    await newShelf(A, s2);
    const csv = ["ürün kodu;raf kodu;miktar (adet)", `${p}-1;${s1};1.250,0`, `${p}-1;${s2};40`, `${p}-2;${s1};7`, `${p}-3;${s2.toLowerCase()};1`].join("\r\n");
    const pv = await previewImport(asAdmin(A), `﻿${csv}`);
    expect(pv).toMatchObject({ kind: "STOCK", rowCount: 4, issueTotal: 0, chunkCount: 1, stock: { lines: 4, items: 3, warehouses: 1, totalQuantity: "1298" } });
    expect(await countLedger(A, p)).toBe(0);

    const first = await applyAll(() => asAdmin(A), csv);
    expect(first[0]?.counts).toMatchObject({ APPLIED: 4, FAILED: 0 });
    expect(await countLedger(A, p)).toBe(4);
    // Defter = bakiye (I-04): ürün başına Σ defter = Σ bakiye.
    const rows = await adm.query<{ code: string; ledger: string; bal: string }>(
      `SELECT i.code,
              (SELECT COALESCE(sum(quantity), 0) FROM public.stock_ledger l WHERE l.tenant_id = i.tenant_id AND l.item_id = i.id)::text AS ledger,
              (SELECT COALESCE(sum(b.quantity), 0) FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
                WHERE d.tenant_id = i.tenant_id AND d.item_id = i.id)::text AS bal
         FROM public.items i WHERE i.tenant_id = $1 AND i.code LIKE $2 ORDER BY i.code`,
      [A.tenantId, `${p}%`],
    );
    expect(rows.rows.map((r) => [r.code, Number(r.ledger), Number(r.bal)])).toEqual([[`${p}-1`, 1290, 1290], [`${p}-2`, 7, 7], [`${p}-3`, 1, 1]]);
    const reasons = await adm.query<{ reason: string }>("SELECT DISTINCT l.reason FROM public.stock_ledger l JOIN public.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id WHERE l.tenant_id = $1 AND i.code LIKE $2", [A.tenantId, `${p}%`]);
    expect(reasons.rows.map((r) => r.reason)).toEqual(["RECEIPT"]); // A-79: STOCK_IN + RECEIPT

    const docs = await num("SELECT count(*) AS n FROM public.documents WHERE tenant_id = $1 AND reason = 'import.opening_stock'", [A.tenantId]);
    const second = await applyAll(() => asAdmin(A), csv);
    expect(second[0]?.counts).toMatchObject({ REPLAYED: 4, APPLIED: 0, FAILED: 0 });
    expect(await countLedger(A, p)).toBe(4);
    expect(await num("SELECT count(*) AS n FROM public.documents WHERE tenant_id = $1 AND reason = 'import.opening_stock'", [A.tenantId])).toBe(docs);
  });

  it("200+ satır parçalanır (her parça ayrı belge); ikinci yükleme defteri değiştirmez", async () => {
    const p = pfx();
    const n = IMPORT_CHUNK_SIZE * 2 + 5;
    await applyAll(() => asAdmin(A), ["kod,ad", ...Array.from({ length: n }, (_, i) => `${p}-${i},Ürün ${i}`)].join("\n"));
    const shelf = `${p}-R`;
    await newShelf(A, shelf);
    const csv = ["ürün kodu,raf kodu,miktar", ...Array.from({ length: n }, (_, i) => `${p}-${i},${shelf},${i + 1}`)].join("\n");
    const first = await applyAll(() => asAdmin(A), csv);
    expect(first.map((r) => r.rows.length)).toEqual([IMPORT_CHUNK_SIZE, IMPORT_CHUNK_SIZE, 5]);
    expect(first.every((r) => r.complete)).toBe(true);
    expect(await countLedger(A, p)).toBe(n);
    const second = await applyAll(() => asAdmin(A), csv);
    expect(second.every((r) => r.counts.REPLAYED === r.rows.length)).toBe(true);
    expect(await countLedger(A, p)).toBe(n);
  }, 180_000);

  it("hatalı satırlar (bilinmeyen ürün/raf, kesirli ADET, arşivli/izlenen ürün) önizlemede; uygulama hiçbir şey yazmaz", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir`);
    await newShelf(A, `${p}-R`);
    const csv = ["ürün kodu;raf kodu;miktar", `${p}-1;${p}-R;5`, `YOK-${p};${p}-R;1`, `${p}-1;YOKRAF-${p};1`, `${p}-1;${p}-R;2,5`, "U1;" + `${p}-R;1`].join("\n");
    const pv = await previewImport(asAdmin(A), csv);
    expect(pv.issues.map((i) => `${i.row}:${i.column}:${i.code}`)).toEqual(["3:ürün kodu:ITEM_UNKNOWN", "4:raf kodu:SHELF_UNKNOWN", "5:miktar:QTY_FRACTIONAL", "6:ürün kodu:ITEM_TRACKED"]);
    const before = await countLedger(A, p);
    expect((await failure(applyImportChunk(asAdmin(A), { text: csv, chunk: 0, digest: NO_DIGEST }))).code).toBe("VALIDATION_FAILED");
    expect(await countLedger(A, p)).toBe(before);
    expect(await num("SELECT count(*) AS n FROM public.stock_dimensions d JOIN public.items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id WHERE d.tenant_id = $1 AND i.code LIKE $2", [A.tenantId, `${p}%`])).toBe(0);
  });

  it("anahtar satır İÇERİĞİNDEN türer: sıra değişimi aynı anahtar; farklı içerik/depo/adım farklı", () => {
    const l1 = { itemId: "i1", locationId: "l1", quantity: "5" };
    const l2 = { itemId: "i2", locationId: "l2", quantity: "7" };
    const d = linesDigestOf([l1, l2]);
    expect(linesDigestOf([l2, l1])).toBe(d);
    const k = stockClientKey(d, A.warehouseId, "post");
    expect(k).toBe(stockClientKey(linesDigestOf([l2, l1]), A.warehouseId, "post"));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set([k, stockClientKey(linesDigestOf([l1, { ...l2, quantity: "8" }]), A.warehouseId, "post"), stockClientKey(d, B.warehouseId, "post"), stockClientKey(d, A.warehouseId, "create")]).size).toBe(4);
  });

  it("çiftte stok varsa satır hatası (M-1); dosyayı sıralamak ya da satır eklemek önceden yazılmış satırı iki kez yazmaz (M-2)", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir\n${p}-2;İki\n${p}-3;Üç`);
    const s1 = `${p}-R1`;
    const s2 = `${p}-R2`;
    await newShelf(A, s1);
    await newShelf(A, s2);
    const head = "ürün kodu;raf kodu;miktar";
    await applyAll(() => asAdmin(A), [head, `${p}-1;${s1};10`, `${p}-2;${s1};20`].join("\n"));
    expect(await countLedger(A, p)).toBe(2);

    // Aynı çiftte farklı miktar: açılış stoku yalnız boş raflar içindir → hata, hiçbir şey yazılmaz.
    const conflict = [head, `${p}-1;${s1};12`].join("\n");
    const pv = await previewImport(asAdmin(A), conflict);
    expect(pv.issues.map((i) => `${i.row}:${i.code}`)).toEqual(["2:PAIR_HAS_STOCK"]);
    expect((await failure(applyImportChunk(asAdmin(A), { text: conflict, chunk: 0, digest: NO_DIGEST }))).code).toBe("VALIDATION_FAILED");
    expect(await countLedger(A, p)).toBe(2);

    // Sıra değişti + yeni satır eklendi: eski iki satır "zaten uygulanmış" (REPLAYED), yalnız yeni satır yazılır.
    const reordered = [head, `${p}-3;${s2};30`, `${p}-2;${s1};20`, `${p}-1;${s1};10`].join("\n");
    const rep = await applyAll(() => asAdmin(A), reordered);
    expect(rep[0]?.rows.map((r) => [r.code, r.status])).toEqual([[`${p}-3`, "APPLIED"], [`${p}-2`, "REPLAYED"], [`${p}-1`, "REPLAYED"]]);
    expect(await countLedger(A, p)).toBe(3);
    const bal = await adm.query<{ code: string; q: string }>(
      "SELECT i.code, sum(b.quantity)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id JOIN public.items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id WHERE i.tenant_id = $1 AND i.code LIKE $2 GROUP BY i.code ORDER BY i.code",
      [A.tenantId, `${p}%`],
    );
    expect(bal.rows.map((r) => [r.code, Number(r.q)])).toEqual([[`${p}-1`, 10], [`${p}-2`, 20], [`${p}-3`, 30]]);
  });

  it("EŞZAMANLI iki içe aktarma (aynı ürün+raf, farklı miktar): biri yazar, diğeri PAIR_HAS_STOCK ile durur; defterde TEK STOCK_IN (kilit altında yeniden denetim)", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir`);
    const shelf = `${p}-R`;
    await newShelf(A, shelf);
    const head = "ürün kodu;raf kodu;miktar";
    const a = `${head}\n${p}-1;${shelf};5`;
    const b = `${head}\n${p}-1;${shelf};9`;
    // İkisi de çift BOŞKEN önizlenir (temiz); sonra aynı anda uygulanır.
    const [pa, pb] = [await previewImport(asAdmin(A), a), await previewImport(asAdmin(A), b)];
    expect([pa.issueTotal, pb.issueTotal]).toEqual([0, 0]);
    const [ra, rb] = await Promise.all([
      applyImportChunk(asAdmin(A), { text: a, chunk: 0, digest: pa.digest }),
      applyImportChunk(asAdmin(A), { text: b, chunk: 0, digest: pb.digest }),
    ]);
    const statuses = [ra.rows[0]?.status, rb.rows[0]?.status].sort();
    expect(statuses).toEqual(["APPLIED", "FAILED"]);
    const loser = ra.rows[0]?.status === "FAILED" ? ra : rb;
    expect(loser.rows[0]).toMatchObject({ status: "FAILED", reason: "PAIR_HAS_STOCK" });
    expect(loser.complete).toBe(false);
    expect(await countLedger(A, p)).toBe(1);
    const q = await adm.query<{ q: string }>("SELECT sum(b.quantity)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id JOIN public.items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id WHERE i.tenant_id = $1 AND i.code = $2", [A.tenantId, `${p}-1`]);
    expect([5, 9]).toContain(Number(q.rows[0]?.q));
    expect(await num("SELECT count(*) AS n FROM public.documents d JOIN public.document_lines dl ON dl.tenant_id = d.tenant_id AND dl.document_id = d.id JOIN public.items i ON i.tenant_id = dl.tenant_id AND i.id = dl.item_id WHERE d.tenant_id = $1 AND d.reason = 'import.opening_stock' AND d.kind = 'STOCK_IN' AND i.code = $2", [A.tenantId, `${p}-1`])).toBe(1);
  });

  it("önizleme en çok 50 hata döner, toplamı ayrıca bildirir (İ-06)", async () => {
    const p = pfx();
    const csv = ["kod;ad", ...Array.from({ length: 60 }, (_, i) => `${p}-${i};`)].join("\n");
    const pv = await previewImport(asAdmin(A), csv);
    expect(pv.issues).toHaveLength(50);
    expect(pv.issueTotal).toBe(60);
    expect(pv.summary).toMatchObject({ errorRows: 60 });
  });

  it("apply önizleme özetini ister: içerik önizlemeden sonra değiştiyse reddedilir ve hiçbir şey yazılmaz (MINOR-1)", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir`);
    await newShelf(A, `${p}-R`);
    const a = `ürün kodu;raf kodu;miktar\n${p}-1;${p}-R;5`;
    const b = `ürün kodu;raf kodu;miktar\n${p}-1;${p}-R;6`;
    const pv = await previewImport(asAdmin(A), a);
    expect((await failure(applyImportChunk(asAdmin(A), { text: b, chunk: 0, digest: pv.digest }))).code).toBe("VALIDATION_FAILED");
    expect(await countLedger(A, p)).toBe(0);
  });
});

describe("yetki ve tenant izolasyonu", () => {
  it("yetkisiz üye (PICKER): önizleme ve uygulama FORBIDDEN; hiçbir şey yazılmaz", async () => {
    const p = pfx();
    const csv = `kod;ad\n${p}-1;Bir`;
    expect((await failure(previewImport(asPicker(A), csv))).code).toBe("FORBIDDEN");
    expect((await failure(applyImportChunk(asPicker(A), { text: csv, chunk: 0, digest: NO_DIGEST }))).code).toBe("FORBIDDEN");
    const stockCsv = "ürün kodu;raf kodu;miktar\nU3;X;1";
    expect((await failure(previewImport(asPicker(A), stockCsv))).code).toBe("FORBIDDEN");
    expect(await countItems(A, p)).toBe(0);
  });

  it("başka tenant'ın ürün ve rafı görünmez; aynı kodlar kendi tenant'ında bağımsız oluşur", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad;adet barkodu\n${p}-1;A ürünü;${p}BC`);
    await newShelf(A, `${p}-R`);
    const pv = await previewImport(asAdmin(B), `ürün kodu;raf kodu;miktar\n${p}-1;${p}-R;3`);
    expect(pv.issues.map((i) => i.code)).toEqual(["ITEM_UNKNOWN", "SHELF_UNKNOWN"]);
    // B aynı kod ve barkodu serbestçe alır (A'nın barkodu B'ye BARCODE_TAKEN olarak görünmez); A etkilenmez.
    await applyAll(() => asAdmin(B), `kod;ad;adet barkodu\n${p}-1;B ürünü;${p}BC`);
    expect(await countItems(A, p)).toBe(1);
    expect(await countItems(B, p)).toBe(1);
    expect((await adm.query<{ name: string }>("SELECT name FROM public.items WHERE tenant_id = $1 AND code = $2", [A.tenantId, `${p}-1`])).rows[0]?.name).toBe("A ürünü");
  });

  it("dosya düzeyi hatalar: boş, bilinmeyen biçim, kapanmamış tırnak", async () => {
    expect((await previewImport(asAdmin(A), "")).issues.map((i) => i.code)).toEqual(["FILE_EMPTY"]);
    expect((await previewImport(asAdmin(A), "foo;bar\n1;2")).issues.map((i) => i.code)).toEqual(["FORMAT_UNKNOWN"]);
    expect((await previewImport(asAdmin(A), 'kod;ad\n"A;B')).issues.map((i) => i.code)).toEqual(["CSV_UNTERMINATED_QUOTE"]);
  });
});

// M-3: satır düzeyi FAILED / NOT_ATTEMPTED yolları. Hata TEST-YALNIZ DB tetikleyicisiyle enjekte edilir (üretim koduna kanca yok): `t289_inject` tablosunda
// satır varsa belge ONAYI ya da belirli kodlu ÜRÜN eklemesi hata verir. Tetikleyici/tablo testten sonra kaldırılır.
describe("kısmi başarısızlık ve yeniden deneme (M-3)", () => {
  beforeAll(async () => {
    await adm.query("CREATE TABLE IF NOT EXISTS public.t289_inject (tenant_id uuid NOT NULL, what text NOT NULL, PRIMARY KEY (tenant_id, what))");
    await adm.query(`CREATE OR REPLACE FUNCTION public.t289_inject_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF TG_TABLE_NAME = 'documents' THEN
          IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NEW.reason = 'import.opening_stock'
             AND EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'approve') THEN
            RAISE EXCEPTION 't289 injected approve failure' USING ERRCODE = 'XX000';
          END IF;
        ELSIF TG_TABLE_NAME = 'items' THEN
          IF EXISTS (SELECT 1 FROM public.t289_inject WHERE tenant_id = NEW.tenant_id AND what = 'item:' || NEW.code) THEN
            RAISE EXCEPTION 't289 injected item failure' USING ERRCODE = 'XX000';
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await adm.query("CREATE TRIGGER t289_inject_docs BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn()");
    await adm.query("CREATE TRIGGER t289_inject_items BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.t289_inject_fn()");
  });
  afterAll(async () => {
    await adm.query("DROP TRIGGER IF EXISTS t289_inject_docs ON public.documents");
    await adm.query("DROP TRIGGER IF EXISTS t289_inject_items ON public.items");
    await adm.query("DROP FUNCTION IF EXISTS public.t289_inject_fn()");
    await adm.query("DROP TABLE IF EXISTS public.t289_inject");
  });
  const inject = (w: TenantWorld, what: string) => adm.query("INSERT INTO public.t289_inject (tenant_id, what) VALUES ($1, $2) ON CONFLICT DO NOTHING", [w.tenantId, what]);
  const clear = (w: TenantWorld) => adm.query("DELETE FROM public.t289_inject WHERE tenant_id = $1", [w.tenantId]);
  const importDocs = (w: TenantWorld, p: string) =>
    num(
      `SELECT count(DISTINCT d.id) AS n FROM public.documents d JOIN public.document_lines dl ON dl.tenant_id = d.tenant_id AND dl.document_id = d.id
         JOIN public.items i ON i.tenant_id = dl.tenant_id AND i.id = dl.item_id WHERE d.tenant_id = $1 AND d.reason = 'import.opening_stock' AND i.code LIKE $2`,
      [w.tenantId, `${p}%`],
    );

  it("stok: belge oluşur ama onayda kalır → ilk grup FAILED, sonrakiler NOT_ATTEMPTED, defter boş; yeniden denemede aynı belge sürdürülür (çift belge yok)", async () => {
    const p = pfx();
    await applyAll(() => asAdmin(A), `kod;ad\n${p}-1;Bir\n${p}-2;İki\n${p}-3;Üç`);
    const w2 = (await createWarehouse({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, { code: pfx(), name: "İkinci depo" })).warehouseId;
    const s1 = `${p}-R1`;
    const s2 = `${p}-R2`;
    await newShelf(A, s1);
    await createLocation({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug }, { warehouseId: w2, code: s2, name: s2, kind: "STORAGE" });
    const csv = ["ürün kodu;raf kodu;miktar", `${p}-1;${s1};5`, `${p}-2;${s1};6`, `${p}-3;${s2};7`].join("\n");
    await inject(A, "approve");
    const pv = await previewImport(asAdmin(A), csv);
    expect(pv.issueTotal).toBe(0);
    const r = await applyImportChunk(asAdmin(A), { text: csv, chunk: 0, digest: pv.digest });
    expect(r.complete).toBe(false);
    expect(r.rows.map((x) => [x.row, x.status, x.errorCode])).toEqual([[2, "FAILED", "INTERNAL"], [3, "FAILED", "INTERNAL"], [4, "NOT_ATTEMPTED", undefined]]);
    expect(r.counts).toMatchObject({ FAILED: 2, NOT_ATTEMPTED: 1, APPLIED: 0 });
    expect(await countLedger(A, p)).toBe(0); // sahte başarı yok: hiçbir stok yazılmadı
    expect(await importDocs(A, p)).toBe(1); // yalnız ilk grubun taslağı

    // m-1: bitmemiş (taslak) açılış belgesi çifti "dolu" sayar: FARKLI miktarlı dosya reddedilir, AYNI içerik sürdürülebilir.
    const changed = csv.replace(`${p}-1;${s1};5`, `${p}-1;${s1};50`);
    expect((await previewImport(asAdmin(A), changed)).issues.map((i) => `${i.row}:${i.code}`)).toEqual(["2:PAIR_PENDING"]);
    expect((await previewImport(asAdmin(A), csv)).issueTotal).toBe(0);

    await clear(A);
    const again = await applyImportChunk(asAdmin(A), { text: csv, chunk: 0, digest: pv.digest });
    expect(again.complete).toBe(true);
    expect(again.counts).toMatchObject({ APPLIED: 3, FAILED: 0, NOT_ATTEMPTED: 0 });
    expect(await countLedger(A, p)).toBe(3);
    expect(await importDocs(A, p)).toBe(2); // ilk grubun taslağı SÜRDÜRÜLDÜ (aynı içerik anahtarı), ikinci depo için yeni belge
  });

  it("ürün: satır hatası ilk başarısız satırda durur (önceki CREATED, sonrakiler NOT_ATTEMPTED); yeniden denemede kalanlar tamamlanır", async () => {
    const p = pfx();
    const csv = ["kod;ad", `${p}-1;Bir`, `${p}-2;İki`, `${p}-3;Üç`].join("\n");
    await inject(B, `item:${p}-2`);
    const pv = await previewImport(asAdmin(B), csv);
    const r = await applyImportChunk(asAdmin(B), { text: csv, chunk: 0, digest: pv.digest });
    expect(r.complete).toBe(false);
    expect(r.rows.map((x) => [x.row, x.status])).toEqual([[2, "CREATED"], [3, "FAILED"], [4, "NOT_ATTEMPTED"]]);
    expect(await countItems(B, p)).toBe(1);
    await clear(B);
    const again = await applyImportChunk(asAdmin(B), { text: csv, chunk: 0, digest: pv.digest });
    expect(again.rows.map((x) => [x.row, x.status])).toEqual([[2, "UNCHANGED"], [3, "CREATED"], [4, "CREATED"]]);
    expect(await countItems(B, p)).toBe(3);
  });
});
