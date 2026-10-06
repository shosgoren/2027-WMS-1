// Kök ESLint yapılandırması (flat config). Tüm repo bu dosyayla lint edilir.
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Next.js eklentisi `apps/web`in devDependency'sidir; oradan çözülür.
const requireFromWeb = createRequire(new URL("./apps/web/package.json", import.meta.url));
/** @type {typeof import("@next/eslint-plugin-next").default} */
const nextPlugin = requireFromWeb("@next/eslint-plugin-next");

/** Tüm repo kaynakları (lint kapsamı). */
/** Depo kökü (normalize edilmiş yol denetimi için; T-127a). */
const REPO_ROOT_POSIX = path.posix.resolve(new URL(".", import.meta.url).pathname).replace(/\/$/, "");

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
const DB_INTERNAL_ENTRY = {
  regex: "^@wms\\/db\\/internal(?:\\/|$)",
  message: `Ham DB istemcisi/TenantContext oluşturucusu yalnızca packages/db içindir; ${MSG_DB}`,
};
const FORBIDDEN_MODULES = [
  DB_INTERNAL_ENTRY,
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
    // Yol biçimli: takma adlı çağrı denetiminde yalnızca göreli/mutlak belirteç olarak aranır (T-015).
    pathLike: true,
  },
  {
    regex: "(?:^|\\/)node_modules(?:\\/|$)",
    message: `node_modules içine doğrudan yol (paket çözümünü atlatma) yasaktır; ${MSG_DB}`,
    pathLike: true,
  },
];

/**
 * T-111 (Faz 1 modül sınırları, ADR-014/ADR-005): kütüphane import'ları kendi paketlerine hapsedilir.
 * İzinli yollar aşağıdaki PROFILES tablosundadır. Bare `better-auth` / `pg-boss` sıradan dizelerle
 * çakışabileceğinden `ambiguous` (takma adlı çağrıda yalnızca require benzeri konumda aranır;
 * `createRequire` takma adlarını `wms/no-aliased-module-loader` izler); kapsamlı adlar değildir.
 */
const MSG_AUTH_LIB =
  "Better Auth / Argon2 yalnızca packages/auth, apps/web/app/api/auth ve (yalnızca `better-auth/react`) apps/web/lib/auth-client.ts içinde import edilir (ADR-014, T-111).";
const MSG_QUEUE_LIB = "pg-boss yalnızca packages/queue-adapter içinde import edilir (ADR-005, T-111).";
const BETTER_AUTH_ENTRY = { regex: "^better-auth(?:\\/|$)", message: MSG_AUTH_LIB, ambiguous: true };
/** `auth-client.ts` için: yalnızca `better-auth/react` serbest. */
const BETTER_AUTH_EXCEPT_REACT_ENTRY = { regex: "^better-auth(?:$|\\/(?!react$))", message: MSG_AUTH_LIB, ambiguous: true };
const AUTH_SCOPED_ENTRY = { regex: "^(?:@better-auth\\/|@node-rs\\/argon2(?:\\/|$))", message: MSG_AUTH_LIB };
const PG_BOSS_ENTRY = { regex: "^pg-boss(?:\\/|$)", message: MSG_QUEUE_LIB, ambiguous: true };
/**
 * T-127a (T-109b/T-125 inceleme takipleri; ADR-006): güvenlik varsayımları kod incelemesine değil lint'e
 * dayanır. İzinli kapsamlar PROFILES tablosundadır (`packages/storage/**`). Girdiler birbirini dışlar:
 * `@wms/storage/src/context` yalnızca paket-adı girdisine, `…/storage/src/context` yolları yalnızca yol
 * girdisine uyar (arkadan bakış `(?<!^@wms\/)`).
 */
const MSG_AWS_SDK = "@aws-sdk/* yalnızca packages/storage içinde import edilir (ADR-006, T-127a).";
const MSG_STORAGE_INTERNAL =
  "`@wms/storage` iç modülleri (context.ts: bağlam üreticisi) paket dışından hiçbir yoldan import edilmez; yalnızca paket girişi `@wms/storage` (T-125, T-127a).";
const MSG_CACHE_KEY =
  "`@wms/shared/cache-key` (`formatTenantCacheKey`) yalnızca packages/storage/src/index.ts içinde import edilir; uygulama kodu marka denetimli `tenantCacheKey` (@wms/storage) kullanır (T-125, T-127a).";
const AWS_SDK_ENTRY = { regex: "^@aws-sdk\\/", message: MSG_AWS_SDK };
/** Paket adı derin yolu (`exports` yalnızca `.`; `@wms/storage/src/context`, `@wms/storage/context` …). */
const STORAGE_DEEP_ENTRY = { regex: "^@wms\\/storage\\/", message: MSG_STORAGE_INTERNAL, normalized: true };
/** Göreli/mutlak/`file:` yol (`../../storage/src/context.ts`); node_modules yolu ayrıca yasaktır. */
const STORAGE_CONTEXT_PATH_ENTRY = {
  regex: "(?:^|\\/)(?<!^@wms\\/)storage\\/src\\/context(?![\\w-])",
  message: MSG_STORAGE_INTERNAL,
  pathLike: true,
  normalized: true,
};
/** `packages/storage` içinden ama `src/` dışından: `../src/context.ts` (üstteki girdiyle aynı dizgiye çift rapor vermez). */
const STORAGE_SRC_CONTEXT_RELATIVE_ENTRY = {
  regex: "(?:^|\\/)(?<!storage\\/)src\\/context(?![\\w-])",
  message: MSG_STORAGE_INTERNAL,
  pathLike: true,
};
const CACHE_KEY_ENTRY = { regex: "^@wms\\/shared\\/cache-key(?![\\w-])", message: MSG_CACHE_KEY, normalized: true };
const CACHE_KEY_PATH_ENTRY = { regex: "(?:^|\\/)shared\\/src\\/cache-key(?![\\w-])", message: MSG_CACHE_KEY, pathLike: true, normalized: true };
/**
 * `normalized`: bu girdiler ayrıca belirtecin `path.posix.normalize` edilmiş biçimine ve (göreli/mutlak/`file:` ise)
 * içe aktaran dosyaya göre çözülmüş depo-göreli yoluna karşı denetlenir (`wms/no-normalized-path-import`):
 * `src/./context.ts`, `src//context.ts`, `storage/./src/context`, `src/../src/context`, `../src/./context` atlatmaları.
 */
const STORAGE_ENTRIES = [STORAGE_DEEP_ENTRY, STORAGE_CONTEXT_PATH_ENTRY, CACHE_KEY_ENTRY, CACHE_KEY_PATH_ENTRY];
/** Tüm yasaklı kümenin birleşimi (girdiler birbirini dışlar). */
const ALL_FORBIDDEN_MODULES = [
  ...FORBIDDEN_MODULES,
  BETTER_AUTH_ENTRY,
  AUTH_SCOPED_ENTRY,
  PG_BOSS_ENTRY,
  AWS_SDK_ENTRY,
  ...STORAGE_ENTRIES,
];

/**
 * T-127a: `apps/web/**` için `@wms/db` adlı yasaklar (`packages/db/src/index.ts` dışa aktarımlarından): ham istemci
 * kuran (`createDbClient`) veya tenant/oturum üyeliği doğrulaması olmadan bağlam kuran/DbClient alan yollar
 * (`withSystemTenant`, `withNewTenant`, `recordSecurityEvent`). Web veriye yalnızca domain komutlarıyla erişir.
 * Ad alanı içe aktarımı (`import * as`) ve yeniden dışa aktarım da `no-restricted-imports` ile yakalanır;
 * dinamik/yükleyici biçimleri `WEB_DB_ENTRY` ile yasaktır.
 */
const MSG_WEB_DB =
  "apps/web `@wms/db` sistem/oturumsuz bağlam yollarını (createDbClient, withSystemTenant, withNewTenant, recordSecurityEvent, appendAudit) kullanamaz; DB'ye yalnızca domain komutlarıyla erişilir (T-127a).";
