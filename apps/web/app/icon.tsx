// PWA/sekme simgesi (T-286): kodla üretilen 512×512 PNG; ikili dosya yok. Tek renk zemin + barkod çubukları (içerik orta %60'ta: maskable güvenli alan).
import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
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

export default function Icon(): ImageResponse {
  return barcodeIcon(512);
}
