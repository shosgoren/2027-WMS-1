import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_SEND_JOB_TYPE,
  MailError,
  buildEmailSendPayload,
  canDeliver,
  loadMailConfig,
  maskRecipient,
  type MailConfig,
  type Mailer,
} from "@wms/shared/mailer";
import { JOB_PAYLOAD_SCHEMAS, parseJob } from "@wms/shared/queue";
import { QUEUE_SEAL_KEY_PLACEHOLDER, SealConfigError, SealOpenError, createSealer } from "@wms/shared/seal";
import { createMailer, createSendEmailHandler } from "../jobs/send-email.js";
import { createJsonLogger } from "../lifecycle.js";
import { createMailpitMailer, parseFrom } from "./mailpit.js";
import { createResendMailer } from "./resend.js";
import { renderTemplate } from "./templates.js";

// Sentetik değerler çalışma anında üretilir (gitleaks literal yakalar).
const newKey = (): string => randomBytes(32).toString("hex");
const apiKey = `k_${randomBytes(12).toString("hex")}`;
const RECIPIENT = `alice.${randomBytes(3).toString("hex")}@example.invalid`;
const LINK = `https://app.example.invalid/reset/${randomBytes(16).toString("hex")}`;
const CTX = { jobType: EMAIL_SEND_JOB_TYPE, template: "password_reset" };

function config(env: Record<string, string>): MailConfig {
  return loadMailConfig(env);
}

describe("canDeliver", () => {
  const listed = RECIPIENT.toUpperCase();
  const rows: Array<[string, Record<string, string>, string, boolean]> = [
    ["disabled", { MAIL_MODE: "disabled" }, RECIPIENT, false],
    ["MAIL_MODE yok -> disabled", {}, RECIPIENT, false],
    ["mailpit", { MAIL_MODE: "mailpit" }, RECIPIENT, true],
    ["resend, alan adı yok, izinli alıcı (büyük/küçük harf duyarsız)", { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "a@b.c", MAIL_RESTRICTED_RECIPIENTS: `x@y.z, ${RECIPIENT}` }, listed, true],
    ["resend, alan adı yok, izinsiz alıcı", { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "a@b.c", MAIL_RESTRICTED_RECIPIENTS: "x@y.z" }, RECIPIENT, false],
    ["resend, alan adı yok, liste boş", { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "a@b.c" }, RECIPIENT, false],
    ["resend, doğrulanmış alan adı", { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "a@b.c", MAIL_VERIFIED_DOMAIN: "b.c" }, RECIPIENT, true],
    ["resend, anahtar yok", { MAIL_MODE: "resend", MAIL_FROM: "a@b.c", MAIL_VERIFIED_DOMAIN: "b.c" }, RECIPIENT, false],
    ["resend, gönderen yok", { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_VERIFIED_DOMAIN: "b.c" }, RECIPIENT, false],
  ];
  it.each(rows)("%s", (_name, env, recipient, expected) => {
    expect(canDeliver(config(env), recipient)).toBe(expected);
  });
  it("bilinmeyen MAIL_MODE yapılandırma hatasıdır", () => {
    expect(() => config({ MAIL_MODE: "smtp" })).toThrow(/MAIL_MODE/);
  });
});

describe("maskRecipient", () => {
  it("a***@d*** biçimi", () => {
    expect(maskRecipient("alice@domain.example")).toBe("a***@d***");
    expect(maskRecipient("bozuk")).toBe("***");
  });
});

