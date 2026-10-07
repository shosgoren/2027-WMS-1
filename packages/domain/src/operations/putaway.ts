// Yerleştirme komutu (T-305; ADR-021 §3/§6, 06 §Mal kabul ve yerleştirme, 16 Senaryo A adım 3 / Senaryo D adım 3).
//
// `putaway` (`stock.post`): `STOCK_MOVE`/`MOVE` (kaynak lokasyon → STORAGE hedef; durum AVAILABLE, miktar temel birimde). İKİNCİ STOK GİRİŞİ YOKTUR: toplam
// fiziksel değişmez (16 kural 3). Görev verilmişse görev AYNI transaction'da `DONE` olur (`completeTask`; ADR-021 §6). Primitif belge saha komutunun tek
// istemci anahtarıyla oluşturulur/onaylanır/işlenir (`field-posting.ts`). Lokasyon ACTIVE yeniden okuması ve sayım kilidi (`LOCATION_LOCKED`) motordadır
// (acquireStockLocks + posting çekirdeği; T-217 notu).
//
// A-305-7: `taskId` verilirse görev PUTAWAY/REPUTAWAY, OPEN/ASSIGNED olmalı; ürün, kaynak lokasyon ve miktar görevle BİREBİR eşleşmeli (kısmi yerleştirme
// görevi tamamlamaz; bölünmüş yerleştirme için görev iptal edilip görevsiz yerleştirme yapılır). Başkasına atanmış görevi yalnızca `document.approve` sahibi
// tamamlar (A-304-3: atanan kişi denetimi saha komutunundur).
// A-305-8: hedef lokasyon `STORAGE` türünde ve kaynaktan farklı olmalı; kaynak lokasyon türü sınırlanmaz (geri yerleştirme SEVK → raf aynı komutu kullanır).
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import type { AccessTx } from "../identity/access.ts";
import { hasPermission } from "../identity/permissions.ts";
import { pgUuidArray } from "../warehouse/scope.ts";
import {
  executeStockCommand,
  type StockCommandOutcome,
  type StockCommandResult,
  type StockDocCallParams,
} from "../stock/index.ts";
import { decimalToMicro, documentState, emptyPlan, planFieldPosting, postFieldDocument, uuidOf, DECIMAL_RE, type FieldPostSpec } from "./field-posting.ts";
import { completeTask } from "./tasks.ts";

export interface PutawayInput {
  readonly taskId?: string;
  readonly sourceLocationId: string;
  /** STORAGE türünde lokasyon. */
  readonly targetLocationId: string;
  readonly itemId: string;
  /** Temel birimde pozitif ondalık dizgi. */
  readonly quantity: string;
  readonly requestId?: string | null;
}

type LocRow = {
  id: string;
  warehouse_id: string;
  kind: string;
}
async function readLocations(tx: AccessTx, tenantId: string, ids: readonly string[]): Promise<LocRow[]> {
  return tx.execute<LocRow>(
    sql`SELECT id, warehouse_id, kind FROM public.locations WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${pgUuidArray(ids)}::uuid[])`,
  );
}

async function buildSpec(tx: AccessTx, tenantId: string, p: Required<Pick<PutawayInput, "sourceLocationId" | "targetLocationId" | "itemId" | "quantity">>, taskId: string | null): Promise<FieldPostSpec> {
  const locs = await readLocations(tx, tenantId, [p.sourceLocationId, p.targetLocationId]);
  const src = locs.find((l) => l.id.toLowerCase() === p.sourceLocationId);
  const dst = locs.find((l) => l.id.toLowerCase() === p.targetLocationId);
  if (src === undefined || dst === undefined) throw new AppError("NOT_FOUND");
  if (dst.kind !== "STORAGE") throw new AppError("VALIDATION_FAILED");
  const items = await tx.execute<{ base_unit_id: string }>(
    sql`SELECT base_unit_id FROM public.items WHERE tenant_id = ${tenantId}::uuid AND id = ${p.itemId}::uuid`,
  );
  const unitId = items[0]?.base_unit_id;
  if (unitId === undefined) throw new AppError("NOT_FOUND");
  return {
    kind: "STOCK_MOVE",
    warehouseId: src.warehouse_id,
    sourceKind: taskId === null ? null : "TASK",
    sourceId: taskId,
    lines: [
      {
        itemId: p.itemId,
        unitId,
        quantity: p.quantity,
        conversionFactor: "1.000000",
        baseQuantity: p.quantity,
        sourceLocationId: p.sourceLocationId,
        targetLocationId: p.targetLocationId,
        stockStatus: "AVAILABLE",
        targetStockStatus: null,
        sourceLineId: null,
      },
    ],
  };
}

