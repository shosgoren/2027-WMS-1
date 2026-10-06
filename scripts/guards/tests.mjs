// `pnpm check:tests` (T-008b): devre dışı bırakılmış testleri statik olarak yakalar.
// Depodaki tüm test dosyaları taranır (yalnızca değişenler değil). Ayrıştırma TypeScript
// derleyici API'si ile yapılır (regex değil): yorumdaki veya dizedeki "skip"/"only" çağrı değildir.
//
// Neden kodları (her bulgu `dosya:satır`):
//   SKIP                      it|test|describe|suite üzerinde .skip/.fails/.fail/.fixme/.slow
//                             zinciri; xit/xtest/xdescribe; gövde içi `test.skip()`, `ctx.skip()`,
//                             `skip()`; node:test seçeneği `{ skip: … }`; test kökünde hesaplanan
//                             üye (T-008i MINOR 1): sabit dizeye indirgenen (`it["sk"+"ip"]`,
//                             `` it[`sk${"ip"}`] ``) yasak üye kendi koduyla, indirgenemeyen (`it[k]`) SKIP
//   ONLY                      .only zinciri; fit/fdescribe; `{ only: … }`
//   TODO                      .todo zinciri; `t.todo()`; `{ todo: … }`
//   CONDITIONAL_SKIP          .skipIf/.runIf; test/describe gövdesinde `if (<koşul>) return`
//                             ve koşul process.env / CI / platform okuyor ya da ortamdan türetilmiş
//                             bir değişkeni okuyor (`const s = !!process.env.X; … if (s) return`);
//                             test bağlamından yapı bozulan `skip` çağrısı (`({ skip: s }) => s(…)`,
//                             `const { skip } = ctx`, `const s = ctx.skip`; T-008i MINOR 1)
// Test kökleri (T-008h m6): genel adlar (it/test/describe/suite) + `vitest`, `@playwright/test`,
// `node:test` içe aktarımlarının takma adları (`import { it as t }`, varsayılan, ad alanı
// `import * as v` → `v.it`), bunlardan türeyen değişkenler (`const t2 = test.extend({…})`,
// `const c = it.concurrent`) ve yapı bozma (`const { skip } = it` → SKIP). Dinamik içe aktarım
// (T-008i MINOR 1): `const v = await import("vitest")` / `require("vitest")` ad alanıdır;
// `(await import("vitest")).it…` zinciri ve `import("vitest").then(({ it }) => …)` kökleri izlenir.
//   QUARANTINE_NOT_SUPPORTED  yukarıdakilerden biri `@quarantine` etiketli testte. İstisna yok:
//                             karantina `skip` ile değil, T-008e'de "koşar, kapıyı kırmaz"
//                             olarak uygulanır (PROTOCOL §Karantina: testler her CI'da koşturulur).
//   READ_ERROR                test dosyası okunamadı
// Atlama istisnası yoktur.
//
// Karantina (T-008e; PROTOCOL §Karantina kuralı, ayrıntı `lib/quarantine.mjs`): başlığında
// `@quarantine Q-xx` olan her test/describe için kayıt denetlenir (test yine koşar):
//   QUARANTINE_UNREGISTERED   kayıt yok / kimliksiz etiket / kayıt başka dosya için
//   QUARANTINE_NOT_APPROVED   kayıt satırı `origin/main`'de birebir yok (karantinayı ekleyen PR birleşmemiş)
//   QUARANTINE_GATE_AC        test (veya altındaki test) `currentGatePhase` ∪ `passedGates` fazlarının `@AC` testi
//   QUARANTINE_FUTURE_DATE    (kayıt satırı) eklendi tarihi bugünden (UTC) ileri (T-008j)
//   QUARANTINE_EXPIRED        (kayıt satırı) bitiş tarihi geçti (UTC)
//   QUARANTINE_TOO_LONG       (kayıt satırı) bitiş > eklendiği tarih + 14 gün
//   QUARANTINE_REGISTRY_INVALID  `tests/QUARANTINE.md` ayrıştırılamadı
//   WARN QUARANTINE_ACTIVE    kayıt varsa rapor satırı `MEVCUT KARANTİNA: n (süresi dolmuş: m)`
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { loadAcceptance } from "../test-ac/acceptance.mjs";
import { loadConditions } from "../test-ac/conditions.mjs";
import { UsageError } from "./lib/output.mjs";
import { acTagsOf, entryDateFindings, evaluateSite, gateAcIdsFor, loadQuarantine, QUARANTINE_FILE, quarantineSummary } from "./lib/quarantine.mjs";

