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

/** İstek başına yenilenen kuyruk tutucusu: `canDeliver` eşzamanlıdır, kuyruk başlatması eşzamansızdır. */
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

/** Web'in tekil Better Auth örneği (port enjekte). Kuyruk tutucusunu yenilemek için `webAuthHandler` kullanın. */
export function getAuthService(): AuthService {
  const port = webResetMail();
  return getBaseAuthService(process.env, port === undefined ? {} : { resetMail: port });
}

/** `/api/auth/*`: kuyruğu (önbellekli) hazırlar, sonra Better Auth'a devreder; kuyruk yoksa `canDeliver` false kalır. */
async function handle(request: Request): Promise<Response> {
  if (webResetMail() !== undefined) {
    holder.queue = await getSenderQueue();
  }
  return getAuthService().handler(request);
}

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
