import { describe, expect, it } from "vitest";
import { checkMap, checkStack, composeImage, isRange, readSource, summaryLine } from "./check-docs.mjs";

/**
 * Bellek içi dosya sistemi.
 * @param {Record<string, string>} files
 * @returns {(rel: string) => string | null}
 */
function fsOf(files) {
  return (rel) => (Object.hasOwn(files, rel) ? (files[rel] ?? null) : null);
}

const PKG = JSON.stringify({
  packageManager: "pnpm@10.28.0",
  engines: { node: ">=24 <25" },
  devDependencies: { typescript: "6.0.3", "@types/node": "24.19.1", vitest: "^5.0.3" },
});

const COMPOSE = [
  "name: x",
  "",
  "services:",
  "  postgres:",
  "    # yorum",
  "    image: postgres:17.11-trixie",
  "    environment:",
  "      A: b",
  "",
  "  pgbouncer:",
  '    image: "edoburu/pgbouncer:v1.26.0-p0"',
  "",
  "volumes:",
  "  image: not-a-service",
].join("\n");

const FILES = fsOf({ "package.json": PKG, "docker-compose.yml": COMPOSE });

/** @param {string[]} rows */
function stackMd(rows) {
  return [
    "# STACK",
    "## Kilitli sürümler",
    "açıklama",
    "",
    "| bileşen | paket/imaj | sürüm | kaynak | ADR |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Başka",
    "| a | b |",
    "|---|---|",
    "| x | ^1.0.0 |",
  ].join("\n");
}

describe("checkStack", () => {
  it("birebir eşleşen satırlar OK; kilitsiz (—) satırlar sayılmaz", () => {
    const r = checkStack(
      stackMd([
        "| Node | node | >=24 <25 | package.json#engines.node | ADR-001 |",
        "| pnpm | pnpm | 10.28.0 | package.json#packageManager | |",
        "| TS | typescript | 6.0.3 | package.json#devDependencies.typescript | |",
        "| tipler | @types/node | 24.19.1 | package.json#devDependencies.@types/node | |",
        "| PG | postgres | 17.11-trixie | docker-compose.yml#postgres | |",
        "| PgBouncer | edoburu/pgbouncer | v1.26.0-p0 | docker-compose.yml#pgbouncer | |",
        "| Drizzle | drizzle-orm | — T-005b (Q-03) | | |",
      ]),
      FILES,
    );
    expect(r).toEqual({ ok: true, count: 6, failures: [] });
  });

  it("yama numarası uyuşmazlığında satırı ve iki değeri gösterir", () => {
    const r = checkStack(stackMd(["| TS | typescript | 6.0.4 | package.json#devDependencies.typescript | |"]), FILES);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["stack: TS (package.json#devDependencies.typescript): STACK=6.0.4 kaynak=6.0.3"]);
  });

  it("compose imaj etiketi uyuşmazlığı ve imaj adı uyuşmazlığı FAIL", () => {
    const r = checkStack(
      stackMd([
        "| PG | postgres | 17.10-trixie | docker-compose.yml#postgres | |",
        "| PgB | bitnami/pgbouncer | v1.26.0-p0 | docker-compose.yml#pgbouncer | |",
      ]),
      FILES,
    );
    expect(r.failures).toEqual([
      "stack: PG (docker-compose.yml#postgres): STACK=17.10-trixie kaynak=17.11-trixie",
      "stack: PgB (docker-compose.yml#pgbouncer): imaj adı uyuşmuyor STACK=bitnami/pgbouncer:v1.26.0-p0 kaynak=edoburu/pgbouncer:v1.26.0-p0",
    ]);
  });

  it("STACK'te ya da kaynakta aralık sürümü FAIL", () => {
    const r = checkStack(
      stackMd([
        "| TS | typescript | ^6.0.3 | package.json#devDependencies.typescript | |",
        "| Vitest | vitest | 5.0.3 | package.json#devDependencies.vitest | |",
      ]),
      FILES,
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      'stack: TS (package.json#devDependencies.typescript): STACK sürümü aralık "^6.0.3" (tam sürüm olmalı)',
      'stack: Vitest (package.json#devDependencies.vitest): kaynak sürümü aralık "^5.0.3" (tam sürüm olmalı)',
    ]);
  });

  it("eksik kaynak dosya/alan/servis ve tablo yokluğu FAIL", () => {
    const r = checkStack(
      stackMd([
        "| A | a | 1.0.0 | apps/x/package.json#dependencies.a | |",
        "| B | b | 1.0.0 | package.json#dependencies.b | |",
        "| C | redis | 7.0.0 | docker-compose.yml#redis | |",
        "| D | d | 1.0.0 | | |",
      ]),
      FILES,
    );
    expect(r.failures).toEqual([
      "stack: A (apps/x/package.json#dependencies.a): kaynak dosya yok: apps/x/package.json",
      'stack: B (package.json#dependencies.b): package.json: "dependencies.b" alanı yok',
      'stack: C (docker-compose.yml#redis): docker-compose.yml: "redis" servisinin imajı bulunamadı',
      'stack: D (kaynak yok): kaynak biçimi geçersiz: ""',
    ]);
    expect(checkStack("# STACK\n| a |\n|---|\n", FILES).ok).toBe(false);
  });
});

