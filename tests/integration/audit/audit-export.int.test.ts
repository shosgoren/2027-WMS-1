// T-126: denetim kaydı listesi + CSV export. Gerçek wms_app bağlantısı + RLS. Fikstürler sentetik (G-09).
// Seed migration rolüyle (RLS dışı); `occurred_at`/`created_xid` tetikleyiciyle sunucu değerine zorlanır → her 100 satırlık
// ifade ayrı `now()` alır (keyset sıralaması birden çok zaman damgası + eşitlik kırıcı `id` ile sınanır).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import { listAudit, openAuditExport } from "../../../packages/domain/src/audit/audit-query.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const A_ROWS = 2500;
const B_ROWS = 500;

let app: DbClient;
let adm: pg.Client;

const rnd = (): string => randomBytes(6).toString("hex");

interface Fx {
  tenant: string;
  slug: string;
  admin: { userId: string };
  picker: { userId: string };
  manager: { userId: string };
}

async function mkMember(tenant: string, role: string, name: string): Promise<{ userId: string }> {
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, `t126-${rnd()}@example.test`]);
  const userId = (r.rows[0] as { id: string }).id;
  const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false) RETURNING id", [tenant, userId]);
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, (m.rows[0] as { id: string }).id, role]);
  return { userId };
}

async function mkTenant(label: string, rows: number): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t126-${label.toLowerCase()}-${rnd()}`;
  await adm.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, $3)", [tenant, slug, `T126 ${label}`]);
  await adm.query("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'Europe/Istanbul', 'COMPLETED')", [tenant]);
  const admin = await mkMember(tenant, "TENANT_ADMIN", `Yönetici ${label}`);
  const picker = await mkMember(tenant, "PICKER", `Toplayıcı ${label}`);
  const manager = await mkMember(tenant, "WAREHOUSE_MANAGER", `Depocu ${label}`);
  await seedRows(tenant, admin.userId, label, rows);
  return { tenant, slug, admin, picker, manager };
}

async function seedRows(tenant: string, actor: string, label: string, rows: number): Promise<void> {
  for (let done = 0; done < rows; done += 100) {
    const n = Math.min(100, rows - done);
    await adm.query(
      `INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, reason, change_summary)
       SELECT $1, $2, 'member.invited', 'invitation', gen_random_uuid()::text, $3 || ' satır, "tırnak", =formül', '{"k":"v"}'::jsonb FROM generate_series(1, $4)`,
      [tenant, actor, `${label}-ROW`, n],
    );
  }
}

const access = (fx: Fx, userId: string, mfa = true) => ({ db: app, principal: { userId, mfaVerified: mfa }, tenantSlug: fx.slug });
const fresh = () => Promise.resolve();
const stale = () => Promise.reject(Object.assign(new Error("reauth"), { code: "UNAUTHENTICATED", reason: "REAUTH_REQUIRED" }));

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

const dataLines = (csv: string): string[] => csv.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "").slice(1);
async function expectCode(p: Promise<unknown>, code: string, detail?: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  if (detail !== undefined) expect((e as AppError).detail).toBe(detail);
}

let A: Fx;
let B: Fx;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  A = await mkTenant("A", A_ROWS);
  B = await mkTenant("B", B_ROWS);
}, 300_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("listAudit (keyset)", () => {
  it("sayfa sayfa gezilir: tekrar/eksik yok, yalnızca A satırları, sıra (occurred_at DESC, id ASC)", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let prevTs: number | null = null;
    for (;;) {
      const p = await listAudit(access(A, A.admin.userId), { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      pages++;
      for (const r of p.items) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
        if (prevTs !== null) expect(r.occurredAt.getTime()).toBeLessThanOrEqual(prevTs);
        prevTs = r.occurredAt.getTime();
        expect(r.actorName).toBe("Yönetici A");
        expect(r.reason ?? "").not.toContain("B-ROW");
      }
      if (p.nextCursor === null) break;
      cursor = p.nextCursor;
    }
    const total = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1", [A.tenant])).rows[0]?.n);
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThanOrEqual(A_ROWS / 100);
  }, 120_000);

  it("filtre: işlem + tarih aralığı; geçersiz imleç/filtre/limit VALIDATION_FAILED", async () => {
    const none = await listAudit(access(A, A.admin.userId), { filters: { action: "tenant.created" } });
    expect(none.items).toHaveLength(0);
    const today = new Date().toISOString().slice(0, 10);
    const some = await listAudit(access(A, A.admin.userId), { limit: 5, filters: { from: today, to: today, action: "member.invited" } });
    expect(some.items.length).toBe(5);
    const past = await listAudit(access(A, A.admin.userId), { filters: { to: "2000-01-01" } });
    expect(past.items).toHaveLength(0);
    await expectCode(listAudit(access(A, A.admin.userId), { cursor: "not-base64!" }), "VALIDATION_FAILED");
    await expectCode(listAudit(access(A, A.admin.userId), { cursor: Buffer.from('{"ts":"x","id":"y"}').toString("base64url") }), "VALIDATION_FAILED");
    await expectCode(listAudit(access(A, A.admin.userId), { filters: { from: "2026-02-30" } }), "VALIDATION_FAILED");
    await expectCode(listAudit(access(A, A.admin.userId), { filters: { action: "x'; DROP TABLE audit_logs;--" } }), "VALIDATION_FAILED");
    await expectCode(listAudit(access(A, A.admin.userId), { limit: 101 }), "VALIDATION_FAILED");
    await expectCode(listAudit(access(A, A.admin.userId), { limit: 0 }), "VALIDATION_FAILED");
  });

  it("izin: PICKER FORBIDDEN, WAREHOUSE_MANAGER görür; başka tenant'ın slug'ı NOT_FOUND", async () => {
    await expectCode(listAudit(access(A, A.picker.userId)), "FORBIDDEN");
    expect((await listAudit(access(A, A.manager.userId), { limit: 1 })).items).toHaveLength(1);
    await expectCode(listAudit({ ...access(A, A.admin.userId), tenantSlug: B.slug }), "NOT_FOUND");
  });
});

describe("openAuditExport", () => {
  it("A export'u yalnızca A satırları; satır sayısı = kesitteki toplam; CSV biçimi (BOM, CRLF, kaçış)", async () => {
    const before = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1", [A.tenant])).rows[0]?.n);
    const { stream } = await openAuditExport({ ...access(A, A.admin.userId), recentAuth: fresh });
    const csv = await readAll(stream);
    expect(csv.startsWith("﻿Tarih (UTC),Kişi,İşlem,Kayıt türü,Kayıt no,Gerekçe,Özet (JSON)\r\n")).toBe(true);
    const lines = dataLines(csv);
    expect(lines).toHaveLength(before);
    expect(csv).not.toContain("B-ROW");
    expect(csv).toContain('"A-ROW satır, ""tırnak"", =formül"');
    expect(csv).not.toMatch(/example\.test/); // e-posta dışa aktarılmaz
    // export olayı yazıldı, ama kendi kesitinde değil
    const ev = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'audit.exported' AND actor_user_id = $2", [A.tenant, A.admin.userId]);
    expect(Number(ev.rows[0]?.n)).toBe(1);
    expect(csv).not.toContain("audit.exported");
    // İkinci export önceki export olayını içerir (yeni kesit)
    const again = dataLines(await readAll((await openAuditExport({ ...access(A, A.admin.userId), recentAuth: fresh })).stream));
    expect(again).toHaveLength(before + 1);
  }, 120_000);

  it("export sürerken eklenen satır dosyada yok (kesit, I-16); parçalar tamamlanır", async () => {
    const before = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1", [A.tenant])).rows[0]?.n);
    const { stream } = await openAuditExport({ ...access(A, A.admin.userId), recentAuth: fresh }, { chunkSize: 500 });
    const reader = stream.getReader();
    const dec = new TextDecoder("utf-8", { ignoreBOM: true });
    let csv = dec.decode((await reader.read()).value); // BOM + başlık
    csv += dec.decode((await reader.read()).value); // ilk veri parçası
    await seedRows(A.tenant, A.admin.userId, "LATE", 150); // akış sürerken COMMIT edilir
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      csv += dec.decode(value, { stream: true });
    }
    expect(dataLines(csv)).toHaveLength(before); // önceki export olayları dahil, kendi olayı ve LATE yok
    expect(csv).not.toContain("LATE-ROW");
  }, 120_000);

  it("filtreli export yalnızca eşleşenleri yazar; filtre audit.exported özetine girer", async () => {
    const csv = await readAll((await openAuditExport({ ...access(B, B.admin.userId), recentAuth: fresh }, { filters: { action: "member.invited" } })).stream);
    expect(dataLines(csv)).toHaveLength(B_ROWS);
    expect(csv).not.toContain("A-ROW");
    const ev = await adm.query<{ s: { format: string; action: string } }>("SELECT change_summary AS s FROM public.audit_logs WHERE tenant_id = $1 AND action = 'audit.exported'", [B.tenant]);
    expect(ev.rows[0]?.s).toMatchObject({ format: "csv", action: "member.invited" });
  }, 60_000);

  it("yetkisiz rol FORBIDDEN (olay yazılmaz); yeniden doğrulama dolmuş/yok → RECENT_AUTH_REQUIRED", async () => {
    await expectCode(openAuditExport({ ...access(A, A.picker.userId), recentAuth: fresh }), "FORBIDDEN");
    await expectCode(openAuditExport({ ...access(A, A.admin.userId), recentAuth: stale }), "UNAUTHENTICATED", "RECENT_AUTH_REQUIRED");
    await expectCode(openAuditExport(access(A, A.admin.userId)), "UNAUTHENTICATED", "RECENT_AUTH_REQUIRED");
    await expectCode(openAuditExport({ ...access(A, A.admin.userId, false), recentAuth: fresh }), "FORBIDDEN", "MFA_REQUIRED");
    await expectCode(openAuditExport({ ...access(A, A.admin.userId), tenantSlug: B.slug, recentAuth: fresh }), "NOT_FOUND");
    await expectCode(openAuditExport({ ...access(A, A.admin.userId), recentAuth: fresh }, { filters: { from: "bad" } }), "VALIDATION_FAILED");
    const n = await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'audit.exported' AND actor_user_id = $2", [A.tenant, A.picker.userId]);
    expect(Number(n.rows[0]?.n)).toBe(0);
  });

  it("akış sırasında üyelik yetkisi düşerse sonraki parça okunmaz (her parça yeniden yetkilendirilir)", async () => {
    const fx = await mkTenant("C", 30);
    const u = await mkMember(fx.tenant, "WAREHOUSE_MANAGER", "Geçici Depocu");
    const { stream } = await openAuditExport({ ...access(fx, u.userId), recentAuth: fresh }, { chunkSize: 10 });
    const reader = stream.getReader();
    await reader.read(); // başlık
    await reader.read(); // ilk parça
    await adm.query("UPDATE public.tenant_memberships SET status = 'REMOVED' WHERE tenant_id = $1 AND user_id = $2", [fx.tenant, u.userId]).catch(async () => {
      await adm.query("DELETE FROM public.membership_roles WHERE tenant_id = $1 AND membership_id IN (SELECT id FROM public.tenant_memberships WHERE user_id = $2)", [fx.tenant, u.userId]);
    });
    await expect(reader.read()).rejects.toBeInstanceOf(AppError);
  }, 60_000);
});
