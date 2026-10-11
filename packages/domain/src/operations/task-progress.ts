// Rehberli saha akışında görev adım ilerlemesi (T-293; ADR-025; A-293-1…A-293-4; A-305-7, A-305-8, A-313-2).
//
// İlerleme STOK DEĞİLDİR (G-01): bu dosya stok kilidi almaz (`acquireStockLocks` yok), stok/defter/belge tablolarına ve `warehouse_tasks`'a YAZMAZ, audit üretmez
// (ADR-025 §4; I-12 kapsamı dışı). Yazdığı tek tablo `warehouse_task_progress`'tir (0026). Görev satırı yalnızca `FOR SHARE` ile okunur (atama/tamamlama ile yarışmasın).
// "Tamamlandı" tek doğruluk kaynağı görevin `DONE` durumudur (ADR-021 §6); ilerlemede "kaydedildi" durumu YOKTUR.
//
// Sözleşme:
// - `membership_id` OTURUMDAN türetilir; girdide `membershipId`/`locationId`/`itemId` (ve her fazla alan) KABUL EDİLMEZ (`VALIDATION_FAILED`, strict).
//   Okutma yalnızca kod dizesi taşır; lokasyon ve ürün sunucuda çözülür (ürün: `resolveBarcode`; raf: görevin deposunda kod, eski kod geçmişi dahil).
// - İlerleme yalnızca görevin ATANDIĞI üyeliğe aittir: görev başkasına atanmışsa/atanmamışsa `FORBIDDEN`; başka tenant'ın görevi `NOT_FOUND`.
//   Geçerlilik = görev `ASSIGNED` + atanan = oturum üyeliği + satırın `task_version`'ı görev sürümüne eşit. Sürüm her atama/iptal/tamamlama/lokasyon
//   değişiminde artar → atama değişirse (A → B → A dahil) eski ilerleme DÖNMEZ; geçersiz satır okunmaz, yazımda silinip baştan başlanır.
// - Yerleştirme adım sırası A-293-3 (Q-110 cevaplanana kadar): ürün okut → hedef raf okut → miktar → kaydet; kaynak raf okutulmaz. Hedef raf serbest
//   (A-305-8): görevin deposunda, ACTIVE, `STORAGE` türünde ve kaynak lokasyondan farklı her raf kabul edilir. Miktar görev miktarıyla BİREBİR (A-305-7).
// - Yanlış okutma/miktar İSTİSNA DEĞİL, `accepted: false` sonucudur: hata gövdesi beklenen/okunan değeri taşıyamaz; UI "B-12 rafını okut. Şu an B-21 rafını
//   okuttun." gibi cümleyi bu alanlarla kurar. İlerleme DEĞİŞMEZ. Beklenen/okunan değerler yalnızca yanıtta döner, loga yazılmaz.
// - Kaydet: `beginSave` istemci anahtarını önce ilerlemeye yazar (ayrı transaction); stok komutu `putaway` AYNI anahtarla çağrılır (ADR-018: yanıt kaybolsa da
//   yeniden gönderim tek defter etkisi üretir; saklı sonuç döner). `savePutawayTask` ikisini sırayla yapar.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx, type Membership, type TenantAccessParams } from "../identity/access.ts";
import { BarcodeNotFoundError, resolveBarcode } from "../catalog/barcodes.ts";
import type { StockDocCallParams } from "../stock/index.ts";
import { assertWarehouseVisible, pgUuidArray, resolveWarehouseScope } from "../warehouse/scope.ts";
import { normalizeCode } from "../warehouse/warehouses.ts";
import { DECIMAL_RE, UUID_RE, decimalToMicro, documentState, microToDecimal } from "./field-posting.ts";
import { putaway } from "./putaway.ts";
import type { TaskKind } from "./tasks.ts";

/** Bu dilimde rehberli akışı olan görev türleri (`putaway` iki türü kabul eder; PICK/COUNT T-314/T-316). */
export const GUIDED_TASK_KINDS = ["PUTAWAY", "REPUTAWAY"] as const satisfies readonly TaskKind[];
/** Sıradaki BEKLENEN adım (ilk adım `SCAN_ITEM` = ilerleme satırı yok). */
export const TASK_PROGRESS_STEPS = ["SCAN_ITEM", "SCAN_TARGET", "ENTER_QUANTITY", "CONFIRM", "SAVING"] as const;
export type TaskProgressStep = (typeof TASK_PROGRESS_STEPS)[number];
/** Okutma/miktar girilebilen adımlar (CONFIRM/SAVING `beginSave` ile ilerler). */
export const RECORDABLE_STEPS = ["SCAN_ITEM", "SCAN_TARGET", "ENTER_QUANTITY"] as const;
export type RecordableStep = (typeof RECORDABLE_STEPS)[number];
export const SCAN_CODE_MAX = 256;