const WEB_DB_RESTRICTED_NAMES = ["createDbClient", "withSystemTenant", "withNewTenant", "recordSecurityEvent", "appendAudit"];
const WEB_DB_PATHS = [{ name: "@wms/db", importNames: WEB_DB_RESTRICTED_NAMES, message: MSG_WEB_DB }];
/**
 * Web'de `@wms/db` kökünün KENDİSİ statik import için serbesttir (yalnızca adlar yasak, `paths`); ama dinamik/yükleyici
 * biçimlerinde (`import()`, `require`, `createRequire` ve takma adları, şablon dizgisi, `import x = require()`) hiçbir ad
 * denetlenemeyeceğinden tümden yasaktır. Bu girdi YALNIZCA sözdizimi ve yükleyici kümesine girer, `no-restricted-imports`
 * desenlerine girmez. `ambiguous`: takma adlı genel çağrılarda aranmaz; yükleyici izleme kuralı tam kümeyle denetler.
 */
const WEB_DB_ENTRY = { regex: "^@wms\\/db$", message: MSG_WEB_DB, ambiguous: true };

/**
 * Yol biçimli girdinin "modül belirteci konumunda" biçimi: göreli (`./`, `../`), mutlak (`/`) veya
 * `file:` ile başlayan dize. Çıplak `"packages/db/src/x.ts"` Node çözümlemesinde paket adıdır (atlatma
 * değildir) ve sıradan dizelerle (glob, yol karşılaştırması) çakışır (T-015 yanlış pozitifi).
 * @param {string} regex
 */
const asSpecifierPath = (regex) => `^(?=\\.\\.?\\/|\\/|file:).*(?:${regex})`;
/** @param {Array<{ regex: string }>} list */
const toSelectorRegex = (list) => `/${list.map(({ regex }) => `(?:${regex})`).join("|")}/i`;
/** @typedef {{ regex: string, message?: string, ambiguous?: boolean, pathLike?: boolean, normalized?: boolean }} ForbiddenEntry */
/**
 * Bir yasaklı küme için esquery düzenli ifadeleri (kapsam başına ayrı küme: PROFILES, T-111).
 * @param {ForbiddenEntry[]} list
 */
const selectorRegexes = (list) => ({
  all: toSelectorRegex(list),
  /**
   * Herhangi bir çağrıda (takma adlı yükleyici) aranan küme: sıradan dizeyle karışmayan kapsamlı/alt
   * yollu adlar olduğu gibi; yol biçimli girdiler yalnızca göreli/mutlak belirteç biçiminde.
   * `require`/`import()`/`createRequire` konumunda ise tam küme (`all`) geçerlidir.
   */
  aliasCall: toSelectorRegex(list.filter((m) => !m.ambiguous).map((m) => (m.pathLike ? { regex: asSpecifierPath(m.regex) } : m))),
  /** Şablonun ilk parçası dışındaki parçalar (önünde ifade var): yol biçimli girdiler de tam aranır. */
  unambiguous: toSelectorRegex(list.filter((m) => !m.ambiguous)),
});
const MSG_FORBIDDEN = `Ham DB istemcisi/sürücüsü yalnızca packages/db içindir (dinamik import/require dahil); ${MSG_DB}`;
const MSG_NON_STATIC =
  "Modül belirteci statik bir dize olmalı (ifadesiz şablon hariç); yasaklı istemci kümesinin dinamik atlatılmasını önler (T-005g, T-016).";

/**
 * `require(…)`, `x.require(…)` (module.require), `createRequire(…)(…)` ve adı "require" içeren
 * takma adlar (`const requireFromX = createRequire(…)`). `createRequire(taban)`ın kendisi hariç
 * (argümanı modül belirteci değil, taban yoldur).
 */
const REQUIRE_CALLEE =
  ":matches([callee.name=/^(?!createrequire$).*require/i], [callee.property.name=/^(?!createrequire$).*require/i], [callee.callee.name='createRequire'], [callee.callee.property.name='createRequire'])";
const REQUIRE_CALL = `CallExpression${REQUIRE_CALLEE}`;
/** require benzeri olmayan çağrı (takma adlı yükleyici adayı; require konumu ayrıca, tam kümeyle denetlenir). */
const OTHER_CALL = `CallExpression:not(${REQUIRE_CALLEE})`;
/** Şablon dizesi ifade içeriyor ve `./` veya `../` ile başlamıyor (dinamik paket adı). */
const DYNAMIC_BARE_TEMPLATE = "[expressions.length>0][quasis.0.value.raw=/^(?!\\.\\.?\\/)/]";
/**
 * T-016: göreli ön ekten sonra ifade içeren şablon (`../${x}` → `../../node_modules/pg` vb.) da
 * dinamiktir; `DYNAMIC_BARE_TEMPLATE`in tümleyeni (ikisi birlikte: ifadeli her şablon, tek rapor).
 */
const DYNAMIC_RELATIVE_TEMPLATE = "[expressions.length>0][quasis.0.value.raw=/^\\.\\.?\\//]";

/** `import(<değişken/ifade>)`; tek muafiyeti bekçi yükleyicisidir (aşağıda GUARD_LOADER_FILE). */
const IMPORT_NON_STATIC = {
  selector: "ImportExpression:not([source.type='Literal'], [source.type='TemplateLiteral'])",
  message: MSG_NON_STATIC,
};

/**
 * T-008k: bekçi yükleyicisinin tek serbest biçimi `import(pathToFileURL(<ifade>).href)`; yalnızca
 * noktalı `.href` (hesaplanmış `["href"]`, çıplak değişken, `x.href` serbest değildir), tek ve yayılımsız argüman.
 */
const IMPORT_PATH_TO_FILE_URL_HREF =
  "[source.type='MemberExpression'][source.computed=false][source.optional=false][source.property.name='href']" +
  "[source.object.type='CallExpression'][source.object.optional=false][source.object.callee.type='Identifier']" +
  "[source.object.callee.name='pathToFileURL'][source.object.arguments.length=1]" +
  ":not([source.object.arguments.0.type='SpreadElement'])";
const IMPORT_NON_STATIC_EXCEPT_FILE_URL = {
  selector: `ImportExpression:not([source.type='Literal'], [source.type='TemplateLiteral'], ${IMPORT_PATH_TO_FILE_URL_HREF})`,
  message: MSG_NON_STATIC,
};

