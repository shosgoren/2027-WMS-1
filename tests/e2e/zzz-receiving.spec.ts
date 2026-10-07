// T-313: mal kabul ve yerleştirme ekranları (masaüstü + mobil). Tek demo girişi/test (demo girişi hız sınırlıdır).
// Akış: saha kabulü (yanlış tarama engeli, koli adedi, tek dokunuş bütçesi) → masaüstü teslim formu ve kalite onayı → görevli yerleştirme
// → serbest yerleştirme → sayım kilidi uyarısı. Fikstür (ürün, lokasyon, beklenen teslim) migration rolüyle SQL'den yazılır (sentetik veri, G-09);
// tüm stok etkisi UI → sunucu eylemi → domain komutudur. Mobil görüntüler/ölçümler `.artifacts/t-313/` altına yazılır (git'e girmez).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Demo girişi hız sınırı kovası: proje başına ayrı istemci adresi playwright.config.ts projelerindedir (receiving-desktop/-mobile); dosya düzeyinde ezilmez (T-280).

const OUT = process.env.T313_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-313");
const SIZES = [
  { name: "360", width: 360, height: 740 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
  { name: "390s", width: 390, height: 664 }, // kısa ekran (Safari araç çubukları açık): D-09 riskli boyut
] as const;
// Her test kendi fikstürünü kurar (`seed` adları yeniler); testler sırayla koşar (tek işçi).
const names = (r: string) => ({
  run: r,
  codes: { kabul: `E2EK${r}`, raf1: `E2ER1${r}`, raf2: `E2ER2${r}`, kilit: `E2EL${r}` },
  barcode: { koli: `869${r}01`, tekli: `869${r}02`, baska: `869${r}03` },
});
let run = "";
let CODES = names("").codes;
let BARCODE = names("").barcode;

interface Fx {
  /** Bu spec depoyu kendisi oluşturduysa true (temizlikte arşivlenir). */
  createdWarehouse: boolean;
  tenantId: string;
  warehouseId: string;
  unitId: string;
  itemId: string;
  otherItemId: string;
  kabulId: string;
  raf1Id: string;
  raf2Id: string;
  kilitId: string;
  receiptId: string;
  receiptNo: string;
  membershipId: string;
}

/**
 * Fikstür/gözlem SQL'i migration rolüyle `psql` üzerinden çalışır (e2e'de `pg` sürücüsü yasaktır, I-02). Bağlantı bilgisi ASLA argümanla verilmez
 * (süreç listesine/hata iletisine sızar, G-09): URL ayrıştırılıp yalnızca `PG*` ortam değişkenleriyle çocuk sürece geçer, SQL stdin'den gider.
 * Hata iletisi sterilizedir (argv/ortam/URL/parola yok). Yazmadan önce sunucunun loopback olduğu doğrulanır (yerel yığın dışına yazılmaz).
 * Parametreler ($n) değişmez metne çevrilir (yalnızca bu dosyanın sentetik değerleri). SELECT sonuçları JSON satırlarıdır.
 */
type Row = Record<string, string>;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  if (!LOOPBACK.has(u.hostname)) throw new Error("e2e: fikstür veritabanı loopback değil; yerel olmayan sunucuya yazılmaz");
  return {
    PATH: process.env.PATH,
    PGHOST: u.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: u.port === "" ? "5432" : u.port,
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}
/** Sterilize hata: yalnızca çıkış durumu; argv, ortam, URL ve psql çıktısı iletiye girmez. */
function sanitized(e: unknown): Error {
  const err = e as { code?: string; status?: number | null };
  if (err.code === "ENOENT") return new Error("e2e: psql bulunamadı (PostgreSQL istemcisi kurulu olmalı: postgresql-client)");
  return new Error(`e2e: fikstür SQL başarısız (psql çıkış durumu ${err.status ?? "?"})`);
}
async function db<T = Row>(text: string, params: unknown[] = [], url: string | undefined = process.env.DATABASE_URL_DIRECT): Promise<T[]> {
  if (url === undefined || url === "") throw new Error("e2e: DATABASE_URL_DIRECT yok (globalSetup .env yükler)");
  const env = pgEnv(url);
  const sql = text.replace(/\$(\d+)/g, (_m, i: string) => lit(params[Number(i) - 1]));
  const isSelect = /^\s*SELECT/i.test(sql);
  const wrapped = isSelect ? `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t` : sql;
  try {
    const out = execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"], { input: wrapped, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] });
    return isSelect ? (JSON.parse(out.trim() || "[]") as T[]) : [];
  } catch (e) {
    throw sanitized(e);
  }
}

const fixtures: Fx[] = [];

/**
 * Temizlik: bu spec'in ürün/birim/lokasyon/depo fikstürleri ARŞİVLENİR (silme yok: defter değişmezdir). Aynı veritabanında sonraki proje/spec'ler (T-274 boş durum,
 * kolay kurulum rehberi) etkin kayıt görmemeli; zz-code-edit de aynı yolu izler.
 */
async function cleanup(): Promise<void> {
  for (const f of fixtures.splice(0)) {
    // Kalite kontrolü varsayılana (açık, A-06) döner: bu spec'in sonunda kapatılır; sonraki koşu/proje aynı varsayımla başlamalı.
    await db("UPDATE public.tenant_settings SET receiving_qc_enabled = true WHERE tenant_id = $1", [f.tenantId]);
    // Açık/atanmış PUTAWAY görevleri iptal edilir: sonraki koşu "ilk görev" olarak bu koşunun görevini seçmemeli.
    await db("UPDATE public.warehouse_tasks SET status = 'CANCELLED', version = version + 1 WHERE tenant_id = $1 AND item_id IN ($2, $3) AND status IN ('OPEN', 'ASSIGNED')", [f.tenantId, f.itemId, f.otherItemId]);
    await db("UPDATE public.locations SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id IN ($2, $3, $4, $5)", [f.tenantId, f.kabulId, f.raf1Id, f.raf2Id, f.kilitId]);
    await db("UPDATE public.items SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id IN ($2, $3)", [f.tenantId, f.itemId, f.otherItemId]);
    await db("UPDATE public.units SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.unitId]);
    if (f.createdWarehouse) await db("UPDATE public.warehouses SET status = 'ARCHIVED', archived_at = now() WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.warehouseId]);
  }
}

test.afterAll(async () => {
  await cleanup();
});

async function seed(): Promise<Fx> {
  // Bu spec yerel yığına (compose DB + migration rolü) SQL fikstürü yazar; E2E_BASE_URL (staging) koşusunda uygulanamaz. `test.skip` guard tarafından
  // yasak (G-11) olduğundan sessizce atlanmaz, açık hatayla durur: staging koşusu bu dosyayı hariç tutmalıdır (örn. `--grep-invert`).
  if (process.env.E2E_BASE_URL?.trim()) throw new Error("e2e: zzz-receiving yerel yığın ister (E2E_BASE_URL ile staging'de fikstür yazılamaz); bu dosyayı staging koşusundan hariç tut (playwright.config.ts testIgnore bunu E2E_BASE_URL varken yapar)");
  const n = names(randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase());
  run = n.run;
  CODES = n.codes;
  BARCODE = n.barcode;
  {
    const q = db;
    const tenantId = (await q<{ id: string }>("SELECT id FROM public.tenants WHERE slug = 'demo'"))[0]?.id;
    if (tenantId === undefined) throw new Error("e2e: demo tenant yok");
    await q("UPDATE public.tenant_settings SET receiving_qc_enabled = true WHERE tenant_id = $1", [tenantId]);
    const membershipId = (await q<{ id: string }>("SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 ORDER BY joined_at LIMIT 1", [tenantId]))[0]?.id as string;
    const existingWh = (await q<{ id: string }>("SELECT id FROM public.warehouses WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY code LIMIT 1", [tenantId]))[0]?.id;
    const createdWarehouse = existingWh === undefined;
    const warehouseId = existingWh ?? randomUUID();
    // Tüm kimlikler ÖNCEDEN üretilir ve fikstür temizlik listesine HEMEN kaydedilir: kurulum yarıda kalsa da afterAll temizliği yazılanları geri alır (T-313 güvenlik MINOR).
    const fx: Fx = {
      createdWarehouse, tenantId, warehouseId, unitId: randomUUID(), itemId: randomUUID(), otherItemId: randomUUID(), kabulId: randomUUID(), raf1Id: randomUUID(), raf2Id: randomUUID(),
      kilitId: randomUUID(), receiptId: randomUUID(), receiptNo: `KBL-E2E-${run}`, membershipId,
    };
    fixtures.push(fx);
    if (createdWarehouse) await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E depo')", [tenantId, warehouseId, `E2E${run}`]);
    await q("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E adet')", [tenantId, fx.unitId, `EA${run}`]);
    const mkItem = async (id: string, name: string): Promise<void> => {
      await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,$4,$5,'NONE',0)", [tenantId, id, `E2E-${run}-${name.slice(0, 1)}`, name, fx.unitId]);
    };
    await mkItem(fx.itemId, `Vida ${run}`);
    await mkItem(fx.otherItemId, `Somun ${run}`);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode, quantity) VALUES ($1, gen_random_uuid(), $2, $3, 12)", [tenantId, fx.itemId, BARCODE.koli]);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3)", [tenantId, fx.itemId, BARCODE.tekli]);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3)", [tenantId, fx.otherItemId, BARCODE.baska]);
    const mkLoc = async (id: string, code: string, kind: "RECEIVING" | "STORAGE"): Promise<void> => {
      await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,$5,0,$6)", [tenantId, id, warehouseId, code, `E2E ${code}`, kind]);
    };
    await mkLoc(fx.kabulId, CODES.kabul, "RECEIVING");
    await mkLoc(fx.raf1Id, CODES.raf1, "STORAGE");
    await mkLoc(fx.raf2Id, CODES.raf2, "STORAGE");
    await mkLoc(fx.kilitId, CODES.kilit, "STORAGE");
    await q("INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by, status) VALUES ($1,$2,$3,$4,'E2E-IRS-1',(SELECT user_id FROM public.tenant_memberships WHERE id = $5),'OPEN')", [
      tenantId, fx.receiptId, warehouseId, fx.receiptNo, membershipId,
    ]);
    await q("INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) VALUES ($1, gen_random_uuid(), $2, 1, $3, $4, 1, 30)", [
      tenantId, fx.receiptId, fx.itemId, fx.unitId,
    ]);
    return fx;
  }
}

