// `@AC` test ve assertion sayımı + AC tabanı (`tests/.ac-baseline.json`) yardımcıları (T-008d).
// `check:ac-ratchet` ve `check:assertions` bu modülü paylaşır. Ayrıştırma TypeScript derleyici
// API'si ile yapılır (regex değil): yorumdaki veya dizedeki `expect(true)` çağrı değildir.
//
// Sayım kuralları:
//   - AC testi  = başlığı dize olan `it|test(…)` yaprak testi; etiket (`@AC-\d+`, `collect.mjs`
//     `TAG_RE`) testin tam adından (çevreleyen `describe|suite|test.describe` başlıkları + kendi
//     başlığı) okunur. `describe("@AC-1")` altındaki her `it` AC-1 testidir (etiket mirası).
//   - Assertion = matcher'a bağlanan `expect(…)` zinciri (`expect(x).not.toBe(y)`,
//     `expect.soft(x).toBe(y)`, `expect.poll(f).toBe(y)`) veya `assert…` çağrısı (`assert(x)`,
//     `assert.equal(a, b)`, `assertEquals(a, b)`, `t.assert.ok(x)`). Sayılmayanlar: matcher'sız
//     `expect(x)`, `expect.assertions(n)`, `expect.any(…)`, `assertType<…>()` (tip düzeyi),
//     `assert.fail(…)` (her zaman başarısız; kanıt değil). Sabit assertion sayılmaz.
//   - Sabit assertion: konu ve matcher argümanlarının hepsi sabit (`expect(true).toBeTruthy()`,
//     `expect(1).toBe(1)`, `expect("x").toBeDefined()`, `expect()`), veya konu ifadesi matcher
//     argümanı olarak tekrar ediyor (`expect(x).toBe(x)`); `assert` için tüm argümanlar sabit
//     (`assert(true)`, `assert.ok(1, "m")`) veya ilk iki argüman aynı (`assert.equal(x, x)`).
//     `expect(true).toBe(gercek)` sabit değildir (ters yazılmış ama gerçek kontrol).
//   - Etkisiz assertion (T-008j; sayılmaz, sabit bulgusu da değildir — testte başka assertion yoksa
//     NO_ASSERTION, dosya sayısı düşerse ratchet yakalar): `ineffectiveReason`
//       · erişilemeyen kod: sabit koşullu dalın ölü kolu (`if (false) {…}`, `if (1) {} else {…}`,
//         `while (0) {…}`, `false && expect(…)…`, `c ? … : …` sabit koşulla) ve aynı blokta koşulsuz
//         `return`/`throw` sonrası deyimler (hoist edilen işlev bildirimi hariç);
//       · yutulan assertion: `try` bloğunda, `catch` bloğu üst düzeyde `throw` etmiyorsa
//         (`try { expect(…) } catch {}`); `try … finally` (catch yok) etkilidir;
//       · await edilmemiş asenkron matcher: `.resolves`/`.rejects` zinciri veya `expect.poll`
//         doğrudan `await` edilmiyor ya da `return` edilmiyorsa (`Promise.all([...])` içi de sayılmaz).
//     Yerel yardımcı işlev çağrısı da aynı kuralla süzülür (`try { yardimci() } catch {}`).
//   - Dosya assertion sayısı = `@AC` dosyasındaki tüm sabit olmayan assertion'lar (yardımcı
//     işlevlerdekiler dahil).
//   - Her AC testi en az bir sabit olmayan assertion içermeli; test gövdesinden çağrılan aynı
//     dosyadaki adlandırılmış işlevlerin (işlev bildirimi / `const f = () => …`) gövdeleri geçişli
//     olarak sayılır. İçinde yaprak test olmayan `@AC` describe'ı da assertion'sızdır.
// Test kökleri (T-008e; T-008d bulgu 4): genel adlar + takma adlar `check:tests` ile aynı yöntemle
// (`tests.mjs` `collectTestRoots`) çözülür: `import { it as t }`, `import * as v` → `v.it`,
// `const t2 = test.extend(…)`, `const d = test.describe`, `const { it: t } = await import("vitest")`.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { TAG_RE } from "../../test-ac/collect.mjs";
import { AC_BASELINE } from "../protected-paths.mjs";
import { collectTestRoots, EXCLUDED_DIRS, isTestFile, listTestFiles } from "../tests.mjs";
import { DEFAULT_TARGET, fileAtRef, git, GitError, mergeBase } from "./git.mjs";
import { UsageError } from "./output.mjs";

