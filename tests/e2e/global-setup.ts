// Playwright globalSetup (T-131): yerel yığını kurar; `E2E_BASE_URL` verilmişse (staging) hiçbir şey yapmaz.
//
// Yerel yığın (compose postgres + pgbouncer ÖNCEDEN ayakta olmalı: `docker compose up -d --wait`):
//   1. `pnpm db:migrate` (demo tenant satırı dahil; DEMO_MODE=1, WMS_ENV=staging)
//   2. worker derlenir ve başlatılır; açılışta `demo.reseed` işi demo kullanıcılarını kurar ("demo.reseed done" günlüğü beklenir)
//   3b. (T-279) boş tenant fikstürü: kayıt açık (ci) KISA ÖMÜRLÜ ikinci web örneğinde hesap + çalışma alanı + MFA (gerçek ekranlar); sonra kapatılır
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
import { provisionEmptyTenant } from "./support/empty-tenant.ts";

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

    // T-279: boş tenant fikstürü (depo/ürün yok). TENANT_ADMIN MFA ister (access.ts:92-96) ve demo hesapları MFA kuramaz; bu yüzden fikstür
    // DEMO OLMAYAN bir hesaptır ve çalışma alanını kendisi açar (M9 etkin: DEMO_EMAIL_DOMAIN iletilir). Üretimdeki yol kullanılır: kayıt ucu +
    // kurulum sihirbazı + gerçek MFA ekranı. Kalan TEK aşım ortam kapısıdır (`workspaceCreationAllowed`: WMS_ENV=ci + SIGNUP_ENABLED=true): bu
    // kapı YALNIZCA kısa ömürlü ikinci bir web örneğinde (aynı DB) açılır ve fikstür kurulunca kapatılır; testlerin koştuğu örnek staging kalır.
    // Parola/TOTP sırrı her koşuda rastgele; yalnızca bellekte/process.env.
    const suffix = randomBytes(4).toString("hex");
    const innerB = port + 2;
    const portB = port + 3;
    const envB: NodeJS.ProcessEnv = { ...env, WMS_ENV: "ci", SIGNUP_ENABLED: "true", BETTER_AUTH_URL: `https://localhost:${portB}` };
    delete envB.DEMO_MODE; // demo girişi yalnızca ana örnekte
    const webB = start("pnpm", ["--filter", "@wms/web", "exec", "next", "start", "-p", String(innerB), "-H", "127.0.0.1"], envB, "web-signup.log");
    children.push(webB);
    await waitFor("kayıt açık web örneği hazır değil (bkz. .artifacts/e2e/web-signup.log)", 120_000, async () => {
      if (webB.exitCode !== null) throw new Error("e2e: kayıt açık web örneği çıktı (bkz. .artifacts/e2e/web-signup.log)");
      try {
        return (await fetch(`http://127.0.0.1:${innerB}/api/health/live`)).ok;
      } catch {
        return false;
      }
    });
    const proxyB = startTlsProxy(portB, innerB, key, cert);
    const closeProxyB = (): void => {
      proxyB.close();
      proxyB.closeAllConnections();
    };
    const email = `bos-${suffix}@example.test`; // demo olmayan alan adı (DEMO_EMAIL_DOMAIN=example.invalid)
    const password = randomBytes(18).toString("hex");
    const browser = await chromium.launch();
    try {
      const made = await provisionEmptyTenant({
        browser,
        origin: `https://localhost:${portB}`,
        clientIp: "198.51.100.20",
        name: "E2E bos kiracı yöneticisi",
        email,
        password,
        workspaceName: `E2E bos ${suffix}`,
      });
      process.env.E2E_EMPTY_SLUG = made.slug;
      process.env.E2E_EMPTY_EMAIL = email;
      process.env.E2E_EMPTY_PASSWORD = password;
      process.env.E2E_EMPTY_TOTP_SECRET = made.totpSecret;
    } finally {
      await browser.close();
      closeProxyB();
      stop(webB);
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
