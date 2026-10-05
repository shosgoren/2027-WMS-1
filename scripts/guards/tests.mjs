// `pnpm check:tests` (T-008b): devre dışı bırakılmış testleri statik olarak yakalar.
// Depodaki tüm test dosyaları taranır (yalnızca değişenler değil). Ayrıştırma TypeScript
// derleyici API'si ile yapılır (regex değil): yorumdaki veya dizedeki "skip"/"only" çağrı değildir.
//
// Neden kodları (her bulgu `dosya:satır`):
//   SKIP                      it|test|describe|suite üzerinde .skip/.fails/.fail/.fixme/.slow
//                             zinciri; xit/xtest/xdescribe; gövde içi `test.skip()`, `ctx.skip()`,
//                             `skip()`; node:test seçeneği `{ skip: … }`
//   ONLY                      .only zinciri; fit/fdescribe; `{ only: … }`
//   TODO                      .todo zinciri; `t.todo()`; `{ todo: … }`
//   CONDITIONAL_SKIP          .skipIf/.runIf; test/describe gövdesinde `if (<koşul>) return`
//                             ve koşul process.env / CI / platform okuyor
//   QUARANTINE_NOT_SUPPORTED  yukarıdakilerden biri `@quarantine` etiketli testte. İstisna yok:
//                             karantina `skip` ile değil, T-008e'de "koşar, kapıyı kırmaz"
//                             olarak uygulanır (PROTOCOL §Karantina: testler her CI'da koşturulur).
//   READ_ERROR                test dosyası okunamadı
// Atlama istisnası yoktur.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { UsageError } from "./lib/output.mjs";

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
      if (ts.isStringLiteralLike(e.argumentExpression)) names.unshift(e.argumentExpression.text);
      e = e.expression;
    } else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    else return names;
  }
}

/**
 * Üye erişimi düğümünün adı (`a.b` → b, `a["b"]` → b).
 * @param {ts.Node} node
 * @returns {string | null}
 */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/**
 * Koşul ifadesi ortam değişkeni, CI veya platform okuyor mu.
 * @param {ts.Node} node
 * @returns {boolean}
 */
function readsEnvironment(node) {
  /** @param {string} name */
  const envName = (name) =>
    /^(?:ci|is_?ci|env)$/i.test(name) || /platform/i.test(name) || /^is_?(?:windows|win32|mac|macos|darwin|linux)$/i.test(name);
  /** @param {ts.Node} n @returns {boolean} */
  const visit = (n) => {
    if (ts.isIdentifier(n) && envName(n.text)) return true;
    if (ts.isPropertyAccessExpression(n) && envName(n.name.text)) return true;
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && envName(n.argumentExpression.text)) {
      return true;
    }
    return ts.forEachChild(n, visit) === true;
  };
  return visit(node);
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
    if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isBlock(fn.body)) return;
    for (const stmt of fn.body.statements) {
      if (isIfReturn(stmt) && readsEnvironment(stmt.expression)) {
        report(stmt, "CONDITIONAL_SKIP", `${rootName} gövdesinde ortama bağlı erken dönüş: if (${stmt.expression.getText(sf)}) return`);
      }
    }
  }

  /** @param {ts.Node} node */
  function visit(node) {
    // it.skip / describe.concurrent.only / test["todo"] / it.skipIf(…) …
    const member = memberName(node);
    if (member !== null && MODIFIERS.has(member) && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const root = chainRoot(node.expression);
      if (root !== null && BASE_NAMES.has(root.text)) {
        report(node, /** @type {string} */ (MODIFIERS.get(member)), `${node.getText(sf)}`);
      }
    }

    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const callee = ts.isCallExpression(node) ? node.expression : node.tag;
      const root = chainRoot(callee);
      // xit / fdescribe … (zincirli: xit.each(…)(…))
      if (root !== null && PREFIXED.has(root.text)) {
        report(root, /** @type {string} */ (PREFIXED.get(root.text)), `${root.text}(…)`);
      }
      if (ts.isCallExpression(node)) {
        const name = memberName(callee);
        // ctx.skip() / this.skip() / t.skip() / t.todo() — test kökü dışındaki alıcılar
        if ((name === "skip" || name === "todo") && !(root !== null && BASE_NAMES.has(root.text))) {
          report(node, name === "skip" ? "SKIP" : "TODO", `${callee.getText(sf)}()`);
        }
        // Bağlamdan ayrıştırılmış `skip()`
        if (ts.isIdentifier(callee) && callee.text === "skip") report(node, "SKIP", "skip()");

        if (root !== null && BASE_NAMES.has(root.text)) {
          // node:test seçenekleri: test("…", { skip: true }, fn)
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const p of arg.properties) {
              const key = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
              const code = key === null ? undefined : OPTION_KEYS.get(key);
              if (code === undefined) continue;
              if (ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
              report(p, code, `${root.text}(…, { ${p.getText(sf)} })`);
            }
          }
          checkConditionalBody(node, root.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return findings.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
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
  }
}
