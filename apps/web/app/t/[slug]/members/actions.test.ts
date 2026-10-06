// inviteMemberAction mail kipi denetimi (T-116c): staging/prod'da mailpit → genel INTERNAL, hiçbir yan etki yok.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inviteMember = vi.hoisted(() => vi.fn());
const getSenderQueue = vi.hoisted(() => vi.fn());
const getPrincipal = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ origin: "https://app.example.test" })) }));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/identity/invitations", () => ({ inviteMember, revokeInvitation: vi.fn() }));
vi.mock("../../../../lib/queue.ts", () => ({ getSenderQueue }));

import { inviteMemberAction } from "./actions.ts";

const INPUT = { slug: "acme", email: "a@example.test", roleKey: "TENANT_ADMIN" };
const ENV_KEYS = ["MAIL_MODE", "WMS_ENV", "BETTER_AUTH_URL", "MAILPIT_URL", "MAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.BETTER_AUTH_URL = "https://app.example.test";
  process.env.MAIL_MODE = "mailpit";
  process.env.MAILPIT_URL = "http://localhost:8025";
  process.env.MAIL_FROM = "a@example.test";
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
  getSenderQueue.mockResolvedValue(undefined);
  inviteMember.mockResolvedValue({ invitationId: "i1", expiresAt: new Date(0), delivery: "EMAIL" });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("inviteMemberAction mail kipi denetimi", () => {
  for (const wmsEnv of ["staging", "production"]) {
    it(`WMS_ENV=${wmsEnv} + mailpit: INTERNAL; kuyruk ve inviteMember çağrılmaz; log adı ayırt edici`, async () => {
      process.env.WMS_ENV = wmsEnv;
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await inviteMemberAction(INPUT);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("INTERNAL");
      expect(JSON.stringify(res)).not.toContain("mailpit");
      expect(getSenderQueue).toHaveBeenCalledTimes(0);
      expect(inviteMember).toHaveBeenCalledTimes(0);
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("MailConfigError");
    });
  }

  it("WMS_ENV=local + mailpit (pozitif): eylem başarılı, inviteMember bir kez çağrılır", async () => {
    process.env.WMS_ENV = "local";
    const res = await inviteMemberAction(INPUT);
    expect(res.ok).toBe(true);
    expect(getSenderQueue).toHaveBeenCalledTimes(1);
    expect(inviteMember).toHaveBeenCalledTimes(1);
  });
});
