// ObjectStorage entegrasyon testi (T-125, ADR-006, AC-04 dosya katmanı). Gerçek MinIO'ya karşı; atlama YOK:
// STORAGE_* yoksa (ör. neon hedefi, MinIO verilmemiş) beforeAll açık hatayla düşer.
// Bağdaştırıcı, global-setup'ın ürettiği root OLMAYAN geçici anahtarla çalışır. Veriler sentetik UUID'lerdir (G-09).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { createDbClient, withTenant } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, createTenantContext, type DbClient } from "../../../packages/db/src/client.ts";
import { readIntEnv } from "../harness/env.ts";
import { type ObjectStorage, type StorageContext } from "../../../packages/shared/src/storage.ts";
import { createObjectStorage, createStorageContext, readStorageConfig, type ObjectStorageConfig } from "../../../packages/storage/src/index.ts";

// Yalnızca kullanılan SDK yüzeyi bildirilir (SDK tiplerine kökten bakmak çözülemeyen @smithy/* tiplerini getirir).
interface TestS3Client {
  send(command: unknown): Promise<unknown>;
  destroy(): void;
  middlewareStack: {
    add(mw: (next: (args: unknown) => Promise<unknown>) => (args: unknown) => Promise<unknown>, options: { step: "finalizeRequest"; name: string; priority: "low" }): void;
  };
}
interface S3Module {
  S3Client: new (config: { endpoint: string; region: string; forcePathStyle: boolean; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }) => TestS3Client;
  CreateBucketCommand: new (input: { Bucket: string }) => unknown;
  ListBucketsCommand: new (input: Record<string, never>) => unknown;
}
const storageRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/storage/package.json"));
const s3 = storageRequire("@aws-sdk/client-s3") as S3Module;

const enc = new TextEncoder();
const dec = new TextDecoder();

let requests = 0;
let storage: ObjectStorage;
let dbClient: DbClient;
let ctxA: StorageContext;
let ctxB: StorageContext;
let tenantA: string;
let tenantB: string;
let bucketEndpointKeyless: { endpoint: string; bucket: string };

beforeAll(async () => {
  const missing = ["STORAGE_ENABLED", "STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"].filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`object-storage int test needs a MinIO target; missing env: ${missing.join(", ")} (compose target sets them in global-setup; neon target must supply them)`);
  }
  const config = readStorageConfig(process.env);
  const client = new s3.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    },
  });
  // Ağa giden her SDK isteğini sayar (imzalama sonrası adım): reddedilen çağrılar sayacı artırmamalı.
  client.middlewareStack.add(
    (next) => async (args) => {
      requests += 1;
      return next(args);
    },
    { step: "finalizeRequest", name: "countRequests", priority: "low" },
  );
  storage = createObjectStorage({ ...config, client: client as unknown as NonNullable<ObjectStorageConfig["client"]> });
  tenantA = randomUUID();
  tenantB = randomUUID();
  // Bağlam, tenant kimliğini çağırandan değil tx'in app.current_tenant_id ayarından alır (security MAJOR).
  dbClient = createDbClient({ url: readIntEnv(process.env).databaseUrl, ...DB_CLIENT_SETTINGS });
  const ctxFor = (tenantId: string): Promise<StorageContext> => withTenant(createTenantContext(dbClient, tenantId), (tx) => createStorageContext(tx));
  ctxA = await ctxFor(tenantA);
  ctxB = await ctxFor(tenantB);
  bucketEndpointKeyless = { endpoint: config.endpoint, bucket: config.bucket };
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

afterAll(async () => {
  await dbClient.close();
});

