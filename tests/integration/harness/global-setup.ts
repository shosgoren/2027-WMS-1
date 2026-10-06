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
// neon hedefi: hiçbir şey kaldırılmaz; DATABASE_URL, DATABASE_URL_DIRECT ve AUTH_DATABASE_URL zorunludur, eksikse
// koşu açık hatayla düşer (atlama yok). URL'ler loglanmaz; yalnızca maskeli host (G-09).
//
// Depolama (T-125, ADR-006): compose hedefinde `minio` de kaldırılır; koşuya özel rastgele root anahtarıyla bucket
// oluşturulur ve root OLMAYAN, yalnızca bu bucket'a yetkili geçici anahtar (STS AssumeRole + oturum politikası)
// STORAGE_* ortam değişkenleriyle testlere verilir (uygulama root anahtarı görmez). neon hedefinde MinIO yoktur:
// STORAGE_INT_* dışarıdan verilmezse depolama testi AÇIK HATAYLA düşer (atlama yok; bkz. object-storage.int.test.ts).
//
// Her iki hedefte testlerden önce `migrate up` (migration rolü, DATABASE_URL_DIRECT) uygulanır
// (T-101, ADR-015 §8); hata varsa koşu testlerden önce düşer.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DockerComposeEnvironment, Wait, type StartedDockerComposeEnvironment } from "testcontainers";
import { migrateUp } from "../../../packages/db/src/migrate.ts";
import { APP_ROLE, AUTH_ROLE, PGBOUNCER_ADMIN_URL_VAR, maskHost, parsePoolSize, parsePrepare, parseTarget, readAuthDatabaseUrl, readIntEnv, redactErrorChain } from "./env.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVICES = ["postgres", "pgbouncer", "minio"];
const STORAGE_BUCKET = "wms-int";
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
    console.log(`[test:int] target=neon app=${maskHost(env.databaseUrl)} auth=${maskHost(authUrl)} direct=${maskHost(env.databaseUrlDirect)}`);
    await applyMigrations(env.databaseUrlDirect);
    return;
  }

  const poolSize = parsePoolSize(process.env);
  const migratorUser = "wms_migrator";
  const db = "wms";
  const migratorPassword = secret();
  const appPassword = secret();
  const authPassword = secret();
  const adminPassword = secret();
  const minioRoot = { user: `root${secret().slice(0, 12)}`, password: secret() };

  environment = await new DockerComposeEnvironment(REPO_ROOT, "docker-compose.yml")
    .withProjectName(`wms-int-${randomBytes(4).toString("hex")}`)
    .withEnvironmentFile(".env.example")
    .withEnvironment({
      POSTGRES_USER: migratorUser,
      POSTGRES_PASSWORD: migratorPassword,
      POSTGRES_DB: db,
      WMS_APP_PASSWORD: appPassword,
      WMS_AUTH_PASSWORD: authPassword,
      PGBOUNCER_ADMIN_PASSWORD: adminPassword,
      PGBOUNCER_DEFAULT_POOL_SIZE: String(poolSize),
      POSTGRES_HOST_PORT: "0",
      PGBOUNCER_HOST_PORT: "0",
      MINIO_ROOT_USER: minioRoot.user,
      MINIO_ROOT_PASSWORD: minioRoot.password,
      MINIO_API_HOST_PORT: "0",
      MINIO_CONSOLE_HOST_PORT: "0",
    })
    .withDefaultWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .up(SERVICES);

  try {
    exportUrls(environment, { migratorUser, migratorPassword, appPassword, authPassword, adminPassword, db, poolSize });
    await applyMigrations(process.env.DATABASE_URL_DIRECT ?? "");
    await provisionStorage(environment, minioRoot);
  } catch (e) {
    await teardown();
    throw e;
  }
}

// SDK yalnızca packages/storage'ın bağımlılığıdır; kökten çözülemez → o paketin çözümleyicisi (CJS require).
const storageRequire = createRequire(path.join(REPO_ROOT, "packages/storage/package.json"));

interface Sendable {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy(): void;
}
interface ClientConfig {
  endpoint: string;
  region: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
}
interface S3Surface {
  S3Client: new (config: ClientConfig) => Sendable;
  CreateBucketCommand: new (input: { Bucket: string }) => unknown;
}
interface StsSurface {
  STSClient: new (config: ClientConfig) => Sendable;
  AssumeRoleCommand: new (input: { RoleArn: string; RoleSessionName: string; DurationSeconds: number; Policy: string }) => unknown;
}

