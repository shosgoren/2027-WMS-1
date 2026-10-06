// T-116d: web auth kurulumu — sıfırlama e-postası portu fail-closed davranışı (A-42). Alıcı/bağlantı yalnızca mühürlü yükte.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEUE_NEGATIVE_CACHE_MS, QUEUE_PREPARE_TIMEOUT_MS, buildResetMail, createRouteHandler, type QueueHolder } from "./auth-service.ts";

vi.mock("@wms/auth", () => ({ getAuthService: () => ({}) }));
vi.mock("./queue.ts", () => ({ getSenderQueue: () => Promise.resolve(undefined) }));

const KEY = randomBytes(32).toString("hex");
const MAILPIT = { MAIL_MODE: "mailpit", MAILPIT_URL: "http://localhost:8025", MAIL_FROM: "noreply@example.test", WMS_ENV: "ci", QUEUE_SEAL_KEY: KEY };
const TO = "user-a@example.test";

function mkHolder(): { holder: QueueHolder; jobs: unknown[] } {
  const jobs: unknown[] = [];
  return { holder: { queue: { enqueuePlatform: (j: unknown) => (jobs.push(j), Promise.resolve({ jobId: "j" })) } as never }, jobs };
}

afterEach(() => vi.restoreAllMocks());

describe("buildResetMail", () => {
  it("kuyruk hazırken teslim edilebilir; tek email.send platform işi, düz alıcı/bağlantı yok", async () => {
    const { holder, jobs } = mkHolder();
    const port = buildResetMail(MAILPIT, holder);
    expect(port?.canDeliver(TO)).toBe(true);
    await port?.sendResetLink({ to: TO, link: "https://app.example.test/reset-password/tok123", locale: "tr" });
    expect(jobs).toHaveLength(1);
    const text = JSON.stringify(jobs[0]);
    expect(text).toContain("email.send");
    expect(text).not.toContain(TO);
    expect(text).not.toContain("tok123");
  });

  it("kuyruk yoksa canDeliver false (503 yolu)", () => {
    expect(buildResetMail(MAILPIT, { queue: undefined })?.canDeliver(TO)).toBe(false);
  });

  it("mail kipi disabled ise canDeliver false", () => {
    expect(buildResetMail({ ...MAILPIT, MAIL_MODE: "disabled" }, mkHolder().holder)?.canDeliver(TO)).toBe(false);
  });

  it("yanlış ortamda mailpit, geçersiz kip veya geçersiz mühür anahtarı: port yok, log değer içermez", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(buildResetMail({ ...MAILPIT, WMS_ENV: "production" }, mkHolder().holder)).toBeUndefined();
    expect(buildResetMail({ ...MAILPIT, MAIL_MODE: "bogus" }, mkHolder().holder)).toBeUndefined();
    expect(buildResetMail({ ...MAILPIT, QUEUE_SEAL_KEY: "short" }, mkHolder().holder)).toBeUndefined();
    expect(err).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(err.mock.calls)).not.toContain(KEY);
  });

  it("gönderim sırasında kuyruk kaybolursa hata fırlatır (sahte başarı yok)", async () => {
    const holder: QueueHolder = mkHolder().holder;
    const port = buildResetMail(MAILPIT, holder);
    holder.queue = undefined;
    await expect(port?.sendResetLink({ to: TO, link: "https://app.example.test/x", locale: "tr" })).rejects.toThrow();
  });
});

describe("createRouteHandler (kuyruk hazırlığı yalnızca sıfırlama isteğinde)", () => {
  const post = (path: string): Request => new Request(`https://app.example.test/api/auth/${path}`, { method: "POST" });
  const mk = (getQueue: () => Promise<never | undefined>, now = () => 0) => {
    const holder: QueueHolder = { queue: undefined };
    const handler = vi.fn(() => Promise.resolve(new Response("ok")));
    const getQ = vi.fn(getQueue);
    return { holder, handler, getQ, route: createRouteHandler({ hasPort: () => true, getQueue: getQ, holder, handler, now }) };
  };

  it("get-session / sign-in isteklerinde getSenderQueue çağrılmaz", async () => {
    const t = mk(() => Promise.resolve({} as never));
    await t.route(new Request("https://app.example.test/api/auth/get-session"));
    await t.route(post("sign-in/email"));
    expect(t.getQ).not.toHaveBeenCalled();
    expect(t.handler).toHaveBeenCalledTimes(2);
  });

  it("sıfırlama isteğinde kuyruk hazırlanır", async () => {
    const q = {} as never;
    const t = mk(() => Promise.resolve(q));
    await t.route(post("request-password-reset"));
    expect(t.getQ).toHaveBeenCalledTimes(1);
    expect(t.holder.queue).toBe(q);
  });

  it("kuyruk asılıyken sign-in etkilenmez; sıfırlama 2 sn sonra queue=undefined ile devam eder, 30 sn negatif önbellek", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const t = mk(() => new Promise(() => undefined), () => clock);
      const signIn = await t.route(post("sign-in/email"));
      expect(signIn.status).toBe(200);
      expect(t.getQ).not.toHaveBeenCalled();
      const pending = t.route(post("request-password-reset"));
      await vi.advanceTimersByTimeAsync(QUEUE_PREPARE_TIMEOUT_MS);
      await pending;
      expect(t.holder.queue).toBeUndefined();
      clock = QUEUE_NEGATIVE_CACHE_MS - 1;
      await t.route(post("request-password-reset"));
      expect(t.getQ).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
