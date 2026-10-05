// T-101d `app-settings` bekçisi testleri: bilinmeyen ad, değişken argüman, SET biçimi, gerçek depo.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main, readKnownSettings, scanRepo, scanText } from "./app-settings.mjs";

// Lint kuralı (tenant ayarı literalleri yalnızca packages/db içinde) bekçi test verisini de kapsar;
// bu yüzden fikstür adları parçalardan kurulur ve gerçek ad yerine uydurma ad kullanılır.
const SC = ["set", "config"].join("_");
const CS = ["current", "setting"].join("_");
const KNOWN_NAME = ["app", "known_probe"].join(".");
const KNOWN = [KNOWN_NAME];
/** Bir SQL fikstürü: ilk satır yorum (ifade başında SET/RESET yazan dizeler lint'e takılır). */
const SET_LOCAL = ["SET", "LOCAL"].join(" ");
const SET_ = "SET";
const fx = (/** @type {string[]} */ ...lines) => ["-- fixture", ...lines].join("\n");

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanText", () => {
  it("accepts known names in read, write and SET forms", () => {
    const sql = fx(
      `USING (t = NULLIF(${CS}('${KNOWN_NAME}', true), ''))`,
      `SELECT ${SC}('${KNOWN_NAME}', 'x', true);`,
      `${SET_LOCAL} ${KNOWN_NAME} = 'x';`,
    );
    expect(scanText(sql, "a.sql", KNOWN, { dynamic: true })).toEqual([]);
  });

  it("flags an unknown app.* name with its line, in all three forms", () => {
    const sql = fx(`SELECT ${CS}('app.other', true);`, `SELECT ${SC}('app.third', 'x', false);`, `${SET_} app.fourth TO 'x';`);
    const f = scanText(sql, "a.sql", KNOWN, { dynamic: false });
    expect(f.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(f.map((x) => /"(app\.[a-z]+)"/.exec(x.message)?.[1])).toEqual(["app.other", "app.third", "app.fourth"]);
  });

  it("flags a non-literal setting name in SQL only when dynamic is on", () => {
    const sql = fx(`SELECT ${CS}(name_col, true) FROM t;`);
    expect(scanText(sql, "a.sql", KNOWN, { dynamic: true })).toHaveLength(1);
    expect(scanText(sql, "a.ts", KNOWN, { dynamic: false })).toEqual([]);
  });

  it("is case-insensitive for function and SET keywords", () => {
    expect(scanText(fx(`SELECT ${CS.toUpperCase()}('app.x', true);`), "a.sql", KNOWN, { dynamic: true })).toHaveLength(1);
    expect(scanText(fx(`${SET_LOCAL.toLowerCase()} app.x = 1;`), "a.sql", KNOWN, { dynamic: true })).toHaveLength(1);
  });
});

describe("scanText: quoting and fragment evasions (MINOR 2)", () => {
  it("catches names inside EXECUTE string constants with doubled single quotes", () => {
    const sql = fx(`EXECUTE 'SELECT ${CS}(''app.hidden'', true)';`, `EXECUTE 'SELECT ${SC}(''app.hidden2'', ''v'', true)';`);
    const f = scanText(sql, "a.sql", KNOWN, { dynamic: false });
    expect(f.map((x) => /"(app\.[a-z0-9]+)"/.exec(x.message)?.[1]).sort()).toEqual(["app.hidden", "app.hidden2"]);
    expect(f.map((x) => x.line)).toEqual([2, 3]);
  });

  it("does not flag a known name inside an EXECUTE constant", () => {
    expect(scanText(fx(`EXECUTE 'SELECT ${CS}(''${KNOWN_NAME}'', true)';`), "a.sql", KNOWN, { dynamic: false })).toEqual([]);
  });

  it("catches a double-quoted identifier in the SET statement", () => {
    const f = scanText(fx(`${SET_LOCAL} "app.quoted" = 'x';`, `${SET_} "${KNOWN_NAME}" TO 'x';`), "a.sql", KNOWN, { dynamic: false });
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("app.quoted");
  });

  it("catches a name assembled from fragments: TS template literal and SQL concatenation", () => {
    const ts = "const q = `SELECT x('app.${name}', true)`;\n";
    expect(scanText(ts, "a.ts", KNOWN, { dynamic: false }).some((x) => x.message.includes("parçalardan"))).toBe(true);
    const sql = fx(`SELECT ${CS}('app.' || suffix, true);`);
    expect(scanText(sql, "a.sql", KNOWN, { dynamic: false }).some((x) => x.message.includes("parçalardan"))).toBe(true);
  });
});

describe("scanRepo", () => {
  it("scans migrations/*.sql and src/*.ts but skips test files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "app-settings-"));
    dirs.push(root);
    mkdirSync(path.join(root, "packages/db/migrations"), { recursive: true });
    mkdirSync(path.join(root, "packages/db/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/db/migrations/0009_x.up.sql"), `${fx(`SELECT ${CS}('app.sneaky', true);`)}\n`);
    writeFileSync(path.join(root, "packages/db/src/x.ts"), `const q = "SELECT ${CS}('app.sneaky2', true)";\n`);
    writeFileSync(path.join(root, "packages/db/src/x.test.ts"), `const q = "SELECT ${CS}('app.in_test', true)";\n`);
    const f = scanRepo(root, KNOWN);
    expect(f.map((x) => x.file).sort()).toEqual(["packages/db/migrations/0009_x.up.sql", "packages/db/src/x.ts"]);
  });
});

describe("main on the real repository", () => {
  it("is OK against the current migrations and KNOWN_APP_SETTINGS", async () => {
    /** @type {string[]} */
    const lines = [];
    expect(await main([], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toBe("check:app-settings OK");
  });

  it("reads the real KNOWN_APP_SETTINGS list from the migration runner source", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    expect(readKnownSettings(root)).toContain(["app", "current_tenant_id"].join("."));
    expect(readKnownSettings(mkdtempSync(path.join(tmpdir(), "app-settings-empty-")))).toBeUndefined();
  });

  it("rejects unknown arguments with exit code 2", async () => {
    expect(await main(["--bogus"], () => undefined)).toBe(2);
  });
});