/** Taramadan hariç tutulan dizin adları (herhangi bir derinlikte). Başka muafiyet yok. */
export const EXCLUDED_DIRS = Object.freeze(["node_modules", ".artifacts", ".next", "dist", ".git"]);

/** Test çerçevesi kök tanımlayıcıları. */
const BASE_NAMES = new Set(["it", "test", "describe", "suite"]);
/** Devre dışı bırakan önekli tanımlayıcılar → neden kodu. */
const PREFIXED = new Map([
  ["xit", "SKIP"],
  ["xtest", "SKIP"],
  ["xdescribe", "SKIP"],
  ["fit", "ONLY"],
  ["fdescribe", "ONLY"],
]);
/** Kök tanımlayıcı zincirindeki yasak üyeler → neden kodu. */
const MODIFIERS = new Map([
  ["skip", "SKIP"],
  ["fails", "SKIP"],
  ["fail", "SKIP"],
  ["fixme", "SKIP"],
  ["slow", "SKIP"],
  ["only", "ONLY"],
  ["todo", "TODO"],
  ["skipIf", "CONDITIONAL_SKIP"],
  ["runIf", "CONDITIONAL_SKIP"],
]);
/** node:test seçenek nesnesi anahtarları → neden kodu. */
const OPTION_KEYS = new Map([
  ["skip", "SKIP"],
  ["only", "ONLY"],
  ["todo", "TODO"],
]);
/** Test çerçevesi modülleri (içe aktarım takma adları izlenir). */
const TEST_MODULES = new Set(["vitest", "@playwright/test", "node:test"]);
/** Gövdesi koşullu atlama için taranmayan kanca üyeleri (`test.beforeEach` …). */
const HOOK_MEMBERS = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_NAME = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * @typedef {{ code: string, line: number, message: string }} TestFinding
 */

/**
 * Depo-göreli (posix) yol bir test dosyası mı: `*.test.*`, `*.spec.*` veya bir `tests/`
 * dizini altındaki kod dosyası.
 * @param {string} rel
 * @returns {boolean}
 */
export function isTestFile(rel) {
  if (TEST_NAME.test(rel)) return true;
  const parts = rel.split("/");
  return CODE_EXT.test(rel) && parts.slice(0, -1).includes("tests");
}

/**
 * Kökten itibaren test dosyalarını (posix, sıralı) listeler; hariç dizinlere ve sembolik
 * bağlantılara girmez.
 * @param {string} root
 * @returns {string[]}
 */
export function listTestFiles(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} relDir */
  function walk(relDir) {
    const entries = readdirSync(path.join(root, relDir), { withFileTypes: true });
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.includes(e.name)) walk(rel);
      } else if (e.isFile() && isTestFile(rel)) {
        found.push(rel);
      }
    }
  }
  walk("");
  return found.sort();
}

/**
 * @param {string} file
 * @returns {ts.ScriptKind}
 */
function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:ts|mts|cts)$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Üye erişimi / çağrı / etiketli şablon zincirinin kök tanımlayıcısı (`it.concurrent.skip(…)`
 * → `it`, `it.each(t)("…")` → `it`).
 * @param {ts.Expression} expr
 * @returns {ts.Identifier | null}
 */
function chainRoot(expr) {
  /** @type {ts.Expression} */
  let e = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return e;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else return null;
  }
}

/** İndirgenemeyen hesaplanan üye yer tutucusu (geçerli tanımlayıcı olamaz). */
const COMPUTED = "<hesaplanan>";

/**
 * Zincirdeki üye adları (kökten uca).
 * @param {ts.Expression} expr
 * @returns {string[]}
 */
function chainMembers(expr) {
  /** @type {string[]} */
  const names = [];
  /** @type {ts.Expression} */
  let e = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      names.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e)) {
      names.unshift(constString(e.argumentExpression) ?? COMPUTED);
      e = e.expression;
    } else if (ts.isCallExpression(e) && !isTestModuleLoad(e)) e = e.expression;
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else return names;
  }
}

