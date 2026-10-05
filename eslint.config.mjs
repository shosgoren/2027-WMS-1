// Kök ESLint yapılandırması (flat config). Tüm repo bu dosyayla lint edilir.
import { createRequire } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Next.js eklentisi `apps/web`in devDependency'sidir; oradan çözülür.
const requireFromWeb = createRequire(new URL("./apps/web/package.json", import.meta.url));
/** @type {typeof import("@next/eslint-plugin-next").default} */
const nextPlugin = requireFromWeb("@next/eslint-plugin-next");

/** Tüm repo kaynakları (lint kapsamı). */
const LINT_FILES = "**/*.{js,mjs,cjs,ts,mts,cts,tsx}";

const MSG_DB = "tenant erişimi `withTenant` (@wms/db) ile yapılır (T-005b/T-005g, I-02).";

/**
 * `drizzle-orm` alt yollarından sürücüsüz olanlar (kurulu drizzle-orm 0.45.3 `package.json#exports`
 * listesinden; T-005g, G-04). Kök (`drizzle-orm`) her zaman serbesttir; burada olmayan her alt yol
 * (sürücü/bağdaştırıcı: postgres-js, node-postgres, neon-http, neon-serverless, pglite, pg-proxy,
 * vercel-postgres, bun-sql, prisma/*, knex, kysely, aws-data-api, … ve yeni eklenecekler) yasaktır.
 */
const DRIZZLE_DRIVERLESS_SUBPATHS = [
  "alias", "batch", "casing", "column-builder", "column", "entity", "errors", "logger", "migrator",
  "operations", "primary-key", "query-promise", "relations", "runnable-query", "selection-proxy",
  "session", "subquery", "table", "table\\.utils", "tracing-utils", "tracing", "utils", "version",
  "view-common", "sql", "query-builders", "cache\\/core", "pg-core", "mysql-core", "sqlite-core",
  "gel-core", "singlestore-core", "neon", "supabase",
];

/**
 * Yasaklı modül belirteçleri (tek kaynak). `regex` hem `no-restricted-imports` (bayrak `iu`) hem
 * esquery seçicileri (bayrak `i`) için geçerli olacak biçimde yazılır: `/` her zaman `\/` olarak
 * kaçırılır, karakter sınıfı kullanılmaz. Girdiler birbirini dışlar (tek ihlal = tek rapor).
 */
const FORBIDDEN_MODULES = [
  {
    regex: "^@wms\\/db\\/internal(?:\\/|$)",
    message: `Ham DB istemcisi/TenantContext oluşturucusu yalnızca packages/db içindir; ${MSG_DB}`,
  },
  {
    // Kapsamsız sürücü adları sıradan dizelerle (ör. compose servis adı "postgres") çakışabilir:
    // `ambiguous` → takma adlı çağrı denetiminde yalnızca require benzeri çağrılarda aranır.
    regex: "^(?:postgres|pg|pg-pool|pg-native)(?:\\/|$)",
    message: `PostgreSQL sürücüsü yalnızca packages/db içinde kullanılır; ${MSG_DB}`,
    ambiguous: true,
  },
  {
    regex: "^(?:@neondatabase\\/serverless|@vercel\\/postgres|@electric-sql\\/pglite)(?:\\/|$)",
    message: `PostgreSQL sürücüsü yalnızca packages/db içinde kullanılır; ${MSG_DB}`,
  },
  {
    regex: `^drizzle-orm\\/(?!(?:${DRIZZLE_DRIVERLESS_SUBPATHS.join("|")})(?:\\/|$))`,
    message: `Drizzle sürücü bağdaştırıcısı yalnızca packages/db içinde kullanılır (izinli: kök ve sürücüsüz alt yollar); ${MSG_DB}`,
  },
  {
    regex: "(?:^|\\/)packages\\/db\\/src(?:\\/|$)|(?:^|\\/)db\\/src\\/client",
    message: `packages/db kaynağına doğrudan yol yasaktır; paket girişi \`@wms/db\` kullanılır; ${MSG_DB}`,
  },
  {
    regex: "(?:^|\\/)node_modules(?:\\/|$)",
    message: `node_modules içine doğrudan yol (paket çözümünü atlatma) yasaktır; ${MSG_DB}`,
  },
];

/** @param {typeof FORBIDDEN_MODULES} list */
const toSelectorRegex = (list) => `/${list.map(({ regex }) => `(?:${regex})`).join("|")}/i`;
const FORBIDDEN_RE = toSelectorRegex(FORBIDDEN_MODULES);
/** Sıradan dizeyle karışmayan (yol/kapsamlı ad) yasaklı belirteçler: her çağrıda aranır. */
const FORBIDDEN_UNAMBIGUOUS_RE = toSelectorRegex(FORBIDDEN_MODULES.filter((m) => !m.ambiguous));
const MSG_FORBIDDEN = `Ham DB istemcisi/sürücüsü yalnızca packages/db içindir (dinamik import/require dahil); ${MSG_DB}`;
const MSG_NON_STATIC =
  "Modül belirteci statik bir dize olmalı (göreli şablon hariç); yasaklı istemci kümesinin dinamik atlatılmasını önler (T-005g).";

/**
 * `require(…)`, `x.require(…)` (module.require), `createRequire(…)(…)` ve adı "require" içeren
 * takma adlar (`const requireFromX = createRequire(…)`). `createRequire(taban)`ın kendisi hariç
 * (argümanı modül belirteci değil, taban yoldur).
 */
const REQUIRE_CALL =
  "CallExpression:matches([callee.name=/^(?!createrequire$).*require/i], [callee.property.name=/^(?!createrequire$).*require/i], [callee.callee.name='createRequire'], [callee.callee.property.name='createRequire'])";
