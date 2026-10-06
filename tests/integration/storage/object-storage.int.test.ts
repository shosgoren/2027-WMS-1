// ObjectStorage entegrasyon testi (T-125, ADR-006, AC-04 dosya katmanı). Gerçek MinIO'ya karşı; atlama YOK:
// STORAGE_* yoksa (ör. neon hedefi, MinIO verilmemiş) beforeAll açık hatayla düşer.
// Bağdaştırıcı, global-setup'ın ürettiği root OLMAYAN geçici anahtarla çalışır. Veriler sentetik UUID'lerdir (G-09).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { storageContextFromMembership, type ObjectStorage, type StorageContext } from "../../../packages/shared/src/storage.ts";
import { createObjectStorage, readStorageConfig, type ObjectStorageConfig } from "../../../packages/storage/src/index.ts";

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
let ctxA: StorageContext;
let ctxB: StorageContext;
let tenantA: string;
let tenantB: string;
let bucketEndpointKeyless: { endpoint: string; bucket: string };

beforeAll(() => {
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
  ctxA = storageContextFromMembership({ membershipId: randomUUID(), tenantId: tenantA });
  ctxB = storageContextFromMembership({ membershipId: randomUUID(), tenantId: tenantB });
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

describe("ObjectStorage (MinIO)", () => {
  it("A put/get/delete çalışır; anahtar tenants/<A>/ önekli", async () => {
    const key = await storage.put(ctxA, `docs/${randomUUID()}.txt`, enc.encode("merhaba"), { contentType: "text/plain" });
    expect(key.startsWith(`tenants/${tenantA}/docs/`)).toBe(true);
    const got = await storage.get(ctxA, key);
    expect(dec.decode(got.body)).toBe("merhaba");
    expect(got.contentType).toBe("text/plain");
    await storage.delete(ctxA, key);
    expect(await codeOf(() => storage.get(ctxA, key))).toBe("NOT_FOUND");
  });

  it("A bağlamıyla B önekli anahtar: FORBIDDEN ve MinIO'ya istek gitmez", async () => {
    const keyB = await storage.put(ctxB, "secret.txt", enc.encode("b-verisi"), { contentType: "text/plain" });
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
      expect(await codeOf(() => storage.put(ctxA, bad, enc.encode("x"), { contentType: "text/plain" }))).toBe("VALIDATION_FAILED");
    }
    expect(requests).toBe(before);
  });

  it("NFC olmayan ve NFC yazım aynı nesneye çözülür (put normalleştirir)", async () => {
    const key = await storage.put(ctxA, "café.txt", enc.encode("n"), { contentType: "text/plain" });
    expect(key).toBe(`tenants/${tenantA}/café.txt`);
    expect(dec.decode((await storage.get(ctxA, key)).body)).toBe("n");
    await storage.delete(ctxA, key);
  });

  describe("imzalı URL", () => {
    it("süre içinde yalnızca o anahtarı GET ile verir; X-Amz-Expires = ttl", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("imzali"), { contentType: "text/plain" });
      const url = await storage.signedGetUrl(ctxA, key, 30);
      expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("30");
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("imzali");
      await storage.delete(ctxA, key);
    });

    it("süre dolunca reddedilir", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("kisa"), { contentType: "text/plain" });
      const url = await storage.signedGetUrl(ctxA, key, 1);
      expect((await fetch(url)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2500));
      expect((await fetch(url)).status).toBe(403);
      await storage.delete(ctxA, key);
    });

    it("kapsam: başka anahtara, PUT/DELETE yöntemine ve imzasız erişime geçerli değildir", async () => {
      const key = await storage.put(ctxA, `signed/${randomUUID()}.txt`, enc.encode("kapsam"), { contentType: "text/plain" });
      const other = await storage.put(ctxB, "other.txt", enc.encode("baska"), { contentType: "text/plain" });
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
    await expect(client.send(new s3.CreateBucketCommand({ Bucket: `x${randomUUID()}` }))).rejects.toThrow();
    await expect(client.send(new s3.ListBucketsCommand({}))).rejects.toThrow();
    client.destroy();
  });
});
