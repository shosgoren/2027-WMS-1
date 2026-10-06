// Ağsız unit testler (T-125): anahtar normalizasyonu, önek reddi, bağlam markası, bayrak, önbellek anahtarı.
// SDK istemcisi kullanıcıdan gelen istek sayacını tutan sahte `send` ile verilir: reddedilen çağrılar `send`'e ulaşmaz.
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/src/errors.ts";
import { tenantCacheKey } from "../../shared/src/cache-key.ts";
import { assertOwnedKey, normalizeRelativeKey, storageContextFromMembership, type StorageContext } from "../../shared/src/storage.ts";
import { StorageConfigError, StorageDisabledError, createObjectStorage, createObjectStorageFromEnv } from "./index.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctxOf = (tenantId: string): StorageContext => storageContextFromMembership({ membershipId: "m-1", tenantId });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError:${String(e)}`;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError:${String(e)}`;
  }
  return undefined;
}

describe("normalizeRelativeKey", () => {
  it("geçerli anahtarı korur ve NFC'ye çevirir", () => {
    expect(normalizeRelativeKey("imports/2026/a.csv")).toBe("imports/2026/a.csv");
    expect(normalizeRelativeKey("café/x")).toBe("café/x");
  });

  it.each([
    ["boş", ""],
    ["mutlak", "/etc/passwd"],
    ["üst dizin", "../x"],
    ["ortada üst dizin", "a/../b"],
    ["nokta bölüm", "a/./b"],
    ["ters eğik çizgi", "a\\b"],
    ["boş bölüm", "a//b"],
    ["sonda eğik çizgi", "a/"],
    ["yalnızca noktalar", "a/..."],
    ["NUL", "a\u0000b"],
    ["satır sonu", "a\nb"],
    ["tam genişlikli nokta", "．．/x"],
    ["tam genişlikli eğik çizgi", "a／b／．．"],
    ["bidi geçersiz kılma", "a‮b"],
    ["eşleşmemiş vekil", "a\ud800b"],
    ["çok uzun", "a".repeat(1000)],
  ])("reddeder: %s", (_n, key) => {
    expect(codeOf(() => normalizeRelativeKey(key))).toBe("VALIDATION_FAILED");
  });

  it("dizge olmayan girdiyi reddeder", () => {
    expect(codeOf(() => normalizeRelativeKey(undefined))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => normalizeRelativeKey(42))).toBe("VALIDATION_FAILED");
  });
});