/** Şablon dizesi ifade içeriyor ve `./` veya `../` ile başlamıyor (dinamik paket adı). */
const DYNAMIC_BARE_TEMPLATE = "[expressions.length>0][quasis.0.value.raw=/^(?!\\.\\.?\\/)/]";

/** AC-28 / T-005g Yapılacak 1: dinamik biçimlerde aynı yasaklı küme. */
const RAW_CLIENT_SYNTAX = [
  // import("…"), import(`…`)
  { selector: `ImportExpression > Literal.source[value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
  { selector: `ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
  // require("…"), module.require("…"), createRequire(…)("…"), require adlı takma adlar: tüm küme.
  { selector: `${REQUIRE_CALL}[arguments.0.type='Literal'][arguments.0.value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
  { selector: `${REQUIRE_CALL} > TemplateLiteral:first-child > TemplateElement[value.raw=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
  // Herhangi bir çağrının ilk argümanı yol/kapsamlı yasaklı belirteç (takma adlı yükleyici,
  // ör. `const r = createRequire(…); r("drizzle-orm/postgres-js")`).
  {
    selector: `CallExpression[arguments.0.type='Literal'][arguments.0.value=${FORBIDDEN_UNAMBIGUOUS_RE}]`,
    message: MSG_FORBIDDEN,
  },
  {
    selector: `CallExpression > TemplateLiteral:first-child > TemplateElement[value.raw=${FORBIDDEN_UNAMBIGUOUS_RE}]`,
    message: MSG_FORBIDDEN,
  },
  // import x = require("…") (TypeScript)
  { selector: `TSExternalModuleReference > Literal[value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
  // Statik olmayan belirteçler (değişken, birleştirme, dinamik paket adlı şablon).
  { selector: "ImportExpression:not([source.type='Literal'], [source.type='TemplateLiteral'])", message: MSG_NON_STATIC },
  { selector: `ImportExpression > TemplateLiteral.source${DYNAMIC_BARE_TEMPLATE}`, message: MSG_NON_STATIC },
  {
    selector: `${REQUIRE_CALL}:not([arguments.0.type='Literal'], [arguments.0.type='TemplateLiteral'])`,
    message: MSG_NON_STATIC,
  },
  { selector: `${REQUIRE_CALL} > TemplateLiteral:first-child${DYNAMIC_BARE_TEMPLATE}`, message: MSG_NON_STATIC },
];

// T-005g Yapılacak 4: tenant bağlam ayarı yalnızca packages/db (`withTenant`) içinde. Desenler bu
// dosyanın kendisi de lint edildiği için karakter sınıfıyla (`confi[g]`) yazılır.
const TENANT_SETTING_RE = "/set_confi[g]|app\\.current_tenant_i[d]/i";
const SQL_SET_RESET_RE = "/^\\s*(?:SET|RESET)\\s/";
const MSG_TENANT =
  "Tenant bağlam ayarı ve oturum SET/RESET ifadeleri yalnızca packages/db içinde (`withTenant`, transaction-local) yapılır (T-005g, I-02, G-02).";
const TENANT_SETTING_SYNTAX = [
  { selector: `Literal[value=${TENANT_SETTING_RE}]`, message: MSG_TENANT },
  { selector: `Literal[value=${SQL_SET_RESET_RE}]`, message: MSG_TENANT },
  { selector: `TemplateElement[value.raw=${TENANT_SETTING_RE}]`, message: MSG_TENANT },
  { selector: `TemplateLiteral[quasis.0.value.raw=${SQL_SET_RESET_RE}]`, message: MSG_TENANT },
];

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/.next/",
    "**/dist/",
    ".artifacts/",
    "docs/_master/",
    // `next dev|build|typegen` her koşuda yeniden üretir (Next önerisi: commit edilmez).
    "apps/web/next-env.d.ts",
  ]),
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    rules: {
      // 15 §Kod: `any` yalnızca gerekçeli → satır içi
      // `eslint-disable-next-line @typescript-eslint/no-explicit-any -- <gerekçe>`.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Next.js kuralları yalnızca web uygulamasında.
    files: ["apps/web/**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"]],
    settings: { next: { rootDir: "apps/web/" } },
  },
  {
    // T-005b/T-005g (AC-28 lint kısmı; 02 §Pooler uyumluluğu, ADR-003, I-01…I-03): ham DB
    // istemcisi/sürücüsü ve tenant bağlam ayarı `packages/db` dışında yasaktır. Tenant verisine tek
    // yol `@wms/db` → `withTenant(ctx, tx => …)`. Kapsam: tüm repo; istisna yalnızca `packages/db/**`
    // (istemcinin kendisi) ve `tests/integration/**` (fikstür: ham istemci + sonda politikası).
    // Yasaklı küme tek sabittedir (FORBIDDEN_MODULES); statik import (`no-restricted-imports`) ve
    // dinamik biçimler (`no-restricted-syntax`: `import()`, `require`, `createRequire(…)(…)`,
    // şablon dizeleri) aynı düzenli ifadelerden üretilir.
    // Not: flat config'te aynı kural sonraki bir blokta yeniden tanımlanırsa seçenekler BİRLEŞMEZ,
    // değiştirilir; yeni kısıtlar bu bloğa eklenmelidir.
    files: [LINT_FILES],
    ignores: ["packages/db/**", "tests/integration/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: FORBIDDEN_MODULES.map(({ regex, message }) => ({ regex, message })) },
      ],
      "no-restricted-syntax": ["error", ...RAW_CLIENT_SYNTAX, ...TENANT_SETTING_SYNTAX],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
