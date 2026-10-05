// `pnpm db:migrate` sonrası çağrılır: pg-boss şemasını migration rolüyle kurar (T-115, ADR-015).
// Yalnızca `DATABASE_URL_DIRECT` (migration rolü, doğrudan bağlantı); uygulama bağlantısıyla aynı hedef reddedilir.
import { installQueueSchema } from "./index.ts";

const url = process.env.DATABASE_URL_DIRECT;
if (url === undefined || url.trim() === "") {
  console.error("queue install: DATABASE_URL_DIRECT tanımlı değil");
  process.exit(1);
}
try {
  await installQueueSchema({ url });
  console.log("queue install: pg-boss şeması hazır");
} catch (err) {
  const e = err as { name?: unknown; message?: unknown; sqlstate?: unknown };
  // Yalnızca ad + SQLSTATE + (bizim ürettiğimiz) mesaj; bağlantı bilgisi yazılmaz (G-09).
  console.error(`queue install FAILED: ${String(e.name)}${typeof e.sqlstate === "string" ? ` (${e.sqlstate})` : ""}: ${String(e.message)}`);
  process.exit(1);
}