/** AC-28 / T-005g Yapılacak 1: dinamik biçimlerde aynı yasaklı küme. */
const rawClientSyntax = (/** @type {ForbiddenEntry[]} */ list) => {
  const { all: FORBIDDEN_RE, aliasCall: FORBIDDEN_ALIAS_CALL_RE, unambiguous: FORBIDDEN_UNAMBIGUOUS_RE } = selectorRegexes(list);
  return [
    // import("…"), import(`…`)
    { selector: `ImportExpression > Literal.source[value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
    { selector: `ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
    // require("…"), module.require("…"), createRequire(…)("…"), require adlı takma adlar: tüm küme.
    { selector: `${REQUIRE_CALL}[arguments.0.type='Literal'][arguments.0.value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
    { selector: `${REQUIRE_CALL} > TemplateLiteral:first-child > TemplateElement[value.raw=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
    // Herhangi bir çağrının ilk argümanı kapsamlı/alt yollu yasaklı belirteç veya göreli/mutlak yasaklı
    // yol (takma adlı yükleyici, ör. `const r = createRequire(…); r("drizzle-orm/postgres-js")`,
    // `r("../../packages/db/src/client.ts")`). T-015: çıplak yol dizesi (`matchesGlob("packages/db/src/x.ts", …)`)
    // modül belirteci değildir → burada aranmaz; require/import konumunda yukarıdaki tam küme geçerli.
    {
      selector: `${OTHER_CALL}[arguments.0.type='Literal'][arguments.0.value=${FORBIDDEN_ALIAS_CALL_RE}]`,
      message: MSG_FORBIDDEN,
    },
    {
      selector: `${OTHER_CALL} > TemplateLiteral:first-child > TemplateElement:first-child[value.raw=${FORBIDDEN_ALIAS_CALL_RE}]`,
      message: MSG_FORBIDDEN,
    },
    {
      selector: `${OTHER_CALL} > TemplateLiteral:first-child > TemplateElement:not(:first-child)[value.raw=${FORBIDDEN_UNAMBIGUOUS_RE}]`,
      message: MSG_FORBIDDEN,
    },
    // import x = require("…") (TypeScript)
    { selector: `TSExternalModuleReference > Literal[value=${FORBIDDEN_RE}]`, message: MSG_FORBIDDEN },
    // Statik olmayan belirteçler (değişken, birleştirme, dinamik paket adlı şablon).
    IMPORT_NON_STATIC,
    { selector: `ImportExpression > TemplateLiteral.source${DYNAMIC_BARE_TEMPLATE}`, message: MSG_NON_STATIC },
    {
      selector: `${REQUIRE_CALL}:not([arguments.0.type='Literal'], [arguments.0.type='TemplateLiteral'])`,
      message: MSG_NON_STATIC,
    },
    { selector: `${REQUIRE_CALL} > TemplateLiteral:first-child${DYNAMIC_BARE_TEMPLATE}`, message: MSG_NON_STATIC },
    // T-016: göreli ön ekli dinamik şablon (statik göreli şablon serbest).
    { selector: `ImportExpression > TemplateLiteral.source${DYNAMIC_RELATIVE_TEMPLATE}`, message: MSG_NON_STATIC },
    { selector: `${REQUIRE_CALL} > TemplateLiteral:first-child${DYNAMIC_RELATIVE_TEMPLATE}`, message: MSG_NON_STATIC },
  ];
};
/** Tam küme için sözdizimi kuralları (tek kaynak; bekçi yükleyicisi bloğu da bunu kullanır). */
const RAW_CLIENT_SYNTAX = rawClientSyntax(ALL_FORBIDDEN_MODULES);
/** `packages/db` ve `tests/integration`: statik olmayan import/require serbest kalır (mevcut muafiyet), yalnızca yasaklı belirteç denetimi. */
const rawClientModuleSyntaxOnly = (/** @type {ForbiddenEntry[]} */ list) => rawClientSyntax(list).filter((s) => s.message === MSG_FORBIDDEN);

/**
 * T-016: dinamik kod yürütme — yasaklı kümeyi metinden derleyip yükleyerek atlatmayı önler. Üye
 * biçimi yalnızca küresel nesneler üzerinden (`globalThis.eval`, `window.Function` …); `client.eval`
 * (ör. Redis Lua) gibi alan adlı yöntemler serbesttir. `._load` (Node `Module._load`, iç yükleyici)
 * her nesnede yasaktır.
 */
const MSG_CODE_EXEC =
  "Dinamik kod yürütme/iç yükleyici (`eval`, `new Function`, `Module._load`) yasaktır; yasaklı istemci kümesinin dinamik atlatılmasını önler (T-016).";
const GLOBAL_OBJECT = "[callee.object.name=/^(?:globalThis|global|window|self)$/]";
const CODE_EXEC_SYNTAX = [
  {
    selector: `CallExpression:matches([callee.name='eval'], [callee.property.name='eval']${GLOBAL_OBJECT}, [callee.property.value='eval']${GLOBAL_OBJECT}, [callee.property.name='_load'], [callee.property.value='_load'])`,
    message: MSG_CODE_EXEC,
  },
  // Dolaylı eval: `(0, eval)(…)`.
  { selector: "CallExpression > SequenceExpression.callee > Identifier[name='eval']:last-child", message: MSG_CODE_EXEC },
  {
    selector: `:matches(CallExpression, NewExpression):matches([callee.name='Function'], [callee.property.name='Function']${GLOBAL_OBJECT}, [callee.property.value='Function']${GLOBAL_OBJECT})`,
    message: MSG_CODE_EXEC,
  },
];

/** Düz JS RegExp biçimleri (takma adlı yükleyici kuralı için; esquery biçimleriyle aynı kaynak). */
const toRegExp = (/** @type {Array<{ regex: string }>} */ list) => new RegExp(list.map(({ regex }) => `(?:${regex})`).join("|"), "i");
/** @param {ForbiddenEntry[]} list */
const jsRegexes = (list) => ({
  all: toRegExp(list),
  aliasCall: toRegExp(list.filter((m) => !m.ambiguous).map((m) => (m.pathLike ? { regex: asSpecifierPath(m.regex) } : m))),
  unambiguous: toRegExp(list.filter((m) => !m.ambiguous)),
});
/** `REQUIRE_CALLEE`deki ad deseninin JS biçimi. */
const REQUIRE_NAME_JS_RE = /^(?!createrequire$).*require/i;
const NODE_MODULE_BUILTINS = new Set(["module", "node:module"]);

/**
 * T-016 (MINOR createRequire takma adı): `no-restricted-syntax` seçicileri veri akışı izleyemez;
 * `import { createRequire as cr }` + `cr(u)("pg")` veya `const load = createRequire(u); load("postgres")`
 * (adında "require" geçmeyen yükleyici) kapsamsız sürücü adlarıyla seçicilerden kaçıyordu. Bu kural
 * kapsam çözümlemesiyle izler:
 *   - `createRequire` kaynakları: `node:module`/`module`'den adlı içe aktarım (yeniden adlandırılmış
 *     dahil), `createRequire` adlı her tanımlayıcı, `<herhangi>.createRequire` üyesi, `{ createRequire: x }`
 *     yapı bozumu, bunların atandığı/`bind` edildiği her ad;
 *   - yükleyiciler: `createRequire`(…) çağrısının dönüş değeri, onun atandığı/`bind` edildiği her ad;
 *   - yükleyici çağrısında `require` ile aynı denetim: tam yasaklı küme (kapsamsız sürücü adları dahil)
 *     ve statik olmayan belirteç (değişken, ifadeli şablon).
 * Seçicilerin zaten raporladığı biçimler (adında "require" geçen çağrılar, `createRequire(…)(…)`,
 * takma adlı çağrı kümesine uyan dizeler) burada yinelenmez (tek ihlal = tek rapor).
 * @type {import("eslint").Rule.RuleModule}
 */
const noAliasedModuleLoader = {
  meta: {
    type: "problem",
    // Seçenek (T-111): kapsam başına yasaklı küme `{ modules: ForbiddenEntry[] }`; verilmezse tam küme.
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: { modules: { type: "array", items: { type: "object" } }, allowNonStatic: { type: "boolean" } },
      },
    ],
    messages: { forbidden: MSG_FORBIDDEN, nonStatic: MSG_NON_STATIC },
  },
  create(context) {
    const {
      all: FORBIDDEN_JS_RE,
      aliasCall: FORBIDDEN_ALIAS_CALL_JS_RE,
      unambiguous: FORBIDDEN_UNAMBIGUOUS_JS_RE,
    } = jsRegexes(/** @type {any} */ (context.options[0])?.modules ?? ALL_FORBIDDEN_MODULES);
    const allowNonStatic = /** @type {any} */ (context.options[0])?.allowNonStatic === true;
    const allModules = /** @type {ForbiddenEntry[]} */ (/** @type {any} */ (context.options[0])?.modules ?? ALL_FORBIDDEN_MODULES);
    /** @type {import("estree").CallExpression[]} */
    const calls = [];
    return {
      CallExpression(node) {
        calls.push(node);
      },
      "Program:exit"() {
        const sm = context.sourceCode.scopeManager;
        /** @type {Map<unknown, import("eslint").Scope.Variable | null>} */
        const resolvedOf = new Map();
        for (const scope of sm.scopes) for (const ref of scope.references) resolvedOf.set(ref.identifier, ref.resolved);
        /** @type {Set<import("eslint").Scope.Variable>} */ const crVars = new Set();
        /** @type {Set<import("eslint").Scope.Variable>} */ const nsVars = new Set();
        /** @type {Set<import("eslint").Scope.Variable>} */ const loaderVars = new Set();
        /** @param {any} id */
        const varOf = (id) => resolvedOf.get(id) ?? null;
        /** @param {any} e @returns {any} TS sarmalayıcıları, `?.`, virgül ifadesi açılır. */
        const unwrap = (e) => {
          let x = e;
          for (;;) {
            if (x == null) return x;
            if (/^TS(?:As|NonNull|Satisfies|TypeAssertion|Instantiation)Expression$/.test(x.type) || x.type === "ChainExpression") x = x.expression;
            else if (x.type === "SequenceExpression") x = x.expressions[x.expressions.length - 1];
            else if (x.type === "AwaitExpression") x = x.argument;
            else return x;
          }
        };
        /** @param {any} m */
        const propName = (m) => (m.computed ? (m.property.type === "Literal" ? String(m.property.value) : null) : m.property.name);
        /** @param {any} n */
        const isModuleLiteral = (n) => n?.type === "Literal" && NODE_MODULE_BUILTINS.has(String(n.value));
        /** `node:module` ad alanı ifadesi. @param {any} e @returns {boolean} */
        const isNs = (e) => {
          const x = unwrap(e);
          if (x?.type === "Identifier") return nsVars.has(/** @type {any} */ (varOf(x)));
          if (x?.type === "ImportExpression") return isModuleLiteral(x.source);
          if (x?.type === "CallExpression") return isModuleLiteral(x.arguments[0]);
          return false;
        };
        /** `createRequire` (veya takma adı) ifadesi. @param {any} e @returns {boolean} */
        const isCr = (e) => {
          const x = unwrap(e);
          if (x?.type === "Identifier") return x.name === "createRequire" || crVars.has(/** @type {any} */ (varOf(x)));
          if (x?.type === "MemberExpression") return propName(x) === "createRequire";
          if (x?.type === "CallExpression" && x.callee.type === "MemberExpression" && propName(x.callee) === "bind") return isCr(x.callee.object);
          return false;
        };
        /** Yükleyici (createRequire dönüş değeri) ifadesi. @param {any} e @returns {boolean} */
        const isLoader = (e) => {
          const x = unwrap(e);
          if (x?.type === "Identifier") return loaderVars.has(/** @type {any} */ (varOf(x)));
          if (x?.type === "CallExpression") {
            if (x.callee.type === "MemberExpression" && propName(x.callee) === "bind") return isLoader(x.callee.object);
            return isCr(x.callee);
          }
          return false;
        };
        const allVars = sm.scopes.flatMap((s) => s.variables);
        /** @param {Set<import("eslint").Scope.Variable>} set @param {import("eslint").Scope.Variable} v */
        const add = (set, v) => {
          if (set.has(v)) return false;
          set.add(v);
          return true;
        };
        let changed = true;
        while (changed) {
          changed = false;
          for (const v of allVars) {
            for (const def of v.defs) {
              if (def.type !== "ImportBinding" || !isModuleLiteral(def.parent.source)) continue;
              const spec = /** @type {any} */ (def.node);
              if (spec.type !== "ImportSpecifier") changed = add(nsVars, v) || changed;
              else if ((spec.imported.name ?? spec.imported.value) === "createRequire") changed = add(crVars, v) || changed;
            }
            for (const ref of v.references) {
              if (!ref.isWrite()) continue;
              const id = /** @type {any} */ (ref.identifier);
              let p = id.parent;
              let child = id;
              if (p?.type === "AssignmentPattern" && p.left === id) {
                child = p;
                p = p.parent;
              }
              // `{ createRequire: x }` / `{ createRequire }` yapı bozumu (bildirim veya atama).
              if (p?.type === "Property" && p.value === child && p.parent?.type === "ObjectPattern") {
                if (propName({ computed: p.computed, property: p.key }) === "createRequire") changed = add(crVars, v) || changed;
                continue;
              }
              const direct =
                (p?.type === "VariableDeclarator" && p.id === id) || (p?.type === "AssignmentExpression" && p.left === id && p.operator === "=");
              if (!direct || ref.writeExpr == null) continue;
              if (isCr(ref.writeExpr)) changed = add(crVars, v) || changed;
              if (isLoader(ref.writeExpr)) changed = add(loaderVars, v) || changed;
              if (isNs(ref.writeExpr)) changed = add(nsVars, v) || changed;
            }
          }
        }
        // `ns.createRequire` ad alanı üzerinden de `MemberExpression` kuralıyla yakalanır (isCr).
        for (const call of calls) {
          if (!isLoader(call.callee)) continue;
          const c = /** @type {any} */ (call.callee);
          const coveredBySelectors =
            (c.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.name)) ||
            (c.type === "MemberExpression" && c.property.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.property.name)) ||
            (c.type === "CallExpression" && (c.callee.name === "createRequire" || c.callee.property?.name === "createRequire"));
          if (coveredBySelectors) continue;
          const arg = /** @type {any} */ (call.arguments[0]);
          if (arg === undefined) continue;
          if (arg.type === "Literal") {
            const v = String(arg.value);
            if (FORBIDDEN_JS_RE.test(v) && !FORBIDDEN_ALIAS_CALL_JS_RE.test(v)) context.report({ node: arg, messageId: "forbidden" });
            else if (normalizedSpecifierHit(v, context.filename, allModules) !== null) context.report({ node: arg, messageId: "forbidden" });
            continue;
          }
          if (arg.type === "TemplateLiteral") {
            /** @type {string[]} */
            const raws = arg.quasis.map((/** @type {any} */ q) => q.value.raw);
            const covered = FORBIDDEN_ALIAS_CALL_JS_RE.test(raws[0] ?? "") || raws.slice(1).some((r) => FORBIDDEN_UNAMBIGUOUS_JS_RE.test(r));
            if (!covered && raws.some((r) => FORBIDDEN_JS_RE.test(r))) context.report({ node: arg, messageId: "forbidden" });
            if (arg.expressions.length > 0 && !allowNonStatic) context.report({ node: arg, messageId: "nonStatic" });
            continue;
          }
          if (!allowNonStatic) context.report({ node: arg, messageId: "nonStatic" });
        }
      },
    };
  },
};
/**
 * T-127a (security MAJOR-2): `normalized` girdiler (storage iç modülü, cache-key) belirteç dizgisinin kendisine değil,
 * `path.posix.normalize` edilmiş biçimine ve içe aktaran dosyaya göre çözülmüş depo-göreli yoluna karşı denetlenir; böylece
 * `src/./context.ts`, `src//context.ts`, `storage/./src/context.ts`, `src/../src/context.ts`, `../src/./context.ts` yazımları
 * aynı modül olarak yakalanır. Ham dizgi zaten herhangi bir yasaklı girdiye uyuyorsa burada yinelenmez (tek ihlal = tek rapor).
 * Kapsam: `import`/`export … from`, `import()`, `import x = require()`, `require`/`createRequire(…)(…)` ve (loader kuralı) yükleyici.
 * @param {string} spec @param {string} filename mutlak dosya yolu @param {ForbiddenEntry[]} list
 * @param {ForbiddenEntry[]} [extra] yalnızca yeniden dışa aktarımda ek yasaklar
 */
