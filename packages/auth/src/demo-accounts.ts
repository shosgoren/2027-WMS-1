// Demo hesap bağdaştırıcısı (T-123a; A-43, A-50, A-62): `DemoAccountPort` sözleşmesini (packages/domain/src/demo/seed.ts)
// `wms_auth` rolüyle sağlar. YALNIZCA local/staging + DEMO_MODE=1; prod'da kurulamaz (fail-closed).
//
// - Kullanıcı + credential hesabı Better Auth şemasıyla birebir yazılır (users + accounts{provider_id='credential',
//   account_id=user.id}; `internalAdapter.createOAuthUser` ile aynı biçim, index.ts `createInvitedAccount`). Parola özeti
//   Better Auth'a `emailAndPassword.password.hash/verify` olarak verilen aynı işlevlerdir (`./password.ts`, Argon2id).
// - Bu modül `index.ts`'i (better-auth, next) İÇE AKTARMAZ: worker paketine yalnızca özet + DB sürücüsü girer.
// - Yetki: users INSERT/UPDATE(email_verified), accounts INSERT/UPDATE, sessions DELETE, security_events INSERT
//   (0002 `wms_auth` yetkileri); başka hiçbir tabloya dokunulmaz. MFA yazılmaz (two_factor_enabled varsayılan false).
// - Parola ve özeti loglanmaz, olaya/hataya girmez (G-09). Olay `detail` boştur; e-posta yazılmaz.
import { sql } from "drizzle-orm";
import { demoModeEnabled } from "@wms/db";
import { rawDb } from "@wms/db/internal";
import type { DbClient } from "@wms/db/internal";
import { hashPassword, verifyPassword } from "./password.ts";
import { isDemoEmail, parseDemoDomain } from "./policy.ts";

export { parseDemoDomain };

/** `index.ts` PASSWORD_MIN_LENGTH/PASSWORD_MAX_LENGTH (A-41) ile aynı; eşitlik int testinde doğrulanır. */
export const DEMO_ACCOUNT_PASSWORD_MIN_LENGTH = 12;
export const DEMO_ACCOUNT_PASSWORD_MAX_LENGTH = 128;

export const DEMO_ACCOUNT_EVENT = Object.freeze({
  created: "demo.account_created",
  passwordReset: "demo.password_reset",
});

/** Kod `docs/spec/15-engineering.md` listesindendir. Mesaj sabittir (değer içermez). */
export class DemoAccountError extends Error {
  override name = "DemoAccountError";
  readonly code: "FORBIDDEN" | "VALIDATION_FAILED" | "INTERNAL";
  /** Yalnızca SQLSTATE (varsa); parametre/sorgu metni taşınmaz. */
  readonly sqlState?: string;
  constructor(code: "FORBIDDEN" | "VALIDATION_FAILED" | "INTERNAL", sqlState?: string) {
    super(code);
    this.code = code;
    if (sqlState !== undefined) this.sqlState = sqlState;
  }
}

