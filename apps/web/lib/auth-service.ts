// Web sürecinin Better Auth kurulumu (T-116d; A-42). `@wms/auth` `@wms/domain`'i içe aktarmaz: self-servis sıfırlama e-postası
// portu (`createResetMailPort`, T-117b) burada kurulup `getAuthService`'e enjekte edilir. Web'deki TÜM auth erişimi bu modülden
// geçer (tekil örnek ilk kurulandaki portu taşır; porttan habersiz bir çağrı örneği portsuz kurup 503'te bırakırdı).
//
// Fail-closed (sahte başarı yok): geçersiz/izinsiz MAIL_MODE, geçersiz QUEUE_SEAL_KEY → port yok (503 MAIL_DELIVERY_DISABLED);
// kuyruk (gönderen istemci) başlatılamıyorsa `canDeliver` false → aynı 503. Alıcı yalnızca mühürlü yükte yaşar; loga girmez (G-09).
import { getAuthService as getBaseAuthService, type AuthService, type ResetMailPort } from "@wms/auth";
import { createResetMailPort } from "@wms/domain/identity/memberships";
import { AppError } from "@wms/shared/errors";
import { assertMailModeAllowed, loadMailConfig } from "@wms/shared/mailer";
import { createSealer } from "@wms/shared/seal";
import type { JobQueue } from "@wms/shared/queue";
import { getSenderQueue } from "./queue.ts";

type EnvLike = Readonly<Record<string, string | undefined>>;
type EnqueueOnly = Pick<JobQueue, "enqueuePlatform">;

/** Kuyruk tutucusu: `canDeliver` eşzamanlıdır, kuyruk başlatması eşzamansızdır; sıfırlama isteğinde (önbellekli) yenilenir. */
export interface QueueHolder {
  queue: EnqueueOnly | undefined;
}

const logError = (msg: string, error: unknown): void => {
  // Yalnızca sınıf adı (mesaj alıcı/anahtar taşıyabilir, G-09).
  console.error(JSON.stringify({ level: "error", msg, error: error instanceof Error ? error.name : "unknown" }));
};

/**
 * Port kurulumu (saf; testlenebilir). Yapılandırma geçersizse `undefined` (fail-closed). `canDeliver`: kuyruk hazır VE mail kipi
 * alıcıya gönderebiliyor (Resend test kipi/`disabled` → false).
 */
export function buildResetMail(env: EnvLike, holder: QueueHolder): ResetMailPort | undefined {
  let base: ReturnType<typeof createResetMailPort>;
  try {
    const mailConfig = loadMailConfig(env);
    assertMailModeAllowed(mailConfig, env.WMS_ENV?.trim());
    const sealer = createSealer(env.QUEUE_SEAL_KEY);
    const queue: EnqueueOnly = {
      enqueuePlatform: (job) => {
        const q = holder.queue;
        if (q === undefined) return Promise.reject(new AppError("INTERNAL"));
        return q.enqueuePlatform(job);
      },
    };
    base = createResetMailPort({ mailConfig, queue, sealKey: sealer });
  } catch (error) {
    logError("password reset mail disabled: invalid configuration", error);
    return undefined;
  }
  return {
    canDeliver: (recipient) => holder.queue !== undefined && base.canDeliver(recipient),
    sendResetLink: (input) => base.sendResetLink(input),
  };
}

const holder: QueueHolder = { queue: undefined };
let resetMail: ResetMailPort | undefined;
let resetMailBuilt = false;

/** Port süreç başına bir kez kurulur (ortam sabit). */
function webResetMail(): ResetMailPort | undefined {
  if (!resetMailBuilt) {
    resetMail = buildResetMail(process.env, holder);
    resetMailBuilt = true;
  }
  return resetMail;
}

/** Web'in tekil Better Auth örneği (port enjekte). Kuyruk hazırlığı `authRouteHandlers` içinde yapılır. */
export function getAuthService(): AuthService {
  const port = webResetMail();
  return getBaseAuthService(process.env, port === undefined ? {} : { resetMail: port });
}

/** Better Auth 1.7.7 kurulu yolu (`dist/api/routes/password.mjs`: createAuthEndpoint("/request-password-reset")). */
const RESET_REQUEST_SUFFIX = "/request-password-reset";
export const QUEUE_PREPARE_TIMEOUT_MS = 2_000;
export const QUEUE_NEGATIVE_CACHE_MS = 30_000;

export interface RouteDeps {
  readonly hasPort: () => boolean;
  readonly getQueue: () => Promise<EnqueueOnly | undefined>;
  readonly holder: QueueHolder;
  readonly handler: (request: Request) => Promise<Response>;
  readonly now?: () => number;
}

/**
 * `/api/auth/*` işleyicisi. Kuyruk hazırlığı YALNIZCA `POST …/request-password-reset` için yapılır (diğer uçlar kuyruğa hiç
 * dokunmaz; kuyruk asılsa da giriş etkilenmez). Hazırlık süre sınırlıdır; başarısızlık/aşım `canDeliver`'ı false yapar (503) ve
 * `QUEUE_NEGATIVE_CACHE_MS` boyunca yeniden denenmez.
 */
export function createRouteHandler(deps: RouteDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  let retryAfter = 0;
  return async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(RESET_REQUEST_SUFFIX) && deps.hasPort()) {
      if (now() < retryAfter) {
        deps.holder.queue = undefined;
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), QUEUE_PREPARE_TIMEOUT_MS);
        });
        try {
          deps.holder.queue = await Promise.race([deps.getQueue().catch(() => undefined), timeout]);
        } finally {
          clearTimeout(timer);
        }
        if (deps.holder.queue === undefined) retryAfter = now() + QUEUE_NEGATIVE_CACHE_MS;
      }
    }
    return deps.handler(request);
  };
}

const handle = createRouteHandler({
  hasPort: () => webResetMail() !== undefined,
  getQueue: getSenderQueue,
  holder,
  handler: (request) => getAuthService().handler(request),
});

export const authRouteHandlers = Object.freeze({
  GET: handle,
  POST: handle,
});

/** Kimlik doğrulama yardımcıları (eskiden `@wms/auth` düz işlevleri); aynı tekil örnek üzerinden. */
export const ensureRecentAuth = (headers: Headers): Promise<void> => getAuthService().ensureRecentAuth(headers);
export const createPasswordResetToken: AuthService["createPasswordResetToken"] = (userId, tenantId) =>
  getAuthService().createPasswordResetToken(userId, tenantId);
export const discardPasswordResetToken: AuthService["discardPasswordResetToken"] = (id) => getAuthService().discardPasswordResetToken(id);
export const recordPasswordResetLinkIssued: AuthService["recordPasswordResetLinkIssued"] = (input) =>
  getAuthService().recordPasswordResetLinkIssued(input);
export const createInvitedAccount: AuthService["createInvitedAccount"] = (input) => getAuthService().createInvitedAccount(input);