const normalizedSpecifierHit = (spec, filename, list, extra = /** @type {ForbiddenEntry[]} */ ([])) => {
  const entries = [...list, ...extra].filter((e) => e.normalized);
  if (entries.length === 0 || typeof spec !== "string") return null;
  if (list.some((e) => new RegExp(e.regex, "iu").test(spec))) return null; // ham dizgi zaten raporlanır
  // Yüzde kodlaması (`%2E`, `%63ontext.ts`) çözülür; geçersiz kodlama güvenli tarafta raporlanır.
  let decoded;
  try {
    decoded = decodeURIComponent(spec);
  } catch {
    return entries[0] ?? null;
  }
  // Ters eğik çizgi `/` sayılır (`..\\src\\context.ts`).
  let target = decoded.replaceAll("\\", "/");
  if (target.startsWith("file:")) target = target.slice(5).replace(/^\/\//, "");
  if (/^\.\.?(?:\/|$)/.test(target)) target = path.posix.join(path.posix.dirname(filename.replaceAll("\\", "/")), target);
  target = path.posix.normalize(target);
  if (target.startsWith(`${REPO_ROOT_POSIX}/`)) target = target.slice(REPO_ROOT_POSIX.length + 1);
  return entries.find((e) => new RegExp(e.regex, "iu").test(target)) ?? null;
};

/** @type {import("eslint").Rule.RuleModule} */
const noNormalizedPathImport = {
  meta: {
    type: "problem",
    schema: [{ type: "object", additionalProperties: false, properties: { modules: { type: "array", items: { type: "object" } }, reexportModules: { type: "array", items: { type: "object" } } } }],
    messages: { forbidden: "{{message}}" },
  },
  create(context) {
    const modules = /** @type {ForbiddenEntry[]} */ (/** @type {any} */ (context.options[0])?.modules ?? ALL_FORBIDDEN_MODULES);
    const reexportModules = /** @type {ForbiddenEntry[]} */ (/** @type {any} */ (context.options[0])?.reexportModules ?? []);
    /** @param {any} node @param {any} src @param {ForbiddenEntry[]} [extra] yalnızca bu düğüm türünde ek yasaklar */
    const check = (node, src, extra = []) => {
      let spec = null;
      if (src?.type === "Literal" && typeof src.value === "string") spec = src.value;
      else if (src?.type === "TemplateLiteral" && src.expressions.length === 0 && src.quasis.length === 1) spec = src.quasis[0].value.cooked;
      if (spec === null) return;
      const hit = normalizedSpecifierHit(spec, context.filename, modules, extra);
      if (hit) context.report({ node, messageId: "forbidden", data: { message: hit.message ?? "" } });
    };
    const isLoaderCallee = (/** @type {any} */ c) =>
      (c.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.name)) ||
      (c.type === "MemberExpression" && c.property.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.property.name)) ||
      (c.type === "CallExpression" && (c.callee.name === "createRequire" || c.callee.property?.name === "createRequire"));
    return {
      ImportDeclaration: (n) => check(n, n.source),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source, reexportModules),
      ExportAllDeclaration: (n) => check(n, n.source, reexportModules),
      ImportExpression: (n) => check(n, n.source),
      TSExternalModuleReference: (/** @type {any} */ n) => check(n, /** @type {any} */ (n).expression),
      CallExpression: (n) => {
        if (isLoaderCallee(n.callee) && n.arguments.length > 0) check(n, n.arguments[0]);
      },
    };
  },
};

