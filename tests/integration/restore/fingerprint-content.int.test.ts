// T-284 (devops): restore doğrulaması stok İÇERİĞİNİ kanıtlar. Gerçek PostgreSQL, gerçek `FINGERPRINT_SQL` ve gerçek
// `scripts/lib/stock-consistency.sql` (psql yerine `pg` ile aynı SQL metni). Sentetik veri (G-09).
// "Restore edilmiş kopya" = aynı veritabanının mutasyon öncesi ve sonrası parmak izi (satır sayısı aynı, tek miktar farklı).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { approveDocument, createStockDocument, postDocument, type StockDocCallParams } from "../../../packages/domain/src/stock/index.ts";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";
import { CONTENT_TABLES, FINGERPRINT_SQL, compareFingerprints, parseFingerprintOutput } from "../../../scripts/db-fingerprint.mjs";
import { CONSISTENCY_ZERO_COUNTERS, STOCK_CONSISTENCY_SQL, consistencyProblems, parseConsistencyOutput } from "../../../scripts/restore-drill.mjs";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let dimensionId: string;
let lineId: string;

const WIDE = { lockTimeoutMs: 8000, statementTimeoutMs: 20_000 } as const;
const uuid = (): string => randomUUID();
const ownerP = (): StockDocCallParams => ({ db: app, principal: { userId: A.ownerUserId, mfaVerified: true }, tenantSlug: A.slug, clientKey: uuid(), timeouts: WIDE });

/** Çok ifadeli SQL'i basit protokolle koşar; `prefix` ile başlayan tek satırı döndürür. */
async function runSql(c: pg.Client, sql: string, prefix: string): Promise<string> {
  const res = await c.query(sql);
  const list = Array.isArray(res) ? res : [res];
  for (const r of list) for (const row of r.rows as Record<string, string>[]) {
    const v = Object.values(row)[0];
    if (typeof v === "string" && v.startsWith(prefix)) return v;
  }
  throw new Error("çıktı satırı yok");
}
/**
 * Tenant bağlamlı (transaction-local, G-02) fikstür yazımı. `tamper`: commit-zamanı tutarlılık tetikleyicilerini
 * (stock_balances_assert / reservations_assert, 0013) yalnızca bu transaction'da kapatır: bozuk "restore edilmiş kopya"
 * durumunu üretmek içindir (gerçek veritabanı bu bozulmayı normalde reddeder; restore kaynağı bozuksa yine de yakalanmalı).
 */
async function tx(statements: [string, unknown[]][], tamper = false): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    if (tamper) {
      await adm.query("ALTER TABLE public.stock_balances DISABLE TRIGGER stock_balances_assert");
      await adm.query("ALTER TABLE public.reservations DISABLE TRIGGER reservations_assert");
    }
    for (const [sql, params] of statements) await adm.query(sql, params);
    if (tamper) {
      await adm.query("ALTER TABLE public.stock_balances ENABLE TRIGGER stock_balances_assert");
      await adm.query("ALTER TABLE public.reservations ENABLE TRIGGER reservations_assert");
    }
    await adm.query("COMMIT");
  } catch (e) {
    await adm.query("ROLLBACK");
    throw e;
  }
}
const setBal = (set: string): [string, unknown[]] => [`UPDATE public.stock_balances SET ${set} WHERE tenant_id=$1 AND stock_dimension_id=$2`, [A.tenantId, dimensionId]];
const setRes = (set: string): [string, unknown[]] => [`UPDATE public.reservations SET ${set} WHERE tenant_id=$1 AND stock_dimension_id=$2`, [A.tenantId, dimensionId]];
const fingerprint = async () => parseFingerprintOutput(await runSql(adm, FINGERPRINT_SQL, "FP:"));
const consistency = async () => parseConsistencyOutput(await runSql(adm, STOCK_CONSISTENCY_SQL, "SC:"));

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A284C");
  // 10 birim giriş (gerçek stok komutları: defter + bakiye aynı transaction).
  const itemId = uuid();
  const locId = uuid();
  await adm.query("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,'T284',$4,'NONE',0)", [
    A.tenantId, itemId, `P-${uuid().slice(0, 8)}`, A.unitId,
  ]);
  await adm.query("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind, pick_blocked) VALUES ($1,$2,$3,NULL,$4,'T284',0,'STORAGE',false)", [
    A.tenantId, locId, A.warehouseId, `L-${uuid().slice(0, 8)}`,
  ]);
  const doc = await createStockDocument(ownerP(), {
    kind: "STOCK_IN", warehouseId: A.warehouseId,
    lines: [{ itemId, unitId: A.unitId, quantity: "10", conversionFactor: "1", baseQuantity: "10", stockStatus: "AVAILABLE", targetLocationId: locId }],
  });
  const documentId = doc.documentId as string;
  await approveDocument(ownerP(), { documentId, expectedVersion: 1 });
  const v = (await adm.query<{ version: number }>("SELECT version FROM public.documents WHERE id=$1", [documentId])).rows[0];
  await postDocument(ownerP(), { documentId, expectedVersion: Number(v?.version) });
  dimensionId = (await adm.query<{ id: string }>("SELECT id FROM public.stock_dimensions WHERE tenant_id=$1 AND item_id=$2", [A.tenantId, itemId])).rows[0]?.id as string;
  lineId = (await adm.query<{ id: string }>("SELECT id FROM public.document_lines WHERE tenant_id=$1 AND document_id=$2", [A.tenantId, documentId])).rows[0]?.id as string;
  // Temel durum: 3 birimlik ACTIVE rezervasyon + bakiyede reserved=3 (tutarlı fikstür; doğrudan SQL yalnızca test kurulumu).
  await tx([
    ["INSERT INTO public.reservations (tenant_id, stock_dimension_id, document_line_id, item_id, quantity) VALUES ($1,$2,$3,$4,3)", [A.tenantId, dimensionId, lineId, itemId]],
    setBal("reserved_quantity = 3"),
  ]);
}, 120_000);

