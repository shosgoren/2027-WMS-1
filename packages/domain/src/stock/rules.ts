// Stok belgesi işleme kuralları (T-217; 05 §İşlem sözleşmesi adım 5, 16 kural 5, I-05, I-09, AC-09). SAF: `LockedState`'ten türetilmiş
// düz verilerle çalışır; kilit/okuma `posting.ts`'tedir. Kodlar: 15 §Hata kodları.
//   - Yeterlilik: çıkış boyutunda `quantity − reserved_quantity ≥ toplam çıkış`, aksi `INSUFFICIENT_STOCK` (negatif stok yok; istisna yolu YOK).
//     A-217-2: aynı belgedeki girişler çıkışı karşılamaz (kuralın metni; satır sırasından bağımsız, muhafazakâr).
//   - Arşivli ürün/lokasyon → `VALIDATION_FAILED`/`IN_USE`; STOCK_OUT kaynağı RECEIVING iken izinli (lokasyon türü kısıtı yok; sevk niteliği 3A).
//   - Miktar ölçeği (`QUANTITY_SCALE`), dönüşüm kopyası (I-09), takip modu (`tracking.ts`), seri tekilliği (`TRACKING_VIOLATION`).
//   - A-145: satır lokasyonları belgenin deposunda olmalı (`VALIDATION_FAILED`).
import { AppError } from "@wms/shared/errors";
import { toMicro, type PostingLine, type PostingPlan } from "./plan.ts";
import { assertTracking, type TrackingMode } from "./tracking.ts";

export interface ItemInfo {
  readonly id: string;
  readonly status: string;
  readonly trackingMode: TrackingMode;
  readonly quantityScale: number;
}
export interface LocationInfo {
  readonly id: string;
  readonly warehouseId: string;
  readonly status: string;
}
export interface SerialInfo {
  readonly id: string;
  readonly itemId: string;
  readonly lotId: string | null;
}

const MICRO_DIGITS = 6;

export const inUse = (): AppError => new AppError("VALIDATION_FAILED", { detail: "IN_USE" });

/** Satır düzeyi kurallar (sıra: arşiv → depo → ölçek → dönüşüm → takip). */
export function assertLineRules(
  lines: readonly PostingLine[],
  documentWarehouseId: string,
  items: ReadonlyMap<string, ItemInfo>,
  locations: ReadonlyMap<string, LocationInfo>,
  serials: ReadonlyMap<string, SerialInfo>,
): void {
  for (const line of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    const item = items.get(line.itemId.toLowerCase());
    if (item === undefined) throw new AppError("NOT_FOUND");
    if (item.status !== "ACTIVE") throw inUse();
    for (const id of [line.sourceLocationId, line.targetLocationId]) {
      if (id === null) continue;
      const loc = locations.get(id.toLowerCase());
      if (loc === undefined) throw new AppError("NOT_FOUND");
      if (loc.status !== "ACTIVE") throw inUse();
      if (loc.warehouseId.toLowerCase() !== documentWarehouseId.toLowerCase()) throw new AppError("VALIDATION_FAILED"); // A-145
    }
    const base = toMicro(line.baseQuantity);
    const divisor = 10n ** BigInt(MICRO_DIGITS - item.quantityScale);
    if (base % divisor !== 0n) throw new AppError("VALIDATION_FAILED", { detail: "QUANTITY_SCALE" });
    // I-09: base = round(quantity × factor, 6), yarım yukarı (PostgreSQL numeric round ile aynı, pozitif değerler).
    const expected = (toMicro(line.quantity) * toMicro(line.conversionFactor) + 500_000n) / 1_000_000n;
    if (expected !== base) throw new AppError("VALIDATION_FAILED");
    const serial = line.serialId === null ? undefined : serials.get(line.serialId.toLowerCase());
    if (line.serialId !== null && (serial === undefined || serial.itemId.toLowerCase() !== line.itemId.toLowerCase())) {
      throw new AppError("TRACKING_VIOLATION");
    }
    assertTracking(item.trackingMode, { lotId: line.lotId, serialId: line.serialId, quantityMicro: base }, serial === undefined ? undefined : serial.lotId);
  }
}

export interface BalanceView {
  readonly quantity: bigint;
  readonly reserved: bigint;
}

/** Yeterlilik: boyut kimliği → bakiye (kilitli görüntü). Eksik boyut 0 sayılır. */
export function assertSufficient(plan: PostingPlan, balances: ReadonlyMap<string, BalanceView>): void {
  for (const [identity, out] of plan.outTotals) {
    const b = balances.get(identity) ?? { quantity: 0n, reserved: 0n };
    if (b.quantity - b.reserved < out) throw new AppError("INSUFFICIENT_STOCK");
  }
}

/**
 * Seri tekilliği (AC-09): işlemden SONRA her seri en çok bir boyutta pozitif olmalıdır. `existing`: seri → (boyut kimliği → mevcut miktar),
 * belge dışı boyutlar dahil; `netByDimensionId`: belgenin boyut başına net değişimi (boyut kimliği = DB uuid).
 */
export function assertSerialUnique(
  existing: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  netByDimensionId: ReadonlyMap<string, bigint>,
  serialOfDimension: ReadonlyMap<string, string>,
): void {
  const serials = new Set(serialOfDimension.values());
  for (const serial of serials) {
    const final = new Map<string, bigint>(existing.get(serial) ?? []);
    for (const [dimId, s] of serialOfDimension) {
      if (s !== serial) continue;
      final.set(dimId, (final.get(dimId) ?? 0n) + (netByDimensionId.get(dimId) ?? 0n));
    }
    let positive = 0;
    for (const q of final.values()) if (q > 0n) positive += 1;
    if (positive > 1) throw new AppError("TRACKING_VIOLATION");
  }
}

