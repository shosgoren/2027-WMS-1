// `pnpm db:migrate` sonrası çağrılır: pg-boss şemasını migration rolüyle kurar (T-115, ADR-015).
// Yalnızca `DATABASE_URL_DIRECT` (migration rolü, doğrudan bağlantı) kabul edilir. `DATABASE_URL` ile aynı
// host/port/kullanıcı/veritabanına işaret ederse reddedilir; rol denetimi (uygulama rolü ret, şema sahibi olma
// zorunluluğu) `installQueueSchema` içindedir. Bağlantı bilgisi hiçbir çıktıya yazılmaz (G-09).
import { sameConnectionTarget } from "@wms/db";
import { installQueueSchema } from "./index.ts";

const url = process.env.DATABASE_URL_DIRECT;
const appUrl = process.env.DATABASE_URL;
if (url === undefined || url.trim() === "") {
  console.error("queue install: DATABASE_URL_DIRECT tanımlı değil");
  process.exit(1);
}
if (appUrl !== undefined && appUrl.trim() !== "" && sameConnectionTarget(appUrl, url)) {
  console.error("queue install: DATABASE_URL_DIRECT uygulama bağlantısıyla (DATABASE_URL) aynı hedefe işaret edemez");
  process.exit(1);
}
try {
  await installQueueSchema({ url });
  console.log("queue install: pg-boss şeması hazır");
} catch (err) {
  const e = err as { name?: unknown; message?: unknown; sqlstate?: unknown };
  // Yalnızca ad + SQLSTATE + (bizim ürettiğimiz) mesaj.
  console.error(`queue install FAILED: ${String(e.name)}${typeof e.sqlstate === "string" ? ` (${e.sqlstate})` : ""}: ${String(e.message)}`);
  process.exit(1);
}
