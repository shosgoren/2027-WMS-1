// Şema sapma testi (T-102, Yapılacaklar 5): migration'lar uygulanmış gerçek veritabanında
// `information_schema.columns` ↔ Drizzle `getTableConfig` (ad, tip, NULL'luk) birebir olmalı.
// Sonraki şema kartları bu testi genişletir (yeni şema modülünü SCHEMA_MODULES'e ekler).
// Okuma, tablo sahibi migration rolüyle yapılır: `information_schema.columns` yalnızca çağıranın
// yetkili olduğu sütunları gösterir (wms_app ile eksik görünürdü).
//
// Better Auth 1.7.7 referans alan listeleri (kaynak: `@better-auth/core` dist/db/get-tables.mjs ve
// `better-auth` dist/plugins/two-factor/schema.mjs, npm tarball'ı) aşağıdadır; Drizzle şemasındaki
// bu listede olmayan sütunlar YALNIZCA bilinçli eklerdir (BILINCLI_EKLER).
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import * as identity from "../../../packages/db/src/schema/identity.ts";
import { readIntEnv, redactErrorChain, secretUrls } from "../harness/env.ts";

const env = readIntEnv(process.env);

// `drizzle-orm` yalnızca packages/db'nin bağımlılığıdır; kökten çözülemez → o paketin çözümleyicisi.
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../../packages/db/package.json"));
const pgCore = (await import(pathToFileURL(dbRequire.resolve("drizzle-orm/pg-core")).href)) as typeof import("drizzle-orm/pg-core");

type PgTableAny = Parameters<typeof pgCore.getTableConfig>[0];
const SCHEMA_MODULES: Record<string, unknown>[] = [identity];

function allTables(): PgTableAny[] {
  const out: PgTableAny[] = [];
  for (const mod of SCHEMA_MODULES) {
    for (const value of Object.values(mod)) {
      if (typeof value === "object" && value !== null && (value as { [k: symbol]: unknown })[Symbol.for("drizzle:IsDrizzleTable")] === true) {
        out.push(value as PgTableAny);
      }
    }
  }
  return out;
}

/** information_schema.data_type değerleri ile Drizzle `getSQLType()` eşlemesi (yalnızca farklılar). */
const TYPE_ALIAS: Record<string, string> = {};

interface Col {
  type: string;
  nullable: boolean;
}

async function dbColumns(): Promise<Map<string, Map<string, Col>>> {
  const client = new pg.Client({ connectionString: env.databaseUrlDirect });
  try {
    await client.connect();
    const r = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'`,
    );
    const out = new Map<string, Map<string, Col>>();
    for (const row of r.rows) {
      const cols = out.get(row.table_name) ?? new Map<string, Col>();
      cols.set(row.column_name, { type: row.data_type, nullable: row.is_nullable === "YES" });
      out.set(row.table_name, cols);
    }
    return out;
  } catch (e) {
    throw new Error(redactErrorChain(e, secretUrls(env)));
  } finally {
    await client.end();
  }
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Better Auth 1.7.7 alanları (camelCase; `id` örtük). `rateLimit.key` → `key_hash` (ADR-014 §13, m9). */
const BETTER_AUTH_FIELDS: Record<string, string[]> = {
  users: ["name", "email", "emailVerified", "image", "createdAt", "updatedAt", "twoFactorEnabled"],
  sessions: ["expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"],
  accounts: [
    "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
    "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt",
  ],
  verifications: ["identifier", "value", "expiresAt", "createdAt", "updatedAt"],
  two_factors: ["secret", "backupCodes", "userId", "verified", "failedVerificationCount", "lockedUntil"],
  auth_rate_limits: ["keyHash", "count", "lastRequest"],
};

/** Better Auth çekirdek şemasına BİLİNÇLİ ekler (ADR-014 §12; ADR-016 3. tur m7). */
const BILINCLI_EKLER: Record<string, string[]> = {
  users: ["invitation_claim_id"],
  sessions: ["mfa_verified_at"],
};

describe(`identity schema drift (target=${env.target})`, () => {
  it("public tablolari tam olarak Drizzle tablolarinin kumesidir (ek/eksik tablo yok)", async () => {
    const db = await dbColumns();
    const declared = allTables().map((t) => pgCore.getTableConfig(t).name).sort();
    expect([...db.keys()].sort()).toEqual(declared);
  });

  it("her tablo icin sutun adi, tip ve NULL'luk birebir esler", async () => {
    const db = await dbColumns();
    for (const table of allTables()) {
      const cfg = pgCore.getTableConfig(table);
      const dbCols = db.get(cfg.name);
      expect(dbCols, `tablo yok: ${cfg.name}`).toBeDefined();
      const declared = new Map<string, Col>(
        cfg.columns.map((c) => [c.name, { type: TYPE_ALIAS[c.getSQLType()] ?? c.getSQLType(), nullable: !c.notNull }]),
      );
      expect(Object.fromEntries([...(dbCols ?? [])].sort()), cfg.name).toEqual(Object.fromEntries([...declared].sort()));
    }
  });

  it("Better Auth alanlari + yalnizca bilincli ekler: baska sutun yok (mfa_verified_at, invitation_claim_id istisnasi)", () => {
    const byName = new Map(allTables().map((t) => [pgCore.getTableConfig(t).name, pgCore.getTableConfig(t)]));
    for (const [table, fields] of Object.entries(BETTER_AUTH_FIELDS)) {
      const cfg = byName.get(table);
      expect(cfg, `tablo yok: ${table}`).toBeDefined();
      const expected = ["id", ...fields.map(snake), ...(BILINCLI_EKLER[table] ?? [])].sort();
      expect((cfg?.columns ?? []).map((c) => c.name).sort(), table).toEqual(expected);
    }
    // Bilinçli eklerin toplamı tam olarak iki sütundur.
    expect(Object.values(BILINCLI_EKLER).flat().sort()).toEqual(["invitation_claim_id", "mfa_verified_at"]);
  });

  it("kimlikler uuid ve users.email kucuk harfe normalize + UNIQUE", async () => {
    const client = new pg.Client({ connectionString: env.databaseUrlDirect });
    try {
      await client.connect();
      const ids = await client.query<{ table_name: string; data_type: string; column_default: string }>(
        `SELECT table_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'id'`,
      );
      expect(ids.rows.length).toBe(7);
      for (const r of ids.rows) {
        expect(r.data_type, r.table_name).toBe("uuid");
        expect(r.column_default, r.table_name).toBe("gen_random_uuid()");
      }
      const cons = await client.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'public.users'::regclass AND conname IN ('users_email_key', 'users_email_lowercase_chk')`,
      );
      expect(cons.rows.map((r) => r.conname).sort()).toEqual(["users_email_key", "users_email_lowercase_chk"]);
    } finally {
      await client.end();
    }
  });
});
