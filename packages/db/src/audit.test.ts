// Unit: audit maskeleme, boyut sınırı, eylem listesi ve SQL biçimi (T-107). Ağ erişimi YOK: sorgu gönderilmediği
// ya da sahte tx ile yakalandığı doğrulanır. Gerçek RLS/tetikleyici/geri alma davranışı: tests/integration/audit.int.test.ts.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_ACTIONS,
  AuditError,
  CHANGE_SUMMARY_MAX_BYTES,
  REDACTED,
  appendAudit,
  maskChangeSummary,
  recordSecurityEvent,
  type AuditAction,
} from "./audit.ts";
import { DB_CLIENT_SETTINGS, createDbClient, rawDb, type DbClient, type TenantTx } from "./client.ts";

const USER = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const clients: DbClient[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function fakeTx() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: vi.fn(async (q: SQL) => {
      const built = new PgDialect().sqlToQuery(q);
      queries.push({ sql: built.sql, params: built.params });
      return [{ id: "11111111-2222-4333-8444-555555555555", created_xid: "42" }];
    }),
  } as unknown as TenantTx;
  return { tx, queries };
}

describe("eylem listesi", () => {
  it("kartta sayılan 12 eylemi içerir", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        "member.invited", "member.removed", "member.role_changed", "member.left", "ownership.transferred",
        "invitation.revoked", "invitation.accepted", "tenant.created", "tenant.settings_changed",
        "onboarding.step_completed", "password_reset_link.issued", "audit.exported",
      ].sort(),
    );
  });

  it("kayıtsız eylem sorgusuz VALIDATION_FAILED", async () => {
    const { tx, queries } = fakeTx();
    const err = await appendAudit(tx, { action: "member.exploded" as AuditAction }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).code).toBe("VALIDATION_FAILED");
    expect(queries).toHaveLength(0);
  });
});

