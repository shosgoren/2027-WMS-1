// ScannerService (ADR-010): ekranlar yalnızca `onScan(value, source)` dinler; kaynaklar (keystroke, ileride
// kamera) servis arkasındadır. Tek etkin dinleyici: yeni abonelik eskisini bırakır (ekran değişimi).
import { parseGs1 } from "@wms/domain/catalog/gs1";
import type { Gs1Result } from "@wms/domain/catalog/gs1";

// Çekirdek (sınıf ve tipler) `scanner-core.ts`'e taşındı (T-313: istemci grafı); burada yeniden dışa verilir, mevcut içe aktarımlar değişmez.
export { ScannerService } from "./scanner-core.ts";
export type { ScanHandler, ScanSource, ScannerSource, Unsubscribe } from "./scanner-core.ts";

/** Okunan değeri GS1 olarak ayrıştırır (ayrıştırıcı `catalog/gs1.ts`; bu kart yalnızca çağırır). */
export function parseScannedGs1(value: string): Gs1Result {
  return parseGs1(value);
}
