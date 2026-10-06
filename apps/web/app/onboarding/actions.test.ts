// Sihirbaz eylemleri (T-122): taslak çerezi, sabit requestId, formdan değil çerezden ad/requestId, başarıda çerez silme ve
// guard (Origin) reddi. vi.mock yolları gerçek import yollarıyla aynıdır.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const cookieSet = vi.hoisted(() => vi.fn());
const cookieDelete = vi.hoisted(() => vi.fn());
const hdrs = vi.hoisted(() => ({ value: new Headers() }));
const getPrincipal = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(hdrs.value),
  cookies: () =>
    Promise.resolve({
      get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
      set: (n: string, v: string, o: unknown) => {
        store.set(n, v);
        cookieSet(n, v, o);
      },
      delete: (arg: { name: string; path: string }) => {
        store.delete(arg.name);
        cookieDelete(arg);
      },
    }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@wms/auth", () => ({ getAuthService: () => ({ getPrincipal }) }));
vi.mock("@wms/db", () => ({ getAppDb: () => ({}) }));
vi.mock("@wms/domain/onboarding/workspace", () => ({ createWorkspace }));
vi.mock("../../lib/rate-limit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/rate-limit.ts")>()),
  createProductionLimiter: () => ({ check: () => Promise.resolve() }),
}));

import { createWorkspaceAction, saveWorkspaceNameAction } from "./actions.ts";

const ORIGIN = "https://app.example.test";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
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
const draftOf = () => JSON.parse(store.get("wms_onboarding") ?? "null") as { name: string; requestId: string } | null;

let savedUrl: string | undefined;
beforeEach(() => {
  savedUrl = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = ORIGIN;
  store.clear();
  hdrs.value = new Headers({ origin: ORIGIN, "fly-client-ip": "203.0.113.7" });
  getPrincipal.mockResolvedValue({ userId: "u1", mfaVerified: true });
  createWorkspace.mockResolvedValue({ tenantId: "t1", slug: "anadolu", created: true });
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = savedUrl;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("saveWorkspaceNameAction", () => {
  it("adı httpOnly çerez taslağına yazar; geri/yenile (ikinci kayıt) requestId'yi korur", async () => {
    expect(await redirectOf(saveWorkspaceNameAction(form({ name: "Taslak Ad" })))).toBe("/onboarding");
    const first = draftOf();
    expect(first?.name).toBe("Taslak Ad");
    expect(cookieSet).toHaveBeenCalledWith("wms_onboarding", expect.any(String), expect.objectContaining({ httpOnly: true, path: "/onboarding", sameSite: "lax", maxAge: 1800 }));
    await redirectOf(saveWorkspaceNameAction(form({ name: "  Anadolu Ambalaj " })));
    const second = draftOf();
    expect(second?.name).toBe("Anadolu Ambalaj");
    expect(second?.requestId).toBe(first?.requestId);
  });

  it("geçersiz ad: invalid=1, çerez yazılmaz", async () => {
    for (const name of ["", "   ", "x".repeat(121), "a\u0000b"]) {
      expect(await redirectOf(saveWorkspaceNameAction(form({ name })))).toBe("/onboarding?invalid=1");
    }
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("guard: Origin yok ya da yanlışsa FORBIDDEN'a yönlenir, çerez yazılmaz", async () => {
    for (const origin of [undefined, "https://evil.example"]) {
      hdrs.value = new Headers({ "fly-client-ip": "203.0.113.7", ...(origin === undefined ? {} : { origin }) });
      expect(await redirectOf(saveWorkspaceNameAction(form({ name: "Ad" })))).toBe("/onboarding?error=FORBIDDEN");
    }
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("guard: oturum yoksa UNAUTHENTICATED'a yönlenir", async () => {
    getPrincipal.mockResolvedValue(null);
    expect(await redirectOf(saveWorkspaceNameAction(form({ name: "Ad" })))).toBe("/onboarding?error=UNAUTHENTICATED");
  });
});

describe("createWorkspaceAction", () => {
  it("ad ve requestId formdan değil çerezden gelir; şablon formdan", async () => {
    await redirectOf(saveWorkspaceNameAction(form({ name: "Gerçek Ad" })));
    const draft = draftOf();
    const url = await redirectOf(createWorkspaceAction({}, form({ templateKey: "GENERIC", name: "Sahte Ad", requestId: "00000000-0000-4000-8000-000000000000" })));
    expect(url).toBe("/t/anadolu");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "Gerçek Ad", requestId: draft?.requestId, templateKey: "GENERIC", principal: expect.objectContaining({ userId: "u1" }) }));
  });

  it("başarıda taslak çerezi silinir", async () => {
    await redirectOf(saveWorkspaceNameAction(form({ name: "Ad" })));
    await redirectOf(createWorkspaceAction({}, form({ templateKey: "GENERIC" })));
    expect(cookieDelete).toHaveBeenCalledWith({ name: "wms_onboarding", path: "/onboarding" });
    expect(draftOf()).toBeNull();
  });

  it("hatada çerez kalır ve yeniden denemede aynı requestId gider (çift gönderim/yenile)", async () => {
    await redirectOf(saveWorkspaceNameAction(form({ name: "Ad" })));
    const id = draftOf()?.requestId;
    createWorkspace.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "AppError" }));
    const res = await createWorkspaceAction({}, form({ templateKey: "GENERIC" }));
    expect(res.errorCode).toBe("INTERNAL");
    expect(cookieDelete).not.toHaveBeenCalled();
    await redirectOf(createWorkspaceAction({}, form({ templateKey: "GENERIC" })));
    const ids = createWorkspace.mock.calls.map((c) => (c[0] as { requestId: string }).requestId);
    expect(ids).toEqual([id, id]);
  });

  it("taslak yoksa VALIDATION_FAILED; createWorkspace çağrılmaz", async () => {
    const res = await createWorkspaceAction({}, form({ templateKey: "GENERIC", name: "Ad", requestId: "00000000-0000-4000-8000-000000000000" }));
    expect(res.errorCode).toBe("VALIDATION_FAILED");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("guard: Origin reddi FORBIDDEN; createWorkspace çağrılmaz, çerez silinmez", async () => {
    await redirectOf(saveWorkspaceNameAction(form({ name: "Ad" })));
    hdrs.value = new Headers({ origin: "https://evil.example", "fly-client-ip": "203.0.113.7" });
    const res = await createWorkspaceAction({}, form({ templateKey: "GENERIC" }));
    expect(res.errorCode).toBe("FORBIDDEN");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(cookieDelete).not.toHaveBeenCalled();
    expect(draftOf()).not.toBeNull();
  });
});