/** Klavye kaması taramasını taklit eder: STX + karakterler + Enter, tek tikte (tuşlar arası < 30 ms). */
async function scan(page: Page, code: string): Promise<void> {
  await page.evaluate(`(() => { const send = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); send("\\u0002"); for (const ch of ${JSON.stringify(code)}) send(ch); send("Enter"); })()`);
}

async function taps(page: Page): Promise<number> {
  return page.evaluate<number>("window.__taps ?? 0");
}

interface StepMetrics {
  primaries: number;
  primaryGap: number | null;
  primaryHeight: number | null;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  innerHeight: number;
  small: string[];
  numericInputs: number;
  /** İçeriğin son öğesi alt sabit çubuğun altına taşan yükseklik (px); ≤ 0: içerik çubuğun üstünde, kaydırma gerekmez (R-03). */
  bodyOverflow: number;
}

/** Adım ekranı ölçümü: tek birincil, alt boşluk, taşma, kaydırma, 48 px altı hedefler, `inputmode=numeric` sayısı. */
async function measure(page: Page): Promise<StepMetrics> {
  return page.evaluate<StepMetrics>(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const prim = [...document.querySelectorAll('[data-variant="primary"]')].filter(vis);
    const nav = document.querySelector('[data-testid="field-action-bar"]');
    const p = prim[0];
    const small = [];
    for (const el of document.querySelectorAll('a[href], button, summary, input, select, textarea')) {
      if (el.matches('a[href="#main"]')) continue;
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 47.5 || r.height < 47.5) small.push(((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return {
      primaries: prim.length,
      primaryGap: p && nav ? Math.round(nav.getBoundingClientRect().top - p.getBoundingClientRect().bottom) : null,
      primaryHeight: p ? Math.round(p.getBoundingClientRect().height) : null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.scrollingElement.scrollHeight,
      innerHeight: window.innerHeight,
      small,
      numericInputs: document.querySelectorAll('input[inputmode="numeric"]').length,
      bodyOverflow: (() => {
        const step = document.querySelector('[data-testid="flow-step"]');
        const bar = step && step.querySelector(':scope > [role="group"]');
        if (!step || !bar) return 0;
        const bottoms = [...step.children].filter((c) => c !== bar).map((c) => c.getBoundingClientRect().bottom);
        return Math.round(Math.max(...bottoms) - bar.getBoundingClientRect().top);
      })(),
    };
  })()`);
}

async function login(page: Page, label: string): Promise<void> {
  await page.addInitScript("window.__taps = 0; document.addEventListener('pointerdown', () => { window.__taps++; }, true); try { delete window.BarcodeDetector; } catch (e) { window.BarcodeDetector = undefined; }");
  await page.goto("/");
  await page.getByRole("button", { name: `${label} olarak gir` }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
}

const isMobile = (name: string): boolean => name.endsWith("mobile");

/** Ekran ölçümleri ve görüntüleri (aynı oturum: demo girişi hız sınırlı olduğundan ikinci giriş yapılmaz). */
async function screens(page: Page, projectName: string): Promise<void> {
  const mobile = isMobile(projectName);
  mkdirSync(OUT, { recursive: true });
  const fx = await seed();
  // Kalite kontrolü kapalı: kabul doğrudan AVAILABLE olur, yerleştirme adım görüntüleri için kaynak rafta mal bulunur (cleanup QC'yi geri açar).
  await db("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1", [fx.tenantId]);
  const metrics: Record<string, unknown> = {};
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const shot = async (name: string): Promise<void> => {
      const m = await measure(page);
      metrics[`${size.name}-${name}`] = m;
      expect(m.scrollWidth, `${size.name} ${name}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.small, `${size.name} ${name}: 48 px altı hedef`).toEqual([]);
      // Adım ekranları kaydırmasız sığar (R-03); teslim LİSTESİ sayfalı listedir (kaydırma beklenir).
      if (name !== "receive-pick") expect(m.bodyOverflow, `${size.name} ${name}: içerik sabit çubuğun altına girmez (R-03)`).toBeLessThanOrEqual(1);
      if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-${name}.png`) });
    };
    await page.goto("/t/demo/field/receive");
    await shot("receive-pick");
    await page.goto(`/t/demo/field/receive?receipt=${fx.receiptId}`);
    await page.waitForLoadState("networkidle");
    await shot("receive-scan");
    // Tarama adımı: tek birincil "Barkodu okut" (Elle gir ikincil); okuyucu/kamera yoksa hazır vurgusu.
    const primary = page.locator('[data-variant="primary"]:visible');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveText("Barkodu okut");
    await primary.click();
    await expect(page.getByTestId("scan-panel")).toHaveAttribute("data-ready", "true");
    await scan(page, "0000000000000");
    await expect(page.getByTestId("scan-alert")).toBeVisible();
    const a = await page.getByTestId("scan-alert").boundingBox();
    metrics[`${size.name}-alert`] = a;
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-wrong-scan-alert.png`) });
    await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
    // SCAN_MISMATCH: tanımlı ama bu teslimde olmayan ürün.
    await scan(page, BARCODE.baska);
    await expect(page.getByTestId("scan-alert")).toContainText("SCAN_MISMATCH");
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-scan-mismatch-alert.png`) });
    await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
    await scan(page, BARCODE.koli);
    await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toBeVisible();
    // R-03/B2: varsayılan durumda adım ekranı kaydırmasız sığar; seçili kabul rafı birincil düğmenin hemen üstünde görünür.
    const qtyM = await measure(page);
    metrics[`${size.name}-receive-qty-fit`] = qtyM;
    expect(qtyM.bodyOverflow, `${size.name}: miktar adımı kaydırmasız sığmalı`).toBeLessThanOrEqual(1);
    const rack = await page.getByTestId("rack-choice").boundingBox();
    const prim = await page.locator('[data-variant="primary"]:visible').boundingBox();
    expect(rack, `${size.name}: kabul rafı seçimi görünür`).not.toBeNull();
    expect((rack?.y ?? 0) + (rack?.height ?? 0), `${size.name}: raf seçimi birincil düğmenin üstünde`).toBeLessThanOrEqual((prim?.y ?? 0) + 1);
    await expect(page.getByTestId("rack-choice").locator("p", { hasText: "Kabul rafı" }), `${size.name}: "Kabul rafı" etiketi her boyutta görünür`).toBeVisible();
    // Seçili raf düğmesi akış rengindedir (kabul yeşil), ana mavi değil (R-07): bu çalışmanın rafını seç.
    await page.getByTestId("rack-chips").getByRole("button", { name: `E2E ${CODES.kabul}` }).click();
    const chosen = page.getByTestId("rack-chips").locator('[aria-pressed="true"]');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toContainText(CODES.kabul);
    const chipBg = await chosen.evaluate((e: { ownerDocument: { defaultView: { getComputedStyle: (x: unknown) => { backgroundColor: string } } } }) => e.ownerDocument.defaultView.getComputedStyle(e).backgroundColor);
    const accentBg = await page.evaluate<string>("(() => { const d = document.createElement('div'); d.className = 'bg-accent-soft'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })()");
    expect(chipBg, `${size.name}: seçili raf ana mavi (accent-soft) değil`).not.toBe(accentBg);
    await shot("receive-qty");
    await page.getByRole("button", { name: "Hasarlı ekle" }).click();
    // R-03/R-06: hasarlı satırı sabit çubuğun altına girmez (bodyOverflow ≤ 1 shot() içinde) ve etiket görünür.
    await expect(page.getByTestId("rack-choice").locator("p", { hasText: "Kabul rafı" })).toBeVisible();
    await shot("receive-qty-damaged");
    await page.getByRole("textbox", { name: "Hasarlı adet" }).fill("0");
    await page.getByRole("textbox", { name: /^Gelen \(/ }).fill("5");
    await page.getByRole("button", { name: "Kabul et" }).click();
    await expect(page.getByTestId("saved-summary")).toContainText("5 adet kabul edildi");
    await shot("receive-saved");
    // Yerleştirme (serbest, 5 adım): kaynak → ürün → hedef → miktar/onay → bitti; adım numaraları 1…5 / 5.
    await page.goto(`/t/demo/field/putaway?wh=${fx.warehouseId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("step-label")).toHaveText("Adım 1 / 5");
    await shot("putaway-source");
    await scan(page, CODES.kabul);
    await expect(page.getByTestId("step-label")).toHaveText("Adım 2 / 5");
    await shot("putaway-item");
    await scan(page, BARCODE.koli);
    await expect(page.getByTestId("step-label")).toHaveText("Adım 3 / 5");
    await shot("putaway-target");
    await scan(page, CODES.raf1);
    await expect(page.getByTestId("step-label")).toHaveText("Adım 4 / 5");
    await expect(page.getByRole("textbox", { name: "Kaç adet?" })).toHaveValue("5");
    await shot("putaway-confirm");
    await page.getByRole("button", { name: "Rafa koy" }).click();
    await expect(page.getByTestId("saved-summary")).toContainText("5 adet");
    await expect(page.getByTestId("step-label")).toHaveText("Adım 5 / 5");
    await shot("putaway-saved");
    await page.goto("/t/demo/receipts");
    const m = await measure(page);
    metrics[`${size.name}-receipts`] = m;
    expect(m.scrollWidth, `${size.name} receipts: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-receipts.png`), fullPage: true });
  }
  // Masaüstü (1280) görüntüsü: teslim listesi + form.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/t/demo/receipts");
  if (mobile) await page.screenshot({ path: path.join(OUT, "final-1280-receipts.png"), fullPage: true });
  writeFileSync(path.join(OUT, `metrics-screens-${projectName}.json`), JSON.stringify(metrics, null, 2));
}