export { AC_BASELINE };

/** `pnpm check:ac-ratchet --update` önerisi (BASELINE_STALE mesajlarında). */
export const UPDATE_HINT = "`pnpm check:ac-ratchet --update` ile tabanı güncelleyin";

/**
 * @typedef {{ line: number, message: string }} LineFinding
 * @typedef {{ ids: string[], title: string, line: number }} AcTest
 * @typedef {{
 *   file: string,
 *   ids: string[],
 *   tests: AcTest[],
 *   assertions: number,
 *   constants: LineFinding[],
 *   noAssertion: LineFinding[],
 * }} FileScan
 * @typedef {{ acTests: Record<string, number>, acFileAssertions: Record<string, number> }} Baseline
 * @typedef {{ from: string, to: string, count: number }} Move
 */

const SUITE_ROOTS = new Set(["describe", "suite"]);
const TEST_ROOTS = new Set(["it", "test"]);
/** Yaprak test zincirinde izin verilen üyeler (`it.concurrent.each(t)(…)` …). */
const TEST_MODS = new Set(["concurrent", "sequential", "each", "for", "only", "skip", "todo", "fails", "fail", "fixme", "slow", "skipIf", "runIf"]);
/** Suite zincirinde izin verilen üyeler (`describe.each`, Playwright `test.describe.serial` …). */
const SUITE_MODS = new Set(["concurrent", "sequential", "shuffle", "each", "for", "only", "skip", "todo", "fixme", "skipIf", "runIf", "serial", "parallel"]);
const ASSERT_ROOT_RE = /^assert(?:[A-Z]\w*)?$/;
const EXPECT_VARIANTS = new Set(["soft", "poll"]);

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
 * @param {ts.Expression} e
 * @returns {ts.Expression}
 */
function unwrap(e) {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) {
    x = x.expression;
  }
  return x;
}

/**
 * Çağrı/üye zincirinin kök tanımlayıcı adı ve üye adları (`it.each(t)("…")` → it, [each]).
 * @param {ts.Expression} expr
 * @returns {{ root: string | null, members: string[] }}
 */
function chain(expr) {
  /** @type {string[]} */
  const members = [];
  let e = expr;
  for (;;) {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return { root: e.text, members };
    if (ts.isPropertyAccessExpression(e)) {
      members.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e)) {
      const a = e.argumentExpression;
      members.unshift(ts.isStringLiteralLike(a) ? a.text : "<hesaplanan>");
      e = e.expression;
    } else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag;
    else return { root: null, members };
  }
}

/**
 * Başlık metni (şablon boşlukları `${…}` olarak); başlık değilse `null`.
 * @param {ts.Expression | undefined} arg
 * @returns {string | null}
 */
function titleText(arg) {
  if (arg === undefined) return null;
  const e = unwrap(arg);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => "${…}" + s.literal.text).join("");
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = titleText(e.left);
    const r = titleText(e.right);
    return (l ?? "${…}") + (r ?? "${…}");
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tagsOf(text) {
  return [...new Set([...text.matchAll(TAG_RE)].map((m) => m[1] ?? ""))].filter((x) => x !== "");
}

/**
 * Derleme zamanında değeri sabit olan ifade mi (literal, literal'lerden oluşan dizi/nesne/işlem).
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
export function isConstant(expr) {
  const e = unwrap(expr);
  switch (e.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(e)) return e.text === "undefined" || e.text === "NaN" || e.text === "Infinity";
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => isConstant(s.expression));
  if (ts.isPrefixUnaryExpression(e)) return isConstant(e.operand);
  if (ts.isVoidExpression(e) || ts.isTypeOfExpression(e)) return isConstant(e.expression);
  if (ts.isBinaryExpression(e)) return isConstant(e.left) && isConstant(e.right);
  if (ts.isConditionalExpression(e)) return isConstant(e.condition) && isConstant(e.whenTrue) && isConstant(e.whenFalse);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => !ts.isSpreadElement(x) && !ts.isOmittedExpression(x) && isConstant(x));
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isConstant(p.initializer));
  }
  return false;
}

/**
 * @param {ts.Expression} a
 * @param {ts.Expression} b
 * @param {ts.SourceFile} sf
 * @returns {boolean}
 */
