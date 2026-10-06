// Parola özeti: Argon2id (ADR-014 §4, A-41). Better Auth `emailAndPassword.password.hash/verify`
// kancalarına verilir. Parola/özet loglanmaz, hata mesajına girmez (G-09, I-12).
import { type Options, hash, parseOptions, verify } from "@node-rs/argon2";

/**
 * Argon2id parametreleri (OWASP Password Storage Cheat Sheet, 2. seçenek: m=19 MiB, t=2, p=1).
 * `algorithm` bilinçli verilmez: `@node-rs/argon2` 2.2.1 tiplerinde `Algorithm` ortam `const enum`'udur
 * (isolatedModules ile içe aktarılamaz) ve varsayılan Argon2id'dir (index.d.ts `Algorithm.Argon2id`
 * "Default value"); varsayılan `auth.test.ts` ile `$argon2id$` önekinden ve `parseOptions` ile doğrulanır.
 */
export const ARGON2_PARAMS = Object.freeze({
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} satisfies Options);

/** `Algorithm.Argon2id` sayısal değeri (`@node-rs/argon2` index.d.ts). */
const ARGON2ID = 2;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

/**
 * Özet Argon2id değilse (ör. içe aktarılmış Argon2i/Argon2d) veya biçimi bozuksa `false`:
 * bu "doğrulanamadı" demektir, başarı değil. Parametre yükseltmesi (yeniden özetleme) kapsam dışı.
 */
export async function verifyPassword(data: { readonly hash: string; readonly password: string }): Promise<boolean> {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(data.hash);
  } catch {
    return false;
  }
  if ((parsed.algorithm as number) !== ARGON2ID) return false;
  try {
    return await verify(data.hash, data.password);
  } catch {
    return false;
  }
}
