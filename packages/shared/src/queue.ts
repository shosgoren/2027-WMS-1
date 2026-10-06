// İş kuyruğu sözleşmesi (ADR-005, ADR-016 §12): sağlayıcıdan bağımsız `JobQueue` arayüzü, kayıtlı iş
// türleri ve iş yükü şemaları. Sağlayıcı kütüphanesi (pg-boss) yalnızca `packages/queue-adapter` içindedir.
//
// Tenant kimliği iş yükünün parçası DEĞİLDİR: `enqueue(tx, job)` onu `tx`'in `app.current_tenant_id`
// ayarından türetir ve işi tüketen handler'a bağlam olarak verir. Çağıranın başka tenant kimliği
// vermesinin yolu yoktur (tipte alan yok; çalışma anında bilinmeyen alan reddedilir).
import { z } from "zod";

/** Kayıtlı iş türleri. `email.send` T-116, `invitation.deliver` T-117, `demo.reseed` T-123 tarafından doldurulur. */
export const JOB_TYPES = ["email.send", "invitation.deliver", "demo.reseed"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * İş yükünde adı bunlardan birini içeren alan yasaktır (M2): düz belirteç/bağlantı/parola kuyruğa yazılmaz.
 * Hassas veri yalnızca `sealed` alanında (mühürlü, T-116) taşınır.
 */
export const FORBIDDEN_PAYLOAD_KEY_RE = /token|url|password/i;

/** Türe göre kayıtlı iş yükü şemaları. Tüm nesneler `strict`: bilinmeyen alan (örn. `tenantId`) reddedilir. */
export const JOB_PAYLOAD_SCHEMAS = {
  "email.send": z
    .object({
      template: z.string().min(1),
      locale: z.enum(["tr", "en"]),
      /** Alıcı + bağlantı mühürlü biçimde (T-116 `seal.ts`); düz değer yok. */
      sealed: z.record(z.string(), z.union([z.string(), z.number()])),
    })
    .strict(),
  /** Davet teslimi (T-117): yalnızca davet kimliği; belirteç worker'da üretilir, yüke/DB'ye düz yazılmaz (A-42). */
  "invitation.deliver": z.object({ invitationId: z.string().uuid() }).strict(),
  "demo.reseed": z.object({}).strict(),
} as const satisfies Record<JobType, z.ZodType>;

export type JobPayload<T extends JobType> = z.infer<(typeof JOB_PAYLOAD_SCHEMAS)[T]>;

/** Kuyruğa yazılacak iş. `tenantId` alanı yoktur (ADR-016 §12). */
export type Job = {
  [T in JobType]: {
    readonly type: T;
    readonly actorUserId?: string;
    readonly payload: JobPayload<T>;
    /** Aynı (tenant, tür, anahtar) için kuyrukta/çalışırken ikinci iş oluşmaz. */
    readonly singletonKey?: string;
  };
}[JobType];

/** `enqueue` sonucu: `jobId` null ise aynı `singletonKey` ile iş zaten vardı (yeni iş yazılmadı). */
export interface EnqueueResult {
  readonly jobId: string | null;
}

/**
 * Handler'a verilen bağlam. Ham tenant kimliği YOKTUR: handler tenant verisine yalnızca `inTenant` ile erişir;
 * bu, tenant bağlamını (`withSystemTenant`/`withMembership` ailesi, tenant ACTIVE denetimiyle) kurar. Platform
 * işlerinde (`enqueuePlatform`) `inTenant` `FORBIDDEN` ile reddeder.
 */
export type JobContext<T extends JobType = JobType, Tx = unknown> = {
  [K in T]: {
    readonly jobId: string;
    readonly type: K;
    /** Tenant işi mi (yalnızca bilgi; kimlik sızdırmaz). */
    readonly hasTenant: boolean;
    readonly actorUserId: string | null;
    readonly payload: JobPayload<K>;
    inTenant<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  };
}[T];

export type JobHandler<T extends JobType = JobType, Tx = unknown> = (ctx: JobContext<T, Tx>) => Promise<void>;

/**
 * Sağlayıcıdan bağımsız kuyruk arayüzü. `Tx` tenant transaction'ının tipidir (adaptör belirler;
 * bu paket sürücüden bağımsız kalır).
 */
export interface JobQueue<Tx = unknown> {
  /** İşi çağıranın tenant transaction'ında yazar; transaction geri alınırsa iş hiç oluşmaz. */
  enqueue(tx: Tx, job: Job): Promise<EnqueueResult>;
  /** Tenant'sız (platform) iş; kendi kısa transaction'ında yazılır. */
  enqueuePlatform(job: Job): Promise<EnqueueResult>;
  /** Tür için tüketici kaydeder; kayıtlı olmayan türde hata. */
  work<T extends JobType>(type: T, handler: JobHandler<T, Tx>): Promise<void>;
  /** Yeni iş almayı durdurur, çalışan işleri (zaman aşımına kadar) bekler. */
  stop(): Promise<void>;
}

/** Kuyruk hata kodları (`docs/spec/15-engineering.md` listesinden). */
export type QueueErrorCode = "FORBIDDEN" | "VALIDATION_FAILED";

export class QueueError extends Error {
  override name = "QueueError";
  readonly code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

const JOB_ALLOWED_KEYS: ReadonlySet<string> = new Set(["type", "actorUserId", "payload", "singletonKey"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLETON_KEY_MAX = 200;
/** Sağlayıcı anahtar karakter kümesiyle uyumlu, sağlayıcıya özgü olmayan kısıt. */
const SINGLETON_KEY_RE = /^[\w.\-/]+$/;
const PAYLOAD_MAX_DEPTH = 16;

function findForbiddenKey(value: unknown, depth = 0): string | undefined {
  if (depth > PAYLOAD_MAX_DEPTH) return "(derinlik sınırı)";
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenKey(item, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEY_RE.test(key)) return key;
      const hit = findForbiddenKey(inner, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * İşi doğrular ve yazılacak biçimde döndürür: bilinmeyen üst düzey alan (örn. `tenantId`), kayıtsız tür,
 * yasaklı alan adı (`token|url|password`) ve şemaya uymayan yük `VALIDATION_FAILED` ile reddedilir.
 */
export function parseJob(job: unknown): Job {
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    throw new QueueError("VALIDATION_FAILED", "job must be an object");
  }
  const record = job as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!JOB_ALLOWED_KEYS.has(key)) {
      throw new QueueError("VALIDATION_FAILED", `job has unknown field: ${key}`);
    }
  }
  const type = record.type;
  if (!isJobType(type)) {
    throw new QueueError("VALIDATION_FAILED", "job type is not registered");
  }
  const forbidden = findForbiddenKey(record.payload);
  if (forbidden !== undefined) {
    throw new QueueError("VALIDATION_FAILED", `payload field name is forbidden: ${forbidden}`);
  }
  const parsed = JOB_PAYLOAD_SCHEMAS[type].safeParse(record.payload);
  if (!parsed.success) {
    throw new QueueError("VALIDATION_FAILED", `payload does not match the schema of ${type}`);
  }
  const { actorUserId, singletonKey } = record;
  if (actorUserId !== undefined && (typeof actorUserId !== "string" || !UUID_RE.test(actorUserId))) {
    throw new QueueError("VALIDATION_FAILED", "actorUserId must be a UUID");
  }
  if (
    singletonKey !== undefined &&
    (typeof singletonKey !== "string" || singletonKey.length > SINGLETON_KEY_MAX || !SINGLETON_KEY_RE.test(singletonKey))
  ) {
    throw new QueueError("VALIDATION_FAILED", "singletonKey must match [A-Za-z0-9_.-/]+ (max 200)");
  }
  return { type, payload: parsed.data, actorUserId, singletonKey } as Job;
}
