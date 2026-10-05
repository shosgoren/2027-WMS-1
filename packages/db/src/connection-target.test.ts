// Unit: bağlantı hedefi yardımcıları ve `@wms/db` index'inin modül grafiği (T-115 Supervisor eki 3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTarget, sameConnectionTarget } from "./connection-target.ts";

describe("sameConnectionTarget", () => {
  it("compares host, port, user and database, not the raw string", () => {
    const base = "postgresql://u:p@db.example:5432/w";
    expect(sameConnectionTarget(base, "postgres://u:other@DB.example/w?sslmode=require")).toBe(true);
    expect(sameConnectionTarget(base, "postgresql://u:p@db.example:5433/w")).toBe(false);
    expect(sameConnectionTarget(base, "postgresql://v:p@db.example:5432/w")).toBe(false);
    expect(sameConnectionTarget(base, "postgresql://u:p@db.example:5432/x")).toBe(false);
  });

  it("falls back to raw equality for unparsable URLs", () => {
    expect(sameConnectionTarget("not a url", "not a url")).toBe(true);
    expect(sameConnectionTarget("not a url", "other")).toBe(false);
  });

  it("parseTarget decodes user/db and defaults the port", () => {
    expect(parseTarget("postgresql://us%40er:p@Host/d%62")).toEqual({ host: "host", port: "5432", user: "us@er", db: "db" });
    expect(parseTarget("%%%")).toBeUndefined();
  });
});

/** Göreli `.ts` içe/dışa aktarmaları (statik; `from "./x.ts"` ve `import "./x.ts"`). */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    if (m[1] !== undefined) found.push(path.resolve(path.dirname(file), m[1]));
  }
  return found;
}

describe("@wms/db index modül grafiği", () => {
  it("migrate.ts index'ten (doğrudan veya dolaylı) erişilemez: CLI giriş koruması bundle'a girmez", () => {
    const entry = path.resolve(import.meta.dirname, "index.ts");
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      for (const dep of relativeImports(file)) if (dep.endsWith(".ts")) stack.push(dep);
    }
    expect(seen.size).toBeGreaterThan(3);
    const reached = [...seen].map((f) => path.basename(f));
    expect(reached).not.toContain("migrate.ts");
    expect(reached).toContain("connection-target.ts");
  });
});