function sameExpr(a, b, sf) {
  return unwrap(a).getText(sf).replace(/\s+/g, "") === unwrap(b).getText(sf).replace(/\s+/g, "");
}

/**
 * Çağrı bir assertion mı; ise sabit mi.
 * @param {ts.CallExpression} call
 * @param {ts.SourceFile} sf
 * @returns {{ constant: boolean, reason: string } | null} assertion değilse `null`
 */
export function classifyAssertion(call, sf) {
  const callee = unwrap(call.expression);
  // expect(...)[.not|.resolves|.rejects]*.matcher(...)
  if (ts.isPropertyAccessExpression(callee)) {
    /** @type {ts.Expression} */
    let e = unwrap(callee.expression);
    while (ts.isPropertyAccessExpression(e)) e = unwrap(e.expression);
    if (ts.isCallExpression(e)) {
      const ec = unwrap(e.expression);
      const isExpect =
        (ts.isIdentifier(ec) && ec.text === "expect") ||
        (ts.isPropertyAccessExpression(ec) && EXPECT_VARIANTS.has(ec.name.text) && ts.isIdentifier(unwrap(ec.expression)) && /** @type {ts.Identifier} */ (unwrap(ec.expression)).text === "expect");
      if (isExpect) {
        const subject = e.arguments[0];
        const matcher = callee.name.text;
        const src = `expect(${subject === undefined ? "" : unwrap(subject).getText(sf)}).${matcher}(…)`;
        if (subject === undefined) return { constant: true, reason: `${src}: konu yok` };
        if (call.arguments.some((a) => sameExpr(a, subject, sf))) return { constant: true, reason: `${src}: aynı ifade iki tarafta` };
        if (isConstant(subject) && call.arguments.every((a) => isConstant(a))) return { constant: true, reason: `${src}: konu ve beklenen değer sabit` };
        return { constant: false, reason: "" };
      }
    }
  }
  // assert…(…), assert.x(…), t.assert.x(…)
  const { root, members } = chain(callee);
  if (root === null) return null;
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return null;
  // Zincirde çağrı olmamalı (`assert(x).foo()` assertion değildir).
  /** @type {ts.Expression} */
  let probe = callee;
  while (ts.isPropertyAccessExpression(probe)) probe = unwrap(probe.expression);
  if (!ts.isIdentifier(probe)) return null;
  const rootIsAssert = ASSERT_ROOT_RE.test(root) && root !== "assertType";
  if (!rootIsAssert && !members.includes("assert")) return null;
  if (members.at(-1) === "fail") return null;
  const args = call.arguments;
  const src = `${callee.getText(sf)}(…)`;
  if (args.length === 0 || args.every((a) => isConstant(a))) return { constant: true, reason: `${src}: argümanlar sabit` };
  const [a0, a1] = args;
  if (a0 !== undefined && a1 !== undefined && sameExpr(a0, a1, sf)) return { constant: true, reason: `${src}: aynı ifade iki tarafta` };
  return { constant: false, reason: "" };
}

/**
 * Değeri derleme zamanında belli doğruluk (`true`/`false`); belli değilse `null`.
 * @param {ts.Expression} expr
 * @returns {boolean | null}
 */
export function constantTruthiness(expr) {
  const e = unwrap(expr);
  switch (e.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return false;
    default:
      break;
  }
  if (ts.isNumericLiteral(e)) return Number(e.text) !== 0;
  if (ts.isBigIntLiteral(e)) return e.text !== "0n";
  if (ts.isStringLiteralLike(e)) return e.text !== "";
  if (ts.isIdentifier(e)) return e.text === "undefined" || e.text === "NaN" ? false : null;
  if (ts.isVoidExpression(e)) return false;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const v = constantTruthiness(e.operand);
    return v === null ? null : !v;
  }
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  return null;
}

