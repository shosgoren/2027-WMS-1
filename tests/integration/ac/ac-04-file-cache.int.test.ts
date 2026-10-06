// AC-04 — bağımsız kabul testi (T-128, qa-verifier). Uygulayıcının testlerinden (T-125) bağımsız yazıldı.
// katman: file, cache
//
// AC-04: "Tenant A, B'nin ID'sini kullanır → API, DB, dosya, cache, export reddeder". Bu dosya dosya (nesne deposu) ve
// cache katmanlarını gerçek MinIO'ya ve gerçek DB tx bağlamına karşı kanıtlar. Bağlam, tenant kimliğini çağırandan değil tx
// oturum ayarından alır. Veriler sentetik UUID'lerdir (G-09). Atlama YOK: STORAGE_* yoksa beforeAll açık hatayla düşer.
//
// Kural (T-128 §5): yeni bir tenant-kapsamlı katman (arama, worker işi...) eklendiğinde `ac-04-coverage.int.test.ts` içindeki
// LAYERS listesi genişletilir ve o katmanın dosyası başında `// katman: <ad>` etiketi taşır.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { type ObjectStorage, type StorageContext } from "../../../packages/shared/src/storage.ts";
import { createObjectStorage, createStorageContext, readStorageConfig, tenantCacheKey } from "../../../packages/storage/src/index.ts";
import { readIntEnv } from "../harness/env.ts";

/**
 * İstek sayacı: MinIO önünde, başlıkları aynen ileten küçük bir HTTP aktarıcısı (Host korunur: SigV4 imzası geçerli kalır).
 * SDK'yı test koduna almak yerine ağ düzeyinde sayar: reddedilen çağrı aktarıcıya hiç ulaşmamalıdır.
 */
function startCountingProxy(target: URL): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    requests += 1;
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502).end();
    });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const OCTET = { contentType: "application/octet-stream" } as const;

let requests = 0;
let storage: ObjectStorage;
let dbClient: DbClient;
let ctxA: StorageContext;
let ctxB: StorageContext;
let tenantA: string;
let tenantB: string;
let endpoint: string;
let proxy: { url: string; close: () => Promise<void> };
let bucket: string;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}
function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

beforeAll(async () => {
  const missing = ["STORAGE_ENABLED", "STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"].filter((n) => !process.env[n]);
  if (missing.length > 0) throw new Error(`ac-04 file/cache test needs a MinIO target; missing env: ${missing.join(", ")}`);
  const config = readStorageConfig(process.env);
  proxy = await startCountingProxy(new URL(config.endpoint));
  endpoint = proxy.url;
  bucket = config.bucket;
  storage = createObjectStorage({ ...config, endpoint: proxy.url });
  tenantA = randomUUID();
  tenantB = randomUUID();
  dbClient = createDbClient({ url: readIntEnv(process.env).databaseUrl, ...DB_CLIENT_SETTINGS });
  const ctxFor = (tenantId: string): Promise<StorageContext> => withTenant(createTenantContext(dbClient, tenantId), (tx) => createStorageContext(tx));
  ctxA = await ctxFor(tenantA);
  ctxB = await ctxFor(tenantB);
});

afterAll(async () => {
  await dbClient.close();
  await proxy.close();
});

