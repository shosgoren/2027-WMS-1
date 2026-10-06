import { describe, expect, it, vi } from "vitest";

// DB'ye dokunmadığını kanıtlamak için `@wms/db` yüklenirse test düşer.
vi.mock("@wms/db", () => {
  throw new Error("live endpoint must not import @wms/db");
});
const { GET } = await import("./route");

describe("GET /api/health/live", () => {
  it("200 {status:ok}; önbelleklenmez; DB'ye dokunmaz", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