export type TaskProgressCallParams = Omit<TenantAccessParams, "permission" | "recentAuth">;

/** Adım rütbesi: gönderilen adım rütbesi geçerli adımdan büyükse sıra dışıdır (`DOCUMENT_STATE`); küçük/eşitse yeniden gönderimdir (doğrulanır, idempotent). */
const RANK: Readonly<Record<TaskProgressStep, number>> = { SCAN_ITEM: 0, SCAN_TARGET: 1, ENTER_QUANTITY: 2, CONFIRM: 3, SAVING: 4 };

export interface TaskProgressView {
  readonly taskId: string;
  readonly taskKind: TaskKind;
  readonly taskStatus: "OPEN" | "ASSIGNED" | "DONE" | "CANCELLED";
  /** Görev sürümü (istemci `expectedVersion` olarak geri gönderebilir). */
  readonly taskVersion: number;
  /** Sıradaki beklenen adım; görev `DONE`/`CANCELLED` ise `null`. */
  readonly step: TaskProgressStep | null;
  readonly itemCode: string;
  readonly itemName: string;
  /** Görev miktarı (temel birim; sade ondalık: "6", "2.5"). */
  readonly expectedQuantity: string;
  /** Kaynak raf kodu (okutulmaz; ekranda gösterilir). */
  readonly sourceLocationCode: string;
  /** Doğrulanmış hedef raf kodu. */
  readonly targetLocationCode: string | null;
  /** Doğrulanmış miktar (sade ondalık). */
  readonly quantity: string | null;
  /** Kayıt istemci anahtarı (yalnızca `SAVING`); kaydetme isteğini yeniden göndermek için sunucu da bunu kullanır. */
  readonly saveClientKey: string | null;
}

export type StepRejectionReason = "UNKNOWN_CODE" | "WRONG_ITEM" | "LOCATION_ARCHIVED" | "SAME_AS_SOURCE" | "NOT_STORAGE" | "WRONG_QUANTITY";

export type RecordStepResult =
  | { readonly accepted: true; readonly progress: TaskProgressView }
  | {
      readonly accepted: false;
      readonly code: "VALIDATION_FAILED";
      /** Okutma uyuşmazlıkları `SCAN_MISMATCH`; miktar uyuşmazlığında `null`. */
      readonly detail: "SCAN_MISMATCH" | null;
      readonly reason: StepRejectionReason;
      /** Beklenen değer: ürün kodu (WRONG_ITEM) ya da miktar (WRONG_QUANTITY); diğer nedenlerde `null`. */
      readonly expected: string | null;
      /** Okunan değer: normalleştirilmiş kod ya da girilen miktar (ürün okutmada çözülebilirse ürün kodu). */
      readonly scanned: string;
      /** Okunan rafın türü (NOT_STORAGE); yoksa `null`. */
      readonly scannedKind: string | null;
      /** İlerleme DEĞİŞMEDİ: mevcut durum. */
      readonly progress: TaskProgressView;
    };

// ---------------------------------------------------------------------------------------------
// Girdi doğrulama (strict; saf — birim testi)
// ---------------------------------------------------------------------------------------------

function strictObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AppError("VALIDATION_FAILED");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new AppError("VALIDATION_FAILED"); // membershipId/locationId/itemId dahil
  return obj;
}
function uuidField(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AppError("VALIDATION_FAILED");
  return raw.toLowerCase();
}
function versionField(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 2_147_483_647) throw new AppError("VALIDATION_FAILED");
  return raw;
}

export interface ParsedRecordStep {
  readonly taskId: string;
  readonly step: RecordableStep;
  readonly scannedCode: string | null;
  readonly quantity: string | null;
  readonly expectedVersion: number | null;
}

