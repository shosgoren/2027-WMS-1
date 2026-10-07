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
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
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
/** BEGIN/COMMIT sarmalayıcısız gövde: çağıranın açık transaction'ı içinde (ve ROLLBACK ile biten) koşmak için. */
const unwrap = (sql: string): string => sql.replace(/^BEGIN[^\n]*\n/, "").replace(/\nCOMMIT;\n$/, "\n");
const ASSERT_TRIGGERS = [
  ["stock_balances", "stock_balances_assert"],
  ["reservations", "reservations_assert"],
] as const;

/** ROLLBACK hatası asıl hatayı gizlemez (AggregateError). */
async function rollbackKeeping(original: unknown): Promise<void> {
  try {
    await adm.query("ROLLBACK");
  } catch (rb) {
    throw new AggregateError([original, rb], "ROLLBACK başarısız (asıl hata ilk öğe)");
  }
}

/** Tenant bağlamlı (transaction-local, G-02) kalıcı fikstür yazımı (yalnızca kurulum/temizlik; DDL yok). */
async function tx(statements: [string, unknown[]][]): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    for (const [sql, params] of statements) await adm.query(sql, params);
    await adm.query("COMMIT");
  } catch (e) {
    await rollbackKeeping(e);
    throw e;
  }
}

/**
 * Bozuk "restore edilmiş kopya" simülasyonu: HİÇBİR ŞEY KALICI DEĞİLDİR (veri ve DDL aynı transaction'da, ROLLBACK ile biter).
 * Commit-zamanı tutarlılık tetikleyicileri (0013; `ENABLE ALWAYS`) yalnız bu transaction'da kapatılır, yazımdan sonra
 * `ENABLE ALWAYS` ile geri açılır (ROLLBACK zaten tamamını geri alır). `fn` içinde parmak izi/tutarlılık gövdeleri
 * (`unwrap`) bu transaction'ın değişikliklerini görür. Bu DDL yöntemi yalnız test içindir; üretim betiğine kopyalanmaz.
 */
async function withTamperedCopy(statements: [string, unknown[]][], fn: () => Promise<void>, ddl: string[] = []): Promise<void> {
  await adm.query("BEGIN");
  try {
    await adm.query("SELECT set_config('app.current_tenant_id', $1, true)", [A.tenantId]);
    for (const [t, trg] of ASSERT_TRIGGERS) await adm.query(`ALTER TABLE public.${t} DISABLE TRIGGER ${trg}`);
    for (const d of ddl) await adm.query(d);
    for (const [sql, params] of statements) await adm.query(sql, params);
    for (const [t, trg] of ASSERT_TRIGGERS) await adm.query(`ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER ${trg}`);
    await fn();
  } catch (e) {
    await rollbackKeeping(e);
    throw e;
  }
  await adm.query("ROLLBACK");
}
async function triggerModes(): Promise<Record<string, string>> {
  const r = await adm.query<{ tgname: string; tgenabled: string }>(
    "SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1::text[])",
    [ASSERT_TRIGGERS.map(([, g]) => g)],
  );
  return Object.fromEntries(r.rows.map((x) => [x.tgname, x.tgenabled]));
}
const setBal = (set: string): [string, unknown[]] => [`UPDATE public.stock_balances SET ${set} WHERE tenant_id=$1 AND stock_dimension_id=$2`, [A.tenantId, dimensionId]];
const setRes = (set: string): [string, unknown[]] => [`UPDATE public.reservations SET ${set} WHERE tenant_id=$1 AND stock_dimension_id=$2`, [A.tenantId, dimensionId]];
const fingerprint = async () => parseFingerprintOutput(await runSql(adm, FINGERPRINT_SQL, "FP:"));
const consistency = async () => parseConsistencyOutput(await runSql(adm, STOCK_CONSISTENCY_SQL, "SC:"));
// Açık (rollback'li) transaction içinde koşan sürümler:
const fingerprintIn = async () => parseFingerprintOutput(await runSql(adm, unwrap(FINGERPRINT_SQL), "FP:"));
const consistencyIn = async () => parseConsistencyOutput(await runSql(adm, unwrap(STOCK_CONSISTENCY_SQL), "SC:"));

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

