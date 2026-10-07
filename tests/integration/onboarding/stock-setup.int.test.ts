// T-223: sektör şablonu Faz 2 adımları (units.applied, locations.applied) ve demo içeriği (ürün, lokasyon, açılış stoğu).
// Gerçek wms_app + RLS + tetikleyiciler. Demo tenant tekildir (sabit kimlik) ve demo/seed.int.test.ts "taze ortam" varsayar:
// bu yüzden bu dosya YALITILMIŞ bir veritabanında çalışır (demo-guards.int.test.ts ile aynı desen). Fikstürler sentetiktir (G-09).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../../packages/auth/src/password.ts";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { ensureDemoTenantStep, migrateUp } from "../../../packages/db/src/migrate.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import {
  DEMO_ITEMS,
  DEMO_LOCATIONS,
  DEMO_ROLES,
  DEMO_STOCK_TARGETS,
  DEMO_TENANT_ID,
  reseedDemo,
  type DemoAccountPort,
} from "../../../packages/domain/src/demo/seed.ts";
import { approveDocument, createStockDocument, postDocument } from "../../../packages/domain/src/stock/index.ts";
import { continueOnboarding, createWorkspace, type WorkspaceEnv } from "../../../packages/domain/src/onboarding/workspace.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const OPEN: WorkspaceEnv = { WMS_ENV: "ci", SIGNUP_ENABLED: "true", DEMO_EMAIL_DOMAIN: "demo.example.test" };
const PASSWORD = `Dm-${randomBytes(9).toString("hex")}`;
const DB_NAME = `t223_${randomBytes(5).toString("hex")}`;

let app: DbClient;
let adm: pg.Client;
let admMain: pg.Client;
let isolatedDirect = "";

function isolated(url: string): string {
  const u = new URL(url);
  const direct = new URL(env.databaseUrlDirect);
  u.protocol = direct.protocol;
  u.host = direct.host;
  u.pathname = `/${DB_NAME}`;
  u.search = "";
  return u.toString();
}

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []): Promise<T[]> =>
  (await adm.query<T>(text, args)).rows;
const n = async (text: string, args: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, args))[0]!.n);
const principal = (userId: string) => ({ userId, mfaVerified: true });

