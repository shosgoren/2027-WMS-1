// Demo hesap bağdaştırıcısı (T-123a; A-43, A-50, A-62, A-63): `DemoAccountPort` sözleşmesini
// (packages/domain/src/demo/seed.ts) `wms_auth` rolüyle sağlar. YALNIZCA local/staging + DEMO_MODE=1.
//
// - Kullanıcı + credential hesabı Better Auth şemasıyla birebir yazılır (users + accounts{provider_id='credential',
//   account_id=user.id}; `internalAdapter.createOAuthUser` ile aynı biçim, index.ts `createInvitedAccount`). Özet Better
//   Auth'a `emailAndPassword.password.hash/verify` olarak verilen Argon2id ile aynı parametrelerdedir (aşağıdaki not).
// - Bu modül `index.ts`'i (better-auth, next) VE `password.ts`'i içe aktarmaz: worker paketinde `@node-rs/argon2`
//   (yerel ikili) yalnızca burada, `createRequire` + sabit dizeyle ve yalnızca ilk kullanımda yüklenir; esbuild dış paketi
//   statik `import`a çevirip dosya başına taşırdı (prod worker'ı modül yokken açılışta çökerdi). Parametre eşitliği ve
//   birlikte çalışma int testinde (`ARGON2_PARAMS`, `verifyPassword`) doğrulanır.
// - Alan adı kodda sabittir (`DEMO_ACCOUNT_EMAIL_DOMAIN`, seed ile tek kaynak: int testi eşitliği doğrular);
//   `DEMO_EMAIL_DOMAIN` yalnızca buna eşitse kabul edilir.
// - Yetki: users INSERT/UPDATE(email_verified, two_factor_enabled), accounts INSERT/UPDATE, sessions DELETE,
//   two_factors DELETE, security_events INSERT (0002 `wms_auth` yetkileri). MFA yazılmaz.
// - Parola ve özeti loglanmaz, olaya/hataya girmez (G-09). Olay `detail` boştur; e-posta yazılmaz.
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { demoModeEnabled } from "@wms/db";
import { rawDb } from "@wms/db/internal";
import type { DbClient } from "@wms/db/internal";
import { isDemoEmail, parseDemoDomain } from "./policy.ts";

export { parseDemoDomain };

/** `packages/domain/src/demo/seed.ts` DEMO_EMAIL_DOMAIN ile aynı (int testi doğrular). */
export const DEMO_ACCOUNT_EMAIL_DOMAIN = "example.invalid";

/** `index.ts` PASSWORD_MIN_LENGTH/PASSWORD_MAX_LENGTH (A-41) ile aynı; eşitlik int testinde doğrulanır. */
export const DEMO_ACCOUNT_PASSWORD_MIN_LENGTH = 12;
export const DEMO_ACCOUNT_PASSWORD_MAX_LENGTH = 128;

/** `password.ts` ARGON2_PARAMS ile aynı (OWASP m=19 MiB, t=2, p=1); int testi eşitliği doğrular. */
const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
const ARGON2ID = 2; // `Algorithm.Argon2id` (ortam const enum; password.ts ile aynı gerekçe)

