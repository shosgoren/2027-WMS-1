// PWA bildirimi (T-286): ana ekrana eklenince tam ekran (standalone) açılır. Service worker/offline önbellek YOK (offline Q-102'ye bağlı).
// Simgeler `icon.tsx` ve `apple-icon.tsx` ile kodla üretilir (depoda ikili dosya yok). Ad `messages/*.json` `shell.productName`'dan gelir (ADR-002).
import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";

// Tema rengi `globals.css` `--color-accent` ile aynıdır.
const THEME_COLOR = "#1559c7";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations("shell");
  return {
    name: t("productName"),
    short_name: t("productName"),
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f3f5f9",
    theme_color: THEME_COLOR,
    icons: [
      { src: "/icon", sizes: "192x192 512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "192x192 512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
