// Seri kartı komutu (T-212; A-72, A-87, A-97, Q-39). Yazma `document.create`.
//
// - Stok DEĞİŞTİRMEZ (G-01). Seri kimliği (`item_id`, `serial_no`, `lot_id`) değişmez (A-87); kullanılmış serinin `lot_id`'si
//   0013 tetikleyicisiyle ayrıca reddedilir.
// - Kapsam A-72: ürün içi (`UNIQUE (tenant_id, item_id, serial_no)`). Tenant geneli tekillik `SERIAL_SCOPE_TENANT_ENABLED`
//   bayrağıyla kapalıdır. Bayrak YALNIZCA çağıranın sunucu yapılandırmasından verdiği `config.env` ile gelir (domain
//   `process.env` okumaz; onboarding/workspace.ts deseni, Q-59). `input` bayrak taşımaz: bilinmeyen anahtar
//   VALIDATION_FAILED ile reddedilir. `config` verilmezse bayrak kapalıdır. Yalnızca tam `"true"` açar.
//   Açıkken tenant+seri no için `pg_advisory_xact_lock` ile yarış serileşir ve ürünler arası tekrar komutta denetlenir.
//   FAIL-CLOSED: bayrak açıkken DB'de tenant geneli tekil indeks (anahtar sütunlar tam `tenant_id, serial_no`; geçerli,
//   hazır, anlık, ifade içermeyen) yoksa komut VALIDATION_FAILED ile reddedilir. Katalog sorgusu her çağrıda yapılır
//   (önbellek yok). İndeks migration'ı bu kartın kapsamı değildir (Q-59). Kısmi indeksin koşulu burada doğrulanamaz;
//   koşulun kapsamı indeksi ekleyen migration'ın sorumluluğudur.
// - `SERIAL`: lot verilmez; `LOT_AND_SERIAL`: lot zorunlu ve aynı ürünün lotu. Tekrar → `TRACKING_VIOLATION`.
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, type AccessTx } from "../identity/access.ts";
import { loadItemForTraceability, parseNfcText } from "./lots.ts";
import { parseUuid, type CatalogCommandParams } from "./units.ts";

export interface RegisterSerialInput {
  readonly itemId: string;
  readonly serialNo: string;
  readonly lotId?: string;
}
/** Çağıranın (sunucu) ortamı; istemci girdisi DEĞİLDİR. */
export interface SerialCommandConfig {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Kapalı bayrak deseni: yalnızca tam `"true"` açar (A-72). */
function serialScopeTenantEnabled(config: SerialCommandConfig | undefined): boolean {
  return config?.env?.["SERIAL_SCOPE_TENANT_ENABLED"] === "true";
}

const INPUT_KEYS: ReadonlySet<string> = new Set(["itemId", "serialNo", "lotId"]);

/** Tenant geneli tekil indeks var mı (sütun kümesi tam `tenant_id, serial_no`). */
async function tenantSerialIndexExists(tx: AccessTx): Promise<boolean> {
  const rows = await tx.execute<{ x: number }>(
    sql`SELECT 1 AS x FROM pg_catalog.pg_index i
         WHERE i.indrelid = 'public.serials'::regclass
           AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
           AND i.indexprs IS NULL AND i.indnatts = 2 AND i.indnkeyatts = 2
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                  FROM pg_catalog.pg_attribute a
                 WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])) = ARRAY['serial_no', 'tenant_id']
         LIMIT 1`,
  );
  return rows[0] !== undefined;
}

export async function registerSerial(
  params: CatalogCommandParams,
  input: RegisterSerialInput,
  config?: SerialCommandConfig,
): Promise<{ readonly serialId: string }> {
  if (typeof input !== "object" || input === null || Object.keys(input).some((k) => !INPUT_KEYS.has(k))) {
    throw new AppError("VALIDATION_FAILED");
  }
  const itemId = parseUuid(input.itemId);
  const serialNo = parseNfcText(input.serialNo, 128);
  const lotId = input.lotId === undefined ? undefined : parseUuid(input.lotId);
  const tenantScope = serialScopeTenantEnabled(config);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "document.create" }, async (tx, actor) => {
    const item = await loadItemForTraceability(tx, actor.tenantId, itemId);
    if (item === undefined) throw new AppError("NOT_FOUND");
    if (item.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    if (item.tracking_mode !== "SERIAL" && item.tracking_mode !== "LOT_AND_SERIAL") throw new AppError("TRACKING_VIOLATION");
    if (item.tracking_mode === "SERIAL" && lotId !== undefined) throw new AppError("TRACKING_VIOLATION");
    if (item.tracking_mode === "LOT_AND_SERIAL") {
      if (lotId === undefined) throw new AppError("TRACKING_VIOLATION");
      // Lot aynı ürüne ait olmalı; paylaşımlı kilit lotun silinme/değişme yarışını kapatır.
      const lot = await tx.execute<{ x: number }>(
        sql`SELECT 1 AS x FROM public.lots
             WHERE tenant_id = ${actor.tenantId}::uuid AND item_id = ${itemId}::uuid AND id = ${lotId}::uuid FOR SHARE`,
      );
      if (lot[0] === undefined) throw new AppError("NOT_FOUND");
    }
    if (tenantScope) {
      if (!(await tenantSerialIndexExists(tx))) throw new AppError("VALIDATION_FAILED");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`serial:${actor.tenantId}:${serialNo}`}, 0))`);
      const dup = await tx.execute<{ x: number }>(
        sql`SELECT 1 AS x FROM public.serials WHERE tenant_id = ${actor.tenantId}::uuid AND serial_no = ${serialNo} LIMIT 1`,
      );
      if (dup[0] !== undefined) throw new AppError("TRACKING_VIOLATION");
    }
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${itemId}::uuid, ${serialNo}, ${lotId ?? null}::uuid)
          ON CONFLICT ON CONSTRAINT serials_tenant_item_serial_no_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("TRACKING_VIOLATION");
    await appendAudit(tx, {
      action: "serial.registered",
      actorUserId: actor.userId,
      entityType: "serial",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { item_id: itemId, lot_id: lotId ?? null },
    });
    return { serialId: id };
  });
}