describe("maskeleme", () => {
  it.each([
    "password", "newPassword", "TOKEN", "resetToken", "client_secret", "totpSecret", "backupCodes", "passwordHash", "otp",
    "apiKey", "api_key", "X-API-Key", "apikey", "cookie", "Set-Cookie", "Authorization", "sessionId", "sid", "credentials",
    "bearer", "jwt", "passphrase", "pwd", "pass", "signature", "privateKey", "OTPCode", "otp_code", "verificationCode",
    "resetCode", "code", "access-key", "accessToken", "hash",
  ])(
    "anahtar %s maskelenir",
    (k) => {
      expect(maskChangeSummary({ [k]: "hassas", ok: "gorunur" }).value).toEqual({ [k]: REDACTED, ok: "gorunur" });
    },
  );

  it.each(["barcode", "postal_code", "postalCode", "sku_code", "skuCode", "monkey", "hashtag", "key", "country_code", "passport", "keyword", "entityKey", "description", "email"])(
    "yanlış pozitif: anahtar %s maskelenmez",
    (k) => {
      expect(maskChangeSummary({ [k]: "gorunur-deger" }).value).toEqual({ [k]: "gorunur-deger" });
    },
  );

  it("değer taraması: Bearer, Basic (base64 kullanıcı:parola), JWT, URL sorgu parametresi", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl";
    const basic = `Basic ${Buffer.from("user:pass-sentinel").toString("base64")}`;
    const { value, json } = maskChangeSummary({
      a: "Bearer abcdef0123456789",
      b: basic,
      c: jwt,
      d: "https://x.example.test/cb?token=zzz-sentinel&x=1",
      e: "https://x.example.test/cb?x=1&password=zzz-sentinel",
      f: "https://x.example.test/cb?api_key=zzz-sentinel",
      g: "https://x.example.test/cb?sig=zzz-sentinel",
      h: "https://x.example.test/cb?key=zzz-sentinel",
      list: ["fine", `Authorization: Bearer ${jwt}`],
    });
    expect(value).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: REDACTED, e: REDACTED, f: REDACTED, g: REDACTED, h: REDACTED, list: ["fine", REDACTED] });
    expect(json).not.toMatch(/sentinel/);
  });

  it("değer taraması yanlış pozitifleri: sıradan metin ve zararsız URL maskelenmez", () => {
    const v = {
      a: "Basic subscription plan",
      b: "Basic plan",
      c: "https://x.example.test/list?page=2&sort=name&monkey=1",
      d: "bearer",
      e: "eyJ is not a token",
      f: "Bearer",
    };
    expect(maskChangeSummary(v).value).toEqual(v);
  });

  it("ad/değer çiftleri: { name, value } ve [[ad, değer]] biçimleri", () => {
    expect(
      maskChangeSummary({
        headers: [
          { name: "Authorization", value: "plain-sentinel" },
          { name: "Accept", value: "json" },
        ],
        raw: [["Authorization", "plain-sentinel"], ["Accept", "json"]],
        params: [{ key: "password", value: "plain-sentinel" }],
      }).value,
    ).toEqual({
      headers: [
        { name: "Authorization", value: REDACTED },
        { name: "Accept", value: "json" },
      ],
      raw: [["Authorization", REDACTED], ["Accept", "json"]],
      params: [{ key: "password", value: REDACTED }],
    });
  });

  it("derin nesne ve dizilerde de maskelenir; sır içeren anahtarın tüm alt ağacı değişir", () => {
    const { value } = maskChangeSummary({
      a: { b: [{ token: "x", n: 1 }, { deep: { Secret: "y", keep: true } }] },
      settings: { password: { nested: "z" } },
      tokenList: ["a", "b"],
    });
    expect(value).toEqual({
      a: { b: [{ token: REDACTED, n: 1 }, { deep: { Secret: REDACTED, keep: true } }] },
      settings: { password: REDACTED },
      tokenList: REDACTED,
    });
  });

  it("sır değeri JSON çıktısında bulunmaz", () => {
    expect(maskChangeSummary({ password: "p4ss-sentinel", nested: { otp: "123456-sentinel" } }).json).not.toMatch(/sentinel/);
  });

  it("nesne olmayan ve döngüsel girdi reddedilir", () => {
    for (const bad of [null, [], "x", 1]) expect(() => maskChangeSummary(bad)).toThrow(AuditError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => maskChangeSummary(loop)).toThrow(/circular/);
    expect(() => maskChangeSummary({ f: () => 1 })).toThrow(AuditError);
  });

  it("aşırı derinlik reddedilir", () => {
    let o: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 30; i++) o = { n: o };
    expect(() => maskChangeSummary(o)).toThrow(/deeply/);
  });
});

describe("boyut sınırı", () => {
  it("sınırda kabul, bir bayt fazlada VALIDATION_FAILED (kırpma yok)", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ v: "" }), "utf8");
    const ok = { v: "a".repeat(CHANGE_SUMMARY_MAX_BYTES - overhead) };
    expect(Buffer.byteLength(maskChangeSummary(ok).json, "utf8")).toBe(CHANGE_SUMMARY_MAX_BYTES);
    const err = (() => {
      try {
        maskChangeSummary({ v: "a".repeat(CHANGE_SUMMARY_MAX_BYTES - overhead + 1) });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).code).toBe("VALIDATION_FAILED");
  });

  it("boyut maskelemeden sonra ölçülür; çok baytlı karakterler bayt olarak sayılır", () => {
    expect(() => maskChangeSummary({ password: "x".repeat(20000) })).not.toThrow();
    expect(() => maskChangeSummary({ v: "ğ".repeat(CHANGE_SUMMARY_MAX_BYTES / 2) })).toThrow(AuditError);
  });
});

describe("özyineleme bütçesi (erken ret)", () => {
  it("çok sayıda eleman: tüm ağaç gezilmeden reddedilir", () => {
    const big = Array.from({ length: 5000 }, (_, i) => i);
    expect(() => maskChangeSummary({ big })).toThrow(AuditError);
  });

  it("büyük dize bayt bütçesi aşılınca reddedilir; maskelenen büyük sır reddedilmez", () => {
    expect(() => maskChangeSummary({ a: "x".repeat(CHANGE_SUMMARY_MAX_BYTES + 1) })).toThrow(/exceeds/);
    expect(() => maskChangeSummary({ token: "x".repeat(1_000_000), ok: 1 })).not.toThrow();
  });

  it("çok sayıda küçük anahtar bayt bütçesini aşar", () => {
    const o: Record<string, string> = {};
    for (let i = 0; i < 1500; i++) o[`k${i}`] = "vvvvvvvvvv";
    expect(() => maskChangeSummary(o)).toThrow(AuditError);
  });
});

