// Otomatik kod önerisi (T-250; A-250-1). Yeni ürün / depo / lokasyon formunda "sıradaki kod" sunucuda hesaplanır: `<ÖNEK>-<sıra>`.
//
// - Öneri SALT OKUMADIR (kilit ve rezervasyon yok): iki istek aynı öneriyi görebilir. Çakışmasızlık yazımda sağlanır: benzersizlik
//   kısıtı son sözü söyler (`createItem`/`createWarehouse`/`createLocation` → `CODE_TAKEN`); `createWithSuggestedCode` yalnızca
//   gönderilen kod sunucunun önerdiği BİÇİMDE (`<ÖNEK>-<sıfır dolgulu sıra>`) ise ve çakışma olursa, AYNI önekle bir sonraki öneriyle
//   yeniden dener. İstemci bayrağına güvenilmez (T-259): kullanıcının yazdığı kod asla sessizce değiştirilmez.
// - Sıra = aynı önekle başlayan, yalnızca rakamdan oluşan son ekin en büyüğü + 1 (arşivli kayıtlar dahil: kod arşivde de ayrılmıştır).
// - Yetki `settings.manage` (öneri yalnızca oluşturma formunun parçası); lokasyonda depo kapsamı `assertWarehouseVisible` ile denetlenir.
import { sql } from "drizzle-orm";
import { appendAudit, type PickPolicy, type TrackingMode } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery } from "../identity/access.ts";
import { assertWarehouseVisible } from "../warehouse/scope.ts";
import { createItem } from "./items.ts";
import { parseCode, parseName, parseUuid, type CatalogCommandParams } from "./units.ts";

export const CODE_SUGGEST_KINDS = ["item", "warehouse", "location"] as const;
export type CodeSuggestKind = (typeof CODE_SUGGEST_KINDS)[number];

/** A-250-1: varsayılan önek ve sıra basamak sayısı. Kullanıcı öneki değiştirebilir (`A-Z`, `0-9`, `_`; en çok 16 karakter). */
export const CODE_SUGGEST_DEFAULTS: Readonly<Record<CodeSuggestKind, { readonly prefix: string; readonly width: number }>> = {
  item: { prefix: "URN", width: 4 },
  warehouse: { prefix: "DEPO", width: 2 },
  location: { prefix: "LOK", width: 4 },
};

const PREFIX_RE = /^[A-Z0-9_]{1,16}$/;
/** Sıra üst sınırı: `bigint` ve JS güvenli tamsayı içinde kalır. */
const SEQ_MAX_DIGITS = 12;
/** Otomatik kodda çakışma yeniden deneme sayısı (her deneme yeni transaction). */
export const SUGGEST_RETRY_MAX = 8;

export type SuggestCodeParams = Omit<CatalogCommandParams, "requestId">;

export interface SuggestCodeInput {
  readonly kind: CodeSuggestKind;
  /** `kind = "location"` için zorunlu (lokasyon kodu depo içinde benzersizdir). */
  readonly warehouseId?: string;
  /** İsteğe bağlı önek; küçük harf büyütülür. */
  readonly prefix?: string;
}

export interface SuggestedCode {
  readonly code: string;
  readonly prefix: string;
}

/** Önek biçimi: boşsa tür varsayılanı; aksi büyütülür ve `[A-Z0-9_]{1,16}` olmalıdır (`-` önekte yok: ayırıcıdır). */
export function parsePrefix(kind: CodeSuggestKind, raw: unknown): string {
  if (raw === undefined || raw === null) return CODE_SUGGEST_DEFAULTS[kind].prefix;
  if (typeof raw !== "string") throw new AppError("VALIDATION_FAILED");
  const v = raw.trim().toUpperCase();
  if (v === "") return CODE_SUGGEST_DEFAULTS[kind].prefix;
  if (!PREFIX_RE.test(v)) throw new AppError("VALIDATION_FAILED");
  return v;
}

/** `<önek>-<sıra>`; sıra en az `width` basamak sıfır dolgulu. */
export function formatSuggestedCode(prefix: string, seq: number, width: number): string {
  return `${prefix}-${String(seq).padStart(width, "0")}`;
}