/**
 * T-127b: `"use client"` dosyaları sunucu paketlerini/modüllerini içe aktaramaz (`server-only` paketi worker/vitest'i
 * bozduğu için sınır lint'te tutulur; T-127 raporu). Girdiler: `@wms/{db,domain,auth,storage,queue-adapter}` (ve alt yolları)
 * ile `apps/web/lib/{action-guard,rate-limit,queue}` (ve `packages/<bu paketler>/…` yolları). Yol girdisi `normalized`:
 * göreli yazımlar (`../lib/./queue.ts`, `lib//queue`) içe aktaran dosyaya göre çözülüp normalize edilerek denetlenir.
 * Kapsam: `import`/`export … from`/`import()`/`import x = require()`/`require`/`createRequire(…)(…)` (`wms/no-client-server-import`)
 * ve takma adlı yükleyici (`wms/no-client-server-loader`, `no-aliased-module-loader` kuralının "use client" ile sınırlı örneği).
 */
const MSG_CLIENT_SERVER =
  '"use client" dosyası sunucu paketini/modülünü (@wms/db, @wms/domain, @wms/auth, @wms/storage, @wms/queue-adapter, apps/web/lib/{action-guard,rate-limit,queue}) import edemez; veri/yetki işi sunucu eylemlerindedir (T-127b).';
const CLIENT_FORBIDDEN_MODULES = /** @type {ForbiddenEntry[]} */ ([
  { regex: "^@wms\\/(?:db|domain|auth|storage|queue-adapter)(?:[\\/?#]|$)", message: MSG_CLIENT_SERVER },
  {
    regex: "^(?:apps\\/web\\/lib\\/(?:action-guard|rate-limit|queue)(?:\\.[cm]?[jt]sx?)?|packages\\/(?:db|domain|auth|storage|queue-adapter)(?:\\/.*)?)(?:[?#].*)?$",
    message: MSG_CLIENT_SERVER,
    pathLike: true,
    normalized: true,
  },
]);
/** Dosya yönerge öncülünde (ilk ifadeler) `"use client"` var mı. @param {any} program */
const hasUseClientDirective = (program) => {
  for (const st of program.body) {
    if (st.type !== "ExpressionStatement" || typeof st.directive !== "string") return false;
    // Çözülmüş değer (kaçışlı `"use \x63lient"` yazımı da aynı yönergedir); `directive` ham metindir.
    if (st.expression?.value === "use client") return true;
  }
  return false;
};
/** @type {import("eslint").Rule.RuleModule} */
const noClientServerImport = {
  meta: { type: "problem", schema: [], messages: { forbidden: MSG_CLIENT_SERVER } },
  create(context) {
    if (!hasUseClientDirective(context.sourceCode.ast)) return {};
    const rawRe = new RegExp(CLIENT_FORBIDDEN_MODULES.map((m) => `(?:${m.regex})`).join("|"), "iu");
    /** @param {any} node @param {any} src */
    const check = (node, src) => {
      let spec = null;
      if (src?.type === "Literal" && typeof src.value === "string") spec = src.value;
      else if (src?.type === "TemplateLiteral" && src.expressions.length === 0 && src.quasis.length === 1) spec = src.quasis[0].value.cooked;
      if (spec === null) return;
      if (rawRe.test(spec) || normalizedSpecifierHit(spec, context.filename, CLIENT_FORBIDDEN_MODULES) !== null) {
        context.report({ node, messageId: "forbidden" });
      }
    };
    const isLoaderCallee = (/** @type {any} */ c) =>
      (c.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.name)) ||
      (c.type === "MemberExpression" && c.property.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.property.name)) ||
      (c.type === "CallExpression" && (c.callee.name === "createRequire" || c.callee.property?.name === "createRequire"));
    return {
      ImportDeclaration: (n) => check(n, n.source),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source),
      ExportAllDeclaration: (n) => check(n, n.source),
      ImportExpression: (n) => check(n, n.source),
      TSExternalModuleReference: (/** @type {any} */ n) => check(n, n.expression),
      CallExpression: (n) => {
        if (isLoaderCallee(n.callee) && n.arguments.length > 0) check(n, n.arguments[0]);
      },
    };
  },
};
/** Takma adlı yükleyici (`const load = createRequire(…); load("@wms/db")`): mevcut izleme kuralı, yalnızca "use client" dosyalarında. @type {import("eslint").Rule.RuleModule} */
const noClientServerLoader = {
  meta: { type: "problem", schema: [], messages: { forbidden: MSG_CLIENT_SERVER } },
  create(context) {
    if (!hasUseClientDirective(context.sourceCode.ast)) return {};
    return /** @type {any} */ (noAliasedModuleLoader).create(
      Object.create(context, {
        // `ambiguous`: seçici tabanlı bir kural olmadığından takma adlı çağrıdaki ihlali bu kural raporlar. `(?!)` hiçbir
        // şeye uymayan yer tutucudur: boş "ambiguous olmayan" küme `new RegExp("")` olup her dizgeye uyardı.
        options: { value: [{ modules: [...CLIENT_FORBIDDEN_MODULES.map((m) => ({ ...m, ambiguous: true })), { regex: "(?!)" }], allowNonStatic: true }] },
        report: { value: (/** @type {any} */ d) => context.report({ node: d.node, messageId: "forbidden" }) },
      }),
    );
  },
};
/**
 * T-210 (I-04, I-15, G-01): stok tablolarında kilit/yazma SQL'i ve şema nesnesi erişimi yalnızca izinli DOSYALARDA (dizin değil).
 * Mevcut kuralları gevşetmeyen, benzersiz adlı EK kuraldır (flat config'te aynı kural adı değiştirilir, birleşmez).
 * (a) `FOR UPDATE|SHARE` (+ NO KEY / KEY SHARE) ve (b)/(c)/(d) maddeleri kart T-210 §4'tedir; `serials` yalnızca (a)'ya tabidir.
 * Kapsam: `packages/**`, `apps/**` (tests/** ve *.sql dışarıda). İzinli yollar depo-göreli, dosya düzeyindedir; genişletme yalnızca korunan PR'la.
 */
const STOCK_LOCK_FILE = "packages/db/src/locking.ts";
const STOCK_WRITE_FILES = [
  STOCK_LOCK_FILE,
  "packages/domain/src/stock/posting.ts",
  "packages/domain/src/stock/reservations.ts",
  "packages/domain/src/stock/reversal.ts",
];
const STOCK_LOCK_TABLES = ["stock_ledger", "stock_balances", "reservations", "serials", "location_count_locks", "stock_dimensions"];
const STOCK_WRITE_TABLES = ["stock_ledger", "stock_balances", "reservations", "location_count_locks", "stock_dimensions"];
const STOCK_SCHEMA_OBJECTS = new Set(["stockLedger", "stockBalances", "reservations", "locationCountLocks", "stockDimensions"]);
/**
 * Mevcut istisna (T-210 bulgusu): `packages/auth/src/index.ts` kimlik şemasını Better Auth sürücüsüne `import * as schema` ile verir
 * (T-102/ADR-014). YALNIZCA bu dosyada ve YALNIZCA ad alanı importu serbesttir; adlandırılmış stok nesnesi importu orada da yasaktır.
 * Daraltma (yalnızca kimlik tabloları) ayrı karttadır.
 */