describe("ObjectStorage (MinIO)", () => {
  it("bağlam tenant'ı DB oturum ayarından türetir; sahte nesne/dizgi kabul edilmez", async () => {
    expect(ctxA.tenantId).toBe(tenantA);
    const forged = { tenantId: tenantB, membershipId: randomUUID() } as unknown as StorageContext;
    const before = requests;
    expect(await codeOf(() => storage.put(forged, "x", enc.encode("x"), { contentType: "application/octet-stream" }))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.get(forged, `tenants/${tenantB}/x`))).toBe("FORBIDDEN");
    expect(requests).toBe(before);
  });

  it("üzerine yazma varsayılan olarak yok (VERSION_CONFLICT); ifNoneMatch:null izin verir", async () => {
    const rel = `ow/${randomUUID()}.bin`;
    const key = await storage.put(ctxA, rel, enc.encode("bir"), { contentType: "application/octet-stream" });
    expect(await codeOf(() => storage.put(ctxA, rel, enc.encode("iki"), { contentType: "application/octet-stream" }))).toBe("VERSION_CONFLICT");
    expect(dec.decode((await storage.get(ctxA, key)).body)).toBe("bir");
    await storage.put(ctxA, rel, enc.encode("iki"), { contentType: "application/octet-stream", ifNoneMatch: null });
    expect(dec.decode((await storage.get(ctxA, key)).body)).toBe("iki");
    await storage.delete(ctxA, key);
  });

  it("izin listesi dışı / CRLF'li içerik türü ağ çağrısı yapmadan reddedilir", async () => {
    const before = requests;
    for (const ct of ["text/html", "image/svg+xml", "application/pdf\r\nX: y", "TEXT/CSV", ""]) {
      expect(await codeOf(() => storage.put(ctxA, "ct.bin", enc.encode("x"), { contentType: ct }))).toBe("VALIDATION_FAILED");
    }
    expect(requests).toBe(before);
  });

  it("A put/get/delete çalışır; anahtar tenants/<A>/ önekli", async () => {
    const key = await storage.put(ctxA, `docs/${randomUUID()}.txt`, enc.encode("merhaba"), { contentType: "application/octet-stream" });
    expect(key.startsWith(`tenants/${tenantA}/docs/`)).toBe(true);
    const got = await storage.get(ctxA, key);
    expect(dec.decode(got.body)).toBe("merhaba");
    expect(got.contentType).toBe("application/octet-stream");
    await storage.delete(ctxA, key);
    expect(await codeOf(() => storage.get(ctxA, key))).toBe("NOT_FOUND");
  });

  it("A bağlamıyla B önekli anahtar: FORBIDDEN ve MinIO'ya istek gitmez", async () => {
    const keyB = await storage.put(ctxB, "secret.txt", enc.encode("b-verisi"), { contentType: "application/octet-stream" });
    const before = requests;
    expect(await codeOf(() => storage.get(ctxA, keyB))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.delete(ctxA, keyB))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.signedGetUrl(ctxA, keyB, 60))).toBe("FORBIDDEN");
    expect(await codeOf(() => storage.get(ctxA, `tenants/${tenantA}/../${tenantB}/secret.txt`))).toBe("VALIDATION_FAILED");
    expect(await codeOf(() => storage.get(ctxA, "secret.txt"))).toBe("FORBIDDEN");
    expect(requests).toBe(before);
    // B'nin nesnesi sağlam; B kendi bağlamıyla okur.
    expect(dec.decode((await storage.get(ctxB, keyB)).body)).toBe("b-verisi");
    await storage.delete(ctxB, keyB);
  });

  it("yol geçişi / mutlak / ters eğik çizgi / unicode benzeri put anahtarları ağ çağrısı yapmaz", async () => {
    const before = requests;
    for (const bad of ["../x", "a/../../x", "/abs", "a\\b", "a//b", "．．/x", `../${tenantB}/x`]) {
      expect(await codeOf(() => storage.put(ctxA, bad, enc.encode("x"), { contentType: "application/octet-stream" }))).toBe("VALIDATION_FAILED");
    }
    expect(requests).toBe(before);
  });

  it("NFC olmayan ve NFC yazım aynı nesneye çözülür (put normalleştirir)", async () => {
    const key = await storage.put(ctxA, "café.txt", enc.encode("n"), { contentType: "application/octet-stream" });
    expect(key).toBe(`tenants/${tenantA}/café.txt`);
    expect(dec.decode((await storage.get(ctxA, key)).body)).toBe("n");
    await storage.delete(ctxA, key);
  });

  describe("imzalı URL", () => {
    it("süre içinde yalnızca o anahtarı GET ile verir; X-Amz-Expires = ttl", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("imzali"), { contentType: "application/octet-stream" });
      const url = await storage.signedGetUrl(ctxA, key, 30);
      expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("30");
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-disposition")).toBe("attachment");
      expect(await ok.text()).toBe("imzali");
      await storage.delete(ctxA, key);
    });

    it("süre dolunca reddedilir", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("kisa"), { contentType: "application/octet-stream" });
      // T-244: TTL 1 sn + X-Amz-Date saniyeye yuvarlandığı için imza saniye sonunda atılınca URL
      // ilk istekten önce doluyordu (yük altında 403). TTL 5 sn: yuvarlama (<=1 sn) ve yük payı
      // sonrası ilk istek süre içinde kalır; kalmazsa aşağıdaki koruma anlamlı hata verir.
      // Bekleme sabit değil: URL'deki X-Amz-Date + X-Amz-Expires'tan hesaplanır (+1,5 sn pay).
      const ttl = 5;
      const url = await storage.signedGetUrl(ctxA, key, ttl);
      const params = new URL(url).searchParams;
      expect(params.get("X-Amz-Expires")).toBe(String(ttl));
      const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(params.get("X-Amz-Date") ?? "");
      expect(d, "X-Amz-Date biçimi YYYYMMDDTHHMMSSZ olmalı").not.toBeNull();
      const [, y, mo, da, h, mi, s] = d!.map(Number);
      const expiresAtMs = Date.UTC(y!, mo! - 1, da, h, mi, s) + ttl * 1000;
      const firstFetchAt = Date.now();
      expect(
        firstFetchAt,
        `ilk istek URL süresinden önce başlamalı (kalan ${expiresAtMs - firstFetchAt} ms); ortam aşırı yavaş`,
      ).toBeLessThan(expiresAtMs - 1000);
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("kisa");
      await new Promise((r) => setTimeout(r, Math.max(0, expiresAtMs + 1500 - Date.now())));
      expect((await fetch(url)).status).toBe(403);
      await storage.delete(ctxA, key);
    });

    it("kapsam: başka anahtara, PUT/DELETE yöntemine ve imzasız erişime geçerli değildir", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("kapsam"), { contentType: "application/octet-stream" });
      const other = await storage.put(ctxB, "other.txt", enc.encode("baska"), { contentType: "application/octet-stream" });
      const url = new URL(await storage.signedGetUrl(ctxA, key, 60));
      // Aynı imza başka tenant anahtarına uygulanamaz (imza yolu kapsar).
      const swapped = new URL(url);
      swapped.pathname = `/${bucketEndpointKeyless.bucket}/${other}`;
      expect((await fetch(swapped)).status).toBe(403);
      // GET imzası PUT/DELETE için geçerli değildir.
      expect((await fetch(url, { method: "PUT", body: "ezildi" })).status).toBe(403);
      expect((await fetch(url, { method: "DELETE" })).status).toBe(403);
      // Bucket özel: imzasız GET reddedilir.
      expect((await fetch(`${bucketEndpointKeyless.endpoint}/${bucketEndpointKeyless.bucket}/${key}`)).status).toBe(403);
      // Nesneler sağlam.
      expect(dec.decode((await storage.get(ctxA, key)).body)).toBe("kapsam");
      await storage.delete(ctxA, key);
      await storage.delete(ctxB, other);
    });

    it("geçersiz süre ağ çağrısı yapmadan reddedilir", async () => {
      const before = requests;
      for (const ttl of [0, -5, 3601, 1.5]) {
        expect(await codeOf(() => storage.signedGetUrl(ctxA, `tenants/${tenantA}/x`, ttl))).toBe("VALIDATION_FAILED");
      }
      expect(requests).toBe(before);
    });
  });

  it("root olmayan anahtar: bucket oluşturma/listeleme yetkisi yoktur", async () => {
    const config = readStorageConfig(process.env);
    const client = new s3.S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }) },
    });
    const denied = { name: "AccessDenied", $metadata: { httpStatusCode: 403 } };
    await expect(client.send(new s3.CreateBucketCommand({ Bucket: `x${randomUUID()}` }))).rejects.toMatchObject(denied);
    await expect(client.send(new s3.ListBucketsCommand({}))).rejects.toMatchObject(denied);
    client.destroy();
  });
});