export function parseRecordStepInput(raw: unknown): ParsedRecordStep {
  const o = strictObject(raw, ["taskId", "step", "scannedCode", "quantity", "expectedVersion"]);
  const step = o.step;
  if (typeof step !== "string" || !(RECORDABLE_STEPS as readonly string[]).includes(step)) throw new AppError("VALIDATION_FAILED");
  const taskId = uuidField(o.taskId);
  const expectedVersion = versionField(o.expectedVersion);
  if (step === "ENTER_QUANTITY") {
    if (o.scannedCode !== undefined || typeof o.quantity !== "string" || !DECIMAL_RE.test(o.quantity)) throw new AppError("VALIDATION_FAILED");
    return { taskId, step, scannedCode: null, quantity: o.quantity, expectedVersion };
  }
  const code = o.scannedCode;
  if (o.quantity !== undefined || typeof code !== "string" || code.trim() === "" || code.length > SCAN_CODE_MAX) throw new AppError("VALIDATION_FAILED");
  return { taskId, step: step as RecordableStep, scannedCode: code, quantity: null, expectedVersion };
}

function parseTaskOnly(raw: unknown, extra: readonly string[] = []): { taskId: string; expectedVersion: number | null } {
  const o = strictObject(raw, ["taskId", ...extra]);
  return { taskId: uuidField(o.taskId), expectedVersion: extra.includes("expectedVersion") ? versionField(o.expectedVersion) : null };
}