/**
 * Deyim akışı koşulsuz sonlandırıyor mu (`return`, `throw`).
 * @param {ts.Statement} st
 * @returns {boolean}
 */
function terminates(st) {
  return ts.isReturnStatement(st) || ts.isThrowStatement(st);
}

/**
 * Asenkron matcher zinciri mi (`.resolves`/`.rejects` veya `expect.poll`).
 * @param {ts.CallExpression} call
 * @returns {boolean}
 */
function isAsyncMatcher(call) {
  /** @type {ts.Expression} */
  let e = unwrap(call.expression);
  while (ts.isPropertyAccessExpression(e)) {
    if (e !== unwrap(call.expression) && (e.name.text === "resolves" || e.name.text === "rejects")) return true;
    e = unwrap(e.expression);
  }
  if (!ts.isCallExpression(e)) return false;
  const ec = unwrap(e.expression);
  return ts.isPropertyAccessExpression(ec) && ec.name.text === "poll" && ts.isIdentifier(unwrap(ec.expression)) && /** @type {ts.Identifier} */ (unwrap(ec.expression)).text === "expect";
}

/**
 * Çağrı ifadesi `await` ya da `return` ediliyor mu (parantez/tip dönüşümü üzerinden).
 * @param {ts.Node} node
 * @returns {boolean}
 */
function awaitedOrReturned(node) {
  let n = node;
  let p = n.parent;
  while (p !== undefined && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p))) {
    n = p;
    p = p.parent;
  }
  if (p === undefined) return false;
  if (ts.isAwaitExpression(p) || ts.isReturnStatement(p)) return true;
  return ts.isArrowFunction(p) && p.body === n;
}

/**
 * Assertion (veya yerel yardımcı) çağrısı etkisiz mi; ise nedeni (T-008j). Atalar dosya köküne
 * kadar taranır (işlev sınırında durulmaz: ölü koldaki geri çağırım da ölüdür).
 * @param {ts.CallExpression} call
 * @returns {string | null}
 */
export function ineffectiveReason(call) {
  if (isAsyncMatcher(call) && !awaitedOrReturned(call)) return "await edilmemiş .resolves/.rejects/expect.poll";
  /** @type {ts.Node} */
  let child = call;
  let p = call.parent;
  while (p !== undefined) {
    if (ts.isIfStatement(p) && child !== p.expression) {
      const v = constantTruthiness(p.expression);
      if ((v === false && child === p.thenStatement) || (v === true && child === p.elseStatement)) return "erişilemeyen kod (sabit koşullu dal)";
    } else if ((ts.isWhileStatement(p) || ts.isForStatement(p)) && child === p.statement) {
      const cond = ts.isWhileStatement(p) ? p.expression : p.condition;
      if (cond !== undefined && constantTruthiness(cond) === false) return "erişilemeyen kod (sabit yanlış döngü koşulu)";
    } else if (ts.isConditionalExpression(p) && child !== p.condition) {
      const v = constantTruthiness(p.condition);
      if ((v === false && child === p.whenTrue) || (v === true && child === p.whenFalse)) return "erişilemeyen kod (sabit koşullu ifade)";
    } else if (ts.isBinaryExpression(p) && child === p.right) {
      const op = p.operatorToken.kind;
      const v = constantTruthiness(p.left);
      if ((op === ts.SyntaxKind.AmpersandAmpersandToken && v === false) || ((op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) && v === true)) {
        return "erişilemeyen kod (kısa devre)";
      }
    } else if ((ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isModuleBlock(p)) && !ts.isFunctionDeclaration(child)) {
      const stmts = p.statements;
      const idx = stmts.indexOf(/** @type {ts.Statement} */ (child));
      if (idx > 0 && stmts.slice(0, idx).some((st) => terminates(st))) return "erişilemeyen kod (return/throw sonrası)";
    } else if (ts.isTryStatement(p) && child === p.tryBlock && p.catchClause !== undefined) {
      if (!p.catchClause.block.statements.some((st) => ts.isThrowStatement(st))) return "yutulan assertion (try içinde, catch yeniden fırlatmıyor)";
    }
    child = p;
    p = p.parent;
  }
  return null;
}

