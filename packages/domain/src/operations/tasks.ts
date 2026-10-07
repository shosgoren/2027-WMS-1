// Depo görevleri (T-304; ADR-021 §6, A-132). Görev stok DEĞİŞTİRMEZ: stok etkisi görevi tamamlayan saha komutundadır ve görev
// `DONE` yalnızca o komutun transaction'ında olur (`completeTask`, `createTasks` iç yardımcıdır: paket dışına açılmaz — `index.ts`).
//
// - Genel komutlar: `assignTask` (`document.approve`), `cancelTask` (`document.approve`), `claimTask` (kendine atama; izin görev türüne
//   bağlıdır: PUTAWAY/PICK/REPUTAWAY `stock.post`, COUNT `document.create`; görev okunmadan tür bilinmediğinden sarmalayıcı izni
//   `stock.view`, tür izni komut içinde `FORBIDDEN` ile denetlenir). Hepsi `runTenantCommand`; her yazma aynı transaction'da `appendAudit` (I-12).
// - Eşzamanlılık: görev satırı `FOR UPDATE`; `expectedVersion` uyuşmazlığı `VERSION_CONFLICT`. Sonlanmış (DONE/CANCELLED) görev
//   `VALIDATION_FAILED`/`DOCUMENT_STATE` (sürümden ÖNCE denetlenir: sonlanmışlık sürümden bağımsız kesindir).
// - Sorgular (`stock.view`): `listMyTasks`, `listTasks`; keyset (created_at, id), OFFSET yok (I-14). Depo kapsamı açıksa (A-46) kapsam dışı
//   görev görünmez/NOT_FOUND. `tenant_id` yalnızca doğrulanmış üyelikten gelir; kimlik başka tenant'ınsa RLS + tenant süzgeci → NOT_FOUND.
// - Görev durum geçişleri tek tabloda (`nextTaskStatus`); DB tetikleyicisi (0017 `warehouse_tasks_guard_state`) ikinci savunmadır.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx, type Membership, type TenantAccessParams } from "../identity/access.ts";
import { hasPermission, type Permission } from "../identity/permissions.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";

export const TASK_KINDS = ["PUTAWAY", "PICK", "REPUTAWAY", "COUNT"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ["OPEN", "ASSIGNED", "DONE", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_SOURCE_KINDS = ["INBOUND_RECEIPT", "SALES_ORDER", "CUSTOMER_RETURN", "COUNT_SESSION"] as const;
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];

/** Çağıran bağlamı (izin komuta bağlıdır; çağıran veremez). */
export type TaskCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_RE = /\p{C}/u;
const QUANTITY_RE = /^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const REASON_MAX = 500;
export const TASK_LIST_LIMIT_DEFAULT = 50;
export const TASK_LIST_LIMIT_MAX = 200;

/** A-132: görevi tamamlayan iznin sahibi üstlenebilir ve atanabilir. */
export const TASK_KIND_PERMISSION: Readonly<Record<TaskKind, Permission>> = Object.freeze({
  PUTAWAY: "stock.post",
  PICK: "stock.post",
  REPUTAWAY: "stock.post",
  COUNT: "document.create",
});

export type TaskEvent = "ASSIGN" | "CLAIM" | "CANCEL" | "COMPLETE";

/**
 * Durum geçiş tablosu (ADR-021 §6). `null` = geçersiz (`DOCUMENT_STATE`).
 * ASSIGN: OPEN/ASSIGNED → ASSIGNED (yeniden atama serbest, A-304-2). CLAIM: yalnızca OPEN. CANCEL: OPEN/ASSIGNED.
 * COMPLETE: OPEN/ASSIGNED → DONE (A-304-3). DONE/CANCELLED terminaldir.
 */
export function nextTaskStatus(from: TaskStatus, event: TaskEvent): TaskStatus | null {
  switch (from) {
    case "OPEN":
      return event === "ASSIGN" || event === "CLAIM" ? "ASSIGNED" : event === "CANCEL" ? "CANCELLED" : "DONE";
    case "ASSIGNED":
      return event === "ASSIGN" ? "ASSIGNED" : event === "CLAIM" ? null : event === "CANCEL" ? "CANCELLED" : "DONE";
    default:
      return null;
  }
}

export interface TaskRow {
  readonly id: string;
  readonly warehouseId: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly assignedMembershipId: string | null;
  readonly groupId: string | null;
  readonly sourceKind: TaskSourceKind | null;
  readonly sourceId: string | null;
  readonly locationId: string | null;
  readonly itemId: string | null;
  /** Temel birimde ondalık metin (I-09); görevde miktar yoksa `null`. */
  readonly quantity: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

type TaskDbRow = {
  id: string;
  warehouse_id: string;
  kind: TaskKind;
  status: TaskStatus;
  assigned_membership_id: string | null;
  group_id: string | null;
  source_kind: TaskSourceKind | null;
  source_id: string | null;
  location_id: string | null;
  item_id: string | null;
  quantity: string | null;
  version: number;
  created_at: Date | string;
  completed_at: Date | string | null;
  created_key: string;
};

const COLUMNS = sql`id, warehouse_id, kind, status, assigned_membership_id, group_id, source_kind, source_id, location_id, item_id,
  quantity::text AS quantity, version, created_at, completed_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key`;

const toRow = (r: TaskDbRow): TaskRow => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  kind: r.kind,
  status: r.status,
  assignedMembershipId: r.assigned_membership_id,
  groupId: r.group_id,
  sourceKind: r.source_kind,
  sourceId: r.source_id,
  locationId: r.location_id,
  itemId: r.item_id,
  quantity: r.quantity,
  version: Number(r.version),
  createdAt: new Date(r.created_at),
  completedAt: r.completed_at === null ? null : new Date(r.completed_at),
});

