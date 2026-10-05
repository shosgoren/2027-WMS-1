// Bağlantı hedefi yardımcıları (host+port+kullanıcı+veritabanı). YAN ETKİSİZ modül: yalnızca saf işlevler.
// `@wms/db` index'i ve worker/uygulama paketleri bunu `migrate.ts` yerine buradan alır; çünkü `migrate.ts` bir CLI
// giriş noktası koruması içerir ve paketlenen (bundle) çıktıya girerse açılışta migration `main()` koşturabilir.
// Parola/URL hiçbir çıktıya yazılmaz (G-09).

/** Bağlantı hedefi (host+port+kullanıcı+veritabanı); ayrıştırılamazsa `undefined`. */
export function parseTarget(url: string): { host: string; port: string; user: string; db: string } | undefined {
  try {
    const u = new URL(url);
    const dec = (v: string): string => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    return {
      host: u.hostname.toLowerCase(),
      port: u.port === "" ? "5432" : u.port,
      user: dec(u.username),
      db: dec(u.pathname.replace(/^\//, "")),
    };
  } catch {
    return undefined;
  }
}

/** İki URL aynı host+port+kullanıcı+veritabanına mı işaret ediyor? Ayrıştırılamayan çiftte ham eşitlik. */
export function sameConnectionTarget(a: string, b: string): boolean {
  const ta = parseTarget(a);
  const tb = parseTarget(b);
  if (ta === undefined || tb === undefined) return a === b;
  return ta.host === tb.host && ta.port === tb.port && ta.user === tb.user && ta.db === tb.db;
}
