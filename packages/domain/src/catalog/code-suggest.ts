// Otomatik kod önerisi (T-250; A-250-1). Yeni ürün / depo / lokasyon formunda "sıradaki kod" sunucuda hesaplanır: `<ÖNEK>-<sıra>`.
//
// - Öneri SALT OKUMADIR (kilit ve rezervasyon yok): iki istek aynı öneriyi görebilir. Çakışmasızlık yazımda sağlanır: benzersizlik
//   kısıtı son sözü söyler (`createItem`/`createWarehouse`/`createLocation` → `CODE_TAKEN`); `createWithSuggestedCode` yalnızca
//   KULLANICININ DEĞİŞTİRMEDİĞİ (otomatik) kodda çakışma olursa bir sonraki öneriyle yeniden dener. Kullanıcının yazdığı kod asla
//   sessizce değiştirilmez.
// - Sıra = aynı önekle başlayan, yalnızca rakamdan oluşan son ekin en büyüğü + 1 (arşivli kayıtlar dahil: kod arşivde de ayrılmıştır).
// - Yetki `settings.manage` (öneri yalnızca oluşturma formunun parçası); lokasyonda depo kapsamı `assertWarehouseVisible` ile denetlenir.
import { sql } from "drizzle-orm";
import { AppError } from "@wms/shared/errors";
import { runTenantQuery } from "../identity/access.ts";
import { assertWarehouseVisible } from "../warehouse/scope.ts";
import { createUnit, listUnits, parseUuid, type CatalogCommandParams } from "./units.ts";

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

/**
 * Oluşturma komutunu `code` ile çalıştırır. `auto` ise (kod kullanıcı tarafından değiştirilmedi) ve komut `CODE_TAKEN` verirse
 * sıradaki öneriyle yeniden dener (en çok {@link SUGGEST_RETRY_MAX}); aksi her hata olduğu gibi yükselir. Her deneme ayrı transaction'dır
 * (reddedilen deneme geri alınır, yarım kayıt kalmaz).
 */
export async function createWithSuggestedCode<T>(opts: {
  readonly code: string;
  readonly auto: boolean;
  readonly suggest: () => Promise<SuggestedCode>;
  readonly create: (code: string) => Promise<T>;
}): Promise<T> {
  let code = opts.code;
  for (let attempt = 0; ; attempt++) {
    try {
      return await opts.create(code);
    } catch (e) {
      if (!opts.auto || !isCodeTaken(e) || attempt >= SUGGEST_RETRY_MAX) throw e;
      code = (await opts.suggest()).code;
    }
  }
}

/** A-250-5: akıllı varsayılan birim (sektör şablonları temel birim olarak ADET önerir; onboarding/templates.ts `unitsPreview.baseUnit`). */
export const DEFAULT_UNIT = { code: "ADET", name: "Adet" } as const;

/**
 * İlk ürün için temel birim: aktif `ADET` varsa o; yoksa ve HİÇ aktif birim yoksa `ADET` oluşturulur (eşzamanlı çakışmada mevcut olan
 * okunur). Aktif birimler var ama `ADET` yoksa ilk aktif birim kullanılır. `ADET` arşivliyse ve aktif birim yoksa `VALIDATION_FAILED`
 * (arşivli birim sessizce açılmaz). Yetki `settings.manage` (createUnit/listUnits komutlarında).
 */
export async function ensureDefaultUnit(params: CatalogCommandParams): Promise<{ readonly unitId: string; readonly created: boolean }> {
  const pick = async (): Promise<string | undefined> => {
    const active = (await listUnits(params)).filter((u) => u.status === "ACTIVE");
    return (active.find((u) => u.code.toUpperCase() === DEFAULT_UNIT.code) ?? active[0])?.id;
  };
  const existing = await pick();
  if (existing !== undefined) return { unitId: existing, created: false };
  try {
    const { unitId } = await createUnit(params, DEFAULT_UNIT);
    return { unitId, created: true };
  } catch (e) {
    if (!isCodeTaken(e)) throw e;
    const again = await pick();
    if (again === undefined) throw new AppError("VALIDATION_FAILED");
    return { unitId: again, created: false };
  }
}