/**
 * Sabit dizeye indirgenebilen ifadenin değeri (dize/sayı sabiti, şablon, `+` birleştirme,
 * parantez); indirgenemiyorsa `null`.
 * @param {ts.Expression} e
 * @returns {string | null}
 */
function constString(e) {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    return constString(e.expression);
  }
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    let s = e.head.text;
    for (const span of e.templateSpans) {
      const v = constString(span.expression);
      if (v === null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constString(e.left);
    const r = constString(e.right);
    return l === null || r === null ? null : l + r;
  }
  return null;
}

/**
 * Üye erişimi düğümünün adı (`a.b` → b, `a["b"]` → b, `a["s"+"kip"]` → skip).
 * @param {ts.Node} node
 * @returns {string | null}
 */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return constString(node.argumentExpression);
  return null;
}

/**
 * Test modülünün dinamik içe aktarımı / `require`'ı mı (`import("vitest")`, `await import(…)`).
 * @param {ts.Expression} e
 * @returns {boolean}
 */
function isTestModuleLoad(e) {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  if (!ts.isCallExpression(x)) return false;
  const callee = x.expression;
  const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
  const arg = x.arguments[0];
  return dynamic && arg !== undefined && ts.isStringLiteralLike(arg) && TEST_MODULES.has(arg.text);
}

/**
 * Zincirin tanımlayıcı olmayan tabanı (`(await import("vitest")).it.skip` → `await import(…)`).
 * @param {ts.Expression} expr
 * @returns {ts.Expression}
 */
function chainBase(expr) {
  /** @type {ts.Expression} */
  let e = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && !isTestModuleLoad(e)) e = e.expression;
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else return e;
  }
}

/**
 * Koşul ifadesi ortam değişkeni, CI veya platform okuyor mu (doğrudan ya da ortamdan türetilmiş
 * değişken üzerinden).
 * @param {ts.Node} node
 * @param {ReadonlySet<string>} [envVars] ortamdan türetilmiş değişken adları
 * @returns {boolean}
 */
function readsEnvironment(node, envVars = new Set()) {
  /** @param {string} name */
  const envName = (name) =>
    /^(?:ci|is_?ci|env)$/i.test(name) || /platform/i.test(name) || /^is_?(?:windows|win32|mac|macos|darwin|linux)$/i.test(name);
  /** @param {ts.Node} n @returns {boolean} */
  const visit = (n) => {
    if (ts.isIdentifier(n) && envName(n.text)) return true;
    if (ts.isIdentifier(n) && envVars.has(n.text) && !(n.parent !== undefined && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(n) && envName(n.name.text)) return true;
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && envName(n.argumentExpression.text)) {
      return true;
    }
    return ts.forEachChild(n, visit) === true;
  };
  return visit(node);
}

/**
 * Parantez, `await`, `as`, `!` sarmalayıcılarını soyar.
 * @param {ts.Expression} e
 * @returns {ts.Expression}
 */
function unwrap(e) {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) {
    x = x.expression;
  }
  return x;
}

/**
 * Deyimdeki bağlama adları (`a`, `{ a, b: c }` → a, c; iç içe dahil).
 * @param {ts.BindingName} name
 * @returns {string[]}
 */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  /** @type {string[]} */
  const out = [];
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) out.push(...bindingNames(el.name));
  return out;
}

/**
 * Yapı bozma öğesinin kaynak özellik adı (`{ a }`, `{ a: b }`, `{ "a": b }`, `{ ["s"+"kip"]: b }`);
 * indirgenemeyen hesaplanan ad → `null`.
 * @param {ts.BindingElement} el
 * @returns {string | null}
 */
function bindingProp(el) {
  const p = el.propertyName;
  if (p === undefined) return ts.isIdentifier(el.name) ? el.name.text : null;
  if (ts.isIdentifier(p) || ts.isStringLiteralLike(p) || ts.isNumericLiteral(p)) return p.text;
  if (ts.isComputedPropertyName(p)) return constString(p.expression);
  return null;
}

/**
 * `if (…) return` / `if (…) { …; return }` biçimi.
 * @param {ts.Statement} stmt
 * @returns {stmt is ts.IfStatement}
 */
