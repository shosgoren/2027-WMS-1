// Bağlantı hedefi yardımcıları (host+port+kullanıcı+veritabanı). YAN ETKİSİZ modül: saf işlevler; `postgres` sürücüsü yalnızca `options` çözümü için çağrılır (bağlantı açılmaz).
// `@wms/db` index'i ve worker/uygulama paketleri bunu `migrate.ts` yerine buradan alır; çünkü `migrate.ts` bir CLI
// giriş noktası koruması içerir ve paketlenen (bundle) çıktıya girerse açılışta migration `main()` koşturabilir.
// Parola/URL hiçbir çıktıya yazılmaz (G-09).

import postgres from "postgres";

export interface ConnectionTarget {
  /** Sürücünün gerçekten bağlanacağı her host:port çifti. Loopback adları tek biçime indirgenir. */
  readonly hosts: readonly { host: string; port: string }[];
  readonly user: string;
  readonly db: string;
  /** URL sorgusunda izin listesi dışı parametre var (`user`, `database`, `options`, `host`, `port`, bilinmeyen …): StartupMessage/hedef ezilebilir. */
  readonly hasUnsafeQuery: boolean;
}

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];
/** Bağlantı URL sorgusunda kabul edilen anahtarlar: `sslmode`, `ssl*` ve `application_name`. */
const SAFE_QUERY_KEY_RE = /^(?:ssl[a-z_]*|application_name)$/;
/** Sürücünün çözdüğü host yalnızca bu karakterlerden oluşabilir (IPv6 `[::1]` sürücüde `[` olarak bozulur → ret). */
const HOST_NAME_RE = /^[a-z0-9._-]+$/;

/**
 * Bağlantı hedefi — SÜRÜCÜNÜN çözdüğü değerlerle (postgres.js 3.4.9 `options`; bağlantı açılmaz, kullanıcı/
 * veritabanı/`PGHOST`/`PGPORT`/`PGUSER`/`PGUSERNAME` geri düşüşleri sürücüyle birebir aynı). Ayrıştırıcı
 * farkını (sürücü yetkiyi İLK `@`'ten, `#`'i host'a dahil sayar) kapatmak için önce katı ön denetim:
 * yetki bölümünde birden fazla `@` veya herhangi bir `#`, postgres(ql) dışı şema, sürücünün
 * ayrıştıramadığı URL, host adı olmayan/IPv6/unix soket hedefi ya da geçersiz port → `undefined` (çağıran ret).
 */
export function parseTarget(url: string): ConnectionTarget | undefined {
  const trimmed = url.trim();
  const m = /^postgres(?:ql)?:\/\/([^/?]*)(?:[/?]|$)/i.exec(trimmed);
  if (m === null || trimmed.includes("#")) return undefined;
  if (((m[1] ?? "").match(/@/g) ?? []).length > 1) return undefined;
  let o: postgres.ParsedOptions;
  try {
    // Bağlantı kurulmaz (sürücü tembeldir); soket/zamanlayıcı oluşmaz.
    o = postgres(trimmed).options;
  } catch {
    return undefined;
  }
  const sockPath: unknown = o.path;
  if (sockPath !== false && sockPath !== undefined && sockPath !== "") return undefined;
  if (o.host.length === 0 || o.host.length !== o.port.length) return undefined;
  const hosts: { host: string; port: string }[] = [];
  for (let i = 0; i < o.host.length; i++) {
    let host = String(o.host[i]).toLowerCase();
    const port = o.port[i] as number;
    if (!HOST_NAME_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (LOOPBACK_HOSTS.includes(host)) host = "loopback";
    hosts.push({ host, port: String(port) });
  }
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : "";
  // İzin listesi (sürücü sorgu parametrelerini options.connection'a taşır ve `user`/`database`/`options`
  // gibi anahtarlar StartupMessage'ı ezer): yalnızca TLS ve application_name. Anahtar çözülmüş haliyle,
  // büyük/küçük harf duyarlı karşılaştırılır (`%75ser`, `User` da ret).
  const hasUnsafeQuery = [...new URLSearchParams(query).keys()].some((k) => !SAFE_QUERY_KEY_RE.test(k));
  return { hosts, user: String(o.user), db: String(o.database), hasUnsafeQuery };
}

/**
 * İki URL aynı sunucu+kullanıcı+veritabanına işaret edebilir mi? Fail-closed: ayrıştırılamayan,
 * izin listesi dışı sorgu parametreli veya host listeleri kesişen çiftte `true` (ret). `localhost`/`127.0.0.1` eşdeğer.
 */
export function sameConnectionTarget(a: string, b: string): boolean {
  const ta = parseTarget(a);
  const tb = parseTarget(b);
  if (ta === undefined || tb === undefined || ta.hasUnsafeQuery || tb.hasUnsafeQuery) return true;
  if (ta.user !== tb.user || ta.db !== tb.db) return false;
  return ta.hosts.some((x) => tb.hosts.some((y) => x.host === y.host && x.port === y.port));
}