type Argon2 = typeof import("@node-rs/argon2");
// `createRequire` + sabit dize: paketleyici bunu statik `import`a ÇEVİRİP dosya başına taşımaz (esbuild dış paketteki
// `import()`/`import`u hoist eder); modül yalnızca ilk kullanımda yüklenir (üstteki not).
const requireModule = createRequire(import.meta.url);
let argon2Module: Argon2 | undefined;
function loadArgon2(): Promise<Argon2> {
  argon2Module ??= requireModule("@node-rs/argon2") as Argon2;
  return Promise.resolve(argon2Module);
}
async function hashDemoPassword(password: string): Promise<string> {
  return (await loadArgon2()).hash(password, ARGON2_PARAMS);
}
async function verifyDemoPassword(hash: string, password: string): Promise<boolean> {
  const argon2 = await loadArgon2();
  try {
    if ((argon2.parseOptions(hash).algorithm as number) !== ARGON2ID) return false;
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export const DEMO_ACCOUNT_EVENT = Object.freeze({
  created: "demo.account_created",
  passwordReset: "demo.password_reset",
  /** Yalnızca MFA temizlenerek devralındı (parola değişmedi). */
  takenOver: "demo.account_taken_over",
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
  /** `SELECT current_user` = `wms_auth` değilse `FORBIDDEN` (fail-closed, A-63). Açılışta çağrılır; `ensureAccount` da bekler. */
  verifyRole(): Promise<void>;
}

function sqlStateOf(error: unknown): string | undefined {
  for (let e: unknown = error, i = 0; i < 4 && typeof e === "object" && e !== null; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const MAX_ATTEMPTS = 4;
class Retry extends Error {}

interface Observed {
  readonly user: { id: string; email_verified: boolean; two_factor_enabled: boolean } | undefined;
  readonly account: { id: string; password: string | null } | undefined;
}

/**
 * Ortam kapısı: `WMS_ENV` ∈ {local, staging}, `DEMO_MODE=1` ve `DEMO_EMAIL_DOMAIN` = `example.invalid`; aksi
 * `FORBIDDEN`/`VALIDATION_FAILED` fırlatır (bağdaştırıcı hiç kurulmaz). Her `ensureAccount` çağrısında yeniden denetlenir.
 */
export function createDemoAccountPort(options: DemoAccountPortOptions): DemoAccountPortLike {
  const { authDb, env } = options;
  const gate = (): string => {
    if (!demoModeEnabled(env)) throw new DemoAccountError("FORBIDDEN");
    const domain = parseDemoDomain(env.DEMO_EMAIL_DOMAIN);
    if (domain === null || domain !== DEMO_ACCOUNT_EMAIL_DOMAIN) throw new DemoAccountError("VALIDATION_FAILED");
    return domain;
  };
  gate();
  const db = rawDb(authDb);

  let roleChecked: Promise<void> | undefined;
  const verifyRole = (): Promise<void> => {
    roleChecked ??= (async () => {
      let rows: { u: string }[];
      try {
        rows = await db.execute<{ u: string }>(sql`SELECT current_user::text AS u`);
      } catch (error) {
        throw new DemoAccountError("INTERNAL", sqlStateOf(error));
      }
      if (rows[0]?.u !== "wms_auth") throw new DemoAccountError("FORBIDDEN");
    })();
    // Başarısız doğrulama önbelleğe alınmaz: sonraki çağrı yeniden dener.
    roleChecked.catch(() => {
      roleChecked = undefined;
    });
    return roleChecked;
  };

  return {
    verifyRole,
    async ensureAccount({ email, name, password }) {
      const domain = gate();
      if (typeof email === "string" && !isDemoEmail(email, domain)) throw new DemoAccountError("FORBIDDEN");
      if (
        typeof email !== "string" ||
        email !== email.trim().toLowerCase() ||
        typeof name !== "string" ||
        name.trim() === "" ||
        name.length > 200 ||
        typeof password !== "string" ||
        password.length < DEMO_ACCOUNT_PASSWORD_MIN_LENGTH ||
        password.length > DEMO_ACCOUNT_PASSWORD_MAX_LENGTH
      ) {
        throw new DemoAccountError("VALIDATION_FAILED");
      }
      await verifyRole();
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          try {
            return await ensureOnce(email, name.trim(), password);
          } catch (error) {
            if (!(error instanceof Retry)) throw error;
          }
        }
        throw new DemoAccountError("INTERNAL");
      } catch (error) {
        if (error instanceof DemoAccountError) throw error;
        // Drizzle hataları parametre (e-posta/özet) taşır: yalnızca SQLSTATE ile sabit hata (G-09).
        throw new DemoAccountError("INTERNAL", sqlStateOf(error));
      }
    },
  };

  async function observe(email: string): Promise<Observed> {
    const users = await db.execute<{ id: string; email_verified: boolean; two_factor_enabled: boolean }>(
      sql`SELECT id, email_verified, two_factor_enabled FROM public.users WHERE email = ${email}`,
    );
    const user = users[0];
    if (user === undefined) return { user: undefined, account: undefined };
    const accounts = await db.execute<{ id: string; password: string | null }>(
      sql`SELECT id, password FROM public.accounts WHERE user_id = ${user.id}::uuid AND provider_id = 'credential'`,
    );
    return { user, account: accounts[0] };
  }

  // Oku + (Argon2, kilit DIŞINDA) doğrula → gerekirse özetle → kısa transaction'da kilitle, gözlenen durum değiştiyse
  // `Retry` (kilit altında yavaş Argon2 çalışmaz).
  async function ensureOnce(
    email: string,
    name: string,
    password: string,
  ): Promise<{ userId: string; created: boolean; passwordUpdated: boolean }> {
    const seen = await observe(email);
    const matches =
      seen.account?.password != null && (await verifyDemoPassword(seen.account.password, password));
    if (seen.user !== undefined && matches && seen.user.email_verified && !seen.user.two_factor_enabled) {
      return { userId: seen.user.id, created: false, passwordUpdated: false };
    }
    const newHash = seen.user === undefined || !matches ? await hashDemoPassword(password) : undefined;
    const hashToWrite = (): string => {
      if (newHash === undefined) throw new DemoAccountError("INTERNAL"); // mantık hatası: özet gerekli ama üretilmedi
      return newHash;
    };

    return db.transaction(async (tx) => {
      const event = async (type: string, userId: string): Promise<void> => {
        await tx.execute(
          sql`INSERT INTO public.security_events (user_id, event_type, detail) VALUES (${userId}::uuid, ${type}, '{}'::jsonb)`,
        );
      };
      if (seen.user === undefined) {
        const inserted = await tx.execute<{ id: string }>(
          sql`INSERT INTO public.users (name, email, email_verified)
              VALUES (${name}, ${email}, true)
              ON CONFLICT (email) DO NOTHING
              RETURNING id`,
        );
        const id = inserted[0]?.id;
        if (id === undefined) throw new Retry(); // eşzamanlı oluşturma: kazananın satırı yeniden gözlenir
        await tx.execute(
          sql`INSERT INTO public.accounts (account_id, provider_id, user_id, password)
              VALUES (${id}::text, 'credential', ${id}::uuid, ${hashToWrite()})`,
        );
        await event(DEMO_ACCOUNT_EVENT.created, id);
        return { userId: id, created: true, passwordUpdated: false };
      }

      const userId = seen.user.id;
      const locked = await tx.execute<{ email_verified: boolean; two_factor_enabled: boolean }>(
        sql`SELECT email_verified, two_factor_enabled FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`,
      );
      const lockedAccount = await tx.execute<{ id: string; password: string | null }>(
        sql`SELECT id, password FROM public.accounts WHERE user_id = ${userId}::uuid AND provider_id = 'credential' FOR UPDATE`,
      );
      const u = locked[0];
      if (u === undefined) throw new Retry();
      const a = lockedAccount[0];
      if (a?.id !== seen.account?.id || a?.password !== seen.account?.password) throw new Retry();

      let passwordUpdated = false;
      if (!matches) {
        if (a === undefined) {
          await tx.execute(
            sql`INSERT INTO public.accounts (account_id, provider_id, user_id, password)
                VALUES (${userId}::text, 'credential', ${userId}::uuid, ${hashToWrite()})`,
          );
        } else {
          await tx.execute(sql`UPDATE public.accounts SET password = ${hashToWrite()}, updated_at = now() WHERE id = ${a.id}::uuid`);
        }
        passwordUpdated = true;
      }
      const hadMfa = u.two_factor_enabled;
      if (!u.email_verified || hadMfa) {
        // Devralma: MFA kapatılır ve ikinci faktör kayıtları silinir (createInvitedAccount/kurtarma deseni).
        await tx.execute(
          sql`UPDATE public.users SET email_verified = true, two_factor_enabled = false, updated_at = now() WHERE id = ${userId}::uuid`,
        );
      }
      if (hadMfa) await tx.execute(sql`DELETE FROM public.two_factors WHERE user_id = ${userId}::uuid`);
      if (passwordUpdated || hadMfa) {
        // Eski parola/faktörle açılmış oturumlar kapanır.
        await tx.execute(sql`DELETE FROM public.sessions WHERE user_id = ${userId}::uuid`);
        await event(passwordUpdated ? DEMO_ACCOUNT_EVENT.passwordReset : DEMO_ACCOUNT_EVENT.takenOver, userId);
      }
      return { userId, created: false, passwordUpdated };
    });
  }
}
