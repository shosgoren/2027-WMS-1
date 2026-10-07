// Stok belgesi işleme planı (T-217; 05 §Kilit sözleşmesi, 16 §Temel kurallar 1 ve 3, I-15). SAF: veritabanı yok.
//
// Satırlardan (a) tam `StockLockPlan` boyutları/lokasyonları/serileri ve (b) defter girdileri üretilir. Satır başına:
// STOCK_IN hedef `+`; STOCK_OUT kaynak `−`; STOCK_MOVE kaynak `−` + hedef `+` (kural 3: toplam fiziksel değişmez).
// Plan SIRALIDIR ve satır sırasından bağımsızdır (ters sıralı satırlar → aynı plan); tekrarlı boyut birleşir.
//
// T-248 (A-147/A-217-1 kaldırıldı): satır kaynak durumu `stock_status`, hedef durumu `target_stock_status` (NULL = kaynakla aynı); yükleyici
// ikisini ayrı doldurur ve bu katman kaynak/hedef boyutlarını ayrı anahtarlar. Durum geçişi yalnız STOCK_MOVE'da ve izinli çiftlerdedir (A-248-1).
import { AppError } from "@wms/shared/errors";
import type { StockDimensionKey } from "@wms/db";

export type PostingKind = "STOCK_IN" | "STOCK_OUT" | "STOCK_MOVE" | "COUNT_ADJUSTMENT";
export type PostingStatus = StockDimensionKey["stockStatus"];
/** 16 kural 4 + A-79: bu kartta yalnızca belge türünden türeyen nedenler. */
export type LedgerReason = "RECEIPT" | "SHIPMENT" | "MOVE" | "COUNT_DIFF";

/**
 * A-248-1 (Q-49; 16 kural 3 yalnız "durum değişimi = −/+ çifti" der, geçiş matrisi tanımsızdır): fail-closed beyaz liste — yalnızca kalite onayı
 * (QUARANTINE→AVAILABLE) ve karantinaya alma (AVAILABLE→QUARANTINE). DAMAGED/BLOCKED'a ya da DAMAGED/BLOCKED'dan geçiş, matris netleşene dek reddedilir
 * (hasarlı stok hiçbir zaman kullanılabilir sayılmaz; Senaryo A varyantı).
 */
export const ALLOWED_STATUS_TRANSITION_PAIRS: readonly (readonly [PostingStatus, PostingStatus])[] = [
  ["QUARANTINE", "AVAILABLE"],
  ["AVAILABLE", "QUARANTINE"],
];
// T-258: aynı liste DB'de `0020_target_status_guard` tetikleyicisinde sabittir; eşitlik posting.int.test.ts'te 4x4 çift üzerinden doğrulanır.
const ALLOWED_STATUS_TRANSITIONS: ReadonlySet<string> = new Set(ALLOWED_STATUS_TRANSITION_PAIRS.map(([a, b]) => `${a}>${b}`));
export const isStatusTransitionAllowed = (from: PostingStatus, to: PostingStatus): boolean => from === to || ALLOWED_STATUS_TRANSITIONS.has(`${from}>${to}`);

export const REASON_BY_KIND: Readonly<Record<PostingKind, LedgerReason>> = {
  STOCK_IN: "RECEIPT",
  STOCK_OUT: "SHIPMENT",
  STOCK_MOVE: "MOVE",
  // T-309 (A-79, 16 kural 4): sayım farkı. `−` satır yalnız kaynak, `+` satır yalnız hedef lokasyonla (ADR-021 §3); durum değişimi yoktur.
  COUNT_ADJUSTMENT: "COUNT_DIFF",
};

/** Belge satırının işleme görünümü. Miktar = `base_quantity` (I-09: dönüşüm satırdaki kopyadan). */
export interface PostingLine {
  readonly lineId: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly quantity: string;
  readonly conversionFactor: string;
  readonly baseQuantity: string;
  readonly sourceLocationId: string | null;
  readonly targetLocationId: string | null;
  readonly lotId: string | null;
  readonly serialId: string | null;
  readonly sourceStatus: PostingStatus;
  readonly targetStatus: PostingStatus;
  readonly inventoryOwnerId: string | null;
  readonly handlingUnitId: string | null;
}

export interface LedgerEntry {
  readonly lineId: string;
  readonly lineNo: number;
  readonly key: StockDimensionKey;
  /** İşaretli, 1e-6 ölçekli tam sayı. */
  readonly delta: bigint;
  readonly reason: LedgerReason;
}

export interface PostingPlan {
  readonly entries: readonly LedgerEntry[];
  /** Tekil, artan sıralı boyut anahtarları (kilit planı). */
  readonly dimensions: readonly StockDimensionKey[];
  readonly locationIds: readonly string[];
  readonly serialIds: readonly string[];
  /** Boyut kimliği (`dimensionIdentity`) → toplam çıkış (pozitif). */
  readonly outTotals: ReadonlyMap<string, bigint>;
  /** Boyut kimliği → net değişim. */
  readonly net: ReadonlyMap<string, bigint>;
}

