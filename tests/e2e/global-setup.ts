// Playwright globalSetup (T-131): yerel yığını kurar; `E2E_BASE_URL` verilmişse (staging) hiçbir şey yapmaz.
//
// Yerel yığın (compose postgres + pgbouncer ÖNCEDEN ayakta olmalı: `docker compose up -d --wait`):
//   1. `pnpm db:migrate` (demo tenant satırı dahil; DEMO_MODE=1, WMS_ENV=staging)
//   2. worker derlenir ve başlatılır; açılışta `demo.reseed` işi demo kullanıcılarını kurar ("demo.reseed done" günlüğü beklenir)
//   2b. (T-279) boş tenant fikstürü: `apps/worker/e2e/empty-tenant.ts` alt süreci (depo/ürün yok; rastgele parola ortam değişkeniyle)
//   3. web derlenir (E2E_SKIP_BUILD=1 ile atlanır) ve `next start` ile iç porta (PORT+1) açılır
//   4. kendinden imzalı sertifikalı TLS ters vekili PORT'ta dinler (BETTER_AUTH_URL staging kipinde https ister)
// Parolalar/sırlar her koşuda rastgele üretilir (ortamda yoksa); diske/loga yazılmaz. Yalnızca yerel veritabanına (loopback) bağlanır.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { acceptInviteAndEnrollMfa } from "./support/empty-tenant.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, ".artifacts/e2e");
const PLACEHOLDER_SEAL = "0".repeat(64);
// T-278: playwright.config.ts projeleri bu başlıkla ayrı istemci adresi bildirir (yalnızca yerel vekil okur).
const E2E_CLIENT_IP_HEADER = "x-e2e-client-ip";
const TEST_NET_2 = /^198\.51\.100\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function loadDotEnv(): void {
  // `.env` yoksa `.env.example` (yalnızca yerel yer tutucular; G-09). Var olan ortam değişkenleri ezilmez.
  for (const name of [".env", ".env.example"]) {
    const file = path.join(ROOT, name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

function assertLoopbackDatabase(env: NodeJS.ProcessEnv): void {
  for (const key of ["DATABASE_URL_DIRECT", "DATABASE_URL", "AUTH_DATABASE_URL", "DATABASE_URL_WORKER"]) {
    const value = env[key];
    if (value === undefined || value === "") throw new Error(`e2e: ${key} tanımlı değil (.env / .env.example; docker compose up -d --wait)`);
    const host = new URL(value).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`e2e: ${key} yerel olmayan bir sunucuya işaret ediyor; yerel koşu yalnızca loopback veritabanına bağlanır (staging için E2E_BASE_URL verin).`);
    }
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, logName: string): void {
  const fd = openSync(path.join(OUT, logName), "w");
  try {
    execFileSync(cmd, args, { cwd: ROOT, env, stdio: ["ignore", fd, fd] });
  } catch (e) {
    throw new Error(`e2e: '${cmd} ${args.join(" ")}' başarısız (bkz. .artifacts/e2e/${logName})`, { cause: e });
  }
}

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, logName: string): ChildProcess {
  const fd = openSync(path.join(OUT, logName), "w");
  return spawn(cmd, args, { cwd: ROOT, env, stdio: ["ignore", fd, fd], detached: true });
}

function stop(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // süreç grubu (pnpm → node)
  } catch {
    // zaten çıkmış
  }
}

async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`e2e: zaman aşımı — ${what} (${timeoutMs} ms)`);
}