function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}
function optUuid(raw: unknown): string | null {
  return raw === undefined || raw === null ? null : uuid(raw);
}
function version(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 2_147_483_647) throw new AppError("VALIDATION_FAILED");
  return raw;
}
function documentState(): AppError {
  return new AppError("VALIDATION_FAILED", { detail: "DOCUMENT_STATE" });
}
function limitOf(raw: number | undefined): number {
  if (raw === undefined) return TASK_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(raw) || raw < 1 || raw > TASK_LIST_LIMIT_MAX) throw new AppError("VALIDATION_FAILED");
  return raw;
}

/** Görevi kilitleyerek okur (tenant süzgeci açık; başka tenant'ın/olmayan kimlik `NOT_FOUND`; kapsam dışı depo `NOT_FOUND`). */
async function lockTask(tx: AccessTx, m: Membership, taskId: string): Promise<TaskRow> {
  const rows = await tx.execute<TaskDbRow>(
    sql`SELECT ${COLUMNS} FROM public.warehouse_tasks WHERE tenant_id = ${m.tenantId}::uuid AND id = ${taskId}::uuid FOR UPDATE`,
  );
  const row = rows[0];
  if (row === undefined) throw new AppError("NOT_FOUND");
  await assertWarehouseVisible(tx, m, [row.warehouse_id]);
  return toRow(row);
}

