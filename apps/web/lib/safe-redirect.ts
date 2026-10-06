// Açık yönlendirme (open redirect) bekçisi (T-117 M10). Davet kabul sonrası dönüş ve T-118 `proxy.ts` YALNIZCA bunu
// kullanır. Kural: yalnızca tek `/` ile başlayan göreli yol; aksi her durumda `/`.
//
// Reddedilenler: `//…`, `/\…`, şema (`http:`, `javascript:` — `/` ile başlamadığından zaten düşer), ters eğik çizgi,
// denetim karakterleri (tarayıcı `\t`/`\n`/`\r`'yi URL ayrıştırırken siler: `/\t/evil.com` → `//evil.com`), kodlanmış
// eğik çizgi / ters eğik çizgi (`%2f`, `%5c`) ve bir kez çözüldüğünde yukarıdakilere dönüşen biçimler.
const FALLBACK = "/";
const MAX_LENGTH = 2048;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const ENCODED_SLASH = /%(?:2f|5c)/i;

function unsafe(path: string): boolean {
  return (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    CONTROL_OR_BACKSLASH.test(path) ||
    ENCODED_SLASH.test(path)
  );
}

export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_LENGTH) return FALLBACK;
  if (unsafe(raw)) return FALLBACK;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return FALLBACK; // geçersiz yüzde kodlaması
  }
  if (unsafe(decoded)) return FALLBACK;
  return raw;
}