/** Sıradaki boş kod. Salt okuma; eşzamanlı iki çağrı aynı kodu görebilir (bkz. dosya başlığı). */
export async function suggestCode(params: SuggestCodeParams, input: SuggestCodeInput): Promise<SuggestedCode> {
  if (!(CODE_SUGGEST_KINDS as readonly string[]).includes(input.kind)) throw new AppError("VALIDATION_FAILED");
  const kind = input.kind;
  const prefix = parsePrefix(kind, input.prefix);
  const warehouseId = kind === "location" ? parseUuid(input.warehouseId) : null;
  if (kind !== "location" && input.warehouseId !== undefined) throw new AppError("VALIDATION_FAILED");
  const lead = `${prefix}-`;
  return runTenantQuery({ ...params, permission: "settings.manage" }, async (tx, m) => {
    // Son ek yalnızca rakam ve en çok SEQ_MAX_DIGITS basamak olanlar sayılır (taşma/aşırı büyük değer sırayı bozmaz).
    const suffixRe = `^[0-9]{1,${SEQ_MAX_DIGITS}}$`;
    let rows: readonly { n: string | number | null }[];
    if (kind === "location") {
      const wh = await tx.execute<{ id: string }>(sql`SELECT id FROM public.warehouses WHERE tenant_id = ${m.tenantId}::uuid AND id = ${warehouseId}::uuid`);
      if (wh[0] === undefined) throw new AppError("NOT_FOUND");
      await assertWarehouseVisible(tx, m, [warehouseId as string]);
      rows = await tx.execute<{ n: string | number | null }>(
        sql`SELECT max(substring(code FROM ${lead.length + 1}::int)::bigint) AS n
              FROM public.locations
             WHERE tenant_id = ${m.tenantId}::uuid AND warehouse_id = ${warehouseId}::uuid
               AND left(code, ${lead.length}::int) = ${lead} AND substring(code FROM ${lead.length + 1}::int) ~ ${suffixRe}`,
      );
    } else {
      const table = kind === "item" ? sql`public.items` : sql`public.warehouses`;
      rows = await tx.execute<{ n: string | number | null }>(
        sql`SELECT max(substring(code FROM ${lead.length + 1}::int)::bigint) AS n
              FROM ${table}
             WHERE tenant_id = ${m.tenantId}::uuid
               AND left(code, ${lead.length}::int) = ${lead} AND substring(code FROM ${lead.length + 1}::int) ~ ${suffixRe}`,
      );
    }
    const max = rows[0]?.n === null || rows[0]?.n === undefined ? 0 : Number(rows[0].n);
    return { code: formatSuggestedCode(prefix, max + 1, CODE_SUGGEST_DEFAULTS[kind].width), prefix };
  });
}

function isCodeTaken(e: unknown): boolean {
  return e instanceof AppError && e.code === "VALIDATION_FAILED" && e.detail === "CODE_TAKEN";
}

const SUGGESTED_SHAPE_RE = /^([A-Z0-9_]{1,16})-([0-9]{1,12})$/;

/**
 * Kod, sunucunun üreteceği biçimde mi (`<ÖNEK>-<sıra>`, sıra tür için kanonik dolguyla)? Evetse öneki döner; hayırsa `null`.
 * Kullanıcının elle yazdığı `urn-1`, `URN-1`, `URN-0001-X`, `ABC` gibi kodlar eşleşmez (kanonik dolgu `URN-0001`).
 */
export function suggestedCodePrefix(kind: CodeSuggestKind, code: string): string | null {
  const m = SUGGESTED_SHAPE_RE.exec(code);
  if (m === null) return null;
  const prefix = m[1] as string;
  return code === formatSuggestedCode(prefix, Number(m[2]), CODE_SUGGEST_DEFAULTS[kind].width) ? prefix : null;
}

/**
 * Oluşturma komutunu `code` ile çalıştırır. `auto` istemci beyanıdır ve TEK BAŞINA yetmez: `CODE_TAKEN`ta yeniden deneme yalnızca `code`
 * sunucunun önerdiği biçimdeyse ({@link suggestedCodePrefix}) yapılır ve gönderilen önekle (`suggest(prefix)`) sıradaki kodu alır
 * (en çok {@link SUGGEST_RETRY_MAX}); aksi her hata olduğu gibi (`CODE_TAKEN`) yükselir. Her deneme ayrı transaction'dır
 * (reddedilen deneme geri alınır, yarım kayıt kalmaz).
 */
export async function createWithSuggestedCode<T>(opts: {
  readonly kind: CodeSuggestKind;
  readonly code: string;
  readonly auto: boolean;
  readonly suggest: (prefix: string) => Promise<SuggestedCode>;
  readonly create: (code: string) => Promise<T>;
}): Promise<T> {
  const prefix = opts.auto ? suggestedCodePrefix(opts.kind, opts.code) : null;
  let code = opts.code;
  for (let attempt = 0; ; attempt++) {
    try {
      return await opts.create(code);
    } catch (e) {
      if (prefix === null || !isCodeTaken(e) || attempt >= SUGGEST_RETRY_MAX) throw e;
      code = (await opts.suggest(prefix)).code;
    }
  }
}

/** A-250-5: akıllı varsayılan birim (sektör şablonları temel birim olarak ADET önerir; onboarding/templates.ts `unitsPreview.baseUnit`). */
export const DEFAULT_UNIT = { code: "ADET", name: "Adet" } as const;

const TRACKING: readonly TrackingMode[] = ["NONE", "LOT", "SERIAL", "LOT_AND_SERIAL"];
const PICK: readonly PickPolicy[] = ["FIFO", "FEFO"];

export interface CreateItemWithDefaultUnitInput {
  readonly code: string;
  readonly name: string;
  /** Verilmezse sunucu aynı transaction'da varsayılan birimi çözer (aşağıya bakın). */
  readonly baseUnitId?: string;
  readonly trackingMode?: TrackingMode;
  readonly quantityScale?: number;
  readonly pickPolicy?: PickPolicy;
}