describe("AC-04 dosya katmanı", () => {
  it("@AC-04 A bağlamıyla B'nin nesne anahtarı: get/delete/signedGetUrl FORBIDDEN, MinIO'ya istek gitmez, B'nin nesnesi sağlam", async () => {
    const keyB = await storage.put(ctxB, `ac04/${randomUUID()}.bin`, enc.encode("b-gizli-ac04"), OCTET);
    expect(keyB.startsWith(`tenants/${tenantB}/`)).toBe(true);
    const before = requests;
    expect(await codeOf(() => storage.get(ctxA, keyB))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.delete(ctxA, keyB))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.signedGetUrl(ctxA, keyB, 60))).toBe("FORBIDDEN");
    // Öneksiz, büyük harfli önek, başka kök, tenant kimliği yalnız başına: hepsi sahiplik denetiminde düşer.
    const suffix = keyB.slice(`tenants/${tenantB}/`.length);
    for (const k of [suffix, `TENANTS/${tenantB}/${suffix}`, `tenants/${tenantB.toUpperCase()}/${suffix}`, `/tenants/${tenantB}/${suffix}`, `${tenantB}/${suffix}`, `tenants/${tenantB}`]) {
      expect(await codeOf(() => storage.get(ctxA, k)), k).toBe("FORBIDDEN");
    }
    expect(requests).toBe(before);
    // B'nin nesnesi A'nın silme denemesinden etkilenmedi.
    expect(dec.decode((await storage.get(ctxB, keyB)).body)).toBe("b-gizli-ac04");
    await storage.delete(ctxB, keyB);
  });

  it("@AC-04 öneke geri dönüş (..) ve çözülmüş/kodlanmış kaçışlar: VALIDATION_FAILED veya A'nın kendi önekinde NOT_FOUND; B verisi dönmez", async () => {
    const relB = `ac04/${randomUUID()}.bin`;
    const keyB = await storage.put(ctxB, relB, enc.encode("b-kacis"), OCTET);
    const before = requests;
    // `..` segmentli anahtarlar ağ çağrısı yapmadan reddedilir.
    for (const k of [`tenants/${tenantA}/../${tenantB}/${relB}`, `tenants/${tenantA}/a/../../${tenantB}/${relB}`, `tenants/${tenantA}/./${relB}`, `tenants/${tenantA}//${relB}`, `tenants/${tenantA}/..`, `tenants/${tenantA}/`]) {
      for (const op of [() => storage.get(ctxA, k), () => storage.delete(ctxA, k), () => storage.signedGetUrl(ctxA, k, 60)]) {
        expect(await codeOf(op), k).toBe("VALIDATION_FAILED");
      }
    }
    // Tam genişlikli nokta/eğik çizgi (NFKC) ve ters eğik çizgi.
    for (const k of [`tenants/${tenantA}/．．/${tenantB}/${relB}`, `tenants/${tenantA}/..\\${tenantB}\\${relB}`, `tenants/${tenantA}/％２ｅ`]) {
      expect(await codeOf(() => storage.get(ctxA, k)), k).toBe("VALIDATION_FAILED");
    }
    expect(requests).toBe(before);
    // Yüzde kodlu kaçış gerçek geçiş değildir: A'nın önekinde sıradan bir ad olarak aranır (bulunamaz), B'nin nesnesi dönmez.
    const encoded = `tenants/${tenantA}/%2e%2e/${tenantB}/${relB}`;
    expect(await codeOf(() => storage.get(ctxA, encoded))).toBe("NOT_FOUND");
    // put tarafında da kaçış denemesi ağ çağrısı yapmaz.
    const b2 = requests;
    for (const bad of [`../${tenantB}/x`, `a/../../${tenantB}/x`, `/tenants/${tenantB}/x`]) {
      expect(await codeOf(() => storage.put(ctxA, bad, enc.encode("x"), OCTET)), bad).toBe("VALIDATION_FAILED");
    }
    expect(requests).toBe(b2);
    expect(dec.decode((await storage.get(ctxB, keyB)).body)).toBe("b-kacis");
    await storage.delete(ctxB, keyB);
  });

  it("@AC-04 A'nın imzalı URL'si B'nin nesnesini açamaz (yol değişimi, '..' ile yol kaçışı, imzasız erişim); A'nın nesnesi açılır", async () => {
    const keyA = await storage.put(ctxA, `ac04/${randomUUID()}.bin`, enc.encode("a-verisi"), OCTET);
    const keyB = await storage.put(ctxB, `ac04/${randomUUID()}.bin`, enc.encode("b-verisi"), OCTET);
    const url = new URL(await storage.signedGetUrl(ctxA, keyA, 60));
    expect(url.pathname).toBe(`/${bucket}/${keyA}`);
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("a-verisi");
    // Aynı imza B'nin anahtarına uygulanamaz.
    const swapped = new URL(url);
    swapped.pathname = `/${bucket}/${keyB}`;
    const r1 = await fetch(swapped);
    expect(r1.status).toBe(403);
    expect(await r1.text()).not.toContain("b-verisi");
    // `..` ile A önekinden B anahtarına çıkış (fetch yolu normalleştirir; imza yine uyuşmaz).
    const escaped = new URL(url);
    escaped.pathname = `/${bucket}/tenants/${tenantA}/../${tenantB}/${keyB.slice(`tenants/${tenantB}/`.length)}`;
    const r2 = await fetch(escaped);
    expect(r2.status).toBe(403);
    expect(await r2.text()).not.toContain("b-verisi");
    // Kodlanmış '..' ile de açılmaz.
    const encodedEscape = new URL(url);
    encodedEscape.pathname = `/${bucket}/tenants/${tenantA}/%2e%2e/${tenantB}/${keyB.slice(`tenants/${tenantB}/`.length)}`;
    const r3 = await fetch(encodedEscape);
    expect(r3.status).toBe(403);
    expect(await r3.text()).not.toContain("b-verisi");
    // İmzasız B nesnesi (bucket özel).
    expect((await fetch(`${endpoint}/${bucket}/${keyB}`)).status).toBe(403);
    // B'nin kendi imzalı URL'si B'yi açar; A'nın bağlamı bunu üretemez (yukarıda FORBIDDEN).
    const urlB = await storage.signedGetUrl(ctxB, keyB, 60);
    expect(await (await fetch(urlB)).text()).toBe("b-verisi");
    await storage.delete(ctxA, keyA);
    await storage.delete(ctxB, keyB);
  });

  it("@AC-04 sahte/yapıştırılmış bağlam (düz nesne, B'nin kimliğiyle) reddedilir; B yazılamaz", async () => {
    const forged = { tenantId: tenantB } as unknown as StorageContext;
    const before = requests;
    expect(await codeOf(() => storage.put(forged, "ac04/x.bin", enc.encode("x"), OCTET))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.get(forged, `tenants/${tenantB}/ac04/x.bin`))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.delete(forged, `tenants/${tenantB}/ac04/x.bin`))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.signedGetUrl(forged, `tenants/${tenantB}/ac04/x.bin`, 60))).toBe("FORBIDDEN");
    // Bağlamın bir kopyası da (marka kayıtlı değil) geçmez.
    const clone = { ...ctxB } as StorageContext;
    expect(await codeOf(() => storage.get(clone, `tenants/${tenantB}/ac04/x.bin`))).toBe("FORBIDDEN");
    expect(requests).toBe(before);
  });

  it("@AC-04 eşzamanlı: A ve B aynı göreli anahtara aynı anda yazar; her biri yalnızca kendi önekinde, içerikler karışmaz", async () => {
    const rel = `ac04/same-${randomUUID()}.bin`;
    const jobs = Array.from({ length: 10 }, (_, i) => [storage.put(ctxA, `${rel}.${i}`, enc.encode(`A${i}`), OCTET), storage.put(ctxB, `${rel}.${i}`, enc.encode(`B${i}`), OCTET)]).flat();
    const keys = await Promise.all(jobs);
    for (let i = 0; i < 10; i++) {
      const ka = keys[2 * i] as string;
      const kb = keys[2 * i + 1] as string;
      expect(ka).toBe(`tenants/${tenantA}/${rel}.${i}`);
      expect(kb).toBe(`tenants/${tenantB}/${rel}.${i}`);
      expect(dec.decode((await storage.get(ctxA, ka)).body)).toBe(`A${i}`);
      expect(dec.decode((await storage.get(ctxB, kb)).body)).toBe(`B${i}`);
    }
    await Promise.all(keys.map((k, i) => storage.delete(i % 2 === 0 ? ctxA : ctxB, k)));
  });

  it("@AC-04 eşzamanlı idempotency: aynı anahtara 8 paralel put -> tam bir kazanan, kalanlar VERSION_CONFLICT; içerik kazananınki", async () => {
    const rel = `ac04/race-${randomUUID()}.bin`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        storage.put(ctxA, rel, enc.encode(`yaris-${i}`), OCTET).then(
          () => "ok",
          (e: unknown) => (e instanceof AppError ? e.code : "ERR"),
        ),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "VERSION_CONFLICT")).toHaveLength(7);
    const body = dec.decode((await storage.get(ctxA, `tenants/${tenantA}/${rel}`)).body);
    expect(body).toMatch(/^yaris-[0-7]$/);
    await storage.delete(ctxA, `tenants/${tenantA}/${rel}`);
  });
});