/** Sonlanmış → `DOCUMENT_STATE`; sonra sürüm → `VERSION_CONFLICT`; sonra geçiş tablosu → `DOCUMENT_STATE`. */
function guardTransition(task: TaskRow, expectedVersion: number, event: TaskEvent): TaskStatus {
  if (task.status === "DONE" || task.status === "CANCELLED") throw documentState();
  if (task.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
  const next = nextTaskStatus(task.status, event);
  if (next === null) throw documentState();
  return next;
}

async function setState(
  tx: AccessTx,
  m: Membership,
  task: TaskRow,
  next: TaskStatus,
  assignee: string | null,
): Promise<number> {
  const rows = await tx.execute<{ version: number }>(
    sql`UPDATE public.warehouse_tasks
           SET status = ${next}, assigned_membership_id = ${assignee}::uuid
         WHERE tenant_id = ${m.tenantId}::uuid AND id = ${task.id}::uuid AND version = ${task.version}
     RETURNING version`,
  );
  if (rows[0] === undefined) throw new AppError("VERSION_CONFLICT"); // kilit altında olmaz; savunma
  return Number(rows[0].version);
}

// ---------------------------------------------------------------------------------------------
// İç yardımcılar (paket dışına açılmaz)
// ---------------------------------------------------------------------------------------------

export interface NewTaskInput {
  readonly warehouseId: string;
  readonly kind: TaskKind;
  readonly groupId?: string | null;
  readonly sourceKind?: TaskSourceKind | null;
  readonly sourceId?: string | null;
  readonly sourceLineId?: string | null;
  readonly locationId?: string | null;
  readonly itemId?: string | null;
  /** Temel birimde pozitif ondalık metin (en çok 6 basamak); `itemId` ile birlikte. */
  readonly quantity?: string | null;
}

/**
 * İÇ: yalnızca saha komutlarının (T-305–T-309) kendi transaction'ı içinden. Görevler `OPEN` doğar; her biri için `created` audit.
 * Kaynak çifti/miktar-ürün tutarlılığını DB CHECK'leri de zorlar (ihlal `INTERNAL`'a düşer; çağıran doğru girdiyle sorumludur).
 */
export async function createTasks(
  tx: AccessTx,
  m: Pick<Membership, "tenantId" | "userId">,
  inputs: readonly NewTaskInput[],
  requestId: string | null = null,
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const input of inputs) {
    if (!(TASK_KINDS as readonly string[]).includes(input.kind)) throw new AppError("VALIDATION_FAILED");
    const sourceKind = input.sourceKind ?? null;
    if (sourceKind !== null && !(TASK_SOURCE_KINDS as readonly string[]).includes(sourceKind)) throw new AppError("VALIDATION_FAILED");
    const quantity = input.quantity ?? null;
    if (quantity !== null && (!QUANTITY_RE.test(quantity) || Number(quantity) <= 0)) throw new AppError("VALIDATION_FAILED");
    const id = randomUUID();
    const warehouseId = uuid(input.warehouseId);
    await tx.execute(
      sql`INSERT INTO public.warehouse_tasks
            (tenant_id, id, warehouse_id, kind, group_id, source_kind, source_id, source_line_id, location_id, item_id, quantity)
          VALUES (${m.tenantId}::uuid, ${id}::uuid, ${warehouseId}::uuid, ${input.kind}, ${optUuid(input.groupId)}::uuid, ${sourceKind},
                  ${optUuid(input.sourceId)}::uuid, ${optUuid(input.sourceLineId)}::uuid, ${optUuid(input.locationId)}::uuid,
                  ${optUuid(input.itemId)}::uuid, ${quantity}::numeric)`,
    );
    await appendAudit(tx, {
      action: "warehouse_task.created",
      actorUserId: m.userId,
      entityType: "warehouse_task",
      entityId: id,
      requestId,
      changeSummary: { kind: input.kind, warehouse_id: warehouseId, source_kind: sourceKind, source_id: input.sourceId ?? null },
    });
    ids.push(id);
  }
  return ids;
}

/**
 * İÇ: görevi `DONE` yapar — yalnızca görevi tamamlayan saha komutunun, stok etkisiyle AYNI transaction'ında (ADR-021 §6).
 * Atanan kişi denetimi çağıran saha komutunun işidir (A-304-3). Sonlanmış görev `DOCUMENT_STATE`; sürüm uyuşmazlığı `VERSION_CONFLICT`.
 */
export async function completeTask(
  tx: AccessTx,
  taskId: string,
  expectedVersion: number,
  m: Membership,
  requestId: string | null = null,
): Promise<{ readonly version: number }> {
  const id = uuid(taskId);
  const task = await lockTask(tx, m, id);
  const next = guardTransition(task, version(expectedVersion), "COMPLETE");
  const newVersion = await setState(tx, m, task, next, task.assignedMembershipId);
  await appendAudit(tx, {
    action: "warehouse_task.completed",
    actorUserId: m.userId,
    entityType: "warehouse_task",
    entityId: id,
    requestId,
    changeSummary: { from_status: task.status, to_status: next, version: newVersion },
  });
  return { version: newVersion };
}

// ---------------------------------------------------------------------------------------------
// Genel komutlar
// ---------------------------------------------------------------------------------------------

export interface AssignTaskInput {
  readonly taskId: string;
  readonly membershipId: string;
  readonly expectedVersion: number;
  readonly requestId?: string | null;
}

/**
 * Görevi bir üyeye atar (`document.approve`; A-132). Hedef üyelik bu tenant'ta ACTIVE olmalı (aksi `NOT_FOUND`) ve görev türünü
 * tamamlayan izne sahip olmalı (aksi `VALIDATION_FAILED`, A-304-1). OPEN/ASSIGNED görev atanabilir (yeniden atama).
 */
