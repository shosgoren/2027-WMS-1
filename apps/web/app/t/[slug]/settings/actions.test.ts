// saveSettingsAction (T-122): saat dilimi yalnızca sabit listeden; liste dışı ad domain'e hiç ulaşmaz.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ value: new Headers() }));
const getPrincipal = vi.hoisted(() => vi.fn());
const updateTenantSettings = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(hdrs.value) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/onboarding/workspace", () => ({ updateTenantSettings }));
vi.mock("@wms/domain/identity/access", () => ({ runTenantQuery: () => Promise.resolve("t1") }));
vi.mock("../../../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));

import { saveSettingsAction } from "./actions.ts";

const ORIGIN = "https://app.example.test";
const form = (tz: string) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ slug: "acme", name: "Acme", locale: "tr", timeZone: tz })) f.set(k, v);
  return f;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec(String((e as Error).message));
    if (m?.[1] !== undefined) return m[1];
    throw e;
  }
  throw new Error("redirect bekleniyordu");
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = ORIGIN;
  hdrs.value = new Headers({ origin: ORIGIN, "fly-client-ip": "203.0.113.7" });
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
  updateTenantSettings.mockResolvedValue({ changed: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = saved;
  vi.clearAllMocks();
});

describe("saveSettingsAction saat dilimi listesi", () => {
  it("listedeki ad kabul edilir", async () => {
    expect(await redirectOf(saveSettingsAction(form("Europe/Berlin")))).toBe("/t/acme/settings?saved=1");
    expect(updateTenantSettings).toHaveBeenCalledWith({}, "acme", expect.objectContaining({ userId: "u1" }), { name: "Acme", locale: "tr", timeZone: "Europe/Berlin" });
  });
  it("liste dışı adlar (Intl'in kabul ettikleri dahil) VALIDATION_FAILED; domain çağrılmaz", async () => {
    for (const tz of ["Mars/Olympus", "America/Argentina/ComodRivadavia", "EST5EDT", "europe/istanbul", ""]) {
      expect(await redirectOf(saveSettingsAction(form(tz)))).toBe("/t/acme/settings?error=VALIDATION_FAILED");
    }
    expect(updateTenantSettings).not.toHaveBeenCalled();
  });
  it("Origin reddi: FORBIDDEN; domain çağrılmaz", async () => {
    hdrs.value = new Headers({ origin: "https://evil.example", "fly-client-ip": "203.0.113.7" });
    expect(await redirectOf(saveSettingsAction(form("UTC")))).toBe("/t/acme/settings?error=FORBIDDEN");
    expect(updateTenantSettings).not.toHaveBeenCalled();
  });
});