test("kabul → kalite onayı → yerleştirme (görevli ve serbest) + yanlış tarama ve sayım kilidi engelleri", async ({ page }, testInfo) => {
  test.setTimeout(180_000); // çok ekranlı akış (3 boyutta ekran görüntüsü + iki akış); yalnız süre, assertion değişmez
  mkdirSync(OUT, { recursive: true });
  const fx = await seed();
  const mobile = isMobile(testInfo.project.name);
  const log: Record<string, unknown> = {};
  await login(page, "Yönetici");
  const base = "/t/demo";

  // ---- Saha kabulü: teslim seç ----------------------------------------------------------------------------------------------------
  await page.goto(`${base}/field/receive`);
  await expect(page.getByTestId("receive-picker")).toBeVisible();
  await expect(page.getByTestId("receive-pick").filter({ hasText: fx.receiptNo })).toHaveCount(1);
  const pick = await measure(page);
  log.pick = pick;
  expect(pick.primaries, "teslim seç: tek birincil").toBe(1);
  expect(pick.scrollWidth).toBeLessThanOrEqual(pick.clientWidth);
  if (mobile) expect(pick.small, "teslim seç: 48 px altı hedef").toEqual([]);

  // Dokunuş bütçesi: teslim seç (1) + Kabul et (2) ≤ 3; tarama dokunuş değildir.
  await page.evaluate("window.__taps = 0");
  await page.goto(`${base}/field/receive?receipt=${fx.receiptId}`);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2");
  await page.waitForLoadState("networkidle");

  // Yanlış tarama 1: sistemde olmayan kod → tam ekran uyarı; kayıt yok.
  await scan(page, `0${run}999999`);
  const unknown = page.getByTestId("scan-alert");
  await expect(unknown).toBeVisible();
  await expect(unknown).toHaveAttribute("role", "alertdialog");
  await expect(unknown).toContainText("Bu kod sistemde yok.");
  const box = await unknown.boundingBox();
  const vp = page.viewportSize();
  expect(box?.width, "uyarı tam genişlik").toBeGreaterThanOrEqual((vp?.width ?? 0) - 1);
  expect(box?.height, "uyarı tam yükseklik").toBeGreaterThanOrEqual((vp?.height ?? 0) - 1);
  log.alertUnknown = { w: box?.width, h: box?.height };
  if (mobile) await page.screenshot({ path: path.join(OUT, `alert-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await expect(unknown).toHaveCount(0);
  // Yanlış tarama kayıt yazmaz: bu teslim için kabul belgesi yok (önceki proje/spec koşuları aynı DB'de belge bırakmış olabilir; yalnız bu teslim sayılır).
  expect(await db("SELECT 1 FROM public.documents WHERE tenant_id = $1 AND source_kind = 'INBOUND_RECEIPT' AND source_id = $2", [fx.tenantId, fx.receiptId])).toHaveLength(0);

  // Yanlış tarama 2: tanımlı ama bu teslimde olmayan ürün → "Yanlış ürün".
  await scan(page, BARCODE.baska);
  await expect(page.getByTestId("scan-alert")).toContainText("Bu ürün bu işte yok.");
  await expect(page.getByTestId("scan-alert")).toContainText("SCAN_MISMATCH");
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2");
  await page.evaluate("window.__taps = 0"); // uyarı onayları bütçe dışı sayılır (N-16: tarama hatası onayı ayrı satır)

  // Doğru tarama: koli barkodu adet getirir (12).
  await scan(page, BARCODE.koli);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await expect(page.getByTestId("verified-item")).toHaveText(`Vida ${run}`);
  const qty = page.getByRole("textbox", { name: /^Gelen \(/ });
  await expect(qty).toHaveValue("12");
  const q = await measure(page);
  log.qty = q;
  expect(q.primaries).toBe(1);
  expect(q.numericInputs, "inputmode=numeric yalnız miktar alanı").toBe(1);
  expect(q.scrollWidth).toBeLessThanOrEqual(q.clientWidth);
  if (mobile) {
    expect(q.small, "miktar adımı: 48 px altı hedef").toEqual([]);
    expect(q.primaryGap ?? 99, "birincil düğme alt çubuğun hemen üstünde").toBeLessThanOrEqual(16);
    expect(q.primaryHeight ?? 0).toBeGreaterThanOrEqual(56);
  }
  await page.getByRole("button", { name: "Kabul et" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText("12 adet kabul edildi");
  expect(await taps(page), "kabul dokunuş bütçesi: Kabul et (1); teslim seçme +1 ≤ 3").toBeLessThanOrEqual(2);
  log.receiveTaps = await taps(page);

  // İkinci koli aynı teslimden (kalan 18 → 12 daha): "Sıradaki ürüne geç" → tara → kabul.
  await page.getByRole("button", { name: "Sıradaki ürüne geç" }).click();
  await page.waitForLoadState("networkidle");
  // Elle giriş tek ikincil yoldur: "Elle gir" bağlantısı ScanField'ı açar (tarama sayılmaz, aynı servis yolu); açıkken birincil düğme gizlenir.
  await page.getByRole("button", { name: "Elle gir" }).click();
  await expect(page.locator('[data-variant="primary"]:visible')).toHaveCount(0);
  await page.getByRole("textbox", { name: "Barkod" }).fill(BARCODE.koli);
  await page.getByRole("button", { name: "Onayla" }).click();
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("12");
  await expect(page.getByText("Okuttuğun ürün:")).toBeVisible();
  // Aynı koli yeniden okutulunca adet eklenir ve kalan (18) ile sınırlanır: 12 + 12 → 18.
  await scan(page, BARCODE.koli);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("18");
  await page.getByRole("textbox", { name: /^Gelen \(/ }).fill("12");
  await page.getByRole("button", { name: "Hasarlı ekle" }).click();
  await page.getByRole("textbox", { name: "Hasarlı adet" }).fill("2");
  await page.getByRole("button", { name: "Kabul et" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText("12 adet kabul edildi");
  await expect(page.getByText("Bunun 2 adedi hasarlı.")).toBeVisible();
  await expect(page.getByText("Kalan: 6")).toBeVisible();
  const lines = await db<{ received: string; damaged: string }>("SELECT received_quantity::text AS received, damaged_quantity::text AS damaged FROM public.inbound_receipt_lines WHERE receipt_id = $1", [fx.receiptId]);
  expect(lines[0]).toEqual({ received: "24.000000", damaged: "2.000000" });
  // Fazla okutma: kalan 6 iken stepper en çok 6'ya çıkar; sunucu kuralı ayrıca aşılamaz (actions.test.ts).
  await page.getByRole("button", { name: "Sıradaki ürüne geç" }).click();
  await page.waitForLoadState("networkidle");
  await scan(page, BARCODE.koli);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("6");
  await expect(page.getByRole("button", { name: /\+$/ }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Geri" }).click();

  // ---- Masaüstü liste: satır durumu, yeni teslim formu, kalite onayı ----------------------------------------------------------------
  await page.goto(`${base}/receipts`);
  const row = page.getByTestId("receipt-row").filter({ hasText: fx.receiptNo });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Kabul 24");
  await expect(row).toContainText("Hasarlı 2");
  await expect(row).toContainText("Kalan 6");
  await expect(page.getByText("Kişisel veri girmeyin.")).toBeVisible();
  // Yeni teslim: ürün ara → birim → miktar → satır → kaydet.
  await page.getByLabel("Tedarikçi referansı").fill(`E2E-IRS-2-${run}`);
  await page.getByLabel("Ürün", { exact: true }).fill(`E2E-${run}`);
  await page.getByRole("button", { name: new RegExp(`Somun ${run}`) }).click();
  await page.getByLabel("Beklenen miktar").fill("5");
  await page.getByRole("button", { name: "Satırı ekle" }).click();
  await expect(page.getByTestId("draft-lines")).toContainText(`Somun ${run} · 5`);
  await page.getByRole("button", { name: "Teslimi kaydet" }).click();
  await expect(page.getByText(/KBL-\d{4}-\d{6} kaydedildi\./)).toBeVisible();
  await expect(page.getByTestId("receipt-row").filter({ hasText: `E2E-IRS-2-${run}` })).toHaveCount(1);
  expect(await db("SELECT 1 FROM public.inbound_receipts WHERE tenant_id = $1 AND supplier_ref = $2 AND status = 'OPEN'", [fx.tenantId, `E2E-IRS-2-${run}`])).toHaveLength(1);

  // Kalite onayı (ConfirmDialog): bekleyen karantina AVAILABLE olur.
  const before = await db<{ q: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id IS NOT NULL AND s.stock_status='AVAILABLE'",
    [fx.tenantId, fx.itemId],
  );
  expect(Number(before[0]?.q)).toBe(0);
  await row.getByRole("button", { name: "Kalite onayı ver" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Kalite onayı ver" }).click();
  await expect(page.getByText(`${fx.receiptNo} onaylandı.`)).toBeVisible();
  const avail = await db<{ q: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.stock_status='AVAILABLE'",
    [fx.tenantId, fx.itemId],
  );
  expect(Number(avail[0]?.q), "kalite onayı sonrası AVAILABLE (24 − 2 hasarlı)").toBe(22);

  // ---- Görevli yerleştirme ---------------------------------------------------------------------------------------------------------
  await page.goto(`${base}/field/tasks`);
  const tasks = page.getByTestId("field-task");
  await expect(tasks.first()).toBeVisible();
  await tasks.first().getByRole("button", { name: "Üstlen" }).click();
  await expect(page.getByText("Görevi üstlendin.")).toBeVisible();
  await page.getByTestId("field-task").first().getByRole("link", { name: "Başla" }).click();
  await expect(page).toHaveURL(/\/field\/putaway\?task=/);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "1");
  await expect(page.getByTestId("task-card")).toContainText(`Vida ${run}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate("window.__taps = 0");
  await scan(page, BARCODE.baska); // yanlış ürün
  await expect(page.getByTestId("scan-alert")).toContainText("Bu ürün bu işte yok.");
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await page.evaluate("window.__taps = 0");
  await scan(page, BARCODE.tekli);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2");
  // Sayım kilidi: hedef lokasyon COUNTING → "Bu rafta sayım sürüyor."
  const session = randomUUID();
  await db("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, started_by) VALUES ($1,$2,$3,$4)", [fx.tenantId, session, fx.warehouseId, fx.membershipId]);
  await db("UPDATE public.location_count_locks SET status='COUNTING', count_session_id=$3, locked_at=now(), locked_by=$4 WHERE tenant_id=$1 AND location_id=$2", [fx.tenantId, fx.kilitId, session, fx.membershipId]);
  await scan(page, CODES.kilit);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await page.getByRole("button", { name: "Rafa koy" }).click();
  const locked = page.getByTestId("scan-alert");
  await expect(locked).toContainText("Bu rafta sayım sürüyor.");
  await expect(locked).toContainText("LOCATION_LOCKED");
  if (mobile) await page.screenshot({ path: path.join(OUT, `alert-locked-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await db("UPDATE public.location_count_locks SET status='IDLE', count_session_id=NULL, locked_at=NULL, locked_by=NULL WHERE tenant_id=$1 AND location_id=$2", [fx.tenantId, fx.kilitId]);
  // Doğru raf: onay ekranı miktarı görevle birebir sabit gösterir.
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2");
  await page.evaluate("window.__taps = 0");
  await scan(page, CODES.raf1);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await expect(page.getByTestId("fixed-qty")).toContainText("Görevdeki miktar:");
  const c3 = await measure(page);
  log.putawayConfirm = c3;
  expect(c3.primaries).toBe(1);
  expect(c3.scrollWidth).toBeLessThanOrEqual(c3.clientWidth);
  await page.getByRole("button", { name: "Rafa koy" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText(CODES.raf1);
  expect(await taps(page), "görevli yerleştirme: onay (1) ≤ 3").toBeLessThanOrEqual(3);
  log.putawayTaskTaps = await taps(page);
  await expect(page.getByText("Stok sayısı değişmedi; yalnız yeri değişti.")).toBeVisible();
  const onRaf1 = await db<{ q: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'",
    [fx.tenantId, fx.itemId, fx.raf1Id],
  );
  expect(Number(onRaf1[0]?.q)).toBeGreaterThan(0);

  // Kalan 6 adet: kalite kontrolü kapalı tenant'ta kabul doğrudan AVAILABLE olur (A-06 ayarı; fikstür SQL'i) → serbest yerleştirmeye mal çıkar.
  await db("UPDATE public.tenant_settings SET receiving_qc_enabled = false WHERE tenant_id = $1", [fx.tenantId]);
  await page.goto(`${base}/field/receive?receipt=${fx.receiptId}`);
  await page.waitForLoadState("networkidle");
  await scan(page, BARCODE.koli);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("6");
  await page.getByRole("button", { name: "Kabul et" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText("6 adet kabul edildi");
  await expect(page.getByText("Teslim tamam")).toBeVisible();

  // ---- Serbest yerleştirme: kaynak → ürün → hedef → onay ----------------------------------------------------------------------------
  const free = await db<{ q: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'",
    [fx.tenantId, fx.itemId, fx.kabulId],
  );
  const left = Number(free[0]?.q);
  expect(left, "KABUL rafında yerleştirilecek mal kaldı").toBeGreaterThan(0);
  await page.goto(`${base}/field/putaway?wh=${fx.warehouseId}`);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "1");
  await page.waitForLoadState("networkidle");
  await scan(page, `X${run}NOPE`);
  await expect(page.getByTestId("scan-alert")).toContainText("Bu kod sistemde yok.");
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await scan(page, CODES.kabul);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2");
  await scan(page, BARCODE.baska); // KABUL rafında bu üründen yok
  await expect(page.getByTestId("scan-alert")).toContainText("Bu rafta bu üründen yok.");
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await scan(page, BARCODE.koli); // koli adedi (12) kaynaktaki yerleştirilebilir miktarla (kalan) sınırlanır
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await scan(page, CODES.raf2);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "4");
  await expect(page.getByRole("textbox", { name: "Kaç adet?" })).toHaveValue(String(left));
  await page.getByRole("button", { name: "Rafa koy" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText(CODES.raf2);
  const onRaf2 = await db<{ q: string }>(
    "SELECT COALESCE(sum(b.quantity),0)::text AS q FROM public.stock_balances b JOIN public.stock_dimensions s ON s.tenant_id=b.tenant_id AND s.id=b.stock_dimension_id WHERE s.tenant_id=$1 AND s.item_id=$2 AND s.location_id=$3 AND s.stock_status='AVAILABLE'",
    [fx.tenantId, fx.itemId, fx.raf2Id],
  );
  expect(Number(onRaf2[0]?.q)).toBe(left);

  writeFileSync(path.join(OUT, `metrics-flow-${testInfo.project.name}.json`), JSON.stringify(log, null, 2));
  await screens(page, testInfo.project.name);
});

/** Ana ekran ölçümü: en büyük boş dikey bant ve boş alan oranı (mobile-shell expectBand/homeLayout ile aynı tanım; `.now-card` yalnız gerçek veri satırıysa içeriktir). */
async function homeMetrics(page: Page): Promise<{ band: number; emptyRatio: number; tileHeights: number[]; badge: number[]; descCut: boolean[]; descLines: number[]; blank: number[] }> {
  return page.evaluate(`(() => {
    const r = (el) => el.getBoundingClientRect();
    const bar = r(document.querySelector('[data-testid="app-bar"]')), nav = r(document.querySelector('[data-testid="bottom-nav"]'));
    const vis = (el) => { const b = r(el); return b.width > 0 && b.height > 0; };
    const area = { top: bar.bottom, bottom: nav.top };
    const spans = [];
    const add = (b) => { if (b.width > 0 && b.height > 0) spans.push([Math.max(b.top, area.top), Math.min(b.bottom, area.bottom)]); };
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (el.matches('a[href], button, summary, input, select, textarea, [tabindex="0"]')) { add(r(el)); continue; }
      if (el.tagName.toLowerCase() === 'svg') { add(r(el)); continue; }
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim() !== '') { const g = document.createRange(); g.selectNodeContents(n); for (const q of g.getClientRects()) add(q); }
    }
    const iv = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let cursor = area.top, best = 0;
    for (const [a, b] of iv) { best = Math.max(best, a - cursor); cursor = Math.max(cursor, b); }
    best = Math.max(best, area.bottom - cursor);
    const tiles = [...document.querySelectorAll('.task-grid > .task-item > [data-state]')].filter(vis);
    const parts = [r(document.querySelector('main header')), ...tiles.map(r)];
    const top = document.querySelector('.top-rows'); if (top && vis(top)) parts.push(r(top));
    const now = document.querySelector('.now-card[data-state="rows"]'); if (now && vis(now)) parts.push(r(now));
    const sp = parts.map((p) => [Math.max(p.top, area.top), Math.min(p.bottom, area.bottom)]).sort((a, b) => a[0] - b[0]);
    let covered = 0, cur = null;
    for (const [s, e] of sp) { if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e); else { if (cur) covered += cur[1] - cur[0]; cur = [s, e]; } }
    if (cur) covered += cur[1] - cur[0];
    const lines = (e) => Math.round(r(e).height / parseFloat(getComputedStyle(e).lineHeight));
    return {
      band: Math.round(best), emptyRatio: Math.round(((area.bottom - area.top - covered) / (area.bottom - area.top)) * 1000) / 1000,
      tileHeights: tiles.map((t) => Math.round(r(t).height)),
      badge: tiles.map((t) => Math.round(r(t.querySelector('.tile-badge')).width * 10) / 10),
      descCut: tiles.map((t) => { const d = t.querySelector('.tile-desc'); return d ? d.scrollWidth > d.clientWidth + 0.5 : true; }),
      descLines: tiles.map((t) => { const d = t.querySelector('.tile-desc'); return d ? lines(d) : 0; }),
      blank: tiles.map((t) => r(t).height - 28 - [...t.querySelectorAll('.tile-badge, .tile-title, .tile-desc')].reduce((a, e) => a + r(e).height, 0)),
    };
  })()`);
}

test("ana ekran 'Şimdi' kartı: bekleyen iş GERÇEK veriden (DB ile eşleşir); 2 sütun döşeme ve boşluk metrikleri; admin + toplayıcı görüntüleri", async ({ page, context }, testInfo) => {
  mkdirSync(OUT, { recursive: true });
  const fx = await seed();
  // Bekleyen iş fikstürü: ikinci açık teslim + iki açık PUTAWAY görevi (SQL; gerçek akışta kabul komutu doğurur). "Sıradaki" satırları DB'deki en eski işlerdir.
  const receipt2 = randomUUID();
  await db("INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by, status) VALUES ($1,$2,$3,$4,$5,(SELECT user_id FROM public.tenant_memberships WHERE id = $6),'OPEN')", [
    fx.tenantId, receipt2, fx.warehouseId, `KBL-E2E2-${run}`, `E2E-IRS-B-${run}`, fx.membershipId,
  ]);
  await db("INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) VALUES ($1, gen_random_uuid(), $2, 1, $3, $4, 1, 7)", [fx.tenantId, receipt2, fx.itemId, fx.unitId]);
  for (const q of [5, 8]) {
    await db("INSERT INTO public.warehouse_tasks (tenant_id, warehouse_id, kind, status, item_id, location_id, quantity, source_kind, source_id) VALUES ($1,$2,'PUTAWAY','OPEN',$3,$4,$5,'INBOUND_RECEIPT',$6)", [fx.tenantId, fx.warehouseId, fx.itemId, fx.kabulId, q, fx.receiptId]);
  }
  const adminM = (await db<{ id: string }>("SELECT m.id FROM public.tenant_memberships m JOIN public.membership_roles r ON r.tenant_id = m.tenant_id AND r.membership_id = m.id WHERE m.tenant_id = $1 AND r.role_key = 'TENANT_ADMIN' LIMIT 1", [fx.tenantId]))[0]?.id;
  const receiptCount = Number((await db<{ n: string }>("SELECT count(*)::text AS n FROM public.inbound_receipts WHERE tenant_id = $1 AND status = 'OPEN'", [fx.tenantId]))[0]?.n);
  const putCount = Number(
    (await db<{ n: string }>("SELECT count(*)::text AS n FROM public.warehouse_tasks WHERE tenant_id = $1 AND kind = 'PUTAWAY' AND (status = 'OPEN' OR (status = 'ASSIGNED' AND assigned_membership_id = $2))", [fx.tenantId, adminM ?? randomUUID()]))[0]?.n,
  );
  expect(receiptCount).toBeGreaterThan(1);
  expect(putCount).toBeGreaterThan(1);
  const nextReceipts = await db<{ number: string; supplier_ref: string | null; n: string }>(
    "SELECT r.number, r.supplier_ref, (SELECT count(*)::text FROM public.inbound_receipt_lines l WHERE l.tenant_id = r.tenant_id AND l.receipt_id = r.id) AS n FROM public.inbound_receipts r WHERE r.tenant_id = $1 AND r.status = 'OPEN' ORDER BY r.created_at, r.id LIMIT 2",
    [fx.tenantId],
  );
  const nextTasks = await db<{ name: string; quantity: string }>(
    "SELECT i.name, t.quantity::text AS quantity FROM public.warehouse_tasks t JOIN public.items i ON i.tenant_id = t.tenant_id AND i.id = t.item_id WHERE t.tenant_id = $1 AND t.kind = 'PUTAWAY' AND (t.status = 'OPEN' OR (t.status = 'ASSIGNED' AND t.assigned_membership_id = $2)) ORDER BY t.created_at, t.id LIMIT 2",
    [fx.tenantId, adminM ?? randomUUID()],
  );
  const recDetail = (r: { supplier_ref: string | null; n: string }): string => (r.supplier_ref === null ? `${r.n} kalem` : r.supplier_ref);
  const qtyText = (q: string): string => `${Number(q)} adet`;
  const mobile = isMobile(testInfo.project.name);
  const metrics: Record<string, unknown> = {};
  await login(page, "Yönetici");
  for (const [w, h] of [[360, 740], [390, 664], [390, 844], [430, 932]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/t/demo");
    const card = page.getByTestId("now-card");
    await expect(card).toHaveAttribute("data-state", "rows");
    // Satırlar DB'deki gerçek bekleyen işle eşleşir (uydurma sayı yok).
    await expect(page.getByTestId("now-receive")).toHaveAttribute("data-count", String(receiptCount));
    await expect(page.getByTestId("now-receive")).toContainText(`${receiptCount} teslim kabul bekliyor`);
    await expect(page.getByTestId("now-putaway")).toHaveAttribute("data-count", String(putCount));
    await expect(page.getByTestId("now-putaway")).toContainText(`${putCount} ürün yerleştirme bekliyor`);
    await expect(page.getByTestId("now-receive")).toHaveAttribute("href", "/t/demo/field/receive");
    // "Sıradaki" ayrıntıları DB'deki en eski açık işlerdir (uydurma yok); ikinci satır yalnız yüksek ekranda (≥ 880 px) görünür.
    await expect(page.getByTestId("now-receive-next")).toHaveText(`Sıradaki: ${nextReceipts[0]?.number} · ${recDetail(nextReceipts[0] as never)}`);
    await expect(page.getByTestId("now-putaway-next")).toHaveText(`Sıradaki: ${nextTasks[0]?.name} · ${qtyText(nextTasks[0]?.quantity ?? "0")}`);
    if (h >= 880) {
      await expect(page.getByTestId("now-receive-extra")).toContainText(`${nextReceipts[1]?.number}`);
      await expect(page.getByTestId("now-receive-extra")).toContainText(recDetail(nextReceipts[1] as never));
      await expect(page.getByTestId("now-putaway-extra")).toContainText(`${nextTasks[1]?.name}`);
      await expect(page.getByTestId("now-putaway-extra")).toContainText(qtyText(nextTasks[1]?.quantity ?? "0"));
    } else {
      await expect(page.getByTestId("now-receive-extra")).toBeHidden();
    }
    const m = await homeMetrics(page);
    metrics[`admin-${w}x${h}`] = m;
    // Çakışma yok: selam başlığı kartın üstünde, kart ızgaranın üstünde (içerik alana sığar; üst üste binen/kesilen içerik yok).
    const geo = await page.evaluate<{ headB: number; cardT: number; cardB: number; gridT: number }>(`(() => { const r = (e) => e.getBoundingClientRect(); const top = document.querySelector('.task-grid .top-rows'); return { headB: r(document.querySelector('main header')).bottom, cardT: r(document.querySelector('.now-card')).top, cardB: r(document.querySelector('.now-card')).bottom, gridT: r(top || document.querySelector('.task-grid')).top }; })()`);
    expect(geo.cardT, `${w}x${h}: Şimdi kartı selam başlığıyla çakışmaz`).toBeGreaterThanOrEqual(geo.headB - 0.5);
    expect(geo.gridT, `${w}x${h}: ızgara Şimdi kartıyla çakışmaz`).toBeGreaterThanOrEqual(geo.cardB - 0.5);
    // D-04 SIKI + D-04b + açıklama tek satır kesilmeden + ikon sabit/eşit; B-02 ve emptyRatio "bekleyen iş VAR" durumunda ASSERT.
    expect(Math.max(...m.tileHeights), `${w}x${h}: döşeme ≤ 140 (istisna yok)`).toBeLessThanOrEqual(140);
    expect(Math.min(...m.tileHeights), `${w}x${h}: döşeme ≥ ${h < 700 ? 72 : 88}`).toBeGreaterThanOrEqual(h < 700 ? 72 : 88);
    expect(new Set(m.badge).size, `${w}x${h}: ikon boyutu eşit`).toBe(1);
    expect(m.badge[0]).toBe(48);
    expect(m.descCut.some(Boolean), `${w}x${h}: açıklama kesilmemiş`).toBe(false);
    expect(m.descLines.every((n) => n === 1), `${w}x${h}: açıklama tek satır`).toBe(true);
    expect(Math.max(...m.blank), `${w}x${h}: D-04b döşeme içi boşluk ≤ 24`).toBeLessThanOrEqual(24);
    expect(Math.min(...m.blank), `${w}x${h}: içerik döşemeye sığar`).toBeGreaterThanOrEqual(-1);
    expect(m.band, `${w}x${h}: B-02 en büyük boş dikey bant ≤ 120 (bekleyen iş var)`).toBeLessThanOrEqual(120);
    expect(m.emptyRatio, `${w}x${h}: emptyRatio ≤ 0,15 (bekleyen iş var)`).toBeLessThanOrEqual(0.15);
    const pw = await measure(page);
    expect(pw.scrollWidth).toBeLessThanOrEqual(pw.clientWidth);
    expect(pw.small, `${w}x${h}: 48 px altı hedef`).toEqual([]);
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-home-admin-${w}x${h}.png`) });
  }
  // Toplayıcı (tek sütun kipi): görüntüler + taşma/hedef ölçümü; "Görevlerim" özeti bu kipin gerçek içeriğidir.
  await context.clearCookies();
  await login(page, "Toplayıcı");
  for (const [w, h] of [[360, 740], [390, 664], [390, 844], [430, 932]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/t/demo");
    await expect(page.getByTestId("now-card")).toHaveCount(0);
    const pw = await measure(page);
    metrics[`picker-${w}x${h}`] = pw;
    expect(pw.scrollWidth).toBeLessThanOrEqual(pw.clientWidth);
    expect(pw.small, `${w}x${h} toplayıcı: 48 px altı hedef`).toEqual([]);
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-home-picker-${w}x${h}.png`) });
  }
  writeFileSync(path.join(OUT, `metrics-home-pending-${testInfo.project.name}.json`), JSON.stringify(metrics, null, 2));
});

test("fikstür SQL hata iletisi parola/URL/argv içermez ve loopback dışına yazılmaz", async () => {
  const secret = `pw-${randomUUID()}`;
  // Kapalı loopback portu: psql bağlanamaz; ileti sterilize olmalı.
  let message = "";
  try {
    await db("SELECT 1", [], `postgresql://fx_user:${secret}@127.0.0.1:1/fxdb`);
  } catch (e) {
    message = String((e as Error).message);
  }
  expect(message, "hata üretilmeli").toContain("e2e:");
  for (const leak of [secret, "fx_user", "fxdb", "127.0.0.1", "postgresql://", "-c", "psql -", "PGPASSWORD"]) expect(message, `iletide '${leak}' yok`).not.toContain(leak);
  // Loopback olmayan sunucu: bağlanmadan reddedilir.
  let remote = "";
  try {
    await db("SELECT 1", [], `postgresql://u:${secret}@db.example.test:5432/x`);
  } catch (e) {
    remote = String((e as Error).message);
  }
  expect(remote).toContain("loopback değil");
  expect(remote).not.toContain(secret);
});

