// T-123 birim testleri: ortam koruması tablosu, DEMO_TENANT_ID türetimi (RFC 9562 UUIDv5 vektörü), iş yükü şemasında
// tenant kimliği yokluğu, DEMO_ROLES bütünlüğü, günlük zamanlama. Veritabanı davranışı `tests/integration/demo/`.
import { describe, expect, it } from "vitest";
import { DEMO_TENANT_NAMESPACE, DEMO_TENANT_SLUG, demoModeEnabled, uuidV5 } from "@wms/db";
import { JOB_PAYLOAD_SCHEMAS, QueueError, parseJob } from "@wms/shared/queue";
import { ROLE_KEYS } from "../identity/permissions.ts";
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_ITEMS,
  DEMO_LOCATIONS,
  DEMO_ROLES,
  DEMO_STOCK_TARGETS,
  DEMO_TENANT_ID,
  demoDiffDigest,
  demoStockKey,
  diffDemoStock,
  loadDemoSeedConfig,
  nextDailyRunUtc,
} from "./seed.ts";

const PASSWORD = "synthetic-demo-pass-123";

describe("loadDemoSeedConfig (fail-closed ortam koruması)", () => {
  const cases: ReadonlyArray<{ name: string; env: Record<string, string | undefined>; enabled: boolean; reason?: string }> = [
    { name: "production", env: { WMS_ENV: "production", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "ENV_NOT_ALLOWED" },
    { name: "WMS_ENV tanımsız", env: { DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "ENV_NOT_ALLOWED" },
    { name: "WMS_ENV boş", env: { WMS_ENV: "", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "ENV_NOT_ALLOWED" },
    { name: "ci (izinli değil)", env: { WMS_ENV: "ci", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "ENV_NOT_ALLOWED" },
    { name: "büyük harf STAGING", env: { WMS_ENV: "STAGING", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "ENV_NOT_ALLOWED" },
    { name: "DEMO_MODE=0", env: { WMS_ENV: "staging", DEMO_MODE: "0", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "DEMO_MODE_OFF" },
    { name: "DEMO_MODE tanımsız", env: { WMS_ENV: "local", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "DEMO_MODE_OFF" },
    { name: "DEMO_MODE=true (yalnızca '1')", env: { WMS_ENV: "local", DEMO_MODE: "true", DEMO_PASSWORD: PASSWORD }, enabled: false, reason: "DEMO_MODE_OFF" },
    { name: "DEMO_PASSWORD yok", env: { WMS_ENV: "staging", DEMO_MODE: "1" }, enabled: false, reason: "PASSWORD_MISSING" },
    { name: "DEMO_PASSWORD boş", env: { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD: "" }, enabled: false, reason: "PASSWORD_MISSING" },
    { name: "DEMO_PASSWORD kısa", env: { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD: "short" }, enabled: false, reason: "PASSWORD_INVALID" },
    { name: "DEMO_PASSWORD çok uzun", env: { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD: "x".repeat(129) }, enabled: false, reason: "PASSWORD_INVALID" },
    { name: "local", env: { WMS_ENV: "local", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: true },
    { name: "staging", env: { WMS_ENV: "staging", DEMO_MODE: "1", DEMO_PASSWORD: PASSWORD }, enabled: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = loadDemoSeedConfig(c.env);
      expect(r.enabled).toBe(c.enabled);
      if (!r.enabled) {
        expect(r.reason).toBe(c.reason);
        // Kapalı sonuç parolayı asla yansıtmaz.
        expect(JSON.stringify(r)).not.toContain(PASSWORD);
      } else {
        expect(r.password).toBe(PASSWORD);
      }
    });
  }
  it("demoModeEnabled (db katmanı) aynı WMS_ENV/DEMO_MODE kuralı", () => {
    expect(demoModeEnabled({ WMS_ENV: "production", DEMO_MODE: "1" })).toBe(false);
    expect(demoModeEnabled({ DEMO_MODE: "1" })).toBe(false);
    expect(demoModeEnabled({ WMS_ENV: "staging", DEMO_MODE: "0" })).toBe(false);
    expect(demoModeEnabled({ WMS_ENV: "staging" })).toBe(false);
    expect(demoModeEnabled({ WMS_ENV: "staging", DEMO_MODE: "1" })).toBe(true);
    expect(demoModeEnabled({ WMS_ENV: "local", DEMO_MODE: "1" })).toBe(true);
  });
});

describe("DEMO_TENANT_ID (UUIDv5)", () => {
  it("türetim RFC 9562 UUIDv5 test vektörüyle doğrulanır (DNS ad alanı, www.example.com)", () => {
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
  it("slug sabitinden türer ve sabit kalır", () => {
    expect(DEMO_TENANT_SLUG).toBe("demo");
    expect(DEMO_TENANT_ID).toBe(uuidV5(DEMO_TENANT_SLUG, DEMO_TENANT_NAMESPACE));
    expect(DEMO_TENANT_ID).toBe("8c777d8e-19f6-59d5-a728-ddaecd4760bb");
    expect(DEMO_TENANT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("geçersiz ad alanı reddedilir", () => {
    expect(() => uuidV5("demo", "not-a-uuid")).toThrow();
  });
});

describe("demo.reseed iş yükü", () => {
  it("şemada tenant kimliği alanı yok: yalnızca boş nesne kabul edilir", () => {
    const schema = JOB_PAYLOAD_SCHEMAS["demo.reseed"];
    expect(Object.keys(schema.shape)).toEqual([]);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ tenantId: DEMO_TENANT_ID }).success).toBe(false);
    expect(schema.safeParse({ demoTenantId: DEMO_TENANT_ID }).success).toBe(false);
  });
  it("üst düzey tenantId reddedilir (parseJob)", () => {
    expect(() => parseJob({ type: "demo.reseed", payload: {}, tenantId: DEMO_TENANT_ID })).toThrow(QueueError);
    expect(parseJob({ type: "demo.reseed", payload: {}, singletonKey: "demo.reseed" }).type).toBe("demo.reseed");
  });
});

describe("DEMO_ROLES", () => {
  it("her rol için tek, benzersiz, example.invalid adresi", () => {
    expect(Object.keys(DEMO_ROLES).sort()).toEqual([...ROLE_KEYS].sort());
    const emails = Object.values(DEMO_ROLES);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) {
      expect(e).toBe(e.toLowerCase());
      expect(e.endsWith(`@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
    }
    expect(DEMO_EMAIL_DOMAIN).toBe("example.invalid");
    expect(DEMO_ROLES.TENANT_ADMIN).toBe("demo.yonetici@example.invalid");
    expect(DEMO_ROLES.WAREHOUSE_MANAGER).toBe("demo.sef@example.invalid");
    expect(DEMO_ROLES.PICKER).toBe("demo.toplayici@example.invalid");
    expect(DEMO_ROLES.COUNTER).toBe("demo.sayim@example.invalid");
    expect(DEMO_ROLES.READ_ONLY).toBe("demo.izleyici@example.invalid");
  });
  it("dondurulmuştur", () => {
    expect(Object.isFrozen(DEMO_ROLES)).toBe(true);
  });
});

describe("nextDailyRunUtc", () => {
  it("03:00 UTC öncesi aynı gün, sonrası/eşit ertesi gün", () => {
    expect(nextDailyRunUtc(new Date("2026-10-06T02:59:59.999Z")).toISOString()).toBe("2026-10-06T03:00:00.000Z");
    expect(nextDailyRunUtc(new Date("2026-10-06T03:00:00.000Z")).toISOString()).toBe("2026-10-07T03:00:00.000Z");
    expect(nextDailyRunUtc(new Date("2026-10-06T23:30:00.000Z")).toISOString()).toBe("2026-10-07T03:00:00.000Z");
    expect(nextDailyRunUtc(new Date("2026-12-31T12:00:00.000Z")).toISOString()).toBe("2027-01-01T03:00:00.000Z");
  });
});

describe("demo içeriği tanımı (T-223)", () => {
  it("hedefler tanımlı ürün ve lokasyonlara bakar; yalnızca yaprak STORAGE lokasyonları", () => {
    const items = new Set(DEMO_ITEMS.map((i) => i.code));
    const locs = new Map(DEMO_LOCATIONS.map((l) => [l.code, l]));
    expect(items.size).toBe(2);
    for (const t of DEMO_STOCK_TARGETS) {
      expect(items.has(t.item)).toBe(true);
      expect(locs.get(t.location)?.kind).toBe("STORAGE");
      expect(/^[1-9]\d*$/.test(t.quantity)).toBe(true);
    }
    for (const l of DEMO_LOCATIONS) expect(l.parent === null || locs.has(l.parent)).toBe(true);
    // ebeveyn her zaman çocuktan ÖNCE tanımlıdır (oluşturma sırası)
    DEMO_LOCATIONS.forEach((l, i) => expect(l.parent === null || DEMO_LOCATIONS.findIndex((x) => x.code === l.parent) < i).toBe(true));
  });
});

describe("demo stok farkı ve koşu anahtarı (MINOR-11)", () => {
  const cur = (o: Record<string, bigint>) => new Map(Object.entries(o));
  it("boş bakiyeden hedefe: tümü STOCK_IN; hedefte: fark yok", () => {
    const d = diffDemoStock(DEMO_STOCK_TARGETS, cur({}));
    expect(d).toHaveLength(DEMO_STOCK_TARGETS.length);
    expect(d.every((x) => x.delta > 0n)).toBe(true);
    const atTarget = cur(Object.fromEntries(DEMO_STOCK_TARGETS.map((t) => [`${t.item}|${t.location}`, BigInt(t.quantity) * 1_000_000n])));
    expect(diffDemoStock(DEMO_STOCK_TARGETS, atTarget)).toEqual([]);
  });
  it("hedefin altı/üstü işaretli fark üretir", () => {
    const first = DEMO_STOCK_TARGETS[0]!;
    const below = diffDemoStock(DEMO_STOCK_TARGETS, cur({ [`${first.item}|${first.location}`]: 100n * 1_000_000n }));
    expect(below.find((x) => x.item === first.item && x.location === first.location)?.delta).toBe((BigInt(first.quantity) - 100n) * 1_000_000n);
    const above = diffDemoStock(DEMO_STOCK_TARGETS, cur({ [`${first.item}|${first.location}`]: (BigInt(first.quantity) + 5n) * 1_000_000n }));
    expect(above.find((x) => x.item === first.item && x.location === first.location)?.delta).toBe(-5_000_000n);
  });
  it("özet belirlenimli ve içeriğe duyarlı; anahtar koşu/fark/tür/aşamaya göre ayrışır, aynı girdi aynı UUID", () => {
    const a = diffDemoStock(DEMO_STOCK_TARGETS, cur({}));
    const b = diffDemoStock(DEMO_STOCK_TARGETS, cur({ "KRT-3020|R-01": 1_000_000n }));
    expect(demoDiffDigest(a)).toBe(demoDiffDigest(diffDemoStock(DEMO_STOCK_TARGETS, cur({}))));
    expect(demoDiffDigest(a)).not.toBe(demoDiffDigest(b));
    const run = "11111111-1111-4111-8111-111111111111";
    const k = demoStockKey(run, demoDiffDigest(a), "STOCK_IN", "create");
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(demoStockKey(run, demoDiffDigest(a), "STOCK_IN", "create")).toBe(k);
    const others = [
      demoStockKey("22222222-2222-4222-8222-222222222222", demoDiffDigest(a), "STOCK_IN", "create"),
      demoStockKey(run, demoDiffDigest(b), "STOCK_IN", "create"),
      demoStockKey(run, demoDiffDigest(a), "STOCK_OUT", "create"),
      demoStockKey(run, demoDiffDigest(a), "STOCK_IN", "approve"),
      demoStockKey(run, demoDiffDigest(a), "STOCK_IN", "post"),
    ];
    expect(new Set([k, ...others]).size).toBe(6);
  });
});