/**
 * Bir test dosyasını tarar.
 * @param {string} text
 * @param {string} file depo köküne göre yol
 * @returns {FileScan}
 */
export function scanSource(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @param {ts.Node} n */
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Aynı dosyadaki adlandırılmış işlevler (geçişli assertion araması için).
  /** @type {Map<string, ts.Node[]>} */
  const fns = new Map();
  /**
   * @param {string} name
   * @param {ts.Node} body
   */
  const addFn = (name, body) => fns.set(name, [...(fns.get(name) ?? []), body]);
  /** @param {ts.Node} n */
  const collectFns = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && n.body !== undefined) addFn(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) addFn(n.name.text, init.body);
    }
    ts.forEachChild(n, collectFns);
  };
  collectFns(sf);

  // Tüm assertion'lar.
  let assertions = 0;
  /** @type {LineFinding[]} */
  const constants = [];
  /** @param {ts.Node} n */
  const collectAsserts = (n) => {
    if (ts.isCallExpression(n)) {
      const c = classifyAssertion(n, sf);
      if (c !== null) {
        if (c.constant) constants.push({ line: lineOf(n), message: c.reason });
        else if (ineffectiveReason(n) === null) assertions++;
      }
    }
    ts.forEachChild(n, collectAsserts);
  };
  collectAsserts(sf);

  /** @type {Map<ts.Node, boolean>} */
  const memo = new Map();
  /**
   * Düğüm (geçişli olarak yerel işlevler dahil) sabit olmayan assertion içeriyor mu.
   * @param {ts.Node} node
   * @param {Set<string>} seen
   * @returns {boolean}
   */
  const hasAssertion = (node, seen) => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    let found = false;
    /** @param {ts.Node} n */
    const visit = (n) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const c = classifyAssertion(n, sf);
        if (c !== null && !c.constant && ineffectiveReason(n) === null) {
          found = true;
          return;
        }
        const callee = unwrap(n.expression);
        if (ts.isIdentifier(callee) && !seen.has(callee.text) && ineffectiveReason(n) === null) {
          const bodies = fns.get(callee.text);
          if (bodies !== undefined) {
            const next = new Set(seen).add(callee.text);
            if (bodies.some((b) => hasAssertion(b, next))) {
              found = true;
              return;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    if (seen.size === 0) memo.set(node, found);
    return found;
  };

  /** @type {AcTest[]} */
  const tests = [];
  /** @type {LineFinding[]} */
  const noAssertion = [];
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {string[]} */
  const stack = [];
  let leafCount = 0;

  /**
   * Test gövdesi: son işlev argümanı ya da yerel işlev adı.
   * @param {ts.CallExpression} call
   * @returns {ts.Node | null}
   */
  const bodyOf = (call) => {
    for (let i = call.arguments.length - 1; i >= 1; i--) {
      const a = unwrap(/** @type {ts.Expression} */ (call.arguments[i]));
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a.body;
      if (ts.isIdentifier(a)) {
        const bodies = fns.get(a.text);
        if (bodies !== undefined && bodies.length > 0) return /** @type {ts.Node} */ (bodies[0]);
      }
    }
    return null;
  };

  // Takma adlar kanonik köke çevrilir (`t` → it, `v.describe` → describe, `d` → test.describe).
  const roots = collectTestRoots(sf);
  /**
   * @param {ts.Expression} expr
   * @returns {{ root: string | null, members: string[] }}
   */
  const resolved = (expr) => {
    const c = chain(expr);
    if (c.root === null) return c;
    const alias = roots.bases.get(c.root);
    if (alias !== undefined) {
      const [r = c.root, ...rest] = alias;
      return { root: r, members: [...rest, ...c.members.filter((m) => m !== "extend")] };
    }
    const [first, ...rest] = c.members;
    if (roots.namespaces.has(c.root) && first !== undefined && (SUITE_ROOTS.has(first) || TEST_ROOTS.has(first))) return { root: first, members: rest };
    return c;
  };

  /** @param {ts.Node} n */
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const { root, members } = resolved(n.expression);
      const first = n.arguments[0];
      const isSuite =
        root !== null &&
        ((SUITE_ROOTS.has(root) && members.every((m) => SUITE_MODS.has(m))) ||
          (TEST_ROOTS.has(root) && members[0] === "describe" && members.slice(1).every((m) => SUITE_MODS.has(m))));
      const isTest = !isSuite && root !== null && TEST_ROOTS.has(root) && members.every((m) => TEST_MODS.has(m));
      const title = titleText(first);
      if (isSuite && (title !== null || (first !== undefined && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))))) {
        const t = title ?? "";
        const before = leafCount;
        stack.push(t);
        ts.forEachChild(n, walk);
        stack.pop();
        const own = tagsOf(t);
        for (const id of own) ids.add(id);
        if (own.length > 0 && leafCount === before) {
          noAssertion.push({ line: lineOf(n), message: `"${t}" altında hiç test yok` });
        }
        return;
      }
      if (isTest && title !== null) {
        leafCount++;
        const full = [...stack, title].join(" ");
        const tags = tagsOf(full);
        if (tags.length > 0) {
          for (const id of tags) ids.add(id);
          tests.push({ ids: tags, title: full, line: lineOf(n) });
          const body = bodyOf(n);
          if (body === null || !hasAssertion(body, new Set())) {
            noAssertion.push({ line: lineOf(n), message: `"${full}" testinde sabit olmayan assertion yok` });
          }
        }
        ts.forEachChild(n, walk);
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  return { file, ids: [...ids].sort(), tests, assertions, constants, noAssertion };
}

