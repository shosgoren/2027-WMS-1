import type { ReactNode } from "react";

// Kök düzen. Ürün adı (Q-08 açık) ve sabit Türkçe metin yok; görünür metin
// next-intl ile ayrı kartta gelir (ADR-002).
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
