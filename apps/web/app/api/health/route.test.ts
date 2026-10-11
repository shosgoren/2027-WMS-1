import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ok = { ok: true } as const;
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getHealthProbe: vi.fn(),
}));
vi.mock("@wms/db", () => mocks);

const { GET } = await import("./route");
const REQUEST_ID = "3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b";
const metrics = { workerAgeSeconds: 12, oldestWaitingSeconds: 0, expiredActive: 0, failedRecent: 0 };
const healthy = { db: ok, queue: ok, worker: ok, progress: ok, metrics };
const req = (headers: Record<string, string> = {}): Request => new Request("http://localhost/api/health", { headers });

describe("GET /api/health", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    mocks.check.mockReset();
    mocks.getHealthProbe.mockReset();
    mocks.getHealthProbe.mockReturnValue({ check: mocks.check });
    mocks.check.mockResolvedValue(healthy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("DB ve kuyruk sağlamsa 200, status ok, db/queue ok", async () => {
    vi.stubEnv("APP_VERSION", "git-0123abc");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", db: "ok", queue: "ok", worker: "ok", metrics, version: "git-0123abc" });
    expect(lines).toEqual([]);
  });

  it("DB başarısızsa 503 + degraded; gövdede hata metni yok, log'da sınıf adı ve istek kimliği var", async () => {
    mocks.check.mockResolvedValue({ ...healthy, db: { ok: false, reason: "error", errorName: "PostgresError" } });
    const res = await GET(req({ "x-request-id": REQUEST_ID }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", db: "fail", queue: "ok" });
    expect(text).not.toMatch(/PostgresError|ECONNREFUSED|postgres/i);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "error", msg: "health check failed", service: "web", check: "db", reason: "error", errorName: "PostgresError", requestId: REQUEST_ID });
  });

  it("kuyruk başarısızsa 503 (zaman aşımı dahil)", async () => {
    mocks.check.mockResolvedValue({ ...healthy, queue: { ok: false, reason: "timeout" } });
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", db: "ok", queue: "fail" });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ check: "queue", reason: "timeout" });
  });

  it("worker heartbeat bayatsa 503; db/queue ok kalır, sayılar yanıtta, log'da worker", async () => {
    const stale = { ...metrics, workerAgeSeconds: 900 };
    mocks.check.mockResolvedValue({ ...healthy, worker: { ok: false, reason: "stale" }, metrics: stale });
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", db: "ok", queue: "ok", worker: "fail", metrics: stale });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ check: "worker", reason: "stale" });
  });

  it("kuyruk ilerlemesi eşik dışıysa queue fail + 503 (worker ok)", async () => {
    mocks.check.mockResolvedValue({ ...healthy, progress: { ok: false, reason: "threshold" }, metrics: { ...metrics, oldestWaitingSeconds: 4000 } });
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", db: "ok", queue: "fail", worker: "ok" });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ check: "queue-progress", reason: "threshold" });
  });

  it("yanıt yalnız durum ve sayılar: iş/tenant alanı yok", async () => {
    const body = (await (await GET(req())).json()) as { metrics: Record<string, unknown> };
    expect(Object.keys(body.metrics).sort()).toEqual(["expiredActive", "failedRecent", "oldestWaitingSeconds", "workerAgeSeconds"]);
    for (const v of Object.values(body.metrics)) expect(typeof v).toBe("number");
  });

  it("getHealthProbe fırlatırsa (DATABASE_URL yok) 503; URL/ayrıntı gövdede yok", async () => {
    mocks.getHealthProbe.mockImplementation(() => {
      throw new Error("getHealthProbe: DATABASE_URL is not configured");
    });
    const res = await GET(req());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", db: "fail", queue: "fail", worker: "fail" });
    expect(text).not.toContain("DATABASE_URL");
  });

  it("UUID olmayan x-request-id log'a girmez", async () => {
    mocks.check.mockResolvedValue({ ...healthy, db: { ok: false, reason: "timeout" } });
    await GET(req({ "x-request-id": "evil value <script>" }));
    expect(JSON.parse(lines[0] ?? "{}")).not.toHaveProperty("requestId");
  });

  it("version: FLY_IMAGE_REF etiketinden git-<sha>; biçim dışı → unknown", async () => {
    vi.stubEnv("APP_VERSION", "");
    vi.stubEnv("FLY_IMAGE_REF", "registry.fly.io/etkin-wms-staging:git-92a1080aa6bc0f1b2c3d4e5f60718293a4b5c6d7");
    expect((await (await GET(req())).json()) as { version: string }).toMatchObject({ version: "git-92a1080aa6bc0f1b2c3d4e5f60718293a4b5c6d7" });
    vi.stubEnv("FLY_IMAGE_REF", "registry.fly.io/etkin-wms-staging:latest");
    expect((await (await GET(req())).json()) as { version: string }).toMatchObject({ version: "unknown" });
  });
});