function isIfReturn(stmt) {
  if (!ts.isIfStatement(stmt)) return false;
  const then = stmt.thenStatement;
  if (ts.isReturnStatement(then)) return true;
  if (ts.isBlock(then)) {
    const last = then.statements[then.statements.length - 1];
    return last !== undefined && ts.isReturnStatement(last);
  }
  return false;
}

/**
 * @typedef {{
 *   bases: Map<string, string[]>,
 *   prefixed: Map<string, string>,
 *   namespaces: Set<string>,
 * }} TestRoots
 *   `bases`: test kökü yerel adı → kanonik yol (`it` → ["it"], `t2 = test.extend(…)` → ["test"],
 *   `d = test.describe` → ["test", "describe"]); `prefixed`: önekli devre dışı yerel ad → neden kodu;
 *   `namespaces`: test modülü ad alanları (`import * as v from "vitest"`, `const v = await import(…)`).
 */

/**
 * İfade bir test kökü zinciri mi (`it`, `t.concurrent`, `v.it.each(…)`).
 * @param {TestRoots} roots
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
function isTestChainIn(roots, expr) {
  const first = chainMembers(expr)[0] ?? "";
  const nsMember = BASE_NAMES.has(first) || first === COMPUTED;
  const root = chainRoot(expr);
  if (root === null) return isTestModuleLoad(chainBase(expr)) && nsMember;
  if (roots.bases.has(root.text)) return true;
  return roots.namespaces.has(root.text) && nsMember;
}

/**
 * Test kökü zincirinin kanonik yolu (takma adlar çözülmüş; `extend` düşer): `t2.concurrent` →
 * ["test", "concurrent"], `v.describe.each` → ["describe", "each"]. Test kökü değilse `null`.
 * @param {TestRoots} roots
 * @param {ts.Expression} expr
 * @returns {string[] | null}
 */
function canonicalPathIn(roots, expr) {
  if (!isTestChainIn(roots, expr)) return null;
  const members = chainMembers(expr).filter((m) => m !== "extend");
  const root = chainRoot(expr);
  if (root !== null && roots.bases.has(root.text)) return [...(roots.bases.get(root.text) ?? [root.text]), ...members];
  return members;
}

/**
 * Bir kaynak dosyadaki test kökleri ve takma adları (T-008h m6, T-008i MINOR 1). `check:tests`
 * ve `lib/assertion-count.mjs` (T-008e; T-008d bulgu 4) aynı çözümlemeyi kullanır.
 * @param {ts.SourceFile} sf
 * @returns {TestRoots}
 */
