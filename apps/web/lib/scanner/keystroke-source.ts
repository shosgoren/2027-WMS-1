// Klavye kaması (DataWedge keystroke çıkışı) yakalama (07 §Keystroke): global `keydown`; önek–sonek arası tampon;
// tuşlar arası eşik aşılırsa tampon atılır (insan yazımı tarama sayılmaz). `event.key` kullanılır (`keyCode` değil):
// Türkçe düzende `i`, `ı`, `İ`, `ş`, `-`, `/`, `.` birebir gelir. Odak kaybında tampon korunur (blur dinlenmez).
import { SCANNER_CONFIG } from "./scanner-config.ts";
import type { ScannerConfig } from "./scanner-config.ts";
import type { ScannerSource, Unsubscribe } from "./scanner-core.ts";

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  preventDefault(): void;
}

export interface KeyTargetLike {
  addEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  removeEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
}

export interface KeystrokeSourceOptions {
  readonly target?: KeyTargetLike;
  readonly config?: ScannerConfig;
  /** Milisaniye saati; testte enjekte edilir. */
  readonly now?: () => number;
}

export function createKeystrokeSource(options: KeystrokeSourceOptions = {}): ScannerSource {
  const cfg: ScannerConfig = options.config ?? SCANNER_CONFIG;
  const now = options.now ?? (() => performance.now());
  return {
    id: "keystroke",
    start(emit): Unsubscribe {
      const target = options.target ?? (document as unknown as KeyTargetLike);
      let buffer: string | null = null; // null: tampon kapalı
      let last = 0;
      const listener = (e: KeyEventLike): void => {
        const t = now();
        if (buffer !== null && t - last > cfg.interKeyThresholdMs) buffer = null; // yavaş: insan yazımı
        if (buffer === null) {
          if (e.key === cfg.prefix) {
            buffer = "";
            last = t;
            e.preventDefault();
          }
          return; // önek yok: dokunma (formlar normal çalışır)
        }
        last = t;
        e.preventDefault();
        if (e.key === cfg.suffix) {
          const raw = buffer;
          buffer = null;
          if (raw !== "") emit(raw.split(cfg.gs1Placeholder).join(cfg.gs1Separator));
          return;
        }
        if (e.key === cfg.prefix) {
          buffer = ""; // bozuk dizi: yeniden başla
          return;
        }
        if ([...e.key].length !== 1 || e.ctrlKey === true || e.metaKey === true) return; // Shift, Tab vb.
        buffer += e.key;
        if (buffer.length > cfg.maxLength) buffer = null;
      };
      target.addEventListener("keydown", listener);
      return () => target.removeEventListener("keydown", listener);
    },
  };
}