beforeAll(async () => {
  admMain = new pg.Client({ connectionString: env.databaseUrlDirect });
  admMain.on("error", () => undefined);
  await admMain.connect();
  await admMain.query(`CREATE DATABASE "${DB_NAME}"`);
  isolatedDirect = isolated(env.databaseUrlDirect);
  await migrateUp({ url: isolatedDirect });
  app = createDbClient({ url: isolated(env.databaseUrl), poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: isolatedDirect });
  adm.on("error", () => undefined);
  await adm.connect();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
  await admMain?.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`).catch(() => undefined);
  await admMain?.end().catch(() => undefined);
}, 60_000);

async function newUser(): Promise<string> {
  return (await q<{ id: string }>("INSERT INTO public.users (name, email) VALUES ('T223 fixture', $1) RETURNING id", [`t223-${randomBytes(6).toString("hex")}@example.test`]))[0]!.id;
}
async function newWorkspace(templateKey = "PACKAGING_SUPPLIES") {
  const user = await newUser();
  const ws = await createWorkspace({ db: app, env: OPEN, principal: principal(user), name: `Acme ${randomBytes(4).toString("hex")}`, templateKey, requestId: randomUUID() });
  return { user, ...ws };
}
const cont = (user: string, slug: string) => continueOnboarding({ db: app, principal: principal(user), slug });

async function tenantState(tenantId: string) {
  const units = await q<{ code: string }>("SELECT code FROM public.units WHERE tenant_id = $1 ORDER BY code", [tenantId]);
  const whs = await q<{ id: string; code: string; name: string }>("SELECT id, code, name FROM public.warehouses WHERE tenant_id = $1", [tenantId]);
  const locs = await q<{ code: string; kind: string; depth: number }>("SELECT code, kind, depth FROM public.locations WHERE tenant_id = $1 ORDER BY code", [tenantId]);
  const settings = (await q<{ v: number; st: string; steps: { key: string; status: string }[] }>(
    "SELECT sector_template_version v, onboarding_status st, onboarding_steps steps FROM public.tenant_settings WHERE tenant_id = $1", [tenantId]))[0]!;
  const stepAudit = await q<{ step: string }>("SELECT change_summary->>'step' AS step FROM public.audit_logs WHERE tenant_id = $1 AND action = 'onboarding.step_completed' ORDER BY step", [tenantId]);
  return { units: units.map((u) => u.code), whs, locs, settings, stepAudit: stepAudit.map((s) => s.step) };
}

const V2_STEPS = ["settings.applied", "terminology.applied", "units.applied", "locations.applied"];

describe("Faz 2 adımları: yeni tenant (A-78)", () => {
  it("PACKAGING_SUPPLIES: createWorkspace + continueOnboarding → 4 adım, birimler, D1 + KABUL + SEVK, sürüm 2", async () => {
    const ws = await newWorkspace();
    const r = await cont(ws.user, ws.slug);
    expect(r).toEqual({ status: "COMPLETED", applied: V2_STEPS });
    const s = await tenantState(ws.tenantId);
    expect(s.units).toEqual(["ADET", "KOLI", "PAKET", "RULO"]);
    expect(s.whs).toMatchObject([{ code: "D1", name: "Ana Depo" }]);
    expect(s.locs).toEqual([
      { code: "KABUL", kind: "RECEIVING", depth: 0 },
      { code: "SEVK", kind: "STAGING", depth: 0 },
    ]);
    expect(s.settings).toMatchObject({ v: 2, st: "COMPLETED" });
    expect(s.settings.steps.map((x) => `${x.key}:${x.status}`)).toEqual(V2_STEPS.map((k) => `${k}:DONE`));
    expect(s.stepAudit).toEqual([...V2_STEPS].sort());
    // katsayısız birim kaydı: dönüşüm satırı yok (A-32)
    expect(await n("SELECT count(*) n FROM public.unit_conversions WHERE tenant_id = $1", [ws.tenantId])).toBe(0);
    // adım uygulaması stok yaratmaz (G-01)
    expect(await n("SELECT count(*) n FROM public.stock_ledger WHERE tenant_id = $1", [ws.tenantId])).toBe(0);
  });

  it("GENERIC: yalnızca ADET + aynı depo iskeleti", async () => {
    const ws = await newWorkspace("GENERIC");
    expect((await cont(ws.user, ws.slug)).status).toBe("COMPLETED");
    const s = await tenantState(ws.tenantId);
    expect(s.units).toEqual(["ADET"]);
    expect(s.whs.map((w) => w.code)).toEqual(["D1"]);
    expect(s.locs.map((l) => l.code)).toEqual(["KABUL", "SEVK"]);
  });
});

describe("Faz 2 adımları: v1 uygulanmış mevcut tenant", () => {
  async function v1Tenant() {
    const ws = await newWorkspace();
    await q(
      `UPDATE public.tenant_settings SET sector_template_version = 1, onboarding_status = 'COMPLETED',
              onboarding_steps = '[{"key":"settings.applied","status":"DONE"},{"key":"terminology.applied","status":"DONE"}]'::jsonb
        WHERE tenant_id = $1`,
      [ws.tenantId],
    );
    return ws;
  }

  it("continueOnboarding iki kez → eksik adımlar bir kez, tek depo, tek birim kümesi, sürüm 2", async () => {
    const ws = await v1Tenant();
    expect(await cont(ws.user, ws.slug)).toEqual({ status: "COMPLETED", applied: ["units.applied", "locations.applied"] });
    expect(await cont(ws.user, ws.slug)).toEqual({ status: "COMPLETED", applied: [] });
    const s = await tenantState(ws.tenantId);
    expect(s.units).toEqual(["ADET", "KOLI", "PAKET", "RULO"]);
    expect(s.whs).toHaveLength(1);
    expect(s.locs.map((l) => l.code)).toEqual(["KABUL", "SEVK"]);
    expect(s.settings).toMatchObject({ v: 2, st: "COMPLETED" });
    expect(s.stepAudit).toEqual(["locations.applied", "units.applied"]); // adım audit'i tekil
  });

  it("eşzamanlı çift çağrı: yinelenen kayıt ve yinelenen adım audit'i yok", async () => {
    const ws = await v1Tenant();
    const runs = await Promise.allSettled([cont(ws.user, ws.slug), cont(ws.user, ws.slug), cont(ws.user, ws.slug)]);
    expect(runs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const s = await tenantState(ws.tenantId);
    expect(s.units).toEqual(["ADET", "KOLI", "PAKET", "RULO"]);
    expect(s.whs).toHaveLength(1);
    expect(s.stepAudit).toEqual(["locations.applied", "units.applied"]);
    expect(s.settings).toMatchObject({ v: 2, st: "COMPLETED" });
  });

  it("kullanıcının önceden açtığı D1 / KABUL korunur (CODE_TAKEN = uygulanmış); eksik SEVK tamamlanır", async () => {
    const ws = await v1Tenant();
    const wh = (await q<{ id: string }>("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, gen_random_uuid(), 'D1', 'Benim Depom') RETURNING id", [ws.tenantId]))[0]!.id;
    await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, code, name, depth, kind) VALUES ($1, gen_random_uuid(), $2, 'KABUL', 'Benim Kabul', 0, 'STORAGE')", [ws.tenantId, wh]);
    await cont(ws.user, ws.slug);
    const s = await tenantState(ws.tenantId);
    expect(s.whs).toMatchObject([{ code: "D1", name: "Benim Depom" }]);
    expect(s.locs).toEqual([
      { code: "KABUL", kind: "STORAGE", depth: 0 }, // A-223-3: dokunulmaz
      { code: "SEVK", kind: "STAGING", depth: 0 },
    ]);
  });

  it("yarıda kesilen adım (SEVK eklenirken hata): adım PENDING kalır; yeniden çağrıda tamamlanır, tek depo", async () => {
    const ws = await v1Tenant();
    await q(`CREATE OR REPLACE FUNCTION public.t223_fail_sevk() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected SEVK failure'; END $f$`);
    await q(`CREATE TRIGGER t223_fail_sevk BEFORE INSERT ON public.locations FOR EACH ROW
      WHEN (NEW.tenant_id = '${ws.tenantId}'::uuid AND NEW.code = 'SEVK') EXECUTE FUNCTION public.t223_fail_sevk()`);
    try {
      await expect(cont(ws.user, ws.slug)).rejects.toBeInstanceOf(AppError);
    } finally {
      await q("DROP TRIGGER IF EXISTS t223_fail_sevk ON public.locations");
      await q("DROP FUNCTION IF EXISTS public.t223_fail_sevk()");
    }
    const mid = await tenantState(ws.tenantId);
    expect(mid.settings.st).toBe("IN_PROGRESS");
    expect(mid.settings.steps.find((x) => x.key === "locations.applied")?.status).toBe("PENDING");
    expect(mid.stepAudit).toEqual(["units.applied"]);
    expect(mid.locs.map((l) => l.code)).toEqual(["KABUL"]);
    expect(await cont(ws.user, ws.slug)).toEqual({ status: "COMPLETED", applied: ["locations.applied"] });
    const done = await tenantState(ws.tenantId);
    expect(done.whs).toHaveLength(1);
    expect(done.locs.map((l) => l.code)).toEqual(["KABUL", "SEVK"]);
    expect(done.settings).toMatchObject({ v: 2, st: "COMPLETED" });
    expect(done.stepAudit).toEqual(["locations.applied", "units.applied"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Demo içeriği (A-43)
// ---------------------------------------------------------------------------------------------

const accounts: DemoAccountPort = {
  async ensureAccount({ email, name, password }) {
    const existing = await q<{ id: string }>("SELECT id FROM public.users WHERE email = $1", [email]);
    let userId = existing[0]?.id;
    let created = false;
    if (userId === undefined) {
      userId = (await q<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, email]))[0]!.id;
      created = true;
    }
    const acc = await q<{ id: string }>("SELECT id FROM public.accounts WHERE user_id = $1 AND provider_id = 'credential'", [userId]);
    if (acc[0] === undefined) {
      await q("INSERT INTO public.accounts (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, $2)", [userId, await hashPassword(password)]);
    }
    return { userId, created, passwordUpdated: false };
  },
};

const reseed = (runId?: string) => reseedDemo({ db: app, accounts, password: PASSWORD, ...(runId === undefined ? {} : { runId }) });

async function demoBalances(): Promise<Record<string, string>> {
  const rows = await q<{ k: string; qty: string }>(
    `SELECT i.code || '@' || l.code AS k, b.quantity::text AS qty
       FROM public.stock_balances b
       JOIN public.stock_dimensions d ON d.tenant_id = b.tenant_id AND d.id = b.stock_dimension_id
       JOIN public.items i ON i.tenant_id = d.tenant_id AND i.id = d.item_id
       JOIN public.locations l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
      WHERE b.tenant_id = $1 ORDER BY 1`,
    [DEMO_TENANT_ID],
  );
  return Object.fromEntries(rows.map((r) => [r.k, String(Number(r.qty))]));
}
const targetBalances = Object.fromEntries([...DEMO_STOCK_TARGETS].sort((a, b) => (`${a.item}@${a.location}` < `${b.item}@${b.location}` ? -1 : 1)).map((t) => [`${t.item}@${t.location}`, t.quantity]));
const docCount = (kind?: string, status?: string) =>
  n("SELECT count(*) n FROM public.documents WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR status = $3)", [DEMO_TENANT_ID, kind ?? null, status ?? null]);

/** Defter toplamı = bakiye (I-04/I-05) her boyut için. */
async function expectLedgerEqualsBalance(): Promise<void> {
  const bad = await q(
    `SELECT d.id FROM public.stock_dimensions d
       LEFT JOIN (SELECT stock_dimension_id, sum(quantity) s FROM public.stock_ledger WHERE tenant_id = $1 GROUP BY 1) l ON l.stock_dimension_id = d.id
       LEFT JOIN public.stock_balances b ON b.tenant_id = d.tenant_id AND b.stock_dimension_id = d.id
      WHERE d.tenant_id = $1 AND COALESCE(l.s, 0) <> COALESCE(b.quantity, 0)`,
    [DEMO_TENANT_ID],
  );
  expect(bad).toEqual([]);
}

async function demoAdmin(): Promise<string> {
  return (await q<{ id: string }>("SELECT id FROM public.users WHERE email = $1", [DEMO_ROLES.TENANT_ADMIN]))[0]!.id;
}

/** Demo kullanıcısı gibi stok çıkışı (yalnızca stok komutları). */
async function userStockOut(itemCode: string, locCode: string, qty: string): Promise<void> {
  const adminId = await demoAdmin();
  const item = (await q<{ id: string; base_unit_id: string }>("SELECT id, base_unit_id FROM public.items WHERE tenant_id = $1 AND code = $2", [DEMO_TENANT_ID, itemCode]))[0]!;
  const loc = (await q<{ id: string; warehouse_id: string }>("SELECT id, warehouse_id FROM public.locations WHERE tenant_id = $1 AND code = $2", [DEMO_TENANT_ID, locCode]))[0]!;
  const access = { db: app, principal: { userId: adminId, mfaVerified: false }, tenantSlug: "demo" } as const;
  const doc = await createStockDocument(
    { ...access, clientKey: randomUUID() },
    { kind: "STOCK_OUT", warehouseId: loc.warehouse_id, lines: [{ itemId: item.id, unitId: item.base_unit_id, quantity: qty, conversionFactor: "1", baseQuantity: qty, sourceLocationId: loc.id }] },
  );
  await approveDocument({ ...access, clientKey: randomUUID() }, { documentId: doc.documentId as string, expectedVersion: 1 });
  await postDocument({ ...access, clientKey: randomUUID() }, { documentId: doc.documentId as string, expectedVersion: 2 });
}

describe("demo tohumu: ürün, lokasyon, açılış stoğu (A-43, A-79)", () => {
  beforeAll(async () => {
    await ensureDemoTenantStep(isolatedDirect, { WMS_ENV: "local", DEMO_MODE: "1" });
  }, 60_000);

  it("ilk koşu: 2 ürün + dönüşüm, depo/lokasyon ağacı, STOCK_IN/RECEIPT ile açılış stoğu; defter = bakiye", async () => {
    const first = await reseed(randomUUID());
    expect(first.catalog).toEqual({ itemsCreated: DEMO_ITEMS.length, locationsCreated: DEMO_LOCATIONS.length, stockDocuments: 1, stockLines: DEMO_STOCK_TARGETS.length });
    expect(await demoBalances()).toEqual(targetBalances);
    await expectLedgerEqualsBalance();

    // şablon adımları (ayar onarımından önce uygulanır) ve sürüm
    const s = await tenantState(DEMO_TENANT_ID);
    expect(s.units).toEqual(["ADET", "KOLI", "PAKET", "RULO"]);
    expect(s.whs.map((w) => w.code)).toEqual(["D1"]);
    expect(s.settings).toMatchObject({ v: 2, st: "COMPLETED" });
    expect(s.settings.steps.map((x) => x.key)).toEqual(V2_STEPS);

    // ağaç: Bölge A > 3 raf > 4 göz (STORAGE), KABUL/SEVK kökte
    const locs = await q<{ code: string; depth: number; kind: string; parent: string | null }>(
      "SELECT l.code, l.depth, l.kind, p.code AS parent FROM public.locations l LEFT JOIN public.locations p ON p.tenant_id = l.tenant_id AND p.id = l.parent_id WHERE l.tenant_id = $1 ORDER BY l.code COLLATE \"C\"", [DEMO_TENANT_ID]);
    const depthOf = (c: string | null): number => (c === null ? -1 : depthOf(DEMO_LOCATIONS.find((d) => d.code === c)?.parent ?? null) + 1);
    expect(locs).toEqual(
      [
        ...DEMO_LOCATIONS.map((d) => ({ code: d.code, depth: depthOf(d.code), kind: d.kind, parent: d.parent })),
        { code: "KABUL", depth: 0, kind: "RECEIVING", parent: null },
        { code: "SEVK", depth: 0, kind: "STAGING", parent: null },
      ].sort((a, b) => (a.code < b.code ? -1 : 1)),
    );
    expect(locs).toHaveLength(18);
    expect(locs.filter((l) => l.depth === 2)).toHaveLength(12);

    // ürün katsayıları ürün bazında (A-32)
    const conv = await q<{ item: string; unit: string; f: string }>(
      "SELECT i.code item, u.code unit, c.to_base_factor::text f FROM public.unit_conversions c JOIN public.items i ON i.tenant_id = c.tenant_id AND i.id = c.item_id JOIN public.units u ON u.tenant_id = c.tenant_id AND u.id = c.unit_id WHERE c.tenant_id = $1 ORDER BY 1, 2", [DEMO_TENANT_ID]);
    expect(conv.map((c) => `${c.item}:${c.unit}:${Number(c.f)}`).sort()).toEqual(
      DEMO_ITEMS.flatMap((i) => Object.entries(i.conversions).map(([u, f]) => `${i.code}:${u}:${f}`)).sort(),
    );

    // stok yalnızca komutlarla: tek POSTED STOCK_IN belgesi, demo yöneticisi adına; defter nedeni RECEIPT
    expect(await docCount()).toBe(1);
    const doc = (await q<{ kind: string; status: string; reason: string; created_by: string }>("SELECT kind, status, reason, created_by FROM public.documents WHERE tenant_id = $1", [DEMO_TENANT_ID]))[0]!;
    expect(doc).toEqual({ kind: "STOCK_IN", status: "POSTED", reason: "demo.reseed", created_by: await demoAdmin() });
    expect(await q<{ reason: string }>("SELECT DISTINCT reason FROM public.stock_ledger WHERE tenant_id = $1", [DEMO_TENANT_ID])).toEqual([{ reason: "RECEIPT" }]);
  }, 120_000);

  it("ikinci koşu (yeni iş): aynı bakiyeler, yeni belge/ürün/lokasyon yok", async () => {
    const before = { docs: await docCount(), ledger: await n("SELECT count(*) n FROM public.stock_ledger WHERE tenant_id = $1", [DEMO_TENANT_ID]), items: await n("SELECT count(*) n FROM public.items WHERE tenant_id = $1", [DEMO_TENANT_ID]) };
    const second = await reseed(randomUUID());
    expect(second.catalog).toEqual({ itemsCreated: 0, locationsCreated: 0, stockDocuments: 0, stockLines: 0 });
    expect(await demoBalances()).toEqual(targetBalances);
    expect(await docCount()).toBe(before.docs);
    expect(await n("SELECT count(*) n FROM public.stock_ledger WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(before.ledger);
    expect(await n("SELECT count(*) n FROM public.items WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(before.items);
    expect(await n("SELECT count(*) n FROM public.units WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(4);
    await expectLedgerEqualsBalance();
  }, 120_000);

  it("iki koşu arasında kullanıcı çıkış yaparsa sonraki koşu farkı YENİ anahtarla kapatır (IDEMPOTENCY_MISMATCH yok); defter silinmez", async () => {
    await userStockOut("KRT-3020", "A1-G01", "100");
    expect((await demoBalances())["KRT-3020@A1-G01"]).toBe("1100");
    const ledgerBefore = await n("SELECT count(*) n FROM public.stock_ledger WHERE tenant_id = $1", [DEMO_TENANT_ID]);
    const third = await reseed(randomUUID());
    expect(third.catalog).toMatchObject({ stockDocuments: 1, stockLines: 1 });
    expect(await demoBalances()).toEqual(targetBalances);
    expect(await n("SELECT count(*) n FROM public.stock_ledger WHERE tenant_id = $1", [DEMO_TENANT_ID])).toBe(ledgerBefore + 1); // yalnızca eklenir (I-04)
    expect(await docCount("STOCK_IN", "POSTED")).toBe(2);
    expect(await docCount("STOCK_OUT", "POSTED")).toBe(1);
    await expectLedgerEqualsBalance();
  }, 120_000);

  it("hedefin ÜSTÜNDE kalan bakiye STOCK_OUT farkıyla hedefe indirilir", async () => {
    const adminId = await demoAdmin();
    const item = (await q<{ id: string; base_unit_id: string }>("SELECT id, base_unit_id FROM public.items WHERE tenant_id = $1 AND code = 'BNT-45S'", [DEMO_TENANT_ID]))[0]!;
    const loc = (await q<{ id: string; warehouse_id: string }>("SELECT id, warehouse_id FROM public.locations WHERE tenant_id = $1 AND code = 'A2-G01'", [DEMO_TENANT_ID]))[0]!;
    const access = { db: app, principal: { userId: adminId, mfaVerified: false }, tenantSlug: "demo" } as const;
    const doc = await createStockDocument({ ...access, clientKey: randomUUID() }, { kind: "STOCK_IN", warehouseId: loc.warehouse_id, lines: [{ itemId: item.id, unitId: item.base_unit_id, quantity: "30", conversionFactor: "1", baseQuantity: "30", targetLocationId: loc.id }] });
    await approveDocument({ ...access, clientKey: randomUUID() }, { documentId: doc.documentId as string, expectedVersion: 1 });
    await postDocument({ ...access, clientKey: randomUUID() }, { documentId: doc.documentId as string, expectedVersion: 2 });
    expect((await demoBalances())["BNT-45S@A2-G01"]).toBe("750");
    const r = await reseed(randomUUID());
    expect(r.catalog).toMatchObject({ stockDocuments: 1, stockLines: 1 });
    expect(await demoBalances()).toEqual(targetBalances);
    await expectLedgerEqualsBalance();
  }, 120_000);

  it("aynı işin yeniden teslimi (aynı koşu kimliği) ikinci belge üretmez; yarıda kesilen işlem aynı anahtarlarla tamamlanır", async () => {
    // kesinti: işleme adımı (defter yazımı) başarısız → belge APPROVED kalır
    await userStockOut("KRT-3020", "A1-G02", "50");
    const runId = randomUUID();
    await q(`CREATE OR REPLACE FUNCTION public.t223_fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected ledger failure'; END $f$`);
    await q(`CREATE TRIGGER t223_fail_ledger BEFORE INSERT ON public.stock_ledger FOR EACH ROW
      WHEN (NEW.tenant_id = '${DEMO_TENANT_ID}'::uuid) EXECUTE FUNCTION public.t223_fail_ledger()`);
    try {
      await expect(reseed(runId)).rejects.toBeInstanceOf(Error);
    } finally {
      await q("DROP TRIGGER IF EXISTS t223_fail_ledger ON public.stock_ledger");
      await q("DROP FUNCTION IF EXISTS public.t223_fail_ledger()");
    }
    expect((await demoBalances())["KRT-3020@A1-G02"]).toBe("250");
    expect(await docCount("STOCK_IN", "APPROVED")).toBe(1);
    const inDocsBefore = await docCount("STOCK_IN");

    const redelivered = await reseed(runId); // aynı iş, aynı fark → aynı anahtarlar → aynı belge işlenir
    expect(redelivered.catalog.stockDocuments).toBe(1);
    expect(await docCount("STOCK_IN")).toBe(inDocsBefore); // yeni belge açılmadı
    expect(await docCount("STOCK_IN", "APPROVED")).toBe(0);
    expect(await demoBalances()).toEqual(targetBalances);

    // tamamlanmış işin bir kez daha teslimi: fark yok → belge yok
    const again = await reseed(runId);
    expect(again.catalog.stockDocuments).toBe(0);
    expect(await docCount("STOCK_IN")).toBe(inDocsBefore);
    await expectLedgerEqualsBalance();
  }, 180_000);

  it("aynı koşu kimliği + değişen içerik: yeni fark yeni anahtar üretir (IDEMPOTENCY_MISMATCH yok)", async () => {
    const runId = randomUUID();
    await userStockOut("BNT-45S", "A2-G01", "20");
    expect((await reseed(runId)).catalog.stockDocuments).toBe(1);
    await userStockOut("BNT-45S", "A2-G01", "40"); // farklı fark, aynı iş kimliği
    const r = await reseed(runId);
    expect(r.catalog.stockDocuments).toBe(1);
    expect(await demoBalances()).toEqual(targetBalances);
    await expectLedgerEqualsBalance();
  }, 180_000);
});