// --- decimal (I-09; float yok) -------------------------------------------------------------------------------------------
const MICRO = 1_000_000n;
const DECIMAL_RE = /^(-?)(\d{1,14})(?:\.(\d{1,6}))?$/;

/** `numeric(20,6)` metnini 1e-6 ölçekli tam sayıya çevirir. Geçersiz biçim `VALIDATION_FAILED`. */
export function toMicro(text: string): bigint {
  const m = typeof text === "string" ? DECIMAL_RE.exec(text) : null;
  if (m === null) throw new AppError("VALIDATION_FAILED");
  const whole = BigInt(m[2] as string) * MICRO;
  const frac = BigInt(((m[3] ?? "") + "000000").slice(0, 6));
  return m[1] === "-" ? -(whole + frac) : whole + frac;
}

export function fromMicro(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "-" : ""}${(a / MICRO).toString()}.${(a % MICRO).toString().padStart(6, "0")}`;
}

// --- anahtar sırası (locking.ts ile birebir aynı sıra; yalnızca deterministik plan için) -----------------------------------
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpNullsFirst = (a: string | null, b: string | null): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return cmp(a, b);
};
export const compareDimensionKeys = (a: StockDimensionKey, b: StockDimensionKey): number =>
  cmp(a.itemId, b.itemId) ||
  cmp(a.locationId, b.locationId) ||
  cmpNullsFirst(a.lotId, b.lotId) ||
  cmpNullsFirst(a.serialId, b.serialId) ||
  cmp(a.stockStatus, b.stockStatus) ||
  cmpNullsFirst(a.inventoryOwnerId, b.inventoryOwnerId) ||
  cmpNullsFirst(a.handlingUnitId, b.handlingUnitId);

export const dimensionIdentity = (k: StockDimensionKey): string =>
  [k.itemId, k.locationId, k.lotId ?? "", k.serialId ?? "", k.stockStatus, k.inventoryOwnerId ?? "", k.handlingUnitId ?? ""].join("|");

const lower = (v: string | null): string | null => (v === null ? null : v.toLowerCase());

function key(line: PostingLine, locationId: string, status: PostingStatus): StockDimensionKey {
  return {
    itemId: line.itemId.toLowerCase(),
    locationId: locationId.toLowerCase(),
    lotId: lower(line.lotId),
    serialId: lower(line.serialId),
    stockStatus: status,
    inventoryOwnerId: lower(line.inventoryOwnerId),
    handlingUnitId: lower(line.handlingUnitId),
  };
}

const invalid = (): AppError => new AppError("VALIDATION_FAILED");

/**
 * Satır biçimi + plan. Biçim ihlali (kaynak/hedef lokasyonun türle uyuşmaması, boş hareket) `VALIDATION_FAILED`.
 * IN: yalnız hedef; OUT: yalnız kaynak; MOVE: ikisi de ve kaynak boyut ≠ hedef boyut.
 */
export function buildPostingPlan(kind: PostingKind, lines: readonly PostingLine[]): PostingPlan {
  const entries: LedgerEntry[] = [];
  const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  for (const line of ordered) {
    const qty = toMicro(line.baseQuantity);
    if (qty <= 0n) throw invalid();
    const reason = REASON_BY_KIND[kind];
    const { sourceLocationId: src, targetLocationId: dst } = line;
    // Hedef durum yalnız STOCK_MOVE'da anlamlıdır (IN/OUT tek uçlu); aksi kaynak ≠ hedef durum sessizce yanlış boyuta yazardı.
    if (kind !== "STOCK_MOVE" && line.sourceStatus !== line.targetStatus) throw invalid();
    if (kind === "STOCK_IN") {
      if (dst === null || src !== null) throw invalid();
      entries.push({ lineId: line.lineId, lineNo: line.lineNo, key: key(line, dst, line.targetStatus), delta: qty, reason });
    } else if (kind === "COUNT_ADJUSTMENT") {
      // Satır başına tek uç: yalnız kaynak = eksik sayım (−), yalnız hedef = fazla sayım (+). İkisi de dolu ya da boş → biçim ihlali.
      if ((src === null) === (dst === null)) throw invalid();
      entries.push(
        src !== null
          ? { lineId: line.lineId, lineNo: line.lineNo, key: key(line, src, line.sourceStatus), delta: -qty, reason }
          : { lineId: line.lineId, lineNo: line.lineNo, key: key(line, dst as string, line.targetStatus), delta: qty, reason },
      );
    } else if (kind === "STOCK_OUT") {
      if (src === null || dst !== null) throw invalid();
      entries.push({ lineId: line.lineId, lineNo: line.lineNo, key: key(line, src, line.sourceStatus), delta: -qty, reason });
    } else {
      if (src === null || dst === null) throw invalid();
      if (!isStatusTransitionAllowed(line.sourceStatus, line.targetStatus)) throw invalid();
      const from = key(line, src, line.sourceStatus);
      const to = key(line, dst, line.targetStatus);
      if (dimensionIdentity(from) === dimensionIdentity(to)) throw invalid(); // boş hareket: lokasyon da durum da değişmiyor
      entries.push({ lineId: line.lineId, lineNo: line.lineNo, key: from, delta: -qty, reason });
      entries.push({ lineId: line.lineId, lineNo: line.lineNo, key: to, delta: qty, reason });
    }
  }
  const byIdentity = new Map<string, StockDimensionKey>();
  const outTotals = new Map<string, bigint>();
  const net = new Map<string, bigint>();
  for (const e of entries) {
    const id = dimensionIdentity(e.key);
    byIdentity.set(id, e.key);
    net.set(id, (net.get(id) ?? 0n) + e.delta);
    if (e.delta < 0n) outTotals.set(id, (outTotals.get(id) ?? 0n) - e.delta);
  }
  const dimensions = [...byIdentity.values()].sort(compareDimensionKeys);
  const locationIds = [...new Set(dimensions.map((d) => d.locationId))].sort(cmp);
  const serialIds = [...new Set(dimensions.flatMap((d) => (d.serialId === null ? [] : [d.serialId])))].sort(cmp);
  return { entries, dimensions, locationIds, serialIds, outTotals, net };
}

// --- rezervasyon talep kaynağı (T-306; ADR-017 §7, ADR-021 §4) --------------------------------------------------------------
/**
 * Rezervasyonun talep kaynağı: belge satırı YA DA sipariş satırı (DB: `reservations_source_xor_chk`, tam olarak biri dolu). Ayrımlı birleşim: iki
 * kimlik sütunu ayrı alanlar olarak taşınmaz, böylece ikisini karıştırmak ya da ikisini birden vermek tip düzeyinde mümkün değildir.
 */
export type ReservationSource =
  | { readonly kind: "DOCUMENT_LINE"; readonly lineId: string }
  | { readonly kind: "ORDER_LINE"; readonly lineId: string };

/** `reservations` sütun çifti (INSERT için): biri dolu, diğeri `null`. */
export function sourceColumns(s: ReservationSource): { readonly document_line_id: string | null; readonly order_line_id: string | null } {
  return s.kind === "DOCUMENT_LINE" ? { document_line_id: s.lineId, order_line_id: null } : { document_line_id: null, order_line_id: s.lineId };
}

// --- rezervasyon bölüştürme (T-221; saf) ----------------------------------------------------------------------------------
/** Bir rezervasyon dilimi: kimlik + aktif miktar (1e-6 ölçekli). */
export interface ReservationSlice {
  readonly id: string;
  readonly quantity: bigint;
}
/** Bir rezervasyondan alınan pay. `rest` = alındıktan sonra aktif kalan (0 ⇒ tamamı kapanır). */
export interface ReservationTake {
  readonly id: string;
  readonly take: bigint;
  readonly rest: bigint;
}

/**
 * `amount` miktarını dilimlere KİMLİĞE GÖRE ARTAN sırayla dağıtır (deterministik; kilit sırasıyla aynı). Her dilimden en çok kendi miktarı alınır;
 * pay 0 olan dilim listeye girmez. Toplam yetmezse ya da `amount ≤ 0` ise `VALIDATION_FAILED` (sessiz kısaltma yok).
 */
export function allocateAcross(slices: readonly ReservationSlice[], amount: bigint): ReservationTake[] {
  if (amount <= 0n) throw invalid();
  const out: ReservationTake[] = [];
  let left = amount;
  for (const s of [...slices].sort((a, b) => cmp(a.id, b.id))) {
    if (left === 0n) break;
    if (s.quantity <= 0n) continue;
    const take = s.quantity < left ? s.quantity : left;
    out.push({ id: s.id, take, rest: s.quantity - take });
    left -= take;
  }
  if (left !== 0n) throw invalid();
  return out;
}

/** Satır başına rezervasyon üst sınırı (05 §Rezervasyon: toplam ≤ satır miktarı): kalan tahsis edilebilir miktar (negatif olamaz). */
export function remainingToReserve(lineBaseQuantity: bigint, activeReserved: bigint): bigint {
  const r = lineBaseQuantity - activeReserved;
  return r < 0n ? 0n : r;
}

/**
 * Yeterlilik görünümü için rezerve düzeltmesi (16 kural 5 + T-221 madde 4): işlenen satırın KENDİ rezervasyonu o boyutun
 * `reserved`'ından düşülür, böylece `quantity − (reserved − kendi rezervasyonu) ≥ çıkış`. Negatife inemez.
 */
export function reservedExcluding(reserved: bigint, own: bigint): bigint {
  if (own < 0n) throw invalid();
  // Satırın kendi rezervasyonu boyutun rezerve toplamından büyük olamaz (DB denetimi Σ ACTIVE = reserved): bütünlük ihlali, sessiz kırpma yok.
  if (own > reserved) throw new AppError("INTERNAL");
  return reserved - own;
}