test("kamera taraması: Barkodu okut kamerayı açar; kod TEK kez işlenir (çift okuma yok); okuma kapalıyken gelen kod bildirilir", async ({ page }) => {
  const fx = await seed();
  await page.addInitScript(`
    window.__fakeCode = ""; window.__detects = 0;
    navigator.mediaDevices.getUserMedia = async () => { const c = document.createElement("canvas"); c.width = 64; c.height = 64; c.getContext("2d").fillRect(0, 0, 64, 64); return c.captureStream(5); };
  `);
  await login(page, "Yönetici");
  // login() başlatma betiği BarcodeDetector'ı siler; sahte olan sonradan (sayfa yüklemesinden önce) tanımlanır. Kod SÜREKLİ döner (kamera aynı barkodu karelerce görür).
  await page.addInitScript(`window.BarcodeDetector = class { async detect() { window.__detects++; return window.__fakeCode ? [{ rawValue: window.__fakeCode }] : []; } };`);
  await page.goto(`/t/demo/field/receive?receipt=${fx.receiptId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Barkodu okut" }).click();
  await expect(page.getByTestId("camera-overlay")).toBeVisible();
  await page.evaluate(`window.__fakeCode = ${JSON.stringify(BARCODE.koli)}`);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await expect(page.getByTestId("camera-overlay")).toHaveCount(0);
  // Çift okuma yok: akış ve zamanlayıcı durdu (algılama sayısı artmaz) ve miktar 12 kalır (ikinci okuma 24 yapardı).
  const before = await page.evaluate<number>("window.__detects");
  await page.waitForTimeout(900);
  expect(await page.evaluate<number>("window.__detects"), "okuma sonrası kamera algılaması durdu").toBe(before);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("12");

  // Okuma kapalıyken (uyarı açık) gelen kamera kodu kullanıcıya bildirilir, sessizce düşmez.
  await page.goto(`/t/demo/field/receive?receipt=${fx.receiptId}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(`window.__fakeCode = ""`);
  await page.getByRole("button", { name: "Barkodu okut" }).click();
  await expect(page.getByTestId("camera-overlay")).toBeVisible();
  await scan(page, "0000000000000");
  await expect(page.getByTestId("scan-alert")).toBeVisible();
  await page.evaluate(`window.__fakeCode = ${JSON.stringify(BARCODE.koli)}`);
  await expect(page.getByTestId("camera-dropped")).toBeVisible();
  await expect(page.getByTestId("camera-dropped")).toContainText("okuma şu an kapalıydı");
  await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
  await page.getByRole("button", { name: "Tamam" }).click();
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "2"); // kod işlenmedi: yine tarama adımı
});

