// Vitest globalSetup — `pnpm test:int` (T-005a).
//
// compose hedefi: repodaki docker-compose.yml'den YALNIZCA `postgres` + `pgbouncer` servisleri
// Testcontainers Compose modülüyle kaldırılır (tek yapılandırma kaynağı; ini/imaj kopyalanmaz).
// Varsayılan değerler .env.example'dan okunur (yerel .env okunmaz → koşu geliştirici ayarından
// bağımsızdır); parolalar her koşuda rastgele üretilir, ana makine portları rastgeledir (0), proje
// adı benzersizdir → yerel `docker compose` yığını ve CI `infra` işiyle çakışmaz. Bağlantı
// URL'leri testlere ortam değişkeniyle verilir (çalışan süreçler globalSetup'tan sonra başlar ve
// process.env'i devralır). Sonunda ortam volume'larıyla birlikte indirilir.
//
// neon hedefi: hiçbir şey kaldırılmaz; DATABASE_URL, DATABASE_URL_DIRECT, AUTH_DATABASE_URL ve DATABASE_URL_WORKER zorunludur, eksikse
// koşu açık hatayla düşer (atlama yok). URL'ler loglanmaz; yalnızca maskeli host (G-09).
//
// Her iki hedefte testlerden önce `migrate up` (migration rolü, DATABASE_URL_DIRECT) uygulanır
// (T-101, ADR-015 §8); hata varsa koşu testlerden önce düşer.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DockerComposeEnvironment, Wait, type StartedDockerComposeEnvironment } from "testcontainers";
import { migrateUp } from "../../../packages/db/src/migrate.ts";
import { APP_ROLE, AUTH_ROLE, PGBOUNCER_ADMIN_URL_VAR, WORKER_ROLE, maskHost, parsePoolSize, parsePrepare, parseTarget, readAuthDatabaseUrl, readIntEnv, readWorkerDatabaseUrl, redactErrorChain } from "./env.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVICES = ["postgres", "pgbouncer"];
const STARTUP_TIMEOUT_MS = 300_000;

let environment: StartedDockerComposeEnvironment | undefined;

function secret(): string {
  // Yalnızca [0-9a-f]: PgBouncer userlist ve URL için kaçış gerektirmez.
  return randomBytes(24).toString("hex");
}

function pgUrl(user: string, password: string, host: string, port: number, db: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
}

export async function setup(): Promise<void> {
  const target = parseTarget(process.env);
  parsePrepare(process.env); // geçersiz INT_DB_PREPARE testlerden önce düşsün

  if (target === "neon") {
    const env = readIntEnv(process.env);
    const authUrl = readAuthDatabaseUrl(process.env);
    const workerUrl = readWorkerDatabaseUrl(process.env);
    console.log(`[test:int] target=neon app=${maskHost(env.databaseUrl)} auth=${maskHost(authUrl)} worker=${maskHost(workerUrl)} direct=${maskHost(env.databaseUrlDirect)}`);
    await applyMigrations(env.databaseUrlDirect);
    return;
  }

  const poolSize = parsePoolSize(process.env);
  const migratorUser = "wms_migrator";
  const db = "wms";
  const migratorPassword = secret();
  const appPassword = secret();
  const authPassword = secret();
  const workerPassword = secret();
  const adminPassword = secret();

  environment = await new DockerComposeEnvironment(REPO_ROOT, "docker-compose.yml")
    .withProjectName(`wms-int-${randomBytes(4).toString("hex")}`)
    .withEnvironmentFile(".env.example")
    .withEnvironment({
      POSTGRES_USER: migratorUser,
      POSTGRES_PASSWORD: migratorPassword,
      POSTGRES_DB: db,
      WMS_APP_PASSWORD: appPassword,
      WMS_AUTH_PASSWORD: authPassword,
      WMS_WORKER_PASSWORD: workerPassword,
      PGBOUNCER_ADMIN_PASSWORD: adminPassword,
      PGBOUNCER_DEFAULT_POOL_SIZE: String(poolSize),
      POSTGRES_HOST_PORT: "0",
      PGBOUNCER_HOST_PORT: "0",
    })
    .withDefaultWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .up(SERVICES);

  try {
    exportUrls(environment, { migratorUser, migratorPassword, appPassword, authPassword, workerPassword, adminPassword, db, poolSize });
    await applyMigrations(process.env.DATABASE_URL_DIRECT ?? "");
  } catch (e) {
    await teardown();
    throw e;
  }
}

async function applyMigrations(directUrl: string): Promise<void> {
  let r;
  try {
    r = await migrateUp({ url: directUrl });
  } catch (e) {
    throw new Error(`[test:int] migrate up failed: ${redactErrorChain(e, [directUrl])}`);
  }
  console.log(`[test:int] migrate up: ${r.applied.length} uygulandı, toplam ${r.totalApplied}`);
}

interface Credentials {
  migratorUser: string;
  migratorPassword: string;
  appPassword: string;
  authPassword: string;
  workerPassword: string;
  adminPassword: string;
  db: string;
  poolSize: number;
}

function exportUrls(started: StartedDockerComposeEnvironment, c: Credentials): void {
  const { migratorUser, migratorPassword, appPassword, authPassword, workerPassword, adminPassword, db, poolSize } = c;
  const postgres = started.getContainer("postgres-1");
  const pgbouncer = started.getContainer("pgbouncer-1");
  const pgHost = postgres.getHost();
  const pgPort = postgres.getMappedPort(5432);
  const pbHost = pgbouncer.getHost();
  const pbPort = pgbouncer.getMappedPort(6432);

  process.env.WMS_INT_TARGET = "compose";
  process.env.DATABASE_URL = pgUrl(APP_ROLE, appPassword, pbHost, pbPort, db);
  process.env.AUTH_DATABASE_URL = pgUrl(AUTH_ROLE, authPassword, pbHost, pbPort, db);
  process.env.DATABASE_URL_WORKER = pgUrl(WORKER_ROLE, workerPassword, pbHost, pbPort, db);
  process.env.DATABASE_URL_DIRECT = pgUrl(migratorUser, migratorPassword, pgHost, pgPort, db);
  process.env[PGBOUNCER_ADMIN_URL_VAR] = pgUrl("pgbouncer_admin", adminPassword, pbHost, pbPort, "pgbouncer");
  process.env.INT_PGBOUNCER_POOL_SIZE = String(poolSize);

  console.log(
    `[test:int] target=compose services=${SERVICES.join("+")} pgbouncer=${maskHost(process.env.DATABASE_URL)} auth=${maskHost(process.env.AUTH_DATABASE_URL)} worker=${maskHost(process.env.DATABASE_URL_WORKER)} ` +
      `postgres=${maskHost(process.env.DATABASE_URL_DIRECT)} default_pool_size=${poolSize}`,
  );
}

export async function teardown(): Promise<void> {
  if (environment === undefined) return;
  const started = environment;
  environment = undefined;
  await started.down({ removeVolumes: true });
}
