// S3 uyumlu `ObjectStorage` bağdaştırıcısı (T-125, ADR-006). `@aws-sdk/*` YALNIZCA bu pakette import edilir.
//
// Güvenlik sırası her işlemde aynıdır: (1) bağlam markası + tenant öneki + anahtar normalizasyonu — ağsız,
// (2) ancak sonra SDK çağrısı. Başka tenant önekli anahtar SDK'ya hiç ulaşmaz (`FORBIDDEN`). Bucket özeldir;
// istemciye yalnızca kısa ömürlü, tek anahtarlı, yalnızca GET imzalı URL verilir. Kimlik bilgileri ortamdan gelir
// ve loga/hataya yazılmaz (G-09). `STORAGE_ENABLED` kapalıyken (A-52: staging'de Tigris yok) bağdaştırıcı oluşturulmaz.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../../shared/src/errors.ts";
import {
  assertOwnedKey,
  assertSignedUrlTtl,
  buildTenantKey,
  isIssuedStorageContext,
  type ObjectStorage,
  type PutMeta,
  type StorageContext,
  type StoredObject,
} from "../../shared/src/storage.ts";

export interface ObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Geçici (STS) anahtarlar için; kalıcı erişim anahtarında boş. */
  readonly sessionToken?: string;
  /** MinIO için true; sağlayıcıya göre değişir. */
  readonly forcePathStyle: boolean;
  /** Test/gözlem için hazır istemci (ör. istek sayacı middleware'i). Verilirse kimlik alanları kullanılmaz. */
  readonly client?: S3Client;
}

/** Bayrak kapalıyken bağdaştırıcı istenirse. Kullanıcıya dönmez; çağıran açıkça işler (G-07: sahte başarı yok). */
export class StorageDisabledError extends Error {
  override name = "StorageDisabledError";
  constructor() {
    super("object storage is disabled (STORAGE_ENABLED is not 'true')");
  }
}

export class StorageConfigError extends Error {
  override name = "StorageConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

function mustGet(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new StorageConfigError(`${name} is required when STORAGE_ENABLED=true`);
  return v;
}

/** `STORAGE_ENABLED=true` değilse (varsayılan kapalı) `StorageDisabledError`; açıkken eksik ayar `StorageConfigError` (değer yazılmaz). */
export function readStorageConfig(env: Env): ObjectStorageConfig {
  if (env.STORAGE_ENABLED !== "true") throw new StorageDisabledError();
  return {
    endpoint: mustGet(env, "STORAGE_ENDPOINT"),
    region: env.STORAGE_REGION?.trim() || "us-east-1",
    bucket: mustGet(env, "STORAGE_BUCKET"),
    accessKeyId: mustGet(env, "STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: mustGet(env, "STORAGE_SECRET_ACCESS_KEY"),
    ...(env.STORAGE_SESSION_TOKEN?.trim() ? { sessionToken: env.STORAGE_SESSION_TOKEN } : {}),
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === "true",
  };
}

export function createObjectStorageFromEnv(env: Env): ObjectStorage {
  return createObjectStorage(readStorageConfig(env));
}

function internal(cause: unknown): AppError {
  const e = new AppError("INTERNAL");
  e.cause = cause;
  return e;
}

function isNotFound(e: unknown): boolean {
  return e instanceof S3ServiceException && (e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata.httpStatusCode === 404);
}

export function createObjectStorage(config: ObjectStorageConfig): ObjectStorage {
  const client =
    config.client ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
      },
    });
  const Bucket = config.bucket;

  function guard(ctx: StorageContext): void {
    if (!isIssuedStorageContext(ctx)) throw new AppError("FORBIDDEN");
  }

  return {
    async put(ctx: StorageContext, relativeKey: string, body: Uint8Array, meta: PutMeta): Promise<string> {
      guard(ctx);
      const key = buildTenantKey(ctx, relativeKey);
      if (!(body instanceof Uint8Array)) throw new AppError("VALIDATION_FAILED");
      if (typeof meta?.contentType !== "string" || meta.contentType === "") throw new AppError("VALIDATION_FAILED");
      try {
        await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: meta.contentType }));
      } catch (e) {
        throw internal(e);
      }
      return key;
    },

    async get(ctx: StorageContext, key: string): Promise<StoredObject> {
      guard(ctx);
      const owned = assertOwnedKey(ctx, key);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: owned }));
        if (out.Body === undefined) throw new Error("empty body");
        return { body: await out.Body.transformToByteArray(), contentType: out.ContentType };
      } catch (e) {
        if (isNotFound(e)) throw new AppError("NOT_FOUND");
        throw internal(e);
      }
    },

    async delete(ctx: StorageContext, key: string): Promise<void> {
      guard(ctx);
      const owned = assertOwnedKey(ctx, key);
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: owned }));
      } catch (e) {
        throw internal(e);
      }
    },

    async signedGetUrl(ctx: StorageContext, key: string, ttlSec: number): Promise<string> {
      guard(ctx);
      const owned = assertOwnedKey(ctx, key);
      const expiresIn = assertSignedUrlTtl(ttlSec);
      try {
        return await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: owned }), { expiresIn });
      } catch (e) {
        throw internal(e);
      }
    },
  };
}
