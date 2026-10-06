// Takip modu kuralları (T-217; 04 §Ürün, lot, seri, birim; AC-09). SAF.
//   NONE: lot/seri YASAK · LOT: lot zorunlu, seri yasak · SERIAL: seri zorunlu, lot yok, miktar 1 ·
//   LOT_AND_SERIAL: ikisi zorunlu, miktar 1 ve seri o lota bağlı. İhlal `TRACKING_VIOLATION`.
// DB ikinci savunmadır (0013 `stock_dimensions_check_tracking`); bu katman erken ve açık kodla reddeder.
import { AppError } from "@wms/shared/errors";

export type TrackingMode = "NONE" | "LOT" | "SERIAL" | "LOT_AND_SERIAL";
const ONE_MICRO = 1_000_000n;

export interface TrackedLine {
  readonly lotId: string | null;
  readonly serialId: string | null;
  /** Taban miktar, 1e-6 ölçekli tam sayı. */
  readonly quantityMicro: bigint;
}

const violation = (): AppError => new AppError("TRACKING_VIOLATION");

/** `serialLotId`: serinin kayıtlı lotu (seri kilidinden); seri yoksa `undefined`. */
export function assertTracking(mode: TrackingMode, line: TrackedLine, serialLotId: string | null | undefined): void {
  const wantsLot = mode === "LOT" || mode === "LOT_AND_SERIAL";
  const wantsSerial = mode === "SERIAL" || mode === "LOT_AND_SERIAL";
  if (wantsLot !== (line.lotId !== null)) throw violation();
  if (wantsSerial !== (line.serialId !== null)) throw violation();
  if (line.serialId !== null) {
    if (line.quantityMicro !== ONE_MICRO) throw violation(); // seri başına tam 1 (AC-09)
    if (serialLotId === undefined) throw violation(); // seri satırı kilitli görüntüde yok
    if ((serialLotId ?? null) !== (line.lotId === null ? null : line.lotId.toLowerCase())) throw violation();
  }
}