export function collectTestRoots(sf) {
  /** @type {TestRoots} */
  const roots = {
    bases: new Map([...BASE_NAMES].map((n) => [n, [n]])),
    prefixed: new Map(PREFIXED),
    namespaces: new Set(),
  };
  const { bases, prefixed, namespaces } = roots;
  /** @type {ts.VariableDeclaration[]} */
  const decls = [];

  /**
   * Test modülünden yapı bozma (`{ it: t, xit }`) → kökler/önekliler. Değişiklik varsa `true`.
   * @param {ts.ObjectBindingPattern} pattern
   * @returns {boolean}
   */
  function moduleBindings(pattern) {
    let changed = false;
    for (const el of pattern.elements) {
      const prop = bindingProp(el);
      if (!ts.isIdentifier(el.name) || prop === null) continue;
      if (BASE_NAMES.has(prop) && !bases.has(el.name.text)) {
        bases.set(el.name.text, [prop]);
        changed = true;
      }
      const code = PREFIXED.get(prop);
      if (code !== undefined && !prefixed.has(el.name.text)) {
        prefixed.set(el.name.text, code);
        changed = true;
      }
    }
    return changed;
  }

  /** @param {ts.Node} n */
  function collect(n) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && TEST_MODULES.has(n.moduleSpecifier.text)) {
      const c = n.importClause;
      if (c !== undefined) {
        // Varsayılan içe aktarım: node:test ve @playwright/test'te `test` işlevi.
        if (c.name !== undefined) bases.set(c.name.text, ["test"]);
        const nb = c.namedBindings;
        if (nb !== undefined && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
        if (nb !== undefined && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (BASE_NAMES.has(imported)) bases.set(el.name.text, [imported]);
            const code = PREFIXED.get(imported);
            if (code !== undefined) prefixed.set(el.name.text, code);
          }
        }
      }
    }
    // import("vitest").then(({ it }) => …) / .then((v) => v.it…)
    if (ts.isCallExpression(n) && memberName(n.expression) === "then" && (ts.isPropertyAccessExpression(n.expression) || ts.isElementAccessExpression(n.expression)) && isTestModuleLoad(n.expression.expression)) {
      const fn = n.arguments[0];
      const param = fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.parameters[0] : undefined;
      if (param !== undefined && ts.isIdentifier(param.name)) namespaces.add(param.name.text);
      if (param !== undefined && ts.isObjectBindingPattern(param.name)) moduleBindings(param.name);
    }
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) decls.push(n);
    ts.forEachChild(n, collect);
  }
  collect(sf);

  // Türetilmiş kökler: sabit noktaya kadar.
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      const init = unwrap(/** @type {ts.Expression} */ (d.initializer));
      // const v = await import("vitest") / require("vitest") → ad alanı
      if (ts.isIdentifier(d.name) && !namespaces.has(d.name.text) && isTestModuleLoad(init)) {
        namespaces.add(d.name.text);
        changed = true;
      }
      if (ts.isIdentifier(d.name) && !bases.has(d.name.text)) {
        const derivable =
          ts.isIdentifier(init) ||
          ts.isPropertyAccessExpression(init) ||
          ts.isElementAccessExpression(init) ||
          (ts.isCallExpression(init) && memberName(init.expression) === "extend");
        const canon = derivable ? canonicalPathIn(roots, init) : null;
        if (canon !== null) {
          bases.set(d.name.text, canon.length > 0 ? canon : [d.name.text]);
          changed = true;
        }
      }
      if (ts.isObjectBindingPattern(d.name)) {
        // `const { it: t } = v` / `const { test } = await import("vitest")`
        const e = unwrap(init);
        const isNs = (ts.isIdentifier(e) && namespaces.has(e.text)) || isTestModuleLoad(e);
        if (isNs && moduleBindings(d.name)) changed = true;
      }
    }
  }
  return roots;
}

/**
 * Bir kaynak metindeki devre dışı test biçimlerini bulur.
 * @param {string} text
 * @param {string} file uzantı (ScriptKind) ve tanılama için
 * @returns {TestFinding[]}
 */