export async function assignTask(params: TaskCallParams, input: AssignTaskInput): Promise<{ readonly version: number }> {
  const taskId = uuid(input.taskId);
  const membershipId = uuid(input.membershipId);
  const expectedVersion = version(input.expectedVersion);
  return runTenantCommand({ ...params, permission: "document.approve" }, async (tx, m) => {
    const task = await lockTask(tx, m, taskId);
    const next = guardTransition(task, expectedVersion, "ASSIGN");
    const target = await tx.execute<{ role_key: string }>(
      sql`SELECT r.role_key
            FROM public.tenant_memberships tm
            LEFT JOIN public.membership_roles r ON r.tenant_id = tm.tenant_id AND r.membership_id = tm.id
           WHERE tm.tenant_id = ${m.tenantId}::uuid AND tm.id = ${membershipId}::uuid AND tm.status = 'ACTIVE'`,
    );
    if (target.length === 0) throw new AppError("NOT_FOUND");
    const roles = target.flatMap((r) => (r.role_key === null ? [] : [r.role_key]));
    if (!hasPermission(roles, TASK_KIND_PERMISSION[task.kind])) throw new AppError("VALIDATION_FAILED");
    const newVersion = await setState(tx, m, task, next, membershipId);
    await appendAudit(tx, {
      action: "warehouse_task.assigned",
      actorUserId: m.userId,
      entityType: "warehouse_task",
      entityId: taskId,
      requestId: input.requestId ?? null,
      changeSummary: {
        from_status: task.status,
        to_status: next,
        from_membership_id: task.assignedMembershipId,
        to_membership_id: membershipId,
        version: newVersion,
      },
    });
    return { version: newVersion };
  });
}

export interface ClaimTaskInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly requestId?: string | null;
}

/** Kendine atama; yalnızca `OPEN`. Görev türünün izni yoksa `FORBIDDEN`. İki eşzamanlı üstlenmeden biri `VERSION_CONFLICT` alır. */
export async function claimTask(params: TaskCallParams, input: ClaimTaskInput): Promise<{ readonly version: number }> {
  const taskId = uuid(input.taskId);
  const expectedVersion = version(input.expectedVersion);
  return runTenantCommand({ ...params, permission: "stock.view" }, async (tx, m) => {
    const task = await lockTask(tx, m, taskId);
    if (!hasPermission(m.roles, TASK_KIND_PERMISSION[task.kind])) throw new AppError("FORBIDDEN");
    const next = guardTransition(task, expectedVersion, "CLAIM");
    const newVersion = await setState(tx, m, task, next, m.membershipId);
    await appendAudit(tx, {
      action: "warehouse_task.claimed",
      actorUserId: m.userId,
      entityType: "warehouse_task",
      entityId: taskId,
      requestId: input.requestId ?? null,
      changeSummary: { from_status: task.status, to_status: next, membership_id: m.membershipId, version: newVersion },
    });
    return { version: newVersion };
  });
}

export interface CancelTaskInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  /** Zorunlu gerekçe (1–500 karakter, denetim karakteri yok); audit `reason`. */
  readonly reason: string;
  readonly requestId?: string | null;
}

/** Görevi iptal eder (`document.approve`); stok etkisi yok; gerekçe audit'e. */
export async function cancelTask(params: TaskCallParams, input: CancelTaskInput): Promise<{ readonly version: number }> {
  const taskId = uuid(input.taskId);
  const expectedVersion = version(input.expectedVersion);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason === "" || Array.from(reason).length > REASON_MAX || CONTROL_RE.test(reason)) throw new AppError("VALIDATION_FAILED");
  return runTenantCommand({ ...params, permission: "document.approve" }, async (tx, m) => {
    const task = await lockTask(tx, m, taskId);
    const next = guardTransition(task, expectedVersion, "CANCEL");
    const newVersion = await setState(tx, m, task, next, task.assignedMembershipId);
    await appendAudit(tx, {
      action: "warehouse_task.cancelled",
      actorUserId: m.userId,
      entityType: "warehouse_task",
      entityId: taskId,
      requestId: input.requestId ?? null,
      reason,
      changeSummary: { from_status: task.status, to_status: next, version: newVersion },
    });
    return { version: newVersion };
  });
}

