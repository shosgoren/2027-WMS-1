import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createActionGuard, createRouteGuard, type GuardDeps } from "./action-guard.ts";

const APP = "https://app.example.test";
const GIVEN = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const deps = (headers: Record<string, string>): GuardDeps => ({
  getHeaders: () => Promise.resolve(new Headers({ origin: APP, ...headers })),
  resolvePrincipal: () => Promise.resolve({ userId: "u1", mfaVerified: true }),
  appUrl: APP,
  log: () => undefined,
  newRequestId: () => "fallback-id",
});

describe("istek kimliği proxy ile aynı (T-129)", () => {
  const boom = (): Promise<never> => Promise.reject(new Error("x"));
  it("eylem hata yanıtı proxy'nin ilettiği x-request-id'yi taşır", async () => {
    const action = createActionGuard(deps({ "x-request-id": GIVEN }))({ schema: z.object({}) }, boom);
    const res = await action({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.requestId).toBe(GIVEN);
  });
  it("geçersiz/yok ise üretilen kimlik (newRequestId) kullanılır", async () => {
    for (const headers of <Record<string, string>[]>[{ "x-request-id": "not-a-uuid" }, {}]) {
      const res = await createActionGuard(deps(headers))({ schema: z.object({}) }, boom)({});
      if (!res.ok) expect(res.error.requestId).toBe("fallback-id");
    }
  });
  it("route handler yanıtı da aynı kimliği taşır", async () => {
    const route = createRouteGuard(deps({}))({}, boom);
    const res = await route(new Request("http://localhost/api/t/x", { headers: { "x-request-id": GIVEN } }));
    expect(((await res.json()) as { error: { requestId: string } }).error.requestId).toBe(GIVEN);
  });
});