test("yetkisiz kullanıcı: kilit ekranı gerekçe + Yardım çağır yolu; tek birincil", async ({ page }, testInfo) => {
  mkdirSync(OUT, { recursive: true });
  await login(page, "Salt okunur");
  for (const size of [{ n: "390", w: 390, h: 844 }, { n: "390s", w: 390, h: 664 }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    for (const [flow, title, reason, other] of [
      ["receive", "Bu iş sana kapalı", "Mal kabul için yetkin yok", "Yerleştirme için"],
      ["putaway", "Yerleştirme sana kapalı", "Yerleştirme için yetkin yok", "Mal kabul için"],
    ] as const) {
      await page.goto(`/t/demo/field/${flow}`);
      // Her kilit ekranı KENDİ gerekçesini söyler (yerleştirme kabulün metnini kullanmaz) ve yanlış adım sayısı göstermez.
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.locator("main")).toContainText(reason);
      await expect(page.locator("main")).not.toContainText(other);
      await expect(page.getByTestId("step-label")).toHaveCount(0);
      await expect(page.getByTestId("help-link")).toHaveAttribute("href", "/help");
      await expect(page.locator('[data-variant="primary"]:visible')).toHaveCount(1);
      const m = await measure(page);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
      expect(m.small, `${size.n} ${flow} kilit: 48 px altı hedef`).toEqual([]);
      if (isMobile(testInfo.project.name)) await page.screenshot({ path: path.join(OUT, `final-${size.n}-locked-${flow}.png`) });
    }
  }
});