// ---------------------------------------------------------------------------------------------
// Sorgular (stock.view)
// ---------------------------------------------------------------------------------------------

/** Keyset imleci (created_at mikrosaniye metni + id). Opak kabul edilir; biçim bozuksa `VALIDATION_FAILED`. */
export interface TaskCursor {
  readonly createdKey: string;
  readonly id: string;
}
export interface TaskPage {
  readonly items: readonly TaskRow[];
  readonly next: TaskCursor | null;
}

function cursorOf(raw: TaskCursor | undefined): { key: string; id: string } | null {
  if (raw === undefined) return null;
  if (typeof raw.createdKey !== "string" || !CURSOR_TIME_RE.test(raw.createdKey)) throw new AppError("VALIDATION_FAILED");
  return { key: raw.createdKey, id: uuid(raw.id) };
}

function page(rows: readonly TaskDbRow[], limit: number): TaskPage {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(toRow), next: rows.length > limit && last !== undefined ? { createdKey: last.created_key, id: last.id } : null };
}

export interface ListMyTasksInput {
  readonly after?: TaskCursor;
  readonly limit?: number;
}

/**
 * Personelin listesi: bana atanmış ASSIGNED görevler + türünün izni bende olan üstlenilebilir OPEN görevler (A-132). Sıra: eskiden yeniye
 * (created_at, id). DONE/CANCELLED görünmez.
 */
export async function listMyTasks(params: TaskCallParams, input: ListMyTasksInput = {}): Promise<TaskPage> {
  const limit = limitOf(input.limit);
  const cur = cursorOf(input.after);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const kinds = TASK_KINDS.filter((k) => hasPermission(m.roles, TASK_KIND_PERMISSION[k]));
    const rows = await tx.execute<TaskDbRow>(
      sql`SELECT ${COLUMNS}
            FROM public.warehouse_tasks
           WHERE tenant_id = ${m.tenantId}::uuid
             AND (   (status = 'ASSIGNED' AND assigned_membership_id = ${m.membershipId}::uuid)
                  OR (status = 'OPEN' AND kind = ANY(${`{${kinds.join(",")}}`}::text[])))
             AND (${scope === null}::boolean OR warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
             AND (${cur === null}::boolean OR (created_at, id) > (${cur?.key ?? "1970-01-01T00:00:00.000000Z"}::timestamptz, ${cur?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY created_at, id
           LIMIT ${limit + 1}`,
    );
    return page(rows, limit);
  });
}

export interface ListTasksInput {
  readonly kind?: TaskKind;
  readonly status?: TaskStatus;
  readonly warehouseId?: string;
  readonly after?: TaskCursor;
  readonly limit?: number;
}

/** Yönetici listesi: tür/durum/depo süzgeci; sıra created_at, id; keyset. Okuma `stock.view` (eylemler kendi izinlerini ister). */
export async function listTasks(params: TaskCallParams, input: ListTasksInput = {}): Promise<TaskPage> {
  const limit = limitOf(input.limit);
  const cur = cursorOf(input.after);
  const kind = input.kind ?? null;
  const status = input.status ?? null;
  if (kind !== null && !(TASK_KINDS as readonly string[]).includes(kind)) throw new AppError("VALIDATION_FAILED");
  if (status !== null && !(TASK_STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION_FAILED");
  const warehouseId = input.warehouseId === undefined ? null : uuid(input.warehouseId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, m) => {
    const scope = await resolveWarehouseScope(tx, m);
    const rows = await tx.execute<TaskDbRow>(
      sql`SELECT ${COLUMNS}
            FROM public.warehouse_tasks
           WHERE tenant_id = ${m.tenantId}::uuid
             AND (${kind}::text IS NULL OR kind = ${kind}::text)
             AND (${status}::text IS NULL OR status = ${status}::text)
             AND (${warehouseId}::uuid IS NULL OR warehouse_id = ${warehouseId}::uuid)
             AND (${scope === null}::boolean OR warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
             AND (${cur === null}::boolean OR (created_at, id) > (${cur?.key ?? "1970-01-01T00:00:00.000000Z"}::timestamptz, ${cur?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
           ORDER BY created_at, id
           LIMIT ${limit + 1}`,
    );
    return page(rows, limit);
  });
}