/**
 * Depodaki `@AC` test dosyalarını tarar (diskteki çalışma ağacı).
 * @param {string} root
 * @returns {{ scans: FileScan[], errors: Array<{ file: string, message: string }> }}
 */
export function scanRepo(root) {
  /** @type {FileScan[]} */
  const scans = [];
  /** @type {Array<{ file: string, message: string }>} */
  const errors = [];
  for (const rel of listTestFiles(root)) {
    /** @type {string} */
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch (e) {
      errors.push({ file: rel, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!text.includes("@AC-")) continue;
    const s = scanSource(text, rel);
    if (s.ids.length > 0) scans.push(s);
  }
  return { scans, errors };
}

/**
 * @param {Record<string, number>} obj
 * @returns {Record<string, number>}
 */
function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Tarama sonuçlarından gerçek sayılar.
 * @param {FileScan[]} scans
 * @returns {Baseline}
 */
export function actualCounts(scans) {
  /** @type {Record<string, number>} */
  const acTests = {};
  /** @type {Record<string, number>} */
  const acFileAssertions = {};
  for (const s of scans) {
    for (const t of s.tests) for (const id of t.ids) acTests[id] = (acTests[id] ?? 0) + 1;
    acFileAssertions[s.file] = s.assertions;
  }
  return { acTests: sortKeys(acTests), acFileAssertions: sortKeys(acFileAssertions) };
}

/**
 * Bir dosyadaki AC başına yaprak test sayısı.
 * @param {FileScan} s
 * @returns {Map<string, number>}
 */
export function perAc(s) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const t of s.tests) for (const id of t.ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

export class BaselineError extends Error {}

/**
 * @param {unknown} v
 * @param {string} key
 * @param {RegExp | null} keyRe
 * @returns {Record<string, number>}
 */
function countMap(v, key, keyRe) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BaselineError(`"${key}" nesne olmalı`);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, n] of Object.entries(v)) {
    if (keyRe !== null && !keyRe.test(k)) throw new BaselineError(`"${key}" içinde geçersiz anahtar "${k}"`);
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new BaselineError(`"${key}.${k}" negatif olmayan tamsayı olmalı`);
    out[k] = n;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Baseline}
 */