describe("seal", () => {
  const plain = { to: RECIPIENT, link: LINK };
  it("aç/kapa gidiş dönüş; düz değer mühürde yok", () => {
    const s = createSealer(newKey());
    const box = s.seal(plain, CTX);
    expect(Object.keys(box).sort()).toEqual(["ct", "iv", "kid", "tag", "v"]);
    expect(JSON.stringify(box)).not.toContain(RECIPIENT);
    expect(JSON.stringify(box)).not.toContain("reset/");
    expect(s.open(box, CTX)).toEqual(plain);
  });
  it("her mühür farklı iv kullanır", () => {
    const s = createSealer(newKey());
    expect(s.seal(plain, CTX).iv).not.toBe(s.seal(plain, CTX).iv);
  });
  it("yanlış anahtar -> hata", () => {
    const box = createSealer(newKey()).seal(plain, CTX);
    expect(() => createSealer(newKey()).open(box, CTX)).toThrow(SealOpenError);
  });
  it("kurcalanmış tag veya ct -> hata", () => {
    const s = createSealer(newKey());
    const box = s.seal(plain, CTX);
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = (buf[0] ?? 0) ^ 1;
      return buf.toString("base64");
    };
    expect(() => s.open({ ...box, tag: flip(box.tag) }, CTX)).toThrow(SealOpenError);
    expect(() => s.open({ ...box, ct: flip(box.ct) }, CTX)).toThrow(SealOpenError);
  });
  it("farklı AAD (iş türü veya şablon) -> hata", () => {
    const s = createSealer(newKey());
    const box = s.seal(plain, CTX);
    expect(() => s.open(box, { ...CTX, template: "invitation" })).toThrow(SealOpenError);
    expect(() => s.open(box, { ...CTX, jobType: "demo.reseed" })).toThrow(SealOpenError);
  });
  it("bozuk biçim -> hata", () => {
    const s = createSealer(newKey());
    expect(() => s.open(null, CTX)).toThrow(SealOpenError);
    expect(() => s.open({ v: 1 }, CTX)).toThrow(SealOpenError);
  });
  it("anahtar boş, kısa veya yer tutucu -> açılış hatası", () => {
    expect(() => createSealer(undefined)).toThrow(SealConfigError);
    expect(() => createSealer("  ")).toThrow(SealConfigError);
    expect(() => createSealer("abcd")).toThrow(SealConfigError);
    expect(() => createSealer(randomBytes(16).toString("hex"))).toThrow(SealConfigError);
    expect(() => createSealer(QUEUE_SEAL_KEY_PLACEHOLDER)).toThrow(SealConfigError);
  });
  it(".env.example yer tutucusu koddaki yer tutucuyla aynıdır ve reddedilir", () => {
    const env = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("QUEUE_SEAL_KEY="));
    expect(line?.slice("QUEUE_SEAL_KEY=".length).trim()).toBe(QUEUE_SEAL_KEY_PLACEHOLDER);
  });
  it("base64 32 bayt anahtar kabul edilir", () => {
    const s = createSealer(randomBytes(32).toString("base64"));
    expect(s.open(s.seal(plain, CTX), CTX)).toEqual(plain);
  });
});

describe("kuyruk yükü", () => {
  it("buildEmailSendPayload yalnızca { template, locale, sealed } üretir ve kuyruk şemasına uyar", () => {
    const payload = buildEmailSendPayload(newKey(), { template: "password_reset", locale: "tr", to: RECIPIENT, link: LINK });
    expect(Object.keys(payload).sort()).toEqual(["locale", "sealed", "template"]);
    expect(JOB_PAYLOAD_SCHEMAS["email.send"].safeParse(payload).success).toBe(true);
    expect(() => parseJob({ type: "email.send", payload })).not.toThrow();
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain(RECIPIENT);
    expect(raw).not.toContain(LINK);
  });
  it("anahtar yoksa kuyruğa yazılamaz (açık hata)", () => {
    expect(() => buildEmailSendPayload(undefined, { template: "invitation", locale: "en", to: RECIPIENT, link: LINK })).toThrow(SealConfigError);
  });
});

