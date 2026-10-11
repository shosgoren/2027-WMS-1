// iPhone ana ekran simgesi (T-286): iOS yalnızca PNG alır; 180×180, kodla üretilir (icon.tsx ile aynı çizim; route dosyası başka dışa aktarım taşımaz).
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BARS = [16, 8, 24, 8, 16, 24, 8, 16];

function barcodeIcon(px: number): ImageResponse {
  const u = px / 512;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1559c7" }}>
        <div style={{ display: "flex", alignItems: "stretch", height: 200 * u, gap: 10 * u }}>
          {BARS.map((w, i) => (
            <div key={i} style={{ width: w * u * 1.4, background: "#ffffff", borderRadius: 2 * u }} />
          ))}
        </div>
      </div>
    ),
    { width: px, height: px },
  );
}

export default function AppleIcon(): ImageResponse {
  return barcodeIcon(180);
}