export function parseBaseline(text) {
  /** @type {unknown} */
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new BaselineError(`JSON ayrıştırılamadı: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) throw new BaselineError("kök nesne olmalı");
  const o = /** @type {Record<string, unknown>} */ (j);
  const extra = Object.keys(o).filter((k) => k !== "acTests" && k !== "acFileAssertions");
  if (extra.length > 0) throw new BaselineError(`bilinmeyen anahtar(lar): ${extra.join(", ")}`);
  return { acTests: countMap(o["acTests"], "acTests", /^AC-\d+$/), acFileAssertions: countMap(o["acFileAssertions"], "acFileAssertions", null) };
}

/**
 * Deterministik biçim: sıralı anahtarlar, 2 boşluk girinti, sonda satır sonu.
 * @param {Baseline} b
 * @returns {string}
 */
export function serializeBaseline(b) {
  return JSON.stringify({ acTests: sortKeys(b.acTests), acFileAssertions: sortKeys(b.acFileAssertions) }, null, 2) + "\n";
}

/**
 * Taşınan dosyalar: tabanda olup artık olmayan yol P, tabanda olmayan yeni yol Q; Q'nun assertion
 * sayısı P'nin taban sayısına eşit ve AC kümeleri aynı (P'nin eski içeriğinden). Tek aday şart.
 * @param {Record<string, number>} baseFiles
 * @param {FileScan[]} scans
 * @param {(file: string) => string | null} readOld P'nin eski içeriği (HEAD / merge-base)
 * @returns {Move[]}
 */
export function detectMoves(baseFiles, scans, readOld) {
  const current = new Map(scans.map((s) => [s.file, s]));
  const fresh = scans.filter((s) => !(s.file in baseFiles));
  /** @type {Move[]} */
  const moves = [];
  /** @type {Set<string>} */
  const taken = new Set();
  for (const [from, count] of Object.entries(baseFiles)) {
    if (current.has(from)) continue;
    const old = readOld(from);
    if (old === null) continue;
    const oldIds = scanSource(old, from).ids.join(",");
    const cands = fresh.filter((s) => !taken.has(s.file) && s.assertions === count && s.ids.join(",") === oldIds);
    const only = cands[0];
    if (cands.length === 1 && only !== undefined) {
      taken.add(only.file);
      moves.push({ from, to: only.file, count });
    }
  }
  return moves;
}

/**
 * Tabanı yalnızca yukarı günceller; düşüş yazmaz (azalan/kaybolan anahtar eski değerinde kalır).
 * Taşınan dosyanın anahtarı yeni yola geçer.
 * @param {Baseline | null} old
 * @param {Baseline} actual
 * @param {Move[]} moves
 * @returns {Baseline}
 */
export function raiseBaseline(old, actual, moves) {
  /** @type {Record<string, number>} */
  const acTests = { ...(old?.acTests ?? {}) };
  for (const [k, n] of Object.entries(actual.acTests)) acTests[k] = Math.max(acTests[k] ?? 0, n);
  /** @type {Record<string, number>} */
  const files = { ...(old?.acFileAssertions ?? {}) };
  for (const m of moves) {
    const n = files[m.from];
    if (n === undefined) continue;
    delete files[m.from];
    files[m.to] = Math.max(files[m.to] ?? 0, n);
  }
  for (const [k, n] of Object.entries(actual.acFileAssertions)) files[k] = Math.max(files[k] ?? 0, n);
  return { acTests: sortKeys(acTests), acFileAssertions: sortKeys(files) };
}

/**
 * @typedef {{ update: boolean, base: string }} RatchetArgs
 */

/**
 * `[--update] [--base <ref>]` (`--base` varsayılanı `origin/main`: "main'deki taban").
 * @param {string} guard
 * @param {string[]} argv
 * @returns {RatchetArgs}
 */
export function parseRatchetArgs(guard, argv) {
  /** @type {RatchetArgs} */
  const args = { update: false, base: DEFAULT_TARGET };
  let baseSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") continue;
    if (a === "--update") {
      args.update = true;
      continue;
    }
    const m = /^--base(?:=(.*))?$/.exec(a);
    if (m === null) throw new UsageError(`check:${guard}: bilinmeyen argüman "${a}"`);
    const v = m[1] ?? argv[++i];
    if (v === undefined || v === "") throw new UsageError("--base bir değer ister");
    if (baseSet) throw new UsageError("--base birden fazla verildi");
    baseSet = true;
    args.base = v;
  }
  return args;
}

/**
 * HEAD ile `base` ref'inin ortak atası; bulunamazsa `null`.
 * @param {string} root
 * @param {string} base
 * @returns {string | null}
 */
export function safeMergeBase(root, base) {
  try {
    return mergeBase(root, base);
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/**
 * Verilen commit'teki `@AC` test dosyalarının taraması (yalnızca `@AC-` içerenler).
 * @param {string} root
 * @param {string} ref
 * @returns {FileScan[]}
 */
export function scanAtRef(root, ref) {
  const out = git(root, ["ls-tree", "-r", "-z", "--name-only", ref]);
  /** @type {FileScan[]} */
  const scans = [];
  for (const f of out.split("\0")) {
    if (f === "") continue;
    if (!isTestFile(f) || f.split("/").some((d) => EXCLUDED_DIRS.includes(d))) continue;
    const text = fileAtRef(root, ref, f);
    if (text === null || !text.includes("@AC-")) continue;
    const s = scanSource(text, f);
    if (s.ids.length > 0) scans.push(s);
  }
  return scans;
}

/**
 * @typedef {{
 *   args: RatchetArgs,
 *   base: string | null,
 *   baseline: Baseline,
 *   baselineText: string | null,
 *   scans: FileScan[],
 *   moves: Move[],
 * }} Prepared
 */

/**
 * Ortak hazırlık: argümanlar, tarama, taban okuma; `--update` ise tabanı yukarı güncelleyip yazar.
 * Taban yok/bozuksa FAIL basar ve `null` döner.
 * @param {string} guard
 * @param {{ root: string, argv: string[], out: import("./output.mjs").Reporter }} ctx
 * @returns {Prepared | null}
 */
export function prepare(guard, ctx) {
  const { root, out } = ctx;
  const args = parseRatchetArgs(guard, ctx.argv);
  const base = safeMergeBase(root, args.base);
  if (base === null) out.warn("BASE_UNAVAILABLE", "-", `${args.base} ile ortak ata bulunamadı; dosya eşleştirmesi ve BASELINE_LOWERED bildirimi yapılamadı`);
  out.detail("base", base);

  const { scans, errors } = scanRepo(root);
  for (const e of errors) out.fail("READ_ERROR", e.file, e.message);
  out.detail("acFiles", scans.map((s) => s.file));

  const abs = path.join(root, AC_BASELINE);
  /** @type {string | null} */
  let baselineText = null;
  try {
    baselineText = readFileSync(abs, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  /** @type {Baseline | null} */
  let baseline = null;
  if (baselineText !== null) {
    try {
      baseline = parseBaseline(baselineText);
    } catch (e) {
      if (!(e instanceof BaselineError)) throw e;
      out.fail("BASELINE_INVALID", AC_BASELINE, e.message);
      return null;
    }
  }

  /** @param {string} f */
  const readOld = (f) => fileAtRef(root, "HEAD", f) ?? (base === null ? null : fileAtRef(root, base, f));
  const moves = detectMoves(baseline?.acFileAssertions ?? {}, scans, readOld);

  if (args.update) {
    const next = raiseBaseline(baseline, actualCounts(scans), moves);
    const text = serializeBaseline(next);
    if (text !== baselineText) {
      writeFileSync(abs, text);
      out.detail("updated", true);
    }
    for (const m of moves) out.warn("BASELINE_MOVED", m.to, `taban yolu güncellendi: ${m.from} → ${m.to} (${m.count} assertion)`);
    return { args, base, baseline: next, baselineText: text, scans, moves: [] };
  }
  if (baseline === null) {
    out.fail("BASELINE_MISSING", AC_BASELINE, `taban yok; ${UPDATE_HINT}`);
    return null;
  }
  return { args, base, baseline, baselineText, scans, moves };
}
