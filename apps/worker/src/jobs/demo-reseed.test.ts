// registerDemoReseed (T-123a MAJOR-2, A-63): prod/tanımsız ortamda demo kaydı fail-closed — iş kaydedilmez, zamanlayıcı
// başlamaz, `wms_auth` havuzu açılmaz, bağdaştırıcı modülü yüklenmez. Parola testte üretilir (G-09).
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AccessDbClient } from "@wms/domain/identity/access";
import { registerDemoReseed } from "./demo-reseed.js";

const PASSWORD = `Dm-${randomBytes(9).toString("hex")}`;
const AUTH_URL = "postgresql://wms_auth:x@localhost:6432/wms";
const base = { WMS_ENV: "local", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD, DEMO_EMAIL_DOMAIN: "example.invalid", AUTH_DATABASE_URL: AUTH_URL };

function harness(env: Record<string, string | undefined>, role = "wms_auth") {
  const logs: { level: string; msg: string; fields?: unknown }[] = [];
  const logger = {
    info: (msg: string, fields?: unknown) => logs.push({ level: "info", msg, fields }),
    warn: (msg: string, fields?: unknown) => logs.push({ level: "warn", msg, fields }),
    error: (msg: string, fields?: unknown) => logs.push({ level: "error", msg, fields }),
  };
  const close = vi.fn(async () => undefined);
  const openAuthDb = vi.fn(() => ({ close }) as never);
  const verifyRole = vi.fn(async () => {
    if (role !== "wms_auth") throw Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" });
  });
  const createDemoAccountPort = vi.fn(() => ({ ensureAccount: vi.fn(), verifyRole }));
  const loadAdapter = vi.fn(async () => ({ createDemoAccountPort, parseDemoDomain: (v: string | undefined) => (v === "example.invalid" ? v : null) }) as never);
  const setTimer = vi.fn(() => 0);
  const reg = registerDemoReseed({ env, db: {} as AccessDbClient, logger: logger as never, openAuthDb, loadAdapter, setTimer, clearTimer: () => undefined });
  return { reg, logs, openAuthDb, loadAdapter, createDemoAccountPort, setTimer, close };
}

describe("registerDemoReseed: ortam kapısı", () => {
  it.each([
    ["WMS_ENV=production", { ...base, WMS_ENV: "production" }],
    ["WMS_ENV tanımsız", { ...base, WMS_ENV: undefined }],
    ["WMS_ENV=ci", { ...base, WMS_ENV: "ci" }],
    ["DEMO_MODE=0", { ...base, DEMO_MODE: "0" }],
    ["DEMO_MODE tanımsız", { ...base, DEMO_MODE: undefined }],
    ["DEMO_PASSWORD yok", { ...base, DEMO_PASSWORD: undefined }],
  ])("%s: iş kaydedilmez, zamanlayıcı başlamaz, auth havuzu/bağdaştırıcı açılmaz", async (_n, env) => {
    const h = harness(env);
    const r = await h.reg;
    expect(r.handler).toBeUndefined();
    const enqueue = vi.fn();
    expect(r.startSchedule(enqueue)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.setTimer).not.toHaveBeenCalled();
    expect(h.openAuthDb).not.toHaveBeenCalled();
    expect(h.loadAdapter).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain(PASSWORD);
  });

  it("AUTH_DATABASE_URL yok → kayıt yok, açık hata logu, havuz yok", async () => {
    const h = harness({ ...base, AUTH_DATABASE_URL: undefined });
    const r = await h.reg;
    expect(r.handler).toBeUndefined();
    expect(h.openAuthDb).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.level === "error" && l.msg.includes("AUTH_DATABASE_URL"))).toBe(true);
  });

  it("DEMO_EMAIL_DOMAIN geçersiz → kayıt yok, havuz yok", async () => {
    const h = harness({ ...base, DEMO_EMAIL_DOMAIN: "x.example" });
    const r = await h.reg;
    expect(r.handler).toBeUndefined();
    expect(h.openAuthDb).not.toHaveBeenCalled();
  });

  it("açık ortam: iş kaydedilir, zamanlayıcı başlar, havuz yalnızca burada açılır", async () => {
    const h = harness(base);
    const r = await h.reg;
    expect(r.handler).toBeTypeOf("function");
    expect(h.openAuthDb).toHaveBeenCalledTimes(1);
    expect(h.openAuthDb).toHaveBeenCalledWith(AUTH_URL);
    const enqueue = vi.fn(async () => ({ jobId: "j" }) as never);
    const sched = r.startSchedule(enqueue);
    expect(sched).toBeDefined();
    expect(enqueue).toHaveBeenCalledTimes(1); // açılışta bir kez
    sched!.stop();
    await r.close();
    expect(h.close).toHaveBeenCalled();
  });

  it("rol doğrulaması başarısızsa (current_user ≠ wms_auth) fırlatır ve havuzu kapatır", async () => {
    const h = harness(base, "wms_app");
    await expect(h.reg).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.close).toHaveBeenCalled();
  });
});