export interface DemoAccountPortOptions {
  /** `wms_auth` bağlantısı (AUTH_DATABASE_URL). */
  readonly authDb: DbClient;
  /** `WMS_ENV`, `DEMO_MODE`, `DEMO_EMAIL_DOMAIN` okunur. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface DemoAccountPortLike {
  ensureAccount(input: {
    readonly email: string;
    readonly name: string;
    readonly password: string;
  }): Promise<{ readonly userId: string; readonly created: boolean; readonly passwordUpdated: boolean }>;
}

function sqlStateOf(error: unknown): string | undefined {
  for (let e: unknown = error, i = 0; i < 4 && typeof e === "object" && e !== null; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Ortam kapısı: `WMS_ENV` ∈ {local, staging} ve `DEMO_MODE=1` ve geçerli `DEMO_EMAIL_DOMAIN`; aksi `FORBIDDEN`/
 * `VALIDATION_FAILED` fırlatır (bağdaştırıcı hiç kurulmaz). Her `ensureAccount` çağrısında da yeniden denetlenir.
 */
export function createDemoAccountPort(options: DemoAccountPortOptions): DemoAccountPortLike {
  const { authDb, env } = options;
  const gate = (): string => {
    if (!demoModeEnabled(env)) throw new DemoAccountError("FORBIDDEN");
    const domain = parseDemoDomain(env.DEMO_EMAIL_DOMAIN);
    if (domain === null) throw new DemoAccountError("VALIDATION_FAILED");
    return domain;
  };
  gate();
  const db = rawDb(authDb);

  return {
    async ensureAccount({ email, name, password }) {
      const domain = gate();
      if (
        typeof email !== "string" ||
        email !== email.trim().toLowerCase() ||
        !isDemoEmail(email, domain) ||
        typeof name !== "string" ||
        name.trim() === "" ||
        name.length > 200 ||
        typeof password !== "string" ||
        password.length < DEMO_ACCOUNT_PASSWORD_MIN_LENGTH ||
        password.length > DEMO_ACCOUNT_PASSWORD_MAX_LENGTH
      ) {
        // Alan dışı e-posta FORBIDDEN, biçim/uzunluk hataları VALIDATION_FAILED.
        throw new DemoAccountError(typeof email === "string" && !isDemoEmail(email, domain) ? "FORBIDDEN" : "VALIDATION_FAILED");
      }
      const newHash = await hashPassword(password);
      try {
        return await db.transaction(async (tx) => {
          const event = async (type: string, userId: string): Promise<void> => {
            await tx.execute(
              sql`INSERT INTO public.security_events (user_id, event_type, detail) VALUES (${userId}::uuid, ${type}, '{}'::jsonb)`,
            );
          };
          const inserted = await tx.execute<{ id: string }>(
            sql`INSERT INTO public.users (name, email, email_verified)
                VALUES (${name.trim()}, ${email}, true)
                ON CONFLICT (email) DO NOTHING
                RETURNING id`,
          );
          const createdId = inserted[0]?.id;
          if (createdId !== undefined) {
            await tx.execute(
              sql`INSERT INTO public.accounts (account_id, provider_id, user_id, password)
                  VALUES (${createdId}::text, 'credential', ${createdId}::uuid, ${newHash})`,
            );
            await event(DEMO_ACCOUNT_EVENT.created, createdId);
            return { userId: createdId, created: true, passwordUpdated: false };
          }

          // Mevcut kullanıcı: satır kilitlenir (eşzamanlı iki eşitleme sırayla çalışır).
          const users = await tx.execute<{ id: string; email_verified: boolean }>(
            sql`SELECT id, email_verified FROM public.users WHERE email = ${email} FOR UPDATE`,
          );
          const user = users[0];
          if (user === undefined) throw new DemoAccountError("INTERNAL");
          if (!user.email_verified) {
            await tx.execute(sql`UPDATE public.users SET email_verified = true, updated_at = now() WHERE id = ${user.id}::uuid`);
          }
          const accounts = await tx.execute<{ id: string; password: string | null }>(
            sql`SELECT id, password FROM public.accounts WHERE user_id = ${user.id}::uuid AND provider_id = 'credential' FOR UPDATE`,
          );
          const account = accounts[0];
          if (account === undefined) {
            await tx.execute(
              sql`INSERT INTO public.accounts (account_id, provider_id, user_id, password)
                  VALUES (${user.id}::text, 'credential', ${user.id}::uuid, ${newHash})`,
            );
            await event(DEMO_ACCOUNT_EVENT.passwordReset, user.id);
            return { userId: user.id, created: false, passwordUpdated: true };
          }
          if (account.password !== null && (await verifyPassword({ hash: account.password, password }))) {
            return { userId: user.id, created: false, passwordUpdated: false };
          }
          await tx.execute(sql`UPDATE public.accounts SET password = ${newHash}, updated_at = now() WHERE id = ${account.id}::uuid`);
          // Eski parolayla açılmış oturumlar kapanır.
          await tx.execute(sql`DELETE FROM public.sessions WHERE user_id = ${user.id}::uuid`);
          await event(DEMO_ACCOUNT_EVENT.passwordReset, user.id);
          return { userId: user.id, created: false, passwordUpdated: true };
        });
      } catch (error) {
        if (error instanceof DemoAccountError) throw error;
        // Drizzle hataları parametre (e-posta/özet) taşır: yalnızca SQLSTATE ile sabit hata (G-09).
        throw new DemoAccountError("INTERNAL", sqlStateOf(error));
      }
    },
  };
}