describe("appendAudit SQL biçimi", () => {
  it("tenant_id sütunu YOK; maskelenmiş JSON parametredir", async () => {
    const { tx, queries } = fakeTx();
    const r = await appendAudit(tx, {
      action: "member.invited",
      actorUserId: USER,
      changeSummary: { email: "a@example.test", token: "sentinel" },
      reason: "r",
    });
    expect(r).toEqual({ id: "11111111-2222-4333-8444-555555555555", createdXid: "42" });
    expect(queries).toHaveLength(1);
    const q = queries[0] as { sql: string; params: unknown[] };
    expect(q.sql).toMatch(/INSERT INTO public\.audit_logs\s*\(actor_user_id/);
    expect(q.sql).not.toMatch(/tenant_id/);
    expect(q.params).toContain(JSON.stringify({ email: "a@example.test", token: REDACTED }));
    expect(JSON.stringify(q.params)).not.toContain("sentinel");
  });

  it("geçersiz alanlar sorgusuz reddedilir (sessiz kırpma yok)", async () => {
    const { tx, queries } = fakeTx();
    const bad = [
      { actorUserId: "not-a-uuid" },
      { onBehalfOfUserId: "x" },
      { reason: "x".repeat(501) },
      { ip: "" },
      { userAgent: "u".repeat(513) },
      { entityId: "a\u0000b" },
    ];
    for (const extra of bad) {
      await expect(appendAudit(tx, { action: "tenant.created", ...extra })).rejects.toBeInstanceOf(AuditError);
    }
    expect(queries).toHaveLength(0);
  });
});

describe("recordSecurityEvent", () => {
  function newClient(): DbClient {
    const c = createDbClient({ url: "postgresql://u:unit-secret-pw@127.0.0.1:1/unit", ...DB_CLIENT_SETTINGS });
    clients.push(c);
    return c;
  }

  it("geçersiz olay türü transaction açmadan reddedilir", async () => {
    const client = newClient();
    const tx = vi.spyOn(rawDb(client), "transaction");
    for (const eventType of ["", "Login", "x y", "a;b"]) {
      await expect(recordSecurityEvent(client, { eventType })).rejects.toBeInstanceOf(AuditError);
    }
    await expect(recordSecurityEvent(client, { eventType: "login_failed", detail: { big: "a".repeat(9000) } })).rejects.toBeInstanceOf(AuditError);
    expect(tx).not.toHaveBeenCalled();
  });

  it("suppressNetworkMeta ip/user_agent'ı NULL yazar; detail maskelenir", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx();
    vi.spyOn(rawDb(client), "transaction").mockImplementation(async (cb) => cb(tx as Parameters<typeof cb>[0]));
    await recordSecurityEvent(client, {
      eventType: "login_succeeded",
      userId: USER,
      ip: "203.0.113.9",
      userAgent: "UA",
      detail: { code: "123456", method: "password" },
      suppressNetworkMeta: true,
    });
    const q = queries[0] as { sql: string; params: unknown[] };
    expect(q.sql).toContain("public.security_events");
    expect(q.params).not.toContain("203.0.113.9");
    expect(q.params).not.toContain("UA");
    expect(q.params).toContain(JSON.stringify({ code: REDACTED, method: "password" }));
  });

  it("bayrak yokken ip/user_agent yazılır", async () => {
    const client = newClient();
    const { tx, queries } = fakeTx();
    vi.spyOn(rawDb(client), "transaction").mockImplementation(async (cb) => cb(tx as Parameters<typeof cb>[0]));
    await recordSecurityEvent(client, { eventType: "logout", ip: "203.0.113.9", userAgent: "UA" });
    expect((queries[0] as { params: unknown[] }).params).toEqual(expect.arrayContaining(["203.0.113.9", "UA"]));
  });
});
