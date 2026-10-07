// ScannerService (ADR-010): ekranlar yalnızca `onScan(value, source)` dinler; kaynaklar (keystroke, ileride
// kamera) servis arkasındadır. Tek etkin dinleyici: yeni abonelik eskisini bırakır (ekran değişimi).
import { parseGs1 } from "@wms/domain/catalog/gs1";
import type { Gs1Result } from "@wms/domain/catalog/gs1";

/** `manual`: elle yazılan değer; donanım taraması DEĞİLDİR. `camera` için kaynak bu kartta yok (arayüz noktası). */
export type ScanSource = "keystroke" | "camera" | "manual";
export type ScanHandler = (value: string, source: ScanSource) => void;
export type Unsubscribe = () => void;

/** Servise takılan tarama kaynağı. `start` dinlemeye başlar; döndürülen işlev durdurur. */
export interface ScannerSource {
  readonly id: Exclude<ScanSource, "manual">;
  start(emit: (value: string) => void): Unsubscribe;
}

export class ScannerService {
  private readonly sources = new Map<ScannerSource["id"], ScannerSource>();
  private readonly running = new Map<ScannerSource["id"], Unsubscribe>();
  private handler: ScanHandler | null = null;

  /** Kaynağı kaydeder (aynı kimlik yenisiyle değişir). Dinleyici varsa hemen başlar. */
  registerSource(source: ScannerSource): void {
    this.stopSource(source.id);
    this.sources.set(source.id, source);
    if (this.handler !== null) this.startSource(source);
  }

  /** Tek etkin dinleyici: önceki abonelik düşer. Dönen işlev yalnızca hâlâ etkin olan abonelik için çalışır. */
  onScan(handler: ScanHandler): Unsubscribe {
    const hadHandler = this.handler !== null;
    this.handler = handler;
    if (!hadHandler) for (const s of this.sources.values()) this.startSource(s);
    return () => {
      if (this.handler !== handler) return;
      this.handler = null;
      for (const id of [...this.running.keys()]) this.stopSource(id);
    };
  }

  /** Elle giriş: `source: "manual"`; boş değer iletilmez. */
  submitManual(value: string): void {
    const v = value.trim();
    if (v !== "") this.handler?.(v, "manual");
  }

  private startSource(source: ScannerSource): void {
    this.running.set(
      source.id,
      source.start((value) => this.handler?.(value, source.id)),
    );
  }

  private stopSource(id: ScannerSource["id"]): void {
    this.running.get(id)?.();
    this.running.delete(id);
  }
}

/** Okunan değeri GS1 olarak ayrıştırır (ayrıştırıcı `catalog/gs1.ts`; bu kart yalnızca çağırır). */
export function parseScannedGs1(value: string): Gs1Result {
  return parseGs1(value);
}