describe("AC-04 cache katmanı", () => {
  it("@AC-04 tenantCacheKey(A, ns, x) != tenantCacheKey(B, ns, x); anahtar t:<tenant>: önekli", () => {
    const a = tenantCacheKey(ctxA, "stock", "item-1");
    const b = tenantCacheKey(ctxB, "stock", "item-1");
    expect(a).not.toBe(b);
    expect(a).toBe(`t:${tenantA}:stock:item-1`);
    expect(b).toBe(`t:${tenantB}:stock:item-1`);
    expect(a.startsWith(`t:${tenantB}:`)).toBe(false);
  });

  it("@AC-04 ayırıcı kaçırılır: A'nın parçalarıyla B'nin anahtarı (veya başka namespace) üretilemez", () => {
    const forgedTail = `${tenantB}:stock:item-1`;
    const k = tenantCacheKey(ctxA, "stock", `x:${forgedTail}`);
    expect(k).toBe(`t:${tenantA}:stock:x%3A${tenantB}%3Astock%3Aitem-1`);
    expect(k).not.toBe(tenantCacheKey(ctxB, "stock", "item-1"));
    // Anahtar tam olarak 4 ':' bölümüne ayrılır (t, tenant, ns, tek parça): kaçışsız ':' yok.
    expect(k.split(":")).toHaveLength(4);
    // Parça sınırı kayması: ("a:b") ile ("a","b") aynı anahtarı vermez.
    expect(tenantCacheKey(ctxA, "ns", "a:b")).not.toBe(tenantCacheKey(ctxA, "ns", "a", "b"));
    // Yüzde işareti kaçışı ile `%3A` taklidi ayrışır.
    expect(tenantCacheKey(ctxA, "ns", "a%3Ab")).not.toBe(tenantCacheKey(ctxA, "ns", "a:b"));
    // Geçersiz namespace/boş parça reddedilir.
    expect(codeOfSync(() => tenantCacheKey(ctxA, "ns:evil"))).toBe("VALIDATION_FAILED");
    expect(codeOfSync(() => tenantCacheKey(ctxA, "NS"))).toBe("VALIDATION_FAILED");
    expect(codeOfSync(() => tenantCacheKey(ctxA, "ns", ""))).toBe("VALIDATION_FAILED");
  });

  it("@AC-04 düz tenant kimliği dizgisi derlenmez (tip) ve çalışma anında reddedilir; sahte nesne de", () => {
    // @ts-expect-error: StorageContext markalıdır; düz dizgi atanamaz.
    const viaString = (): string => tenantCacheKey(tenantB, "stock", "item-1");
    expect(codeOfSync(viaString)).toBe("FORBIDDEN");
    // @ts-expect-error: nesne literali markayı taşımaz.
    const viaLiteral = (): string => tenantCacheKey({ tenantId: tenantB }, "stock", "item-1");
    expect(codeOfSync(viaLiteral)).toBe("FORBIDDEN");
    // Dondurulmuş kopya/klon da bağlam değildir.
    expect(codeOfSync(() => tenantCacheKey(Object.freeze({ ...ctxB }) as StorageContext, "stock", "item-1"))).toBe("FORBIDDEN");
    expect(codeOfSync(() => tenantCacheKey(null as unknown as StorageContext, "stock", "item-1"))).toBe("FORBIDDEN");
  });

  it("@AC-04 özellik: rastgele parçalarla iki tenant'ın anahtar kümeleri ayrık; A anahtarı hiçbir zaman B önekiyle başlamaz", () => {
    const alphabet = ["a", "b", ":", "%", "3", "A", "t", tenantB, `${tenantB}:`, " ", "ü", "/"];
    let seed = 0x2f6e2b1;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const seen = new Map<string, string>();
    for (let i = 0; i < 500; i++) {
      const parts = Array.from({ length: 1 + rnd(3) }, () => Array.from({ length: 1 + rnd(4) }, () => alphabet[rnd(alphabet.length)] as string).join(""));
      const ka = tenantCacheKey(ctxA, "prop", ...parts);
      const kb = tenantCacheKey(ctxB, "prop", ...parts);
      expect(ka).not.toBe(kb);
      expect(ka.startsWith(`t:${tenantA}:prop:`)).toBe(true);
      expect(ka.startsWith(`t:${tenantB}:`)).toBe(false);
      // Aynı tenant içinde farklı parça listeleri farklı anahtar verir (çakışma yok = enjeksiyon yok).
      const sig = JSON.stringify(parts);
      const prev = seen.get(ka);
      if (prev !== undefined) expect(prev).toBe(sig);
      seen.set(ka, sig);
      // Anahtardaki kaçışsız ':' sayısı sabittir: t, tenant, ns + parça sayısı.
      expect(ka.split(":")).toHaveLength(3 + parts.length);
    }
  });
});