/** Sade ondalık: "6.000000" → "6", "2.500000" → "2.5". */
export function plainDecimal(text: string): string {
  const d = microToDecimal(decimalToMicro(text));
  return d.replace(/\.?0+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Satır okuma / yetki
// ---------------------------------------------------------------------------------------------

type TaskRowDb = {
  warehouse_id: string;
  kind: TaskKind;
  status: "OPEN" | "ASSIGNED" | "DONE" | "CANCELLED";
  assigned_membership_id: string | null;
  group_id: string | null;
  location_id: string | null;
  item_id: string | null;
  quantity: string | null;
  version: number;
  location_code: string | null;
  item_code: string | null;
  item_name: string | null;
};
type ProgressRowDb = {
  membership_id: string;
  task_version: number;
  step: Exclude<TaskProgressStep, "SCAN_ITEM">;
  location_id: string | null;
  item_id: string;
  quantity: string | null;
  save_client_key: string | null;
  target_code: string | null;
};
interface GuidedTask {
  readonly id: string;
  readonly warehouseId: string;
  readonly kind: TaskKind;
  readonly status: TaskRowDb["status"];
  readonly version: number;
  readonly sourceLocationId: string;
  readonly sourceLocationCode: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** Görevi (tenant süzgeci + RLS) okur; yok/başka tenant/kapsam dışı `NOT_FOUND`; atanan ben değilsem `FORBIDDEN`. `lock`: FOR SHARE. */
async function loadOwnTask(tx: AccessTx, m: Membership, taskId: string, lock: boolean): Promise<GuidedTask> {
  const rows = await tx.execute<TaskRowDb>(
    lock
      ? sql`SELECT t.warehouse_id, t.kind, t.status, t.assigned_membership_id, t.group_id, t.location_id, t.item_id, t.quantity::text AS quantity, t.version,
                   l.code AS location_code, i.code AS item_code, i.name AS item_name
              FROM public.warehouse_tasks t
              LEFT JOIN public.locations l ON l.tenant_id = t.tenant_id AND l.id = t.location_id
              LEFT JOIN public.items i ON i.tenant_id = t.tenant_id AND i.id = t.item_id
             WHERE t.tenant_id = ${m.tenantId}::uuid AND t.id = ${taskId}::uuid FOR SHARE OF t`
      : sql`SELECT t.warehouse_id, t.kind, t.status, t.assigned_membership_id, t.group_id, t.location_id, t.item_id, t.quantity::text AS quantity, t.version,
                   l.code AS location_code, i.code AS item_code, i.name AS item_name
              FROM public.warehouse_tasks t
              LEFT JOIN public.locations l ON l.tenant_id = t.tenant_id AND l.id = t.location_id
              LEFT JOIN public.items i ON i.tenant_id = t.tenant_id AND i.id = t.item_id
             WHERE t.tenant_id = ${m.tenantId}::uuid AND t.id = ${taskId}::uuid`,
  );
  const t = rows[0];
  if (t === undefined) throw new AppError("NOT_FOUND");
  await assertWarehouseVisible(tx, m, [t.warehouse_id]);
  // İlerleme yalnızca atanan üyeliğe aittir (A-293-4): başkasına atanmış/atanmamış görev → FORBIDDEN (başka tenant zaten NOT_FOUND).
  if (!same(t.assigned_membership_id, m.membershipId)) throw new AppError("FORBIDDEN");
  if (!(GUIDED_TASK_KINDS as readonly string[]).includes(t.kind)) throw new AppError("VALIDATION_FAILED");
  if (t.location_id === null || t.location_code === null || t.item_id === null || t.item_code === null || t.item_name === null || t.quantity === null) {
    throw new AppError("VALIDATION_FAILED"); // rehberli akış kaynak raf + ürün + miktar ister
  }
  return {
    id: taskId,
    warehouseId: t.warehouse_id,
    kind: t.kind,
    status: t.status,
    version: Number(t.version),
    sourceLocationId: t.location_id,
    sourceLocationCode: t.location_code,
    itemId: t.item_id,
    itemCode: t.item_code,
    itemName: t.item_name,
    quantity: t.quantity,
  };
}

async function readProgress(tx: AccessTx, m: Membership, taskId: string, lock: boolean): Promise<ProgressRowDb | undefined> {
  const rows = await tx.execute<ProgressRowDb>(
    lock
      ? sql`SELECT p.membership_id, p.task_version, p.step, p.location_id, p.item_id, p.quantity::text AS quantity, p.save_client_key, tl.code AS target_code
              FROM public.warehouse_task_progress p
              LEFT JOIN public.locations tl ON tl.tenant_id = p.tenant_id AND tl.id = p.location_id
             WHERE p.tenant_id = ${m.tenantId}::uuid AND p.task_id = ${taskId}::uuid FOR UPDATE OF p`
      : sql`SELECT p.membership_id, p.task_version, p.step, p.location_id, p.item_id, p.quantity::text AS quantity, p.save_client_key, tl.code AS target_code
              FROM public.warehouse_task_progress p
              LEFT JOIN public.locations tl ON tl.tenant_id = p.tenant_id AND tl.id = p.location_id
             WHERE p.tenant_id = ${m.tenantId}::uuid AND p.task_id = ${taskId}::uuid`,
  );
  return rows[0];
}

/** Geçerlilik (ADR-025 §2): görev ASSIGNED + satır bu üyeliğin + satır doğduğunda görev sürümü aynı (atama değişimi A → B → A'yı da geçersiz kılar). */
function isValid(task: GuidedTask, row: ProgressRowDb | undefined, m: Membership): row is ProgressRowDb {
  return row !== undefined && task.status === "ASSIGNED" && same(row.membership_id, m.membershipId) && Number(row.task_version) === task.version;
}

async function deleteProgress(tx: AccessTx, m: Membership, taskId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM public.warehouse_task_progress WHERE tenant_id = ${m.tenantId}::uuid AND task_id = ${taskId}::uuid`);
}

function viewOf(task: GuidedTask, row: ProgressRowDb | undefined, valid: boolean): TaskProgressView {
  const ended = task.status === "DONE" || task.status === "CANCELLED";
  const r = valid ? row : undefined;
  return {
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: task.status,
    taskVersion: task.version,
    step: ended ? null : r === undefined ? "SCAN_ITEM" : r.step,
    itemCode: task.itemCode,
    itemName: task.itemName,
    expectedQuantity: plainDecimal(task.quantity),
    sourceLocationCode: task.sourceLocationCode,
    targetLocationCode: r?.target_code ?? null,
    quantity: r?.quantity == null ? null : plainDecimal(r.quantity),
    saveClientKey: r?.save_client_key ?? null,
  };
}

function assertWritable(task: GuidedTask, expectedVersion: number | null): void {
  if (task.status === "DONE" || task.status === "CANCELLED") throw documentState();
  if (expectedVersion !== null && expectedVersion !== task.version) throw new AppError("VERSION_CONFLICT");
}

// ---------------------------------------------------------------------------------------------
// Okuma
// ---------------------------------------------------------------------------------------------

/**
 * Görevin rehberli ilerlemesi (`stock.post`). Geçersiz/eski ilerleme yok sayılır (ilk adım döner). Görev `DONE`/`CANCELLED` ise `step = null`
 * ve `taskStatus` gerçeği söyler (UI "Tamamlandı" yalnızca `DONE`'da der).
 */
export async function getTaskProgress(params: TaskProgressCallParams, input: { readonly taskId: string }): Promise<TaskProgressView> {
  const { taskId } = parseTaskOnly(input);
  return runTenantQuery({ ...params, permission: "stock.post" }, async (tx, m) => {
    const task = await loadOwnTask(tx, m, taskId, false);
    const row = await readProgress(tx, m, taskId, false);
    return viewOf(task, row, isValid(task, row, m));
  });
}

// ---------------------------------------------------------------------------------------------
// Okutma çözümleme (sunucuda; istemci kimlik göndermez)
// ---------------------------------------------------------------------------------------------

type Rejection = Omit<Extract<RecordStepResult, { accepted: false }>, "accepted" | "code" | "progress">;
const reject = (reason: StepRejectionReason, scanned: string, expected: string | null = null, scannedKind: string | null = null): Rejection => ({
  detail: reason === "WRONG_QUANTITY" ? null : "SCAN_MISMATCH",
  reason,
  expected,
  scanned,
  scannedKind,
});

type LocationHit = { id: string; code: string; kind: string; status: string };

async function findLocationInWarehouse(tx: AccessTx, m: Membership, warehouseId: string, code: string): Promise<LocationHit | null> {
  const cur = await tx.execute<LocationHit>(
    sql`SELECT id, code, kind, status FROM public.locations WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid AND code = ${code}`,
  );
  if (cur[0] !== undefined) return cur[0];
  // Eski kod (yeniden adlandırılmış raf etiketi): findLocationByCode ile aynı kural; belirsizse sessizce seçilmez.
  const old = await tx.execute<LocationHit>(
    sql`SELECT l.id, l.code, l.kind, l.status FROM public.code_history h
          JOIN public.locations l ON l.tenant_id = h.tenant_id AND l.id = h.entity_id
         WHERE h.tenant_id = ${m.tenantId}::uuid AND h.entity_type = 'location' AND h.old_code = ${code} AND l.warehouse_id = ${warehouseId}::uuid
         GROUP BY l.tenant_id, l.id
         ORDER BY max(h.changed_at) DESC, l.id
         LIMIT 2`,
  );
  if (old.length > 1) throw new AppError("VALIDATION_FAILED", { detail: "CODE_AMBIGUOUS" });
  return old[0] ?? null;
}

async function verifyItem(tx: AccessTx, m: Membership, task: GuidedTask, scanned: string): Promise<Rejection | null> {
  try {
    const hit = await resolveBarcode(tx, m.tenantId, scanned);
    if (same(hit.itemId, task.itemId)) return null;
    const other = await tx.execute<{ code: string }>(sql`SELECT code FROM public.items WHERE tenant_id = ${m.tenantId}::uuid AND id = ${hit.itemId}::uuid`);
    return reject("WRONG_ITEM", other[0]?.code ?? scanned.trim(), task.itemCode);
  } catch (e) {
    if (e instanceof BarcodeNotFoundError) return reject("UNKNOWN_CODE", scanned.trim());
    throw e; // BARCODE_AMBIGUOUS vb. kendi koduyla döner
  }
}

async function verifyTarget(tx: AccessTx, m: Membership, task: GuidedTask, scanned: string): Promise<{ rejection: Rejection } | { locationId: string }> {
  let code: string;
  try {
    code = normalizeCode(scanned);
  } catch {
    return { rejection: reject("UNKNOWN_CODE", scanned.trim()) }; // raf kodu biçimine uymayan okutma
  }
  const loc = await findLocationInWarehouse(tx, m, task.warehouseId, code);
  if (loc === null) return { rejection: reject("UNKNOWN_CODE", code) };
  if (loc.status !== "ACTIVE") return { rejection: reject("LOCATION_ARCHIVED", loc.code, null, loc.kind) };
  if (same(loc.id, task.sourceLocationId)) return { rejection: reject("SAME_AS_SOURCE", loc.code, null, loc.kind) };
  if (loc.kind !== "STORAGE") return { rejection: reject("NOT_STORAGE", loc.code, null, loc.kind) }; // A-305-8: hedef STORAGE olmalı, başka kısıt yok
  return { locationId: loc.id };
}

// ---------------------------------------------------------------------------------------------
// Adım kaydı
// ---------------------------------------------------------------------------------------------

/**
 * Okutulan kodu/miktarı sunucuda doğrular; doğruysa ilerleme bir sonraki adıma geçer, yanlışsa `accepted: false` döner ve ilerleme DEĞİŞMEZ (`stock.post`).
 * Sıra dışı gönderim `VALIDATION_FAILED`/`DOCUMENT_STATE`; `expectedVersion` (görev sürümü) uyuşmazsa `VERSION_CONFLICT`. Önceki adımın yeniden gönderimi
 * (yanıt kaybı) doğrulanır ve ilerlemeyi değiştirmez; hedef raf ENTER_QUANTITY/CONFIRM adımında yeniden okutularak DEĞİŞTİRİLEBİLİR.
 */
export async function recordTaskStep(params: TaskProgressCallParams, input: unknown): Promise<RecordStepResult> {
  const p = parseRecordStepInput(input);
  return runTenantCommand({ ...params, permission: "stock.post" }, async (tx, m) => {
    const task = await loadOwnTask(tx, m, p.taskId, true);
    assertWritable(task, p.expectedVersion);
    let row = await readProgress(tx, m, p.taskId, true);
    if (row !== undefined && !isValid(task, row, m)) {
      await deleteProgress(tx, m, p.taskId); // eski atama/sürümden kalan ilerleme: baştan başla
      row = undefined;
    }
    const current: TaskProgressStep = row === undefined ? "SCAN_ITEM" : row.step;
    if (current === "SAVING" || RANK[p.step] > RANK[current]) throw documentState();
    const unchanged = (rej: Rejection): RecordStepResult => ({ accepted: false, code: "VALIDATION_FAILED", ...rej, progress: viewOf(task, row, true) });

    if (p.step === "SCAN_ITEM") {
      const rej = await verifyItem(tx, m, task, p.scannedCode ?? "");
      if (rej !== null) return unchanged(rej);
      if (row === undefined) {
        await tx.execute(
          sql`INSERT INTO public.warehouse_task_progress (tenant_id, task_id, membership_id, task_version, step, item_id)
              VALUES (${m.tenantId}::uuid, ${p.taskId}::uuid, ${m.membershipId}::uuid, ${task.version}, 'SCAN_TARGET', ${task.itemId}::uuid)`,
        );
      }
    } else if (p.step === "SCAN_TARGET") {
      const r = await verifyTarget(tx, m, task, p.scannedCode ?? "");
      if ("rejection" in r) return unchanged(r.rejection);
      const next = current === "SCAN_TARGET" ? "ENTER_QUANTITY" : current;
      await tx.execute(
        sql`UPDATE public.warehouse_task_progress SET step = ${next}, location_id = ${r.locationId}::uuid, updated_at = now()
             WHERE tenant_id = ${m.tenantId}::uuid AND task_id = ${p.taskId}::uuid`,
      );
    } else {
      const entered = p.quantity ?? "";
      if (decimalToMicro(entered) !== decimalToMicro(task.quantity)) return unchanged(reject("WRONG_QUANTITY", plainDecimal(entered), plainDecimal(task.quantity))); // A-305-7: birebir
      if (current === "ENTER_QUANTITY") {
        await tx.execute(
          sql`UPDATE public.warehouse_task_progress SET step = 'CONFIRM', quantity = ${microToDecimal(decimalToMicro(task.quantity))}::numeric, updated_at = now()
               WHERE tenant_id = ${m.tenantId}::uuid AND task_id = ${p.taskId}::uuid`,
        );
      }
    }
    const after = await readProgress(tx, m, p.taskId, false);
    return { accepted: true, progress: viewOf(task, after, true) };
  });
}

// ---------------------------------------------------------------------------------------------
// Kaydet
// ---------------------------------------------------------------------------------------------

interface SaveContext {
  readonly clientKey: string;
  readonly sourceLocationId: string;
  readonly targetLocationId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly progress: TaskProgressView;
}

async function beginSaveInTx(tx: AccessTx, m: Membership, taskId: string, expectedVersion: number | null): Promise<SaveContext> {
  const task = await loadOwnTask(tx, m, taskId, true);
  if (task.status === "CANCELLED") throw documentState();
  const row = await readProgress(tx, m, taskId, true);
  if (task.status === "DONE") {
    // Yanıt kaybı: kayıt zaten yapıldı (görev DONE) ve anahtar bu üyeliğin SAVING satırında duruyor → AYNI anahtarla yeniden gönderim `putaway`'in saklı sonucunu
    // (replayed) döndürür; yeni etki yok. Başka bir yolla DONE olmuşsa (anahtar eşleşmez) `putaway` kendi denetimiyle reddeder (DOCUMENT_STATE).
    if (row !== undefined && row.step === "SAVING" && same(row.membership_id, m.membershipId) && row.location_id !== null && row.quantity !== null && row.save_client_key !== null) {
      return {
        clientKey: row.save_client_key,
        sourceLocationId: task.sourceLocationId,
        targetLocationId: row.location_id,
        itemId: task.itemId,
        quantity: microToDecimal(decimalToMicro(task.quantity)),
        progress: viewOf(task, row, false),
      };
    }
    throw documentState();
  }
  assertWritable(task, expectedVersion);
  if (!isValid(task, row, m)) throw documentState(); // ilerleme yok ya da eski atama/sürümden kalmış: adımlar baştan (satırı sonraki yazım siler)
  if ((row.step !== "CONFIRM" && row.step !== "SAVING") || row.location_id === null || row.quantity === null) throw documentState(); // adımlar tamam değil
  let key = row.save_client_key;
  if (row.step === "CONFIRM") {
    key = randomUUID();
    await tx.execute(
      sql`UPDATE public.warehouse_task_progress SET step = 'SAVING', save_client_key = ${key}::uuid, updated_at = now()
           WHERE tenant_id = ${m.tenantId}::uuid AND task_id = ${taskId}::uuid`,
    );
  }
  if (key === null) throw new AppError("INTERNAL"); // CHECK (SAVING ⇔ anahtar) ile olamaz
  const after = await readProgress(tx, m, taskId, false);
  return {
    clientKey: key,
    sourceLocationId: task.sourceLocationId,
    targetLocationId: row.location_id,
    itemId: task.itemId,
    quantity: microToDecimal(decimalToMicro(task.quantity)),
    progress: viewOf(task, after, true),
  };
}

/**
 * Kaydet adımına geçer (`stock.post`): istemci anahtarını ÖNCE ilerlemeye yazar (SAVING) ve döndürür; zaten SAVING ise AYNI anahtarı döndürür
 * (yeniden gönderim). Stok değişmez. Adımlar tamam değilse `VALIDATION_FAILED`/`DOCUMENT_STATE`.
 */
export async function beginSave(
  params: TaskProgressCallParams,
  input: { readonly taskId: string; readonly expectedVersion?: number },
): Promise<{ readonly clientKey: string; readonly progress: TaskProgressView }> {
  const { taskId, expectedVersion } = parseTaskOnly(input, ["expectedVersion"]);
  const ctx = await runTenantCommand({ ...params, permission: "stock.post" }, (tx, m) => beginSaveInTx(tx, m, taskId, expectedVersion));
  return { clientKey: ctx.clientKey, progress: ctx.progress };
}

/**
 * Yerleştirmeyi ilerlemedeki doğrulanmış değerlerle kaydeder: `beginSave` (anahtar ilerlemede KALICI) → `putaway` AYNI anahtarla (ADR-018). İstemci anahtar,
 * lokasyon, ürün ya da miktar GÖNDERMEZ; hepsi sunucudaki ilerlemeden/görevden gelir. Yanıt kaybolur/hata olursa aynı çağrı tekrarlanır: aynı anahtar → tek defter
 * etkisi (`replayed`). `putaway` görevi aynı transaction'da `DONE` yapar; ilerleme satırı sonradan `nextTaskFor` ile (ya da eski/geçersiz olarak) silinir.
 */
export async function savePutawayTask(
  params: Omit<StockDocCallParams, "clientKey">,
  input: { readonly taskId: string; readonly expectedVersion?: number; readonly requestId?: string | null },
): Promise<{ readonly replayed: boolean }> {
  const { taskId, expectedVersion } = parseTaskOnly({ taskId: input.taskId, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) }, ["expectedVersion"]);
  const ctx = await runTenantCommand(
    { db: params.db, principal: params.principal, tenantSlug: params.tenantSlug, permission: "stock.post", ...(params.timeouts === undefined ? {} : { timeouts: params.timeouts }) },
    (tx, m) => beginSaveInTx(tx, m, taskId, expectedVersion),
  );
  const r = await putaway(
    { ...params, clientKey: ctx.clientKey },
    {
      taskId,
      sourceLocationId: ctx.sourceLocationId,
      targetLocationId: ctx.targetLocationId,
      itemId: ctx.itemId,
      quantity: ctx.quantity,
      requestId: input.requestId ?? null,
    },
  );
  return { replayed: r.replayed };
}

/** Baştan başla (`stock.post`): ilerleme satırını siler (yeni Kaydet yeni anahtar alır). Atanan olmayan `FORBIDDEN`; sonlanmış görev `DOCUMENT_STATE`. */
export async function resetTaskProgress(params: TaskProgressCallParams, input: { readonly taskId: string }): Promise<TaskProgressView> {
  const { taskId } = parseTaskOnly(input);
  return runTenantCommand({ ...params, permission: "stock.post" }, async (tx, m) => {
    const task = await loadOwnTask(tx, m, taskId, true);
    assertWritable(task, null);
    await deleteProgress(tx, m, taskId);
    return viewOf(task, undefined, false);
  });
}

// ---------------------------------------------------------------------------------------------
// Sıradaki görev (A-293-2)
// ---------------------------------------------------------------------------------------------

export interface NextTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly version: number;
  readonly warehouseId: string;
  readonly groupId: string | null;
}

/**
 * Sıradaki görev (A-293-2; `stock.post`): bana atanmış (`ASSIGNED`), `afterTaskId` ile aynı depoda, rehberli akışı olan türde, ilk görev; önce `afterTaskId` ile AYNI
 * `group_id`, sonra `listMyTasks` sırası (created_at, id). Üstlenilebilir `OPEN` görev otomatik üstlenilmez; yoksa `null` ("Görevlerim"e dön). `afterTaskId` verilmişse
 * o görevin bitmiş/geçersiz ilerleme satırı (bu üyeliğin) aynı transaction'da silinir. Açık istisnalı görevi atlama (A-295-1) istisna tablosu gelince (T-295) eklenir.
 */
export async function nextTaskFor(params: TaskProgressCallParams, input: { readonly afterTaskId?: string } = {}): Promise<NextTask | null> {
  const o = strictObject(input, ["afterTaskId"]);
  const afterId = o.afterTaskId === undefined ? null : uuidField(o.afterTaskId);
  return runTenantCommand({ ...params, permission: "stock.post" }, async (tx, m) => {
    let warehouseId: string | null = null;
    let groupId: string | null = null;
    if (afterId !== null) {
      const prev = await tx.execute<{ warehouse_id: string; group_id: string | null; status: string; assigned_membership_id: string | null; version: number }>(
        sql`SELECT warehouse_id, group_id, status, assigned_membership_id, version FROM public.warehouse_tasks WHERE tenant_id = ${m.tenantId}::uuid AND id = ${afterId}::uuid`,
      );
      const t = prev[0];
      if (t === undefined) throw new AppError("NOT_FOUND");
      await assertWarehouseVisible(tx, m, [t.warehouse_id]);
      if (!same(t.assigned_membership_id, m.membershipId)) throw new AppError("FORBIDDEN");
      warehouseId = t.warehouse_id;
      groupId = t.group_id;
      // Bu üyeliğin eski/bitmiş ilerleme satırı: görev DONE/CANCELLED ya da sürüm değişmişse silinir (geçerli ilerleme dokunulmaz).
      await tx.execute(
        sql`DELETE FROM public.warehouse_task_progress p
             WHERE p.tenant_id = ${m.tenantId}::uuid AND p.task_id = ${afterId}::uuid AND p.membership_id = ${m.membershipId}::uuid
               AND (${t.status} IN ('DONE', 'CANCELLED') OR p.task_version <> ${Number(t.version)})`,
      );
    }
    const scope = await resolveWarehouseScope(tx, m);
    const kinds = `{${GUIDED_TASK_KINDS.join(",")}}`;
    const rows = await tx.execute<{ id: string; kind: TaskKind; version: number; warehouse_id: string; group_id: string | null }>(
      sql`SELECT id, kind, version, warehouse_id, group_id
            FROM public.warehouse_tasks
           WHERE tenant_id = ${m.tenantId}::uuid AND status = 'ASSIGNED' AND assigned_membership_id = ${m.membershipId}::uuid
             AND kind = ANY(${kinds}::text[])
             AND (${afterId}::uuid IS NULL OR id <> ${afterId}::uuid)
             AND (${warehouseId}::uuid IS NULL OR warehouse_id = ${warehouseId}::uuid)
             AND (${scope === null}::boolean OR warehouse_id = ANY(${pgUuidArray(scope ?? [])}::uuid[]))
           ORDER BY COALESCE(group_id = ${groupId}::uuid, false) DESC, created_at, id -- NULL (grupsuz) sıralamada başa geçmesin: COALESCE
           LIMIT 1`,
    );
    const n = rows[0];
    return n === undefined ? null : { id: n.id, kind: n.kind, version: Number(n.version), warehouseId: n.warehouse_id, groupId: n.group_id };
  });
}