function startTlsProxy(port: number, targetPort: number, keyFile: string, certFile: string): https.Server {
  const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    // T-278: her Playwright projesi ayrı bir cihazdır; vekil istemci adresini test başlığından alır (yalnız TEST-NET-2,
    // RFC 5737), yoksa soket adresinden. Başlık uygulamaya iletilmez.
    const { [E2E_CLIENT_IP_HEADER]: declared, ...forwardHeaders } = req.headers;
    const clientIp = typeof declared === "string" && TEST_NET_2.test(declared) ? declared : (req.socket.remoteAddress ?? "127.0.0.1");
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        // Fly kenarını taklit eder: uygulama istemci IP'sini yalnızca `Fly-Client-IP`'den okur (apps/web/lib/rate-limit.ts).
        headers: { ...forwardHeaders, "x-forwarded-proto": "https", "fly-client-ip": clientIp },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.E2E_BASE_URL?.trim()) return undefined; // staging/uzak koşu: yığın dışarıda

  mkdirSync(OUT, { recursive: true });
  loadDotEnv();
  const port = Number(process.env.E2E_PORT ?? "3100");
  const innerPort = port + 1;

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.WMS_ENV = "staging";
  env.DEMO_MODE = "1";
  env.DEMO_EMAIL_DOMAIN = "example.invalid";
  env.MAIL_MODE = "disabled"; // staging kipinde mailpit kapalı; davet bağlantısı ekranda gösterilir
  env.BETTER_AUTH_URL = `https://localhost:${port}`;
  env.DEMO_PASSWORD ||= randomBytes(18).toString("hex");
  env.BETTER_AUTH_SECRET ||= randomBytes(32).toString("hex");
  if (!env.QUEUE_SEAL_KEY || env.QUEUE_SEAL_KEY === PLACEHOLDER_SEAL) env.QUEUE_SEAL_KEY = randomBytes(32).toString("hex");
  assertLoopbackDatabase(env);

  run("pnpm", ["db:migrate"], env, "migrate.log");
  run("pnpm", ["--filter", "@wms/worker", "build"], env, "worker-build.log");
  if (process.env.E2E_SKIP_BUILD !== "1") run("pnpm", ["--filter", "@wms/web", "build"], env, "web-build.log");

  const children: ChildProcess[] = [];
  let proxy: https.Server | undefined;
  const teardown = async (): Promise<void> => {
    proxy?.close();
    proxy?.closeAllConnections();
    for (const c of children) stop(c);
  };

  try {
    const worker = start("node", ["apps/worker/dist/main.js"], env, "worker.log");
    children.push(worker);
    await waitFor("worker demo.reseed tamamlanmadı (bkz. .artifacts/e2e/worker.log)", 120_000, () => {
      if (worker.exitCode !== null) throw new Error("e2e: worker beklenmedik biçimde çıktı (bkz. .artifacts/e2e/worker.log)");
      return readFileSync(path.join(OUT, "worker.log"), "utf8").includes('"msg":"demo.reseed done"');
    });

    // T-279: boş tenant fikstürü (depo/ürün yok). TENANT_ADMIN MFA ister (access.ts) ve demo alan adlı hesap MFA kuramaz; bu yüzden fikstür
    // alt süreci demo alan adlı sahiple çalışma alanını kurar ve DEMO OLMAYAN bir e-postaya TENANT_ADMIN daveti yazar. Davet kabulü + MFA kurulumu
    // web açıldıktan sonra uygulamanın gerçek ekranlarından yapılır (aşağıda). Parola/TOTP sırrı her koşuda rastgele; yalnızca bellekte/process.env.
    const suffix = randomBytes(4).toString("hex");
    const fixtureEnv: NodeJS.ProcessEnv = {
      ...env,
      E2E_EMPTY_EMAIL: `bos-${suffix}@${env.DEMO_EMAIL_DOMAIN}`, // yalnızca çalışma alanı sahibi (demo alan adlı)
      E2E_EMPTY_INVITEE_EMAIL: `yonetici-${suffix}@example.test`, // demo olmayan TENANT_ADMIN
      E2E_EMPTY_PASSWORD: randomBytes(18).toString("hex"),
      E2E_EMPTY_SLUG: `bos-${suffix}`,
    };
    // Davet belirteci YALNIZCA stdout'tan belleğe alınır (dosyaya/loga yazılmaz); stderr günlük dosyasına gider.
    const fixtureLog = openSync(path.join(OUT, "empty-tenant.log"), "w");
    let inviteToken = "";
    try {
      const stdout = execFileSync("pnpm", ["--filter", "@wms/worker", "exec", "node", "e2e/empty-tenant.ts"], {
        cwd: ROOT,
        env: fixtureEnv,
        stdio: ["ignore", "pipe", fixtureLog],
        encoding: "utf8",
      });
      inviteToken = /^E2E_INVITE_TOKEN=(\S+)$/m.exec(stdout)?.[1] ?? "";
    } catch (e) {
      throw new Error("e2e: boş tenant fikstürü başarısız (bkz. .artifacts/e2e/empty-tenant.log)", { cause: e });
    }
    if (inviteToken === "") throw new Error("e2e: boş tenant fikstürü davet belirteci üretmedi (bkz. .artifacts/e2e/empty-tenant.log)");
    process.env.E2E_EMPTY_SLUG = fixtureEnv.E2E_EMPTY_SLUG;
    process.env.E2E_EMPTY_INVITEE_EMAIL = fixtureEnv.E2E_EMPTY_INVITEE_EMAIL;
    process.env.E2E_EMPTY_PASSWORD = fixtureEnv.E2E_EMPTY_PASSWORD;

    const web = start("pnpm", ["--filter", "@wms/web", "exec", "next", "start", "-p", String(innerPort), "-H", "127.0.0.1"], env, "web.log");
    children.push(web);
    await waitFor("web hazır değil (bkz. .artifacts/e2e/web.log)", 120_000, async () => {
      if (web.exitCode !== null) throw new Error("e2e: web beklenmedik biçimde çıktı (bkz. .artifacts/e2e/web.log)");
      try {
        return (await fetch(`http://127.0.0.1:${innerPort}/api/health/live`)).ok;
      } catch {
        return false;
      }
    });

    const key = path.join(OUT, "tls-key.pem");
    const cert = path.join(OUT, "tls-cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert],
      { stdio: "ignore" },
    );
    proxy = startTlsProxy(port, innerPort, key, cert);
    await waitFor("TLS vekili hazır değil", 10_000, async () => {
      return new Promise<boolean>((resolve) => {
        // Kendinden imzalı yerel sertifika: yalnızca bu hazır olma yoklaması doğrulamayı atlar.
        const req = https.get({ host: "localhost", port, path: "/api/health/live", rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
      });
    });

    // Davet kabulü + MFA kurulumu (gerçek ekranlar, izsiz ayrı bağlam; `acceptInviteAndEnrollMfa`). TOTP sırrı yalnızca process.env'e girer.
    const browser = await chromium.launch();
    try {
      const enrolled = await acceptInviteAndEnrollMfa({
        browser,
        baseURL: `https://localhost:${port}`,
        clientIp: "198.51.100.20",
        inviteToken,
        name: "E2E boş kiracı yöneticisi",
        email: fixtureEnv.E2E_EMPTY_INVITEE_EMAIL as string,
        password: fixtureEnv.E2E_EMPTY_PASSWORD as string,
      });
      process.env.E2E_EMPTY_TOTP_SECRET = enrolled.totpSecret;
    } finally {
      await browser.close();
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