describe("checkMap", () => {
  const exists = (/** @type {string} */ p) => ["apps/web", "scripts", "docker-compose.yml"].includes(p);
  /** @param {string[]} rows */
  const mapMd = (rows) => ["# MAP", "", "| yol | durum | açıklama |", "|---|---|---|", ...rows].join("\n");

  it("var olan 'var' yollar ve olmayan 'planlı' yollar OK", () => {
    const r = checkMap(
      mapMd([
        "| apps/web/ | var | web |",
        "| `scripts/` | var | betikler |",
        "| docker-compose.yml | var | compose |",
        "| packages/db/ | planlı: T-005b | db |",
      ]),
      exists,
    );
    expect(r).toEqual({ ok: true, count: 4, failures: [] });
  });

  it("eksik 'var' yolu, mevcut 'planlı' yolu ve tanınmayan durum FAIL", () => {
    const r = checkMap(
      mapMd([
        "| infra/ | var | yok |",
        "| scripts/ | planlı: T-003 | var olan |",
        "| apps/web/ | belki | ? |",
        "| ../dış | var | kaçış |",
      ]),
      exists,
    );
    expect(r.ok).toBe(false);
    expect(r.count).toBe(4);
    expect(r.failures).toEqual([
      'map: infra/ "var" işaretli ama mevcut değil',
      'map: scripts/ "planlı: T-003" işaretli ama mevcut',
      'map: apps/web/ durumu tanınmıyor "belki" (var | planlı: <kart>)',
      'map: geçersiz yol "../dış"',
    ]);
  });

  it("tablo yoksa FAIL", () => {
    expect(checkMap("# MAP\n```\napps/web x\n```\n", exists).ok).toBe(false);
  });
});

describe("yardımcılar", () => {
  it("composeImage servis bloğu dışındaki image anahtarını almaz", () => {
    expect(composeImage(COMPOSE, "postgres")).toBe("postgres:17.11-trixie");
    expect(composeImage(COMPOSE, "pgbouncer")).toBe("edoburu/pgbouncer:v1.26.0-p0");
    expect(composeImage(COMPOSE, "image")).toBeNull();
  });

  it("isRange ^, ~ ve jokeri yakalar, tam sürümü ve engines kısıtını aralık saymaz", () => {
    expect(isRange("^1.2.3")).toBe(true);
    expect(isRange("~1.2.3")).toBe(true);
    expect(isRange("1.*")).toBe(true);
    expect(isRange("1.2.3")).toBe(false);
    expect(isRange(">=24 <25")).toBe(false);
  });

  it("readSource bozuk JSON'u hata olarak döndürür", () => {
    expect(readSource("package.json#a", fsOf({ "package.json": "{" }))).toEqual({ error: "package.json: JSON çözümlenemedi" });
  });

  it("summaryLine kart biçimini üretir", () => {
    expect(summaryLine({ ok: true, count: 17, failures: [] }, { ok: false, count: 3, failures: ["x"] })).toBe(
      "check-docs: stack OK (17 satır) · map FAIL (3 yol)",
    );
  });
});
