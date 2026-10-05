import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJsonLogger,
  createLifecycle,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parseShutdownTimeoutMs,
  type Lifecycle,
} from "./lifecycle.js";

interface Entry {
  level: string;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

function setup(timeoutMs = 1_000): { lifecycle: Lifecycle; lines: Entry[]; exit: ReturnType<typeof vi.fn> } {
  const lines: Entry[] = [];
  const logger = createJsonLogger((line) => lines.push(JSON.parse(line) as Entry));
  const exit = vi.fn<(code: number) => void>();
  const lifecycle = createLifecycle({ timeoutMs, logger, exit });
  return { lifecycle, lines, exit };
}

const live: Lifecycle[] = [];
afterEach(async () => {
  // `start()` zamanlayıcısını temizle.
  await Promise.all(live.splice(0).map((l) => l.stop("test cleanup")));
});

describe("lifecycle.stop", () => {
  it("(a) calls hooks once each, in registration order", async () => {
    const { lifecycle, lines } = setup();
    const calls: string[] = [];
    for (const name of ["queue", "db-pool", "telemetry"]) {
      lifecycle.register({ name, run: async () => void calls.push(name) });
    }
    const code = await lifecycle.stop("SIGTERM");
    expect(code).toBe(0);
    expect(calls).toEqual(["queue", "db-pool", "telemetry"]);
    expect(lines.at(-1)).toMatchObject({ level: "info", msg: "shutdown complete", reason: "SIGTERM" });
  });

  it("(b) a second stop does not call hooks again and returns the same result", async () => {
    const { lifecycle } = setup();
    const run = vi.fn();
    lifecycle.register({ name: "only", run });
    const first = lifecycle.stop("SIGTERM");
    const second = lifecycle.stop("SIGINT");
    expect(await first).toBe(0);
    expect(await second).toBe(0);
    expect(await lifecycle.stop("again")).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("(c) a hook exceeding the timeout yields a non-zero exit code", async () => {
    const { lifecycle, lines } = setup(20);
    const after = vi.fn();
    lifecycle.register({ name: "hangs", run: () => new Promise<void>(() => {}) });
    lifecycle.register({ name: "after", run: after });
    const code = await lifecycle.stop("SIGTERM");
    expect(code).not.toBe(0);
    expect(after).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatchObject({ level: "error", msg: "shutdown timed out", pendingHook: "hangs", timeoutMs: 20 });
  });

  it("a throwing hook is logged, later hooks still run, exit code is non-zero", async () => {
    const { lifecycle, lines } = setup();
    const after = vi.fn();
    lifecycle.register({ name: "boom", run: () => { throw new Error("close failed"); } });
    lifecycle.register({ name: "after", run: after });
    expect(await lifecycle.stop("SIGTERM")).not.toBe(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", msg: "shutdown hook failed", hook: "boom", error: expect.objectContaining({ message: "close failed" }) }),
    );
  });

  it("rejects hook registration after shutdown has begun", async () => {
    const { lifecycle } = setup();
    await lifecycle.stop("SIGTERM");
    expect(() => lifecycle.register({ name: "late", run: () => {} })).toThrow(/late/);
  });
});

describe("lifecycle process handlers", () => {
  it("start logs a structured 'started' line", () => {
    const { lifecycle, lines } = setup();
    live.push(lifecycle);
    lifecycle.start();
    expect(lines[0]).toMatchObject({ level: "info", msg: "started" });
    expect(Number.isNaN(Date.parse(lines[0]?.ts ?? ""))).toBe(false);
  });

  it("SIGTERM runs shutdown and exits 0; a second signal forces a non-zero exit", async () => {
    const { lifecycle, lines, exit } = setup();
    const proc = new EventEmitter();
    let release: () => void = () => {};
    lifecycle.register({ name: "slow", run: () => new Promise<void>((r) => (release = r)) });
    lifecycle.installProcessHandlers(proc);

    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", msg: "forced exit", signal: "SIGINT" }));

    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it.each([
    ["uncaughtException", new Error("kaboom"), "uncaught exception"],
    ["unhandledRejection", new Error("rejected"), "unhandled rejection"],
  ])("%s logs a JSON error line and exits non-zero", (event, err, msg) => {
    const { lifecycle, lines, exit } = setup();
    const proc = new EventEmitter();
    lifecycle.installProcessHandlers(proc);
    proc.emit(event, err);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.at(-1)).toMatchObject({ level: "error", msg, error: { message: err.message } });
  });
});

describe("parseShutdownTimeoutMs", () => {
  it("defaults when unset or blank", () => {
    expect(parseShutdownTimeoutMs(undefined)).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(parseShutdownTimeoutMs("  ")).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it("accepts a positive integer", () => {
    expect(parseShutdownTimeoutMs("2500")).toBe(2500);
  });

  it.each(["0", "-1", "1.5", "abc", "10s"])("rejects %j", (raw) => {
    expect(() => parseShutdownTimeoutMs(raw)).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS/);
  });
});
