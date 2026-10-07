// T-279: e2e boş-tenant fikstürü. YALNIZCA `tests/e2e/global-setup.ts` alt süreç olarak çalıştırır
// (`pnpm --filter @wms/worker exec node e2e/empty-tenant.ts`); `src/` dışındadır, worker paketine/bundle'ına girmez ve hiçbir
// çalışma zamanı yolundan çağrılamaz. Mevcut domain/auth işlevleriyle (createDemoAccountPort + createWorkspace) depo/ürün/lokasyonu
// OLMAYAN bir çalışma alanı kurar: demo tenant artık dolu açıldığından (T-223) S-01 boş durumu ve rehberli kurulum yalnızca burada
// üretilebilir. TENANT_ADMIN MFA ister (access.ts: `is_demo` olmayan tenant) ve demo alan adlı hesap MFA kuramaz; bu yüzden çalışma alanının
// sahibi (demo alan adlı, yalnızca davet göndermek için) DEMO OLMAYAN bir e-postaya TENANT_ADMIN daveti yazar. Davet kabulü ve MFA kurulumu
// `global-setup.ts` içinde uygulamanın gerçek ekranlarından yapılır. Parola ve davet belirteci G-09: parola yalnızca ortam değişkeniyle gelir;
// belirteç YALNIZCA stdout'a yazılır (çağıran belleğe yakalar, dosyaya/loga yazmaz).
import { randomUUID } from "node:crypto";
import { createDbClient } from "@wms/db";
import { createDemoAccountPort } from "@wms/auth/demo-accounts";
import { createWorkspace, openAppDb } from "@wms/domain/onboarding/workspace";
import { TEMPLATE_KEYS } from "@wms/domain/onboarding/templates";
import { inviteMember } from "@wms/domain/identity/invitations";
import { assertMailModeAllowed, loadMailConfig } from "@wms/shared/mailer";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") throw new Error(`e2e fikstürü: ${name} tanımlı değil`);
  return v;
}

function assertLocalOnly(): void {
  if (process.env.E2E_BASE_URL?.trim()) throw new Error("e2e fikstürü: uzak koşuda çalışmaz");
  if (process.env.WMS_ENV !== "staging") throw new Error("e2e fikstürü: yalnızca e2e yığınında (WMS_ENV=staging) çalışır");
  for (const key of ["DATABASE_URL", "AUTH_DATABASE_URL"]) {
    const host = new URL(need(key)).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`e2e fikstürü: ${key} yerel olmayan bir sunucuya işaret ediyor`);
  }
}

assertLocalOnly();
const email = need("E2E_EMPTY_EMAIL");
const password = need("E2E_EMPTY_PASSWORD");
const slug = need("E2E_EMPTY_SLUG");
const inviteeEmail = need("E2E_EMPTY_INVITEE_EMAIL");

const authDb = createDbClient({ url: need("AUTH_DATABASE_URL"), poolMax: 1, prepare: false });
try {
  const port = createDemoAccountPort({ authDb, env: process.env });
  const account = await port.ensureAccount({ email, name: "E2E boş tenant yöneticisi", password });
  const templateKey = TEMPLATE_KEYS[0];
  if (templateKey === undefined) throw new Error("e2e fikstürü: sektör şablonu yok");
  const result = await createWorkspace({
    db: openAppDb(need("DATABASE_URL")),
    // Yalnızca bu alt sürecin yerel bağımsız değişkeni: web/worker çalışma zamanı ortamını etkilemez. Kapı `WMS_ENV` ci/local ister.
    env: { WMS_ENV: "ci", SIGNUP_ENABLED: "true" },
    principal: { userId: account.userId, mfaVerified: false },
    name: "E2E boş çalışma alanı",
    slug,
    templateKey,
    requestId: randomUUID(),
  });
  // Davet: posta teslimi kapalı (MAIL_MODE=disabled) → yanıtta düz belirteç (SCREEN). Kuyruk bu süreçte yok: A-42 geri dönüşü.
  const mailConfig = loadMailConfig(process.env);
  assertMailModeAllowed(mailConfig, process.env.WMS_ENV?.trim());
  const invite = await inviteMember(
    {
      db: openAppDb(need("DATABASE_URL")),
      principal: { userId: account.userId, mfaVerified: true }, // fikstür sahibi: yalnızca bu davet için (MFA kuralı değiştirilmez)
      tenantSlug: result.slug,
      email: inviteeEmail,
      roleKey: "TENANT_ADMIN",
    },
    { mailConfig, queue: { enqueue: () => Promise.reject(new Error("e2e fikstürü: kuyruk yok")) } },
  );
  if (invite.token === undefined) throw new Error("e2e fikstürü: davet belirteci üretilmedi (teslim kapalı olmalı)");
  process.stderr.write(`e2e fikstürü hazır: slug=${result.slug} created=${String(result.created)}\n`);
  process.stdout.write(`E2E_INVITE_TOKEN=${invite.token}\n`);
} finally {
  await authDb.close();
}
process.exit(0);