async function provisionStorage(started: StartedDockerComposeEnvironment, root: { user: string; password: string }): Promise<void> {
  // Tipler elle daraltılır: SDK tiplerine `packages/storage/node_modules/...` yolundan bakmak kökten çözülemeyen
  // @smithy/* tiplerini getirir (kök tsconfig), bu yüzden yalnızca kullanılan yüzey bildirilir.
  const s3 = storageRequire("@aws-sdk/client-s3") as S3Surface;
  const sts = storageRequire("@aws-sdk/client-sts") as StsSurface;
  const minio = started.getContainer("minio-1");
  const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const region = "us-east-1";
  const rootCreds = { accessKeyId: root.user, secretAccessKey: root.password };
  const rootClient = new s3.S3Client({ endpoint, region, forcePathStyle: true, credentials: rootCreds });
  const stsClient = new sts.STSClient({ endpoint, region, credentials: rootCreds });
  try {
    await rootClient.send(new s3.CreateBucketCommand({ Bucket: STORAGE_BUCKET }));
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${STORAGE_BUCKET}/*`] }],
    });
    const out = await stsClient.send(
      new sts.AssumeRoleCommand({ RoleArn: "arn:xxx:xxx:xxx:xxxx", RoleSessionName: "wms-int", DurationSeconds: 3600, Policy: policy }),
    );
    const c = out.Credentials as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string } | undefined;
    if (c?.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.SessionToken === undefined) {
      throw new Error("MinIO AssumeRole returned no credentials");
    }
    process.env.STORAGE_ENABLED = "true";
    process.env.STORAGE_ENDPOINT = endpoint;
    process.env.STORAGE_REGION = region;
    process.env.STORAGE_BUCKET = STORAGE_BUCKET;
    process.env.STORAGE_FORCE_PATH_STYLE = "true";
    process.env.STORAGE_ACCESS_KEY_ID = c.AccessKeyId;
    process.env.STORAGE_SECRET_ACCESS_KEY = c.SecretAccessKey;
    process.env.STORAGE_SESSION_TOKEN = c.SessionToken;
    console.log(`[test:int] storage: minio ${maskHost(endpoint)} bucket=${STORAGE_BUCKET} (root olmayan geçici anahtar)`);
  } catch (e) {
    throw new Error(`[test:int] storage provisioning failed: ${redactErrorChain(e, [root.user, root.password])}`);
  } finally {
    rootClient.destroy();
    stsClient.destroy();
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
  adminPassword: string;
  db: string;
  poolSize: number;
}

function exportUrls(started: StartedDockerComposeEnvironment, c: Credentials): void {
  const { migratorUser, migratorPassword, appPassword, authPassword, adminPassword, db, poolSize } = c;
  const postgres = started.getContainer("postgres-1");
  const pgbouncer = started.getContainer("pgbouncer-1");
  const pgHost = postgres.getHost();
  const pgPort = postgres.getMappedPort(5432);
  const pbHost = pgbouncer.getHost();
  const pbPort = pgbouncer.getMappedPort(6432);

  process.env.WMS_INT_TARGET = "compose";
  process.env.DATABASE_URL = pgUrl(APP_ROLE, appPassword, pbHost, pbPort, db);
  process.env.AUTH_DATABASE_URL = pgUrl(AUTH_ROLE, authPassword, pbHost, pbPort, db);
  process.env.DATABASE_URL_DIRECT = pgUrl(migratorUser, migratorPassword, pgHost, pgPort, db);
  process.env[PGBOUNCER_ADMIN_URL_VAR] = pgUrl("pgbouncer_admin", adminPassword, pbHost, pbPort, "pgbouncer");
  process.env.INT_PGBOUNCER_POOL_SIZE = String(poolSize);

  console.log(
    `[test:int] target=compose services=${SERVICES.join("+")} pgbouncer=${maskHost(process.env.DATABASE_URL)} auth=${maskHost(process.env.AUTH_DATABASE_URL)} ` +
      `postgres=${maskHost(process.env.DATABASE_URL_DIRECT)} default_pool_size=${poolSize}`,
  );
}

export async function teardown(): Promise<void> {
  if (environment === undefined) return;
  const started = environment;
  environment = undefined;
  await started.down({ removeVolumes: true });
}