const STOCK_SCHEMA_NAMESPACE_FILES = ["packages/auth/src/index.ts"];
const STOCK_LOCK_VALUE_EXPORTS = new Set(["acquireStockLocks"]);
/** Tablo adı (isteğe bağlı `public.` ve çift tırnak). */
/** @param {string[]} tables */
const tableRe = (tables) => `(?:"?public"?\\s*\\.\\s*)?"?(?:${tables.join("|")})"?(?![\\w])`;
const STOCK_LOCK_SQL_RE = new RegExp(`\\bFOR\\s+(?:NO\\s+KEY\\s+UPDATE|UPDATE|KEY\\s+SHARE|SHARE)\\b`, "i");
const STOCK_LOCK_TABLE_RE = new RegExp(`(?<![\\w])${tableRe(STOCK_LOCK_TABLES)}`, "i");
const STOCK_WRITE_SQL_RE = new RegExp(
  `(?<![\\w])(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?${tableRe(STOCK_WRITE_TABLES)}`,
  "i",
);
const MSG_STOCK_LOCK = "Stok tablolarında FOR UPDATE/FOR SHARE yalnızca packages/db/src/locking.ts içindedir (`acquireStockLocks`; I-15, T-210).";
const MSG_STOCK_WRITE = "Stok tablolarına INSERT/UPDATE/DELETE yalnızca STOCK_WRITE_FILES dosyalarındadır (G-01, I-04, T-210).";
const MSG_STOCK_SCHEMA =
  "Stok tablosu şema nesneleri (stockLedger, stockBalances, reservations, locationCountLocks, stockDimensions) STOCK_WRITE_FILES ve packages/db/src dışında import edilemez; okuma ham SQL SELECT ile yapılır (G-01, T-210).";
