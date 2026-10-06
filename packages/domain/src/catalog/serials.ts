// Seri kartı komutu (T-212; A-72, A-87, A-97, Q-39). Yazma `document.create`.
//
// - Stok DEĞİŞTİRMEZ (G-01). Seri kimliği (`item_id`, `serial_no`, `lot_id`) değişmez (A-87); kullanılmış serinin `lot_id`'si
//   0013 tetikleyicisiyle ayrıca reddedilir.
// - Kapsam A-72: ürün içi (`UNIQUE (tenant_id, item_id, serial_no)`). Tenant geneli tekillik `SERIAL_SCOPE_TENANT_ENABLED`
//   bayrağıyla kapalıdır. Bayrak YALNIZCA sunucu ortamından (`process.env.SERIAL_SCOPE_TENANT_ENABLED === "true"`) okunur;
//   istemci/çağıran imzası bayrak taşımaz (denetim atlatılamaz). Açıkken tenant+seri no için `pg_advisory_xact_lock` ile
//   yarış serileşir ve ürünler arası tekrar komutta denetlenir.
//   ŞART: bayrak açılmadan önce DB'de tenant geneli kısmi tekil indeks migration'ı eklenmelidir (Q-39/Q-59); komut denetimi
//   tek başına son savunma değildir (advisory kilit yalnızca bu komutu kapsar).
// - `SERIAL`: lot verilmez; `LOT_AND_SERIAL`: lot zorunlu ve aynı ürünün lotu. Tekrar → `TRACKING_VIOLATION`.
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand } from "../identity/access.ts";
import { loadItemForTraceability, parseNfcText } from "./lots.ts";
import { parseUuid, type CatalogCommandParams } from "./units.ts";

export interface RegisterSerialInput {
  readonly itemId: string;
  readonly serialNo: string;
  readonly lotId?: string;
}
/** Kapalı bayrak deseni: yalnızca tam `"true"` açar; çağrı anında okunur (A-72). */
function serialScopeTenantEnabled(): boolean {
  return process.env["SERIAL_SCOPE_TENANT_ENABLED"] === "true";
}

export async function registerSerial(
  params: CatalogCommandParams,
  input: RegisterSerialInput,
): Promise<{ readonly serialId: string }> {
  const itemId = parseUuid(input.itemId);
  const serialNo = parseNfcText(input.serialNo, 128);
  const lotId = input.lotId === undefined ? undefined : parseUuid(input.lotId);
  const tenantScope = serialScopeTenantEnabled();
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
