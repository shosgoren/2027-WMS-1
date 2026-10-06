// T-116d: web auth kurulumu — sıfırlama e-postası portu fail-closed davranışı (A-42). Alıcı/bağlantı yalnızca mühürlü yükte.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildResetMail, type QueueHolder } from "./auth-service.ts";

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
