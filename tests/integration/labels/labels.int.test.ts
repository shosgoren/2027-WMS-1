// T-312: etiket kaynağı okuma (loadLabelSource) — tenant kapsamı, yetki ve olumlu yol. Gerçek wms_app bağlantısı + RLS; fikstürler sentetik (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { addBarcode } from "../../../packages/domain/src/catalog/barcodes.ts";
import { createItem } from "../../../packages/domain/src/catalog/items.ts";
import { createLocation } from "../../../packages/domain/src/warehouse/locations.ts";
import { loadLabelSource, toSvgPages, toZplDocument } from "../../../packages/domain/src/labels/index.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex");

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let noRoleUserId: string;
let strangerUserId: string;
let itemA: { id: string; code: string };
let itemB: string;

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
  noRoleUserId = await mkUser(adm, reg, "norole");
  await mkMembership(adm, A.tenantId, noRoleUserId, { roles: [] });
  strangerUserId = await mkUser(adm, reg, "stranger");
  const code = `LB${rnd()}`;
  const a = await createItem(admin(A), { code, name: `Etiket <&"> ürünü`, baseUnitId: A.unitId });
  itemA = { id: a.itemId, code };
  await addBarcode(admin(A), { itemId: a.itemId, barcode: `8690${rnd()}` });
  itemB = (await createItem(admin(B), { code: `LB${rnd()}`, name: "B ürünü", baseUnitId: B.unitId })).itemId;
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 120_000);

const as = (w: TenantWorld, userId: string) => ({ db: app, principal: { userId, mfaVerified: true }, tenantSlug: w.slug });
const admin = (w: TenantWorld) => as(w, w.ownerUserId);

async function fail(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}
const sig = (e: AppError): string => `${e.code}/${e.detail ?? ""}/${e.httpStatus}`;

describe("loadLabelSource tenant kapsamı", () => {
  it("A kullanıcısı B'nin ürünü için NOT_FOUND alır; yanıt var olmayan kimlikle aynıdır", async () => {
    const cross = await fail(loadLabelSource(admin(A), { itemId: itemB }));
    const missing = await fail(loadLabelSource(admin(A), { itemId: randomUUID() }));
    expect(cross.code).toBe("NOT_FOUND");
    expect(sig(cross)).toBe(sig(missing));
    expect(cross.message).toBe(missing.message);
  });
  it("A kullanıcısı B'nin deposu ve lokasyonu için NOT_FOUND alır; yanıt var olmayan kimlikle aynıdır", async () => {
    const crossWh = await fail(loadLabelSource(admin(A), { warehouseId: B.warehouseId }));
    const missingWh = await fail(loadLabelSource(admin(A), { warehouseId: randomUUID() }));
    expect(crossWh.code).toBe("NOT_FOUND");
    expect(sig(crossWh)).toBe(sig(missingWh));
    // B'nin lokasyonu A'nın deposu altında istenirse: A'nın ağacında yok → NOT_FOUND.
    const crossLoc = await fail(loadLabelSource(admin(A), { warehouseId: A.warehouseId, locationId: B.rootLocationId }));
    const missingLoc = await fail(loadLabelSource(admin(A), { warehouseId: A.warehouseId, locationId: randomUUID() }));
    expect(crossLoc.code).toBe("NOT_FOUND");
    expect(sig(crossLoc)).toBe(sig(missingLoc));
    // B'nin deposu + B'nin lokasyonu A'dan: yine NOT_FOUND.
    expect((await fail(loadLabelSource(admin(A), { warehouseId: B.warehouseId, locationId: B.rootLocationId }))).code).toBe("NOT_FOUND");
  });
  it("geçersiz kimlik NOT_FOUND (varlık sızdırılmaz); üye olmayan NOT_FOUND", async () => {
    expect((await fail(loadLabelSource(admin(A), { itemId: "nope" }))).code).toBe("NOT_FOUND");
    expect((await fail(loadLabelSource(admin(A), { warehouseId: "nope" }))).code).toBe("NOT_FOUND");
    expect((await fail(loadLabelSource(as(A, strangerUserId), { itemId: itemA.id }))).code).toBe("NOT_FOUND");
  });
});

describe("loadLabelSource yetki", () => {
  it("stock.view olmayan üye FORBIDDEN alır (ürün ve lokasyon)", async () => {
    const p = as(A, noRoleUserId);
    expect((await fail(loadLabelSource(p, { itemId: itemA.id }))).code).toBe("FORBIDDEN");
    expect((await fail(loadLabelSource(p, { warehouseId: A.warehouseId }))).code).toBe("FORBIDDEN");
  });
});

describe("loadLabelSource olumlu yol", () => {
  it("ürün: kod, ad, birim ve birincil barkod gelir; ad kaçışlanmış SVG ve ZPL üretir", async () => {
    const s = await loadLabelSource(admin(A), { itemId: itemA.id });
    expect(s?.template).toBe("product");
    const d = s?.datas[0] as { code: string; name: string; unit: string; barcode: string | null };
    expect(d.code).toBe(itemA.code);
    expect(d.unit).not.toBe("");
    expect(d.barcode).toMatch(/^8690/);
    const svg = toSvgPages(s!.template, s!.datas, 1)[0]!;
    expect(svg).toContain("&lt;&amp;&quot;&gt;");
    expect(svg).not.toContain("<&");
    expect(toZplDocument(s!.template, s!.datas)).toContain("^BC");
  });
  it("lokasyon: tek, alt ağaçla ve depodaki tümü; kaynak verilmezse null", async () => {
    const child = await createLocation(admin(A), { warehouseId: A.warehouseId, parentId: A.rootLocationId, code: `LC${rnd()}`.toUpperCase(), name: "Alt", kind: "STORAGE" });
    const single = await loadLabelSource(admin(A), { warehouseId: A.warehouseId, locationId: A.rootLocationId });
    expect(single?.datas.length).toBe(1);
    const sub = await loadLabelSource(admin(A), { warehouseId: A.warehouseId, locationId: A.rootLocationId, subtree: true });
    expect(sub?.template).toBe("location");
    expect(sub?.datas.length).toBeGreaterThanOrEqual(2);
    const only = await loadLabelSource(admin(A), { warehouseId: A.warehouseId, locationId: child.locationId, subtree: true });
    expect(only?.datas.length).toBe(1);
    const all = await loadLabelSource(admin(A), { warehouseId: A.warehouseId });
    expect(all!.datas.length).toBeGreaterThanOrEqual(sub!.datas.length);
    expect(await loadLabelSource(admin(A), {})).toBeNull();
  });
});