// Tenant satırları silinmez: posting audit_logs yazar (değişmez, FK) — stok testlerinin ortak kuralı. Yalnız rezervasyon kapatılır.
afterAll(async () => {
  try {
    await tx([setBal("reserved_quantity = 0"), setRes("status = 'RELEASED', closed_at = now()")]);
  } finally {
    await adm.end();
    await app.close();
  }
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
    await withTamperedCopy([setBal("quantity = quantity + 1")], async () => {
      const after = await fingerprintIn();
      const r = compareFingerprints(before, after);
      expect(after.tables).toEqual(before.tables); // satır sayıları birebir aynı
      expect(r.equal).toBe(false);
      expect(r.sections.table_counts).toBe(true);
      expect(r.sections.content_stock_balances).toBe(false);
      expect(r.sections.content_stock_ledger).toBe(true);
      expect(consistencyProblems(await consistencyIn())).toEqual(["ledger_ne_balance=1"]);
    });
    expect(compareFingerprints(before, await fingerprint()).equal).toBe(true);
    expect(consistencyProblems(await consistency())).toEqual([]);
  });

  it("rezervasyon/reserved uyuşmazlığı yakalanır (reservations_ne_reserved); rezervasyon miktarı değişimi de parmak izine yansır", async () => {
    const before = await fingerprint();
    await withTamperedCopy([setBal("reserved_quantity = 4")], async () => {
      expect(consistencyProblems(await consistencyIn())).toEqual(["reservations_ne_reserved=1"]);
      expect(compareFingerprints(before, await fingerprintIn()).sections.content_stock_balances).toBe(false);
    });
    await withTamperedCopy([setRes("quantity = 2")], async () => {
      const r = compareFingerprints(before, await fingerprintIn());
      expect(r.sections.content_reservations).toBe(false);
      expect(r.sections.table_counts).toBe(true);
      expect(consistencyProblems(await consistencyIn())).toEqual(["reservations_ne_reserved=1"]);
    });
    expect(consistencyProblems(await consistency())).toEqual([]);
  });

  it("CHECK kısıtları kaldırılmış (bozuk) kopyada reserved>miktar, negatif miktar ve negatif reserved yakalanır (işlem geri alınır; bu DDL yöntemi yalnız test içindir, üretim betiğine kopyalanmaz)", async () => {
    const drop = ["ALTER TABLE public.stock_balances DROP CONSTRAINT stock_balances_quantity_chk, DROP CONSTRAINT stock_balances_reserved_chk"];
    await withTamperedCopy([setBal("quantity = -2, reserved_quantity = -1")], async () => {
      const sc = await consistencyIn();
      expect(sc.negative_quantity).toBe(1);
      expect(sc.negative_reserved).toBe(1);
    }, drop);
    await withTamperedCopy([setBal("quantity = 5, reserved_quantity = 6")], async () => {
      expect((await consistencyIn()).reserved_gt_quantity).toBe(1);
    }, drop);
    for (const k of CONSISTENCY_ZERO_COUNTERS) expect((await consistency())[k], k).toBe(0);
  });

  it("çıktı yalnızca sayı/özet içerir: kimlik veya kişisel veri yok", async () => {
    const text = JSON.stringify(await consistency());
    expect(text).not.toContain(dimensionId);
    expect(text).not.toContain(A.tenantId);
    expect(readFileSync(new URL("../../../scripts/lib/stock-consistency.sql", import.meta.url), "utf8")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it("simülasyon kalıcı DDL bırakmaz: tutarlılık tetikleyicileri 'A' (ENABLE ALWAYS) kalır, CHECK kısıtları yerinde", async () => {
    expect(await triggerModes()).toEqual({ stock_balances_assert: "A", reservations_assert: "A" });
    const chk = await adm.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_constraint WHERE conname IN ('stock_balances_quantity_chk','stock_balances_reserved_chk')",
    );
    expect(chk.rows[0]?.n).toBe("2");
  });
});