describe("assertOwnedKey", () => {
  const ctx = ctxOf(A);
  it("kendi önekini kabul eder", () => {
    expect(assertOwnedKey(ctx, `tenants/${A}/x/y.txt`)).toBe(`tenants/${A}/x/y.txt`);
  });
  it("başka tenant önekini FORBIDDEN ile reddeder", () => {
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${B}/x`))).toBe("FORBIDDEN");
  });
  it("öneksiz / mutlak / önek-benzeri anahtarı FORBIDDEN ile reddeder", () => {
    expect(codeOf(() => assertOwnedKey(ctx, "x"))).toBe("FORBIDDEN");
    expect(codeOf(() => assertOwnedKey(ctx, `/tenants/${A}/x`))).toBe("FORBIDDEN");
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${A}`))).toBe("FORBIDDEN");
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${A.toUpperCase()}/x`))).toBe("FORBIDDEN");
    expect(codeOf(() => assertOwnedKey(ctx, undefined))).toBe("FORBIDDEN");
  });
  it("öneki doğru ama yol geçişli anahtarı VALIDATION_FAILED ile reddeder", () => {
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${A}/../${B}/x`))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${A}/%2e%2e/x`))).toBeUndefined(); // yüzde kodu SDK/URL katmanında bir bölüm adıdır, yol geçişi değildir
  });
  it("NFC olmayan anahtarı reddeder (iki farklı yazım tek nesneye çözülmez)", () => {
    expect(codeOf(() => assertOwnedKey(ctx, `tenants/${A}/café`))).toBe("VALIDATION_FAILED");
  });
});

describe("StorageContext markası", () => {
  it("düz tenantId dizgisi ve nesne literali kabul edilmez", async () => {
    let sent = 0;
    const storage = createObjectStorage({ ...cfg(), client: fakeClient(() => sent++) });
    const forged = { tenantId: A } as unknown as StorageContext;
    expect(await asyncCodeOf(() => storage.get(forged, `tenants/${A}/x`))).toBe("FORBIDDEN");
    expect(await asyncCodeOf(() => storage.put(A as unknown as StorageContext, "x", new Uint8Array(), { contentType: "text/plain" }))).toBe("FORBIDDEN");
    expect(sent).toBe(0);
  });
  it("geçersiz üyelik FORBIDDEN", () => {
    expect(codeOf(() => storageContextFromMembership({ membershipId: "m", tenantId: "not-a-uuid" }))).toBe("FORBIDDEN");
    expect(codeOf(() => storageContextFromMembership({ membershipId: "", tenantId: A }))).toBe("FORBIDDEN");
    expect(codeOf(() => storageContextFromMembership(A as never))).toBe("FORBIDDEN");
  });
});

function cfg() {
  return { endpoint: "http://127.0.0.1:1", region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s", forcePathStyle: true };
}
function fakeClient(onSend: () => void): S3Client {
  return { send: () => { onSend(); return Promise.reject(new Error("network must not be reached")); } } as unknown as S3Client;
}

describe("adaptör: ağsız ret", () => {
  it("başka tenant anahtarı ve yol geçişi SDK'ya ulaşmaz", async () => {
    let sent = 0;
    const storage = createObjectStorage({ ...cfg(), client: fakeClient(() => sent++) });
    const ctx = ctxOf(A);
    expect(await asyncCodeOf(() => storage.get(ctx, `tenants/${B}/x`))).toBe("FORBIDDEN");
    expect(await asyncCodeOf(() => storage.delete(ctx, `tenants/${B}/x`))).toBe("FORBIDDEN");
    expect(await asyncCodeOf(() => storage.signedGetUrl(ctx, `tenants/${B}/x`, 60))).toBe("FORBIDDEN");
    expect(await asyncCodeOf(() => storage.get(ctx, `tenants/${A}/../${B}/x`))).toBe("VALIDATION_FAILED");
    expect(await asyncCodeOf(() => storage.put(ctx, "../x", new Uint8Array(), { contentType: "text/plain" }))).toBe("VALIDATION_FAILED");
    expect(await asyncCodeOf(() => storage.put(ctx, "/x", new Uint8Array(), { contentType: "text/plain" }))).toBe("VALIDATION_FAILED");
    expect(sent).toBe(0);
  });
  it.each([0, -1, 1.5, 3601, Number.NaN, Number.POSITIVE_INFINITY])("geçersiz imzalı URL süresi %s reddedilir", async (ttl) => {
    const storage = createObjectStorage({ ...cfg(), client: fakeClient(() => undefined) });
    expect(await asyncCodeOf(() => storage.signedGetUrl(ctxOf(A), `tenants/${A}/x`, ttl))).toBe("VALIDATION_FAILED");
  });
});

describe("STORAGE_ENABLED bayrağı (A-52)", () => {
  it("varsayılan kapalı: bağdaştırıcı oluşturulmaz", () => {
    expect(() => createObjectStorageFromEnv({})).toThrow(StorageDisabledError);
    expect(() => createObjectStorageFromEnv({ STORAGE_ENABLED: "false" })).toThrow(StorageDisabledError);
    expect(() => createObjectStorageFromEnv({ STORAGE_ENABLED: "1" })).toThrow(StorageDisabledError);
  });
  it("açıkken eksik ayar açık hata verir ve değeri yazmaz", () => {
    expect(() => createObjectStorageFromEnv({ STORAGE_ENABLED: "true", STORAGE_ENDPOINT: "http://x" })).toThrow(StorageConfigError);
  });
  it("açık ve tam ayarla oluşur", () => {
    const s = createObjectStorageFromEnv({ STORAGE_ENABLED: "true", STORAGE_ENDPOINT: "http://127.0.0.1:1", STORAGE_BUCKET: "b", STORAGE_ACCESS_KEY_ID: "k", STORAGE_SECRET_ACCESS_KEY: "s" });
    expect(typeof s.put).toBe("function");
  });
});

describe("tenantCacheKey", () => {
  it("t:<tenant>:<namespace>:<parça> biçimi", () => {
    expect(tenantCacheKey(ctxOf(A), "stock", "item", "42")).toBe(`t:${A}:stock:item:42`);
  });
  it("farklı tenant farklı anahtar", () => {
    expect(tenantCacheKey(ctxOf(A), "x", "1")).not.toBe(tenantCacheKey(ctxOf(B), "x", "1"));
  });
  it("ayırıcı parçalarda kaçırılır: parça birleşimiyle başka anahtar üretilemez", () => {
    expect(tenantCacheKey(ctxOf(A), "x", `a:b`)).not.toBe(tenantCacheKey(ctxOf(A), "x", "a", "b"));
    expect(tenantCacheKey(ctxOf(A), "x", `t:${B}:x:1`)).toBe(`t:${A}:x:t%3A${B}%3Ax%3A1`);
  });
  it("düz tenantId, geçersiz namespace ve boş parça reddedilir", () => {
    expect(codeOf(() => tenantCacheKey(A as unknown as StorageContext, "x"))).toBe("FORBIDDEN");
    expect(codeOf(() => tenantCacheKey(ctxOf(A), "X:y"))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => tenantCacheKey(ctxOf(A), "x", ""))).toBe("VALIDATION_FAILED");
  });
});