type TaskLockRow = {
  warehouse_id: string;
  kind: string;
  status: string;
  assigned_membership_id: string | null;
  location_id: string | null;
  item_id: string | null;
  quantity: string | null;
  version: number;
}

/** `stock.post`: bkz. dosya başı. */
export async function putaway(
  params: StockDocCallParams,
  input: PutawayInput,
): Promise<StockCommandResult & { readonly replayed: boolean }> {
  const taskId = input.taskId === undefined ? null : uuidOf(input.taskId);
  const p = {
    sourceLocationId: uuidOf(input.sourceLocationId),
    targetLocationId: uuidOf(input.targetLocationId),
    itemId: uuidOf(input.itemId),
    quantity: input.quantity,
  };
  if (typeof p.quantity !== "string" || !DECIMAL_RE.test(p.quantity) || decimalToMicro(p.quantity) <= 0n) throw new AppError("VALIDATION_FAILED");
  if (p.sourceLocationId === p.targetLocationId) throw new AppError("VALIDATION_FAILED"); // boş hareket
  const hashInput = { taskId, ...p };
  const outcome: StockCommandOutcome<StockCommandResult> = await executeStockCommand<typeof hashInput, StockCommandResult>({
    db: params.db,
    principal: params.principal,
    tenantSlug: params.tenantSlug,
    clientKey: params.clientKey,
    commandType: "stock.putaway",
    permission: "stock.post",
    input: hashInput,
    ...(params.retry === undefined ? {} : { retry: params.retry }),
    ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }),
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    plan: async (tx, _i, m) => {
      try {
        return await planFieldPosting(tx, m.tenantId, await buildSpec(tx, m.tenantId, p, taskId));
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        const locs = await readLocations(tx, m.tenantId, [p.sourceLocationId]);
        return emptyPlan(locs.map((l) => l.warehouse_id)); // apply kilit altında asıl hatayı verir
      }
    },
    apply: async (tx, locked, ctx) => {
      let task: TaskLockRow | undefined;
      if (taskId !== null) {
        // Stok kilitlerinden SONRA görev satırı kilidi (görev stok kilit tablosu değildir).
        const rows = await tx.execute<TaskLockRow>(
          sql`SELECT warehouse_id, kind, status, assigned_membership_id, location_id, item_id, quantity::text AS quantity, version
                FROM public.warehouse_tasks WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${taskId}::uuid FOR UPDATE`,
        );
        task = rows[0];
        if (task === undefined) throw new AppError("NOT_FOUND");
        if (task.status !== "OPEN" && task.status !== "ASSIGNED") throw documentState();
        if (task.kind !== "PUTAWAY" && task.kind !== "REPUTAWAY") throw new AppError("VALIDATION_FAILED");
        if (
          task.item_id === null || task.item_id.toLowerCase() !== p.itemId ||
          task.quantity === null || decimalToMicro(task.quantity) !== decimalToMicro(p.quantity) ||
          (task.location_id !== null && task.location_id.toLowerCase() !== p.sourceLocationId)
        ) {
          throw new AppError("VALIDATION_FAILED");
        }
        if (
          task.status === "ASSIGNED" &&
          task.assigned_membership_id !== ctx.membership.membershipId &&
          !hasPermission(ctx.membership.roles, "document.approve")
        ) {
          throw new AppError("FORBIDDEN");
        }
      }
      const built = await buildSpec(tx, ctx.tenantId, p, taskId);
      if (task !== undefined && task.warehouse_id.toLowerCase() !== built.warehouseId.toLowerCase()) throw new AppError("VALIDATION_FAILED");
      const applied = await postFieldDocument(tx, locked, ctx, built, input.requestId ?? null);
      if (taskId !== null && task !== undefined) await completeTask(tx, taskId, Number(task.version), ctx.membership, input.requestId ?? null);
      return applied;
    },
  });
  if (outcome.status !== "COMPLETED") throw new AppError("VERSION_CONFLICT", { retryable: true });
  return { ...outcome.result, replayed: outcome.replayed };
}