export function scanSource(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {TestFinding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {ts.Node} node */
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const roots = collectTestRoots(sf);
  const { prefixed, namespaces } = roots;
  /** Ortamdan türetilmiş değişken adları. */
  /** @type {Set<string>} */
  const envVars = new Set();
  /** @type {ts.VariableDeclaration[]} */
  const decls = [];

  /**
   * @param {ts.Expression} expr
   * @returns {boolean}
   */
  const isTestChain = (expr) => isTestChainIn(roots, expr);

  /**
   * İfade bir test modülü ad alanı mı (`v`, `await import("vitest")`).
   * @param {ts.Expression} expr
   * @returns {boolean}
   */
  function isNamespace(expr) {
    const e = unwrap(expr);
    return (ts.isIdentifier(e) && namespaces.has(e.text)) || isTestModuleLoad(e);
  }

  /**
   * Önekli devre dışı kök (`xit`, takma adı veya `v.xit`) → neden kodu.
   * @param {ts.Expression} expr
   * @returns {string | undefined}
   */
  function prefixedCode(expr) {
    const root = chainRoot(expr);
    if (root === null) return isTestModuleLoad(chainBase(expr)) ? PREFIXED.get(chainMembers(expr)[0] ?? "") : undefined;
    if (prefixed.has(root.text)) return prefixed.get(root.text);
    if (namespaces.has(root.text)) return PREFIXED.get(chainMembers(expr)[0] ?? "");
    return undefined;
  }

  /** @param {ts.Node} n */
  function collectDecls(n) {
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) decls.push(n);
    ts.forEachChild(n, collectDecls);
  }
  collectDecls(sf);

  // Ortam bayrakları: sabit noktaya kadar.
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      const init = unwrap(/** @type {ts.Expression} */ (d.initializer));
      if (readsEnvironment(init, envVars)) {
        for (const name of bindingNames(d.name)) {
          if (!envVars.has(name)) {
            envVars.add(name);
            changed = true;
          }
        }
      }
    }
  }

  /**
   * Düğümün içinde bulunduğu deyimlerden birinin baş yorumunda veya kapsayan test çağrısının
   * başlığında `@quarantine` var mı.
   * @param {ts.Node} node
   * @returns {boolean}
   */
  function quarantined(node) {
    for (let n = node; n !== undefined && n.kind !== ts.SyntaxKind.SourceFile; n = n.parent) {
      const ranges = ts.getLeadingCommentRanges(sf.text, n.pos) ?? [];
      if (ranges.some((r) => sf.text.slice(r.pos, r.end).includes("@quarantine"))) return true;
      if (ts.isCallExpression(n)) {
        const title = n.arguments[0];
        if (title !== undefined && ts.isStringLiteralLike(title) && title.text.includes("@quarantine")) return true;
      }
    }
    return false;
  }

  /**
   * @param {ts.Node} node
   * @param {string} code
   * @param {string} message
   */
  function report(node, code, message) {
    const key = `${node.getStart(sf)}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (quarantined(node)) {
      findings.push({
        code: "QUARANTINE_NOT_SUPPORTED",
        line: lineOf(node),
        message: `${message} — @quarantine etiketli atlama da yasak (${code}); karantina testi koşturur (T-008e)`,
      });
      return;
    }
    findings.push({ code, line: lineOf(node), message });
  }

  /**
   * Test/describe gövdesindeki `if (<ortam>) return`.
   * @param {ts.CallExpression} call
   * @param {string} rootName
   */
  function checkConditionalBody(call, rootName) {
    if (chainMembers(call.expression).some((m) => HOOK_MEMBERS.has(m))) return;
    const fn = [...call.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
    checkContextSkip(fn, rootName);
    if (!ts.isBlock(fn.body)) return;
    for (const stmt of fn.body.statements) {
      if (isIfReturn(stmt) && readsEnvironment(stmt.expression, envVars)) {
        report(stmt, "CONDITIONAL_SKIP", `${rootName} gövdesinde ortama bağlı erken dönüş: if (${stmt.expression.getText(sf)}) return`);
      }
    }
  }

  /** Test bağlamından alınmış `skip` çağrıları (genel `skip()` kuralı bunları yinelemez). */
  /** @type {Set<ts.Node>} */
  const contextSkipCalls = new Set();

  /**
   * Yapı bozma deseninde `skip` öğelerinin yerel adları.
   * @param {ts.ObjectBindingPattern} pattern
   * @returns {string[]}
   */
  function skipBindings(pattern) {
    /** @type {string[]} */
    const out = [];
    for (const el of pattern.elements) {
      if (bindingProp(el) === "skip" && ts.isIdentifier(el.name)) out.push(el.name.text);
    }
    return out;
  }

  /**
   * Test geri çağrısında bağlamdan yapı bozulan / alınan `skip` çağrıları → CONDITIONAL_SKIP
   * (`({ skip: s }) => s(cond)`, `(ctx) => { const { skip } = ctx; skip() }`, `const s = ctx.skip`).
   * @param {ts.ArrowFunction | ts.FunctionExpression} fn
   * @param {string} rootName
   */
  function checkContextSkip(fn, rootName) {
    /** @type {Set<string>} */
    const ctxNames = new Set();
    /** @type {Set<string>} */
    const skipNames = new Set();
    for (const p of fn.parameters) {
      if (ts.isIdentifier(p.name)) ctxNames.add(p.name.text);
      else if (ts.isObjectBindingPattern(p.name)) for (const n of skipBindings(p.name)) skipNames.add(n);
    }
    /** @param {ts.Expression} e */
    const isCtx = (e) => {
      const x = unwrap(e);
      return ts.isIdentifier(x) && ctxNames.has(x.text);
    };
    /** @param {ts.Node} n */
    const collectAliases = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined && isCtx(n.initializer) && ts.isObjectBindingPattern(n.name)) {
        for (const x of skipBindings(n.name)) skipNames.add(x);
      }
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined && ts.isIdentifier(n.name)) {
        const init = unwrap(n.initializer);
        if ((ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) && memberName(init) === "skip" && isCtx(init.expression)) {
          skipNames.add(n.name.text);
        }
      }
      ts.forEachChild(n, collectAliases);
    };
    collectAliases(fn.body);
    if (skipNames.size === 0) return;
    /** @param {ts.Node} n */
    const findCalls = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        if (ts.isIdentifier(callee) && skipNames.has(callee.text)) {
          contextSkipCalls.add(n);
          report(n, "CONDITIONAL_SKIP", `${rootName} bağlamından alınan skip çağrısı: ${n.getText(sf)}`);
        }
      }
      ts.forEachChild(n, findCalls);
    };
    findCalls(fn.body);
  }

  /** @param {ts.Node} node */
  function visit(node) {
    // it.skip / describe.concurrent.only / test["todo"] / it.skipIf(…) …
    const member = memberName(node);
    if (member !== null && MODIFIERS.has(member) && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      if (isTestChain(node.expression)) {
        report(node, /** @type {string} */ (MODIFIERS.get(member)), `${node.getText(sf)}`);
      }
    }
    // Hesaplanan üye: it[k] / v[k] (sabit dizeye indirgenemeyen) → SKIP (fail-closed)
    if (ts.isElementAccessExpression(node) && member === null && (isTestChain(node.expression) || isNamespace(node.expression))) {
      report(node, "SKIP", `hesaplanan test üyesi (sabit değil): ${node.getText(sf)}`);
    }

    // Yapı bozma: const { skip } = it / const { only: o } = test.concurrent
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined && isTestChain(unwrap(node.initializer))) {
      for (const el of node.name.elements) {
        const prop = bindingProp(el);
        if (prop === null && el.propertyName !== undefined && ts.isComputedPropertyName(el.propertyName)) {
          report(el, "SKIP", `hesaplanan yapı bozma (sabit değil): const { ${el.getText(sf)} } = ${node.initializer.getText(sf)}`);
          continue;
        }
        const code = prop === null ? undefined : MODIFIERS.get(prop);
        if (code !== undefined) report(el, code, `const { ${el.getText(sf)} } = ${node.initializer.getText(sf)}`);
      }
    }

    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const callee = ts.isCallExpression(node) ? node.expression : node.tag;
      const root = chainRoot(callee);
      // xit / fdescribe … (zincirli: xit.each(…)(…)); takma ad ve ad alanı dahil
      const pcode = prefixedCode(callee);
      if (root !== null && pcode !== undefined) {
        report(root, pcode, `${root.text}${namespaces.has(root.text) ? `.${chainMembers(callee)[0] ?? ""}` : ""}(…)`);
      }
      const testCall = isTestChain(callee);
      if (ts.isCallExpression(node)) {
        const name = memberName(callee);
        // ctx.skip() / this.skip() / t.skip() / t.todo() — test kökü dışındaki alıcılar
        if ((name === "skip" || name === "todo") && !testCall) {
          report(node, name === "skip" ? "SKIP" : "TODO", `${callee.getText(sf)}()`);
        }
        // Bağlamdan ayrıştırılmış `skip()`
        if (ts.isIdentifier(callee) && callee.text === "skip" && !contextSkipCalls.has(node)) report(node, "SKIP", "skip()");

        if (testCall) {
          const rootName = root?.text ?? "test";
          // node:test seçenekleri: test("…", { skip: true }, fn)
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const p of arg.properties) {
              const key = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
              const code = key === null ? undefined : OPTION_KEYS.get(key);
              if (code === undefined) continue;
              if (ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
              report(p, code, `${rootName}(…, { ${p.getText(sf)} })`);
            }
          }
          checkConditionalBody(node, rootName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return findings.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
}

/** Suite kanonik kökleri. */
const SUITE_NAMES = new Set(["describe", "suite"]);

/**
 * @typedef {{ file: string, line: number, title: string, acIds: string[] }} QuarantineSite
 */

/**
 * Başlığında `@quarantine` olan test/describe çağrıları (T-008e). `title`: tam ad (çevreleyen
 * describe başlıkları + kendi başlığı); `acIds`: tam addaki ve alt testlerin başlıklarındaki `@AC`
 * etiketleri. Kökler `collectTestRoots` ile çözülür (takma adlar dahil).
 * @param {string} text
 * @param {string} file
 * @returns {QuarantineSite[]}
 */
export function quarantineSites(text, file) {
  if (!text.includes("@quarantine")) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const roots = collectTestRoots(sf);
  /** @type {QuarantineSite[]} */
  const sites = [];
  /** @type {string[]} */
  const stack = [];

  /**
   * @param {ts.Expression | undefined} arg
   * @returns {string | null}
   */
  const titleOf = (arg) => {
    if (arg === undefined) return null;
    const e = unwrap(arg);
    const c = constString(e);
    if (c !== null) return c;
    if (ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)) return e.getText(sf);
    return null;
  };

  /**
   * Çağrı altındaki tüm test başlıklarının metni (alt testlerdeki AC etiketleri için).
   * @param {ts.Node} node
   * @returns {string}
   */
  const innerTitles = (node) => {
    /** @type {string[]} */
    const out = [];
    /** @param {ts.Node} n */
    const visit = (n) => {
      if (ts.isCallExpression(n) && canonicalPathIn(roots, n.expression) !== null) out.push(titleOf(n.arguments[0]) ?? "");
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return out.join(" ");
  };

  /** @param {ts.Node} n */
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const canon = canonicalPathIn(roots, n.expression);
      const title = canon === null ? null : titleOf(n.arguments[0]);
      if (canon !== null && title !== null) {
        const first = canon[0] ?? "";
        const isSuite = SUITE_NAMES.has(first) || canon[1] === "describe";
        const full = [...stack, title].join(" ");
        if (title.includes("@quarantine")) {
          sites.push({
            file,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            title: full,
            acIds: acTagsOf(`${full} ${innerTitles(n)}`),
          });
        }
        if (isSuite) {
          stack.push(title);
          ts.forEachChild(n, walk);
          stack.pop();
          return;
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return sites;
}

/**
 * Karantina etiketlerini ve kaydı denetler (T-008e).
 * @param {string} root
 * @param {QuarantineSite[]} sites
 * @param {import("./lib/output.mjs").Reporter} out
 */
function checkQuarantine(root, sites, out) {
  const state = loadQuarantine(root);
  if (state.registry === null && sites.length === 0) return;
  for (const e of state.registry?.errors ?? []) out.fail("QUARANTINE_REGISTRY_INVALID", `${QUARANTINE_FILE}:${e.line}`, e.message);

  /** @type {Set<string> | null} */
  let gateAcs = null;
  /** @type {string | null} */
  let gateError = null;
  if (sites.length > 0) {
    try {
      const acs = loadAcceptance(root);
      gateAcs = gateAcIdsFor(acs, loadConditions(root, acs));
    } catch (e) {
      gateError = e instanceof Error ? e.message : String(e);
    }
  }
  for (const site of sites) {
    for (const f of evaluateSite(site, state, { gateAcs, gateError })) out.fail(f.code, `${site.file}:${site.line}`, f.message);
  }
  for (const entry of state.registry?.entries.values() ?? []) {
    for (const f of entryDateFindings(entry, state.today)) out.fail(f.code, `${QUARANTINE_FILE}:${entry.line}`, f.message);
  }
  const summary = quarantineSummary(state);
  out.detail("quarantine", { count: summary.count, expired: summary.expired, today: state.today, mainRef: state.mainRef, mainError: state.mainError, sites });
  if (summary.count > 0) out.warn("QUARANTINE_ACTIVE", QUARANTINE_FILE, summary.line);
}

/**
 * @param {{ root: string, argv: string[], out: import("./lib/output.mjs").Reporter }} ctx
 */
export function run(ctx) {
  const { out, root } = ctx;
  const extra = ctx.argv.filter((a) => a !== "--");
  if (extra.length > 0) throw new UsageError(`check:tests argüman almaz ("${extra.join(" ")}")`);

  const files = listTestFiles(root);
  out.detail("scanned", files);
  /** @type {QuarantineSite[]} */
  const sites = [];
  for (const rel of files) {
    /** @type {string} */
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch (e) {
      out.fail("READ_ERROR", rel, e instanceof Error ? e.message : String(e));
      continue;
    }
    for (const f of scanSource(text, rel)) out.fail(f.code, `${rel}:${f.line}`, f.message);
    sites.push(...quarantineSites(text, rel));
  }
  checkQuarantine(root, sites, out);
}
