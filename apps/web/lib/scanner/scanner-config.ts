// DataWedge/okuyucu profili değerleri — TEK YER (A-143, Q-12: pilot cihazında doğrulanana dek varsayım).
// Profil: önek STX, sonek Enter, tuşlar arası eşik 30 ms, GS1 ayracı yer tutucusu `~`.
import { GS } from "@wms/domain/catalog/gs1";

export const SCANNER_CONFIG = {
  /** `KeyboardEvent.key` olarak görülen sabit önek (STX). */
  prefix: "\u0002",
  /** Tamponu kapatan tuş (`KeyboardEvent.key`). */
  suffix: "Enter",
  /** Ardışık iki tuş arası en çok süre (ms); aşılırsa tampon atılır ve tarama sayılmaz. */
  interKeyThresholdMs: 30,
  /** Profildeki görünür GS1 ayracı yer tutucusu; ayrıştırıcıya GS (U+001D) olarak verilir. */
  gs1Placeholder: "~",
  gs1Separator: GS,
  /** Beklenmedik uzun tampon (bozuk profil) atılır. */
  maxLength: 256,
} as const;

export interface ScannerConfig {
  readonly prefix: string;
  readonly suffix: string;
  readonly interKeyThresholdMs: number;
  readonly gs1Placeholder: string;
  readonly gs1Separator: string;
  readonly maxLength: number;
}