/**
 * Ürünü oluşturur; `baseUnitId` yoksa varsayılan birim ile ürün TEK transaction'dadır (T-259 MINOR-3/4): ürün reddedilirse (ör. `CODE_TAKEN`)
 * yeni açılan `ADET` de geri alınır. Birim çözümü: aktif `ADET` varsa o; HİÇ aktif birim yoksa `ADET` oluşturulur (eşzamanlı çakışmada
 * mevcut olan okunur); aktif birimler var ama `ADET` yoksa SESSİZ SEÇİM YOK → `VALIDATION_FAILED` (kullanıcı birim seçmeli); `ADET`
 * arşivliyse ve aktif birim yoksa `VALIDATION_FAILED` (arşivli birim sessizce açılmaz). Yetki `settings.manage`.
 * `baseUnitId` verilmişse davranış `createItem` ile aynıdır (yetki + birim durumu orada denetlenir).
 */
export async function createItemWithDefaultUnit(
  params: CatalogCommandParams,
  input: CreateItemWithDefaultUnitInput,
): Promise<{ readonly itemId: string; readonly unitId: string; readonly unitCreated: boolean }> {
  if (input.baseUnitId !== undefined) {
    const { itemId } = await createItem(params, { ...input, baseUnitId: input.baseUnitId });
    return { itemId, unitId: parseUuid(input.baseUnitId), unitCreated: false };
  }
  const code = parseCode(input.code);
  const name = parseName(input.name);
  const trackingMode = input.trackingMode ?? "NONE";
  if (!TRACKING.includes(trackingMode)) throw new AppError("VALIDATION_FAILED");
  const quantityScale = input.quantityScale ?? 0;
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 6) throw new AppError("VALIDATION_FAILED");
  const pickPolicy = input.pickPolicy ?? "FIFO";
  if (!PICK.includes(pickPolicy)) throw new AppError("VALIDATION_FAILED");
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const activeAdet = async (): Promise<{ readonly id: string | undefined; readonly anyActive: boolean }> => {
      const active = await tx.execute<{ id: string; code: string }>(
        sql`SELECT id, code FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND status = 'ACTIVE' ORDER BY code`,
      );
      return { id: active.find((u) => u.code.toUpperCase() === DEFAULT_UNIT.code)?.id, anyActive: active.length > 0 };
    };
    let unitCreated = false;
    let found = await activeAdet();
    if (found.id === undefined) {
      if (found.anyActive) throw new AppError("VALIDATION_FAILED"); // aktif birim var, ADET yok: sessiz seçim yok
      const ins = await tx.execute<{ id: string }>(
        sql`INSERT INTO public.units (tenant_id, id, code, name)
            VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${DEFAULT_UNIT.code}, ${DEFAULT_UNIT.name})
            ON CONFLICT ON CONSTRAINT units_tenant_code_key DO NOTHING
            RETURNING id`,
      );
      if (ins[0] !== undefined) {
        unitCreated = true;
        await appendAudit(tx, {
          action: "unit.created",
          actorUserId: actor.userId,
          entityType: "unit",
          entityId: ins[0].id,
          requestId: requestId ?? null,
          changeSummary: { code: DEFAULT_UNIT.code, name: DEFAULT_UNIT.name },
        });
        found = { id: ins[0].id, anyActive: true };
      } else {
        found = await activeAdet(); // eşzamanlı oluşturan commit etti ya da ADET arşivli
        if (found.id === undefined) throw new AppError("VALIDATION_FAILED");
      }
    }
    const unitId = found.id as string;
    // T-273 (T-259 MINOR): ADET satırı `FOR SHARE` ile kilitlenip durum KİLİT ALTINDA yeniden doğrulanır. Düz okuma + items INSERT'inin FK kilidi
    // (`FOR KEY SHARE`) birimin `status` güncellemesiyle çakışmaz; arşivleyen işlem araya girerse ürün arşivli birimle oluşurdu. `FOR SHARE`
    // arşivleyenin satır kilidini bekler/bekletir; arşiv commit olmuşsa (READ COMMITTED) güncel durum görülür.
    const locked = await tx.execute<{ status: string }>(
      sql`SELECT status FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${unitId}::uuid FOR SHARE`,
    );
    if (locked[0]?.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale, pick_policy)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${code}, ${name}, ${unitId}::uuid, ${trackingMode},
                  ${quantityScale}::smallint, ${pickPolicy})
          ON CONFLICT ON CONSTRAINT items_tenant_code_key DO NOTHING
          RETURNING id`,
    );
    const itemId = rows[0]?.id;
    if (itemId === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "item.created",
      actorUserId: actor.userId,
      entityType: "item",
      entityId: itemId,
      requestId: requestId ?? null,
      changeSummary: { code, name, base_unit_id: unitId, tracking_mode: trackingMode, quantity_scale: quantityScale, pick_policy: pickPolicy },
    });
    return { itemId, unitId, unitCreated };
  });
}