describe("şablonlar", () => {
  it.each(["invitation", "password_reset"] as const)("%s TR/EN bağlantıyı içerir", (template) => {
    for (const locale of ["tr", "en"] as const) {
      const r = renderTemplate(template, locale, LINK);
      expect(r.text).toContain(LINK);
      expect(r.html).toContain(LINK);
      expect(r.subject).toContain("Etkin WMS");
      expect(r.text).not.toContain(RECIPIENT);
    }
    expect(renderTemplate(template, "tr", LINK).text).not.toBe(renderTemplate(template, "en", LINK).text);
  });
  it("HTML'de bağlantı kaçışlanır; http(s) dışı bağlantı reddedilir", () => {
    expect(renderTemplate("invitation", "en", "https://x.example.invalid/?a=1&b=\"2\"").html).toContain("a=1&amp;b=&quot;2&quot;");
    expect(() => renderTemplate("invitation", "en", "javascript:alert(1)")).toThrow();
    expect(() => renderTemplate("invitation", "en", "değil")).toThrow();
  });
});

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ id: "x" }), { status });
}

describe("Resend istemcisi", () => {
  it("doğru uç nokta, başlıklar ve gövde", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200));
    const jobId = randomUUID();
    await createResendMailer({ apiKey, from: "Etkin <a@b.c>", fetch: f }).send({ to: RECIPIENT, subject: "S", text: "T", html: "<p>H</p>", idempotencyKey: jobId });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": jobId });
    expect(JSON.parse(String(init?.body))).toEqual({ from: "Etkin <a@b.c>", to: [RECIPIENT], subject: "S", html: "<p>H</p>", text: "T" });
  });
  it("4xx/5xx hata fırlatır; mesajda adres/anahtar yok", async () => {
    for (const status of [422, 429, 500]) {
      const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(`{"message":"${RECIPIENT}"}`, { status }));
      const err = await createResendMailer({ apiKey, from: "a@b.c", fetch: f }).send({ to: RECIPIENT, subject: "S", text: "T", html: "H", idempotencyKey: "k" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailError);
      expect(String((err as Error).message)).toContain(String(status));
      expect(String((err as Error).message)).not.toContain(RECIPIENT);
    }
  });
  it("ağ hatası MailError olur ve ayrıntı sızdırmaz", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${RECIPIENT}`));
    const err = await createResendMailer({ apiKey, from: "a@b.c", fetch: f }).send({ to: RECIPIENT, subject: "S", text: "T", html: "H", idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as Error).message).not.toContain(RECIPIENT);
  });
});

describe("Mailpit istemcisi", () => {
  it("POST /api/v1/send, büyük harfli alanlar", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200));
    await createMailpitMailer({ baseUrl: "http://localhost:8025/", from: "Etkin WMS <n@e.local>", fetch: f }).send({ to: RECIPIENT, subject: "S", text: "T", html: "H", idempotencyKey: "k" });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8025/api/v1/send");
    expect(JSON.parse(String(init?.body))).toEqual({ From: { Email: "n@e.local", Name: "Etkin WMS" }, To: [{ Email: RECIPIENT }], Subject: "S", Text: "T", HTML: "H" });
  });
  it("parseFrom yalın adresi destekler; hata durumu fırlatır", async () => {
    expect(parseFrom("n@e.local")).toEqual({ Email: "n@e.local" });
    const f = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(400));
    await expect(createMailpitMailer({ baseUrl: "http://x", from: "n@e.local", fetch: f }).send({ to: RECIPIENT, subject: "S", text: "T", html: "H", idempotencyKey: "k" })).rejects.toBeInstanceOf(MailError);
  });
});

describe("email.send işleyicisi", () => {
  const key = newKey();
  const sealer = createSealer(key);
  function setup(env: Record<string, string>, opts: { hasTenant?: boolean; inTenant?: () => Promise<void> } = {}) {
    const lines: string[] = [];
    const logger = createJsonLogger((l) => lines.push(l));
    const send = vi.fn<Mailer["send"]>().mockResolvedValue(undefined);
    const cfg = config(env);
    const handler = createSendEmailHandler({ sealer, config: cfg, mailer: { send }, logger });
    const payload = buildEmailSendPayload(sealer, { template: "password_reset", locale: "tr", to: RECIPIENT, link: LINK });
    const jobId = randomUUID();
    const inTenant = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      await opts.inTenant?.();
      return fn(undefined);
    });
    const ctx = { jobId, type: "email.send" as const, hasTenant: opts.hasTenant ?? false, actorUserId: null, payload, inTenant } as unknown as Parameters<typeof handler>[0];
    return { handler, ctx, send, lines, inTenant, jobId, payload };
  }

  it("gönderir; idempotency anahtarı = iş kimliği; log'da tam adres/bağlantı yok", async () => {
    const t = setup({ MAIL_MODE: "mailpit" });
    await t.handler(t.ctx);
    expect(t.send).toHaveBeenCalledTimes(1);
    const sent = t.send.mock.calls[0]?.[0];
    expect(sent?.idempotencyKey).toBe(t.jobId);
    expect(sent?.to).toBe(RECIPIENT);
    expect(sent?.text).toContain(LINK);
    const log = t.lines.join("\n");
    expect(log).toContain("a***@e***");
    expect(log).not.toContain(RECIPIENT);
    expect(log).not.toContain(LINK);
    expect(t.inTenant).not.toHaveBeenCalled();
  });
  it("tenant işinde ACTIVE doğrulaması ctx.inTenant ile; reddedilirse gönderilmez ve hata fırlar", async () => {
    const ok = setup({ MAIL_MODE: "mailpit" }, { hasTenant: true });
    await ok.handler(ok.ctx);
    expect(ok.inTenant).toHaveBeenCalledTimes(1);
    const bad = setup({ MAIL_MODE: "mailpit" }, { hasTenant: true, inTenant: () => Promise.reject(new Error("tenant status is not active")) });
    await expect(bad.handler(bad.ctx)).rejects.toThrow("tenant status");
    expect(bad.send).not.toHaveBeenCalled();
  });
  it("teslim edilemeyen ortamda MAIL_DELIVERY_DISABLED fırlatır, sahte başarı yok", async () => {
    for (const env of [{ MAIL_MODE: "disabled" } as Record<string, string>, { MAIL_MODE: "resend", RESEND_API_KEY: apiKey, MAIL_FROM: "a@b.c" }]) {
      const t = setup(env);
      const err = await t.handler(t.ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailError);
      expect((err as MailError).code).toBe("MAIL_DELIVERY_DISABLED");
      expect(t.send).not.toHaveBeenCalled();
      expect(t.lines.join("\n")).not.toContain(RECIPIENT);
    }
  });
  it("Mailer hatası yutulmaz (yeniden deneme için fırlatılır) ve adres loglanmaz", async () => {
    const t = setup({ MAIL_MODE: "mailpit" });
    t.send.mockRejectedValue(new MailError("MAIL_SEND_FAILED", "resend responded with status 500"));
    await expect(t.handler(t.ctx)).rejects.toBeInstanceOf(MailError);
    expect(t.lines.join("\n")).not.toContain(RECIPIENT);
  });
  it("başka şablona taşınan mühür açılmaz", async () => {
    const t = setup({ MAIL_MODE: "mailpit" });
    const moved = { ...t.payload, template: "invitation" as const };
    const ctx = { ...t.ctx, payload: moved } as unknown as typeof t.ctx;
    await expect(t.handler(ctx)).rejects.toBeInstanceOf(SealOpenError);
    expect(t.send).not.toHaveBeenCalled();
  });
  it("createMailer: disabled kipinde gönderim MAIL_DELIVERY_DISABLED ile reddedilir", async () => {
    await expect(createMailer(config({ MAIL_MODE: "disabled" })).send({ to: RECIPIENT, subject: "S", text: "T", html: "H", idempotencyKey: "k" })).rejects.toMatchObject({ code: "MAIL_DELIVERY_DISABLED" });
  });
});