afterAll(async () => {
  await tx([setBal("reserved_quantity = 0"), setRes("status = 'RELEASED', closed_at = now()")]).catch(() => undefined);
  await cleanupRegistry(adm, reg).catch(() => undefined);
  await adm.end();
  await app.close();
}, 60_000);

describe("restore içerik doğrulaması (T-284)", () => {
  it("FINGERPRINT_SQL her içerik tablosunu özetler; temiz durumda tutarlılık yeşil ve iki parmak izi eşit", async () => {
    const a = await fingerprint();
    for (const t of Object.keys(CONTENT_TABLES)) expect(a.content[t]?.digest, t).toMatch(/^[0-9a-f]{64}$/);
    expect(a.content.stock_ledger?.count).toBeGreaterThanOrEqual(1);
    expect(a.content.reservations?.count).toBeGreaterThanOrEqual(1);
    const b = await fingerprint();
    expect(compareFingerprints(a, b).equal).toBe(true);
    const sc = await consistency();
    expect(consistencyProblems(sc)).toEqual([]);
    expect(sc.dimensions).toBeGreaterThanOrEqual(1);
  });

  it("tek bir bakiye miktarı değişir (satır sayısı aynı): parmak izi kırmızı, tutarlılık sorgusu ledger_ne_balance yakalar", async () => {
    const before = await fingerprint();
    await tx([setBal("quantity = quantity + 1")], true);
    try {
      const after = await fingerprint();
      const r = compareFingerprints(before, after);
      expect(after.tables).toEqual(before.tables); // satır sayıları birebir aynı
      expect(r.equal).toBe(false);
      expect(r.sections.table_counts).toBe(true);
      expect(r.sections.content_stock_balances).toBe(false);
      expect(r.sections.content_stock_ledger).toBe(true);
      expect(consistencyProblems(await consistency())).toEqual(["ledger_ne_balance=1"]);
    } finally {
      await tx([setBal("quantity = quantity - 1")], true);
    }
    expect(compareFingerprints(before, await fingerprint()).equal).toBe(true);
    expect(consistencyProblems(await consistency())).toEqual([]);
  });

  it("rezervasyon/reserved uyuşmazlığı yakalanır (reservations_ne_reserved); rezervasyon miktarı değişimi de parmak izine yansır", async () => {
    const before = await fingerprint();
    await tx([setBal("reserved_quantity = 4")], true);
    try {
      expect(consistencyProblems(await consistency())).toEqual(["reservations_ne_reserved=1"]);
      expect(compareFingerprints(before, await fingerprint()).sections.content_stock_balances).toBe(false);
    } finally {
      await tx([setBal("reserved_quantity = 3")], true);
    }
    await tx([setRes("quantity = 2")], true);
    try {
      const r = compareFingerprints(before, await fingerprint());
      expect(r.sections.content_reservations).toBe(false);
      expect(r.sections.table_counts).toBe(true);
      expect(consistencyProblems(await consistency())).toEqual(["reservations_ne_reserved=1"]);
    } finally {
      await tx([setRes("quantity = 3")], true);
    }
    expect(consistencyProblems(await consistency())).toEqual([]);
  });

  it("CHECK kısıtları kaldırılmış (bozuk) kopyada reserved>miktar, negatif miktar ve negatif reserved yakalanır (işlem geri alınır)", async () => {
    await adm.query("BEGIN");
    try {
      await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
      await adm.query("ALTER TABLE public.stock_balances DROP CONSTRAINT stock_balances_quantity_chk, DROP CONSTRAINT stock_balances_reserved_chk");
      await adm.query("UPDATE public.stock_balances SET quantity = -2, reserved_quantity = -1 WHERE tenant_id=$1 AND stock_dimension_id=$2", [A.tenantId, dimensionId]);
      const body = STOCK_CONSISTENCY_SQL.replace(/^BEGIN[^\n]*\n/, "").replace(/\nCOMMIT;\n$/, "\n");
      const sc = parseConsistencyOutput(await runSql(adm, body, "SC:"));
      expect(sc.negative_quantity).toBe(1);
      expect(sc.negative_reserved).toBe(1);
      await adm.query("UPDATE public.stock_balances SET quantity = 5, reserved_quantity = 6 WHERE tenant_id=$1 AND stock_dimension_id=$2", [A.tenantId, dimensionId]);
      const sc2 = parseConsistencyOutput(await runSql(adm, body, "SC:"));
      expect(sc2.reserved_gt_quantity).toBe(1);
    } finally {
      await adm.query("ROLLBACK");
    }
    for (const k of CONSISTENCY_ZERO_COUNTERS) expect((await consistency())[k], k).toBe(0);
  });

  it("çıktı yalnızca sayı/özet içerir: kimlik veya kişisel veri yok", async () => {
    const text = JSON.stringify(await consistency());
    expect(text).not.toContain(dimensionId);
    expect(text).not.toContain(A.tenantId);
    expect(readFileSync(new URL("../../../scripts/lib/stock-consistency.sql", import.meta.url), "utf8")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });
});