const MSG_STOCK_EXPORT = "locking.ts yalnızca `acquireStockLocks` ve tip dışa aktarır; kilit alt adımları export edilemez (I-15, T-210).";
/** `@wms/db/internal/schema` ya da şema dosyası yolları (normalize edilmiş, depo-göreli). */
const STOCK_SCHEMA_SPEC_RE = /^(?:@wms\/db\/internal\/schema|packages\/db\/src\/schema(?:\/(?:index|stock|warehouse|catalog)(?:\.[cm]?[jt]s)?)?)(?:[?#].*)?$/iu;
/** @param {string} filename */
const repoRelative = (filename) => {
  const f = filename.replaceAll("\\", "/");
  return f.startsWith(`${REPO_ROOT_POSIX}/`) ? f.slice(REPO_ROOT_POSIX.length + 1) : f;
};
/** Düğümün (dize/şablon/`+` zinciri) statik metni; bilinmeyen parça `\u0000`. Dize olmayan düğüm için `null`. @param {any} n @returns {string | null} */
const staticText = (n) => {
  if (n?.type === "Literal" && typeof n.value === "string") return n.value;
  if (n?.type === "TemplateLiteral") return n.quasis.map((/** @type {any} */ q) => q.value.cooked ?? q.value.raw).join("\u0000");
  if (n?.type === "BinaryExpression" && n.operator === "+") {
    const l = staticText(n.left);
    const r = staticText(n.right);
    return l === null && r === null ? null : `${l ?? "\u0000"}${r ?? "\u0000"}`;
  }
  return null;
};
/** @type {import("eslint").Rule.RuleModule} */
const stockSqlGuard = {
  meta: { type: "problem", schema: [], messages: { lock: MSG_STOCK_LOCK, write: MSG_STOCK_WRITE, schema: MSG_STOCK_SCHEMA, exports: MSG_STOCK_EXPORT } },
  create(context) {
    const rel = path.posix.normalize(repoRelative(context.filename));
    const isLockFile = rel === STOCK_LOCK_FILE;
    const writeAllowed = STOCK_WRITE_FILES.includes(rel);
    const schemaAllowed = writeAllowed || rel.startsWith("packages/db/src/");
    /** @param {any} node */
    const checkText = (node) => {
      const parent = node.parent;
      if (parent?.type === "BinaryExpression" && parent.operator === "+") return; // üst zincir denetler
      if (parent?.type === "ImportDeclaration" || parent?.type === "ExportAllDeclaration" || parent?.type === "ExportNamedDeclaration") return;
      const text = staticText(node);
      if (text === null) return;
      if (!isLockFile && STOCK_LOCK_SQL_RE.test(text) && STOCK_LOCK_TABLE_RE.test(text)) context.report({ node, messageId: "lock" });
      if (!writeAllowed && STOCK_WRITE_SQL_RE.test(text)) context.report({ node, messageId: "write" });
    };
    /** @param {any} src */
    const isSchemaSource = (src) => {
      let spec = null;
      if (src?.type === "Literal" && typeof src.value === "string") spec = src.value;
      else if (src?.type === "TemplateLiteral" && src.expressions.length === 0 && src.quasis.length === 1) spec = src.quasis[0].value.cooked;
      if (spec === null) return false;
      let target;
      try {
        target = decodeURIComponent(spec).replaceAll("\\", "/");
      } catch {
        return true;
      }
      if (/^\.\.?(?:\/|$)/.test(target)) target = path.posix.join(path.posix.dirname(repoRelative(context.filename)), target);
      target = path.posix.normalize(target).replace(/^\.\//, "");
      return STOCK_SCHEMA_SPEC_RE.test(target);
    };
    /** @param {any} spec */
    const importedName = (spec) => spec.imported?.name ?? spec.imported?.value ?? spec.local?.name;
    /** @param {any} node @param {any[]} specifiers */
    const specifiersHit = (node, specifiers) =>
      specifiers.some((s) => {
        if (s.type === "ImportNamespaceSpecifier" && STOCK_SCHEMA_NAMESPACE_FILES.includes(rel)) return false;
        return s.type !== "ImportSpecifier" && s.type !== "ExportSpecifier" ? true : STOCK_SCHEMA_OBJECTS.has(importedName(s) ?? s.local?.name);
      });
    const dynamicSchema = (/** @type {any} */ n, /** @type {any} */ src) => {
      if (!schemaAllowed && isSchemaSource(src)) context.report({ node: n, messageId: "schema" });
    };
    /** @type {import("eslint").Rule.RuleListener} */
    const listener = {
      Literal: checkText,
      TemplateLiteral: checkText,
      BinaryExpression: checkText,
      ImportDeclaration: (/** @type {any} */ n) => {
        if (!schemaAllowed && isSchemaSource(n.source) && specifiersHit(n, n.specifiers)) context.report({ node: n, messageId: "schema" });
      },
      ExportNamedDeclaration: (/** @type {any} */ n) => {
        if (n.source) {
          if (!schemaAllowed && isSchemaSource(n.source) && specifiersHit(n, n.specifiers)) context.report({ node: n, messageId: "schema" });
        }
        if (isLockFile && !n.source) {
          const d = n.declaration;
          if (d) {
            const typeOnly = d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration" || n.exportKind === "type";
            const names = d.type === "VariableDeclaration" ? d.declarations.map((/** @type {any} */ x) => x.id?.name) : [d.id?.name];
            if (!typeOnly && !names.every((/** @type {string} */ x) => STOCK_LOCK_VALUE_EXPORTS.has(x))) context.report({ node: n, messageId: "exports" });
          } else if (n.exportKind !== "type") {
            for (const s of n.specifiers) {
              const exported = s.exported?.name ?? s.exported?.value;
              if (s.exportKind !== "type" && !STOCK_LOCK_VALUE_EXPORTS.has(exported)) context.report({ node: s, messageId: "exports" });
            }
          }
        }
        if (isLockFile && n.source && n.exportKind !== "type") context.report({ node: n, messageId: "exports" });
      },
      ExportAllDeclaration: (/** @type {any} */ n) => {
        if (!schemaAllowed && isSchemaSource(n.source)) context.report({ node: n, messageId: "schema" });
        if (isLockFile && n.exportKind !== "type") context.report({ node: n, messageId: "exports" });
      },
      ExportDefaultDeclaration: (/** @type {any} */ n) => {
        if (isLockFile) context.report({ node: n, messageId: "exports" });
      },
      ImportExpression: (/** @type {any} */ n) => dynamicSchema(n, n.source),
      TSExternalModuleReference: (/** @type {any} */ n) => dynamicSchema(n, n.expression),
      CallExpression: (/** @type {any} */ n) => {
        const c = n.callee;
        const loader =
          (c.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.name)) ||
          (c.type === "MemberExpression" && c.property.type === "Identifier" && REQUIRE_NAME_JS_RE.test(c.property.name)) ||
          (c.type === "CallExpression" && (c.callee.name === "createRequire" || c.callee.property?.name === "createRequire"));
        if (loader && n.arguments.length > 0) dynamicSchema(n, n.arguments[0]);
      },
    };
    return listener;
  },
};
const WMS_PLUGIN = {
  meta: { name: "wms-local" },
  rules: {
    "no-aliased-module-loader": noAliasedModuleLoader,
    "no-normalized-path-import": noNormalizedPathImport,
    "no-client-server-import": noClientServerImport,
    "no-client-server-loader": noClientServerLoader,
    "stock-sql-guard": stockSqlGuard,
  },
};

// T-005g Yapılacak 4: tenant bağlam ayarı yalnızca packages/db (`withTenant`) içinde. Desenler bu
// dosyanın kendisi de lint edildiği için karakter sınıfıyla (`confi[g]`) yazılır.
const TENANT_SETTING_RE = "/set_confi[g]|app\\.current_tenant_i[d]/i";
// T-016: büyük/küçük harf duyarsız (`set role`, `reset all`, `set search_path`).
const SQL_SET_RESET_RE = "/^\\s*(?:SET|RESET)\\s/i";
// T-016: dize birleştirmesiyle parçalanan tenant ayarı (`"set_" + "config"`, şablonda `${a}_config`).
// `\bset_`: `reset_`/`offset_`/`asset_` gibi sözcük içi eşleşmeler hariç.
const TENANT_FRAGMENT_RE = "/\\bset_|_config|current_tenant/i";
const NOT_TENANT_LITERAL = `:not([value=${TENANT_SETTING_RE}], [value=${SQL_SET_RESET_RE}])`;
const MSG_TENANT =
  "Tenant bağlam ayarı ve oturum SET/RESET ifadeleri yalnızca packages/db içinde (`withTenant`, transaction-local) yapılır (T-005g, I-02, G-02).";
const TENANT_SETTING_SYNTAX = [
  { selector: `Literal[value=${TENANT_SETTING_RE}]`, message: MSG_TENANT },
  { selector: `Literal[value=${SQL_SET_RESET_RE}]`, message: MSG_TENANT },
  { selector: `TemplateElement[value.raw=${TENANT_SETTING_RE}]`, message: MSG_TENANT },
  { selector: `TemplateLiteral[quasis.0.value.raw=${SQL_SET_RESET_RE}]`, message: MSG_TENANT },
  // T-016: birleştirme parçası (`+`, `+=`, `.concat(…)`, ifadeli şablon). Yukarıdaki seçicilerin zaten
  // raporladığı düğümler hariç tutulur (tek ihlal = tek rapor).
  {
    selector: `:matches(BinaryExpression[operator='+'], AssignmentExpression[operator='+='], CallExpression[callee.property.name='concat']) > Literal[value=${TENANT_FRAGMENT_RE}]${NOT_TENANT_LITERAL}`,
    message: MSG_TENANT,
  },
  {
    selector: `CallExpression[callee.property.name='concat'] > MemberExpression.callee > Literal.object[value=${TENANT_FRAGMENT_RE}]${NOT_TENANT_LITERAL}`,
    message: MSG_TENANT,
  },
  {
    selector: `TemplateLiteral[expressions.length>0]:not([quasis.0.value.raw=${SQL_SET_RESET_RE}]) > TemplateElement[value.raw=${TENANT_FRAGMENT_RE}]:not([value.raw=${TENANT_SETTING_RE}])`,
    message: MSG_TENANT,
  },
];

/**
 * T-008k güvenlik MINOR-5: `import(pathToFileURL(x).href)` muafiyeti ADA bakar; ad yeniden bağlanırsa
 * (gölgeleme, başka modülden içe aktarma, yerel işlev/değişken, parametre, desen) muafiyet sahte olur.
 * cli.mjs'te `pathToFileURL` yalnızca `node:url`'den `import { pathToFileURL }` ile bağlanabilir.
 */
const MSG_PATH_TO_FILE_URL_REBIND =
  "cli.mjs'te `pathToFileURL` adı yalnızca `import { pathToFileURL } from \"node:url\"` ile bağlanabilir; yeniden bağlama/gölgeleme yasak (T-008k).";
const PATH_TO_FILE_URL = "[name='pathToFileURL']";
const PATH_TO_FILE_URL_REBINDING = [
  "ImportDeclaration:not([source.value='node:url']) > :matches(ImportSpecifier, ImportDefaultSpecifier, ImportNamespaceSpecifier)[local.name='pathToFileURL']",
  "ImportDeclaration > ImportSpecifier[local.name='pathToFileURL']:not([imported.name='pathToFileURL'])",
  "ImportDeclaration > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)[local.name='pathToFileURL']",
  "VariableDeclarator[id.name='pathToFileURL']",
  ":matches(ObjectPattern, ArrayPattern) Identifier" + PATH_TO_FILE_URL,
  "FunctionDeclaration[id.name='pathToFileURL']",
  "FunctionExpression[id.name='pathToFileURL']",
  "ClassDeclaration[id.name='pathToFileURL']",
  "ClassExpression[id.name='pathToFileURL']",
  ":function > Identifier.params" + PATH_TO_FILE_URL,
  ":function > AssignmentPattern.params > Identifier.left" + PATH_TO_FILE_URL,
  ":function > RestElement.params > Identifier.argument" + PATH_TO_FILE_URL,
  "CatchClause > Identifier.param" + PATH_TO_FILE_URL,
  "AssignmentExpression[left.name='pathToFileURL']",
].map((selector) => ({ selector, message: MSG_PATH_TO_FILE_URL_REBIND }));

/** `import(<ifade>)` muafiyetinin tek dosyası (T-015). */
const GUARD_LOADER_FILE = "scripts/guards/cli.mjs";


/**
 * T-111: kapsam profilleri. Flat config'te aynı kural sonraki blokta yeniden tanımlanırsa seçenekler
 * birleşmez, değişir; bu yüzden her profil kendi tam yasaklı kümesini (genel kümeden yalnızca izinli
 * girdiler çıkarılmış) verir. Bloklar ana bloktan SONRA gelir ve birbirinden ayrık dosyalara bakar.
 * Hiçbir profil tenant bağlam ayarı (TENANT_SETTING_SYNTAX), kod yürütme (CODE_EXEC_SYNTAX) veya
 * statik olmayan belirteç denetimini gevşetmez.
 * @param {{ files: string[], ignores?: string[], allow: ForbiddenEntry[], replace?: ForbiddenEntry[], web?: boolean, reexportForbid?: ForbiddenEntry[] }} p `allow`: bu kapsamda
 *   serbest girdiler; `replace`: serbest girdi yerine uygulanacak daha dar girdiler.
 */
const strictProfile = ({ files, ignores = [], allow, replace = [], web = false, reexportForbid = [] }) => {
  const modules = [...ALL_FORBIDDEN_MODULES.filter((m) => !allow.includes(m)), ...replace];
  // Web: `@wms/db` kökü yalnızca dinamik/yükleyici biçimlerinde yasak (statik import'ta adlar `paths` ile denetlenir).
  const loaderModules = web ? [...modules, WEB_DB_ENTRY] : modules;
  return {
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
    plugins: { wms: WMS_PLUGIN },
    rules: /** @type {import("eslint").Linter.RulesRecord} */ ({
      "no-restricted-imports": [
        "error",
        { patterns: modules.map(({ regex, message }) => ({ regex, message })), ...(web ? { paths: WEB_DB_PATHS } : {}) },
      ],
      "no-restricted-syntax": ["error", ...rawClientSyntax(loaderModules), ...CODE_EXEC_SYNTAX, ...TENANT_SETTING_SYNTAX],
      "wms/no-aliased-module-loader": ["error", { modules: loaderModules }],
      "wms/no-normalized-path-import": ["error", { modules, reexportModules: reexportForbid }],
    }),
  };
};
/** `@aws-sdk` istisnası: yalnızca bu iki dosya (dizin değil; T-127a MINOR-4). */
const AWS_FIXTURE_FILES = ["tests/integration/harness/global-setup.ts", "tests/integration/storage/object-storage.int.test.ts"];
const PROFILES = [
  // T-127a: web kapsamı (önce; daha dar web profilleri sonra gelir ve kendi `paths`/sözdizimini yeniden kurar).
  strictProfile({ files: ["apps/web/**"], allow: [], web: true }),
  // ADR-014 §Sonuçlar: kimlik paketi ham Drizzle istemcisine (`@wms/db/internal`, `/schema` dahil) erişir;
  // sürücü/bağdaştırıcı yasakları geçerli kalır. Better Auth/Argon2 de burada serbesttir.
  strictProfile({ files: ["packages/auth/**"], allow: [DB_INTERNAL_ENTRY, BETTER_AUTH_ENTRY, AUTH_SCOPED_ENTRY] }),
  strictProfile({ files: ["apps/web/app/api/auth/**"], allow: [BETTER_AUTH_ENTRY, AUTH_SCOPED_ENTRY], web: true }),
  // Yalnızca `better-auth/react` istemcisi.
  strictProfile({ files: ["apps/web/lib/auth-client.ts"], allow: [BETTER_AUTH_ENTRY], replace: [BETTER_AUTH_EXCEPT_REACT_ENTRY], web: true }),
  // ADR-005: kuyruk sağlayıcısı yalnızca bağdaştırıcı paketinde.
  strictProfile({ files: ["packages/queue-adapter/**"], allow: [PG_BOSS_ENTRY] }),
  // T-127a (ADR-006): @aws-sdk yalnızca depolama paketinde; context.ts yalnızca paket kaynağında (`src/**`);
  // `@wms/shared/cache-key` yalnızca `src/index.ts`'te. Bloklar daraldıkça sonra gelir (aynı kural: son blok kazanır).
  // `src/` dışında (ör. `packages/storage/test/`) `../src/context` göreli yolu da yasaktır.
  strictProfile({
    files: ["packages/storage/**"],
    ignores: ["packages/storage/src/**"],
    allow: [AWS_SDK_ENTRY],
    replace: [STORAGE_SRC_CONTEXT_RELATIVE_ENTRY],
  }),
  strictProfile({
    files: ["packages/storage/src/**"],
    ignores: ["packages/storage/src/index.ts"],
    allow: [AWS_SDK_ENTRY, STORAGE_CONTEXT_PATH_ENTRY],
  }),
  strictProfile({
    files: ["packages/storage/src/index.ts"],
    allow: [AWS_SDK_ENTRY, STORAGE_CONTEXT_PATH_ENTRY, CACHE_KEY_ENTRY, CACHE_KEY_PATH_ENTRY],
  }),
  // `packages/db` ve `tests/integration` ana bloktan muaftır (mevcut); yeni kütüphane yasakları orada da
  // geçerlidir, statik olmayan import/require muafiyeti değişmez. T-127a: depolama sınırları da burada geçerlidir;
  // `@aws-sdk` yalnızca depolama fikstürleri (MinIO/STS kurulumu ve nesne deposu entegrasyon testi) için serbesttir.
  ...[
    {
      files: ["packages/db/**", "tests/integration/**"],
      ignores: AWS_FIXTURE_FILES,
      extra: [AWS_SDK_ENTRY],
    },
    { files: AWS_FIXTURE_FILES, extra: [] },
  ].map(({ files, ignores = [], extra }) => {
    const modules = [BETTER_AUTH_ENTRY, AUTH_SCOPED_ENTRY, PG_BOSS_ENTRY, ...extra, ...STORAGE_ENTRIES];
    return {
      files,
      ...(ignores.length > 0 ? { ignores } : {}),
      plugins: { wms: WMS_PLUGIN },
      rules: /** @type {import("eslint").Linter.RulesRecord} */ ({
        "no-restricted-imports": ["error", { patterns: modules.map(({ regex, message }) => ({ regex, message })) }],
        "no-restricted-syntax": ["error", ...rawClientModuleSyntaxOnly(modules)],
        "wms/no-aliased-module-loader": ["error", { modules, allowNonStatic: true }],
        "wms/no-normalized-path-import": ["error", { modules }],
      }),
    };
  }),
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
    // Yasaklı küme tek sabittedir (ALL_FORBIDDEN_MODULES); statik import (`no-restricted-imports`) ve
    // dinamik biçimler (`no-restricted-syntax`: `import()`, `require`, `createRequire(…)(…)`,
    // şablon dizeleri) aynı düzenli ifadelerden üretilir.
    // Not: flat config'te aynı kural sonraki bir blokta yeniden tanımlanırsa seçenekler BİRLEŞMEZ,
    // değiştirilir; yeni kısıtlar bu bloğa eklenmelidir.
    files: [LINT_FILES],
    ignores: ["packages/db/**", "tests/integration/**"],
    plugins: { wms: WMS_PLUGIN },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ALL_FORBIDDEN_MODULES.map(({ regex, message }) => ({ regex, message })) },
      ],
      "no-restricted-syntax": ["error", ...RAW_CLIENT_SYNTAX, ...CODE_EXEC_SYNTAX, ...TENANT_SETTING_SYNTAX],
      "wms/no-aliased-module-loader": "error",
      "wms/no-normalized-path-import": "error",
    },
  },
  ...PROFILES,
  {
    // T-127b: "use client" dosyalarında sunucu paketi import yasağı. Kural adları benzersizdir (yukarıdaki profillerin
    // aynı-kural-değiştirme davranışından etkilenmez); hiçbir mevcut kuralı gevşetmez.
    files: ["apps/web/**/*.{js,mjs,cjs,ts,mts,cts,tsx}", "packages/ui/**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    plugins: { wms: WMS_PLUGIN },
    rules: { "wms/no-client-server-import": "error", "wms/no-client-server-loader": "error" },
  },
  {
    // T-210 (I-04, I-15, G-01): stok tablolarında kilit/yazma SQL'i ve şema nesnesi erişimi yalnızca izinli dosyalarda.
    // Yalnızca EK kural (`wms/stock-sql-guard`); mevcut hiçbir kural değiştirilmedi. tests/** ve *.sql kapsam dışıdır.
    files: ["packages/**/*.{js,mjs,cjs,ts,mts,cts,tsx}", "apps/**/*.{js,mjs,cjs,ts,mts,cts,tsx}"],
    plugins: { wms: WMS_PLUGIN },
    rules: { "wms/stock-sql-guard": "error" },
  },
  {
    // T-015: bekçi giriş noktası `scripts/guards/<ad>.mjs` modülünü `import(pathToFileURL(file).href)`
    // ile yükler; `<ad>` `isGuardName` ile sabit `GUARDS` listesine karşı doğrulanır ve testler
    // (`scope.test.mjs`) `guardsDir` ile geçici dizinden sahte modül yükler — statik harita bunu
    // karşılayamaz. Muafiyet YALNIZCA bu dosya ve YALNIZCA `import(pathToFileURL(<ifade>).href)` biçimi içindir (T-008k): aynı
    // dosyada yasaklı küme (statik/dinamik/require), statik olmayan `require` ve tenant ayarı
    // denetimleri aynen geçerlidir (ac-28-lint.test.ts bunu doğrular).
    files: [GUARD_LOADER_FILE],
    // Satır içi yapılandırma/devre dışı bırakma yorumları cli.mjs'te etkisizdir (yüklenen muafiyeti
    // `eslint-disable` ile genişletmek mümkün değil; yorum varsa ESLint uyarı verir).
    linterOptions: { noInlineConfig: true },
    rules: {
      "no-restricted-syntax": [
        "error",
        ...RAW_CLIENT_SYNTAX.map((s) => (s === IMPORT_NON_STATIC ? IMPORT_NON_STATIC_EXCEPT_FILE_URL : s)),
        ...CODE_EXEC_SYNTAX,
        ...TENANT_SETTING_SYNTAX,
        ...PATH_TO_FILE_URL_REBINDING,
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
