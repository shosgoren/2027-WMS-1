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

const OUT = process.env.T313_OUT ?? path.resolve(import.meta.dirname, "../../.artifacts/t-313");
const SIZES = [
  { name: "360", width: 360, height: 740 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
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
 * Fikstür/gözlem SQL'i migration rolüyle `psql` üzerinden çalışır (e2e'de `pg` sürücüsü yasaktır, I-02); parametreler ($n) güvenli biçimde
 * değişmez metne çevrilir (yalnızca bu dosyanın sentetik değerleri). SELECT sonuçları JSON satırlarıdır.
 */
type Row = Record<string, string>;
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}
async function db<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL_DIRECT;
  if (url === undefined || url === "") throw new Error("e2e: DATABASE_URL_DIRECT yok (globalSetup .env yükler)");
  const sql = text.replace(/\$(\d+)/g, (_m, i: string) => lit(params[Number(i) - 1]));
  const isSelect = /^\s*SELECT/i.test(sql);
  const wrapped = isSelect ? `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t` : sql;
  const out = execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-c", wrapped], { encoding: "utf8" });
  return isSelect ? (JSON.parse(out.trim() || "[]") as T[]) : [];
}

async function seed(): Promise<Fx> {
  const n = names(randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase());
  run = n.run;
  CODES = n.codes;
  BARCODE = n.barcode;
  {
    const q = db;
    const tenantId = (await q<{ id: string }>("SELECT id FROM public.tenants WHERE slug = 'demo'"))[0]?.id;
    if (tenantId === undefined) throw new Error("e2e: demo tenant yok");
    const membershipId = (await q<{ id: string }>("SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 ORDER BY joined_at LIMIT 1", [tenantId]))[0]?.id as string;
    let warehouseId = (await q<{ id: string }>("SELECT id FROM public.warehouses WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY code LIMIT 1", [tenantId]))[0]?.id;
    if (warehouseId === undefined) {
      warehouseId = randomUUID();
      await q("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E depo')", [tenantId, warehouseId, `E2E${run}`]);
    }
    const unitId = randomUUID();
    await q("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1,$2,$3,'E2E adet')", [tenantId, unitId, `EA${run}`]);
    const mkItem = async (name: string): Promise<string> => {
      const id = randomUUID();
      await q("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode, quantity_scale) VALUES ($1,$2,$3,$4,$5,'NONE',0)", [tenantId, id, `E2E-${run}-${name.slice(0, 1)}`, name, unitId]);
      return id;
    };
    const itemId = await mkItem(`Vida ${run}`);
    const otherItemId = await mkItem(`Somun ${run}`);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode, quantity) VALUES ($1, gen_random_uuid(), $2, $3, 12)", [tenantId, itemId, BARCODE.koli]);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3)", [tenantId, itemId, BARCODE.tekli]);
    await q("INSERT INTO public.item_barcodes (tenant_id, id, item_id, barcode) VALUES ($1, gen_random_uuid(), $2, $3)", [tenantId, otherItemId, BARCODE.baska]);
    const mkLoc = async (code: string, kind: "RECEIVING" | "STORAGE"): Promise<string> => {
      const id = randomUUID();
      await q("INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind) VALUES ($1,$2,$3,NULL,$4,$5,0,$6)", [tenantId, id, warehouseId, code, `E2E ${code}`, kind]);
      return id;
    };
    const kabulId = await mkLoc(CODES.kabul, "RECEIVING");
    const raf1Id = await mkLoc(CODES.raf1, "STORAGE");
    const raf2Id = await mkLoc(CODES.raf2, "STORAGE");
    const kilitId = await mkLoc(CODES.kilit, "STORAGE");
    const receiptId = randomUUID();
    const receiptNo = `KBL-E2E-${run}`;
    await q("INSERT INTO public.inbound_receipts (tenant_id, id, warehouse_id, number, supplier_ref, created_by, status) VALUES ($1,$2,$3,$4,'E2E-IRS-1',(SELECT user_id FROM public.tenant_memberships WHERE id = $5),'OPEN')", [
      tenantId, receiptId, warehouseId, receiptNo, membershipId,
    ]);
    await q("INSERT INTO public.inbound_receipt_lines (tenant_id, id, receipt_id, line_no, item_id, unit_id, conversion_factor, expected_quantity) VALUES ($1, gen_random_uuid(), $2, 1, $3, $4, 1, 30)", [
      tenantId, receiptId, itemId, unitId,
    ]);
    return { tenantId, warehouseId, unitId, itemId, otherItemId, kabulId, raf1Id, raf2Id, kilitId, receiptId, receiptNo, membershipId };
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
    };
  })()`);
}

async function login(page: Page, label: string): Promise<void> {
  await page.addInitScript("window.__taps = 0; document.addEventListener('pointerdown', () => { window.__taps++; }, true);");
  await page.goto("/");
  await page.getByRole("button", { name: `${label} olarak gir` }).click();
  await expect(page).toHaveURL(/\/t\/demo$/);
}

const isMobile = (name: string): boolean => name === "mobile";

test("kabul → kalite onayı → yerleştirme (görevli ve serbest) + yanlış tarama ve sayım kilidi engelleri", async ({ page }, testInfo) => {
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
  expect(await db("SELECT 1 FROM public.documents WHERE tenant_id = $1 AND source_kind = 'INBOUND_RECEIPT'", [fx.tenantId])).toHaveLength(0);

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

  // İkinci koli aynı teslimden (kalan 18 → 12 daha): "Sıradaki ürün" → tara → kabul.
  await page.getByRole("button", { name: "Sıradaki ürün" }).click();
  await page.waitForLoadState("networkidle");
  await scan(page, BARCODE.koli);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("12");
  // Aynı koli yeniden okutulunca adet eklenir ve kalan (18) ile sınırlanır: 12 + 12 → 18.
  await scan(page, BARCODE.koli);
  await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toHaveValue("18");
  await page.getByRole("textbox", { name: /^Gelen \(/ }).fill("12");
  await page.getByRole("button", { name: "Hasarlı var" }).click();
  await page.getByRole("textbox", { name: "Hasarlı adet" }).fill("2");
  await page.getByRole("button", { name: "Kabul et" }).click();
  await expect(page.getByTestId("saved-summary")).toContainText("12 adet kabul edildi");
  await expect(page.getByText("Bunun 2 adedi hasarlı.")).toBeVisible();
  await expect(page.getByText("Kalan: 6")).toBeVisible();
  const lines = await db<{ received: string; damaged: string }>("SELECT received_quantity::text AS received, damaged_quantity::text AS damaged FROM public.inbound_receipt_lines WHERE receipt_id = $1", [fx.receiptId]);
  expect(lines[0]).toEqual({ received: "24.000000", damaged: "2.000000" });
  // Fazla okutma: kalan 6 iken stepper en çok 6'ya çıkar; sunucu kuralı ayrıca aşılamaz (actions.test.ts).
  await page.getByRole("button", { name: "Sıradaki ürün" }).click();
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
  await page.getByLabel("Tedarikçi referansı").fill("E2E-IRS-2");
  await page.getByLabel("Ürün", { exact: true }).fill(`E2E-${run}`);
  await page.getByRole("button", { name: new RegExp(`Somun ${run}`) }).click();
  await page.getByLabel("Beklenen miktar").fill("5");
  await page.getByRole("button", { name: "Satırı ekle" }).click();
  await expect(page.getByTestId("draft-lines")).toContainText(`Somun ${run} · 5`);
  await page.getByRole("button", { name: "Teslimi kaydet" }).click();
  await expect(page.getByText(/KBL-\d{4}-\d{6} kaydedildi\./)).toBeVisible();
  await expect(page.getByTestId("receipt-row").filter({ hasText: "E2E-IRS-2" })).toHaveCount(1);
  expect(await db("SELECT 1 FROM public.inbound_receipts WHERE tenant_id = $1 AND supplier_ref = 'E2E-IRS-2' AND status = 'OPEN'", [fx.tenantId])).toHaveLength(1);

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
  // Sayım kilidi: hedef lokasyon COUNTING → "Bu lokasyonda sayım sürüyor."
  const session = randomUUID();
  await db("INSERT INTO public.count_sessions (tenant_id, id, warehouse_id, started_by) VALUES ($1,$2,$3,$4)", [fx.tenantId, session, fx.warehouseId, fx.membershipId]);
  await db("UPDATE public.location_count_locks SET status='COUNTING', count_session_id=$3, locked_at=now(), locked_by=$4 WHERE tenant_id=$1 AND location_id=$2", [fx.tenantId, fx.kilitId, session, fx.membershipId]);
  await scan(page, CODES.kilit);
  await expect(page.getByTestId("flow-step")).toHaveAttribute("data-step", "3");
  await page.getByRole("button", { name: "Rafa koy" }).click();
  const locked = page.getByTestId("scan-alert");
  await expect(locked).toContainText("Bu lokasyonda sayım sürüyor.");
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
});

test("ekran ölçümleri (360/390/430): kabul, yerleştirme, teslim listesi, yanlış tarama uyarısı; görüntüler mobil projede", async ({ page }, testInfo) => {
  const mobile = isMobile(testInfo.project.name);
  mkdirSync(OUT, { recursive: true });
  const fx = await seed();
  await login(page, "Yönetici");
  const metrics: Record<string, unknown> = {};
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const shot = async (name: string): Promise<void> => {
      const m = await measure(page);
      metrics[`${size.name}-${name}`] = m;
      expect(m.scrollWidth, `${size.name} ${name}: yatay taşma`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.small, `${size.name} ${name}: 48 px altı hedef`).toEqual([]);
      if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-${name}.png`) });
    };
    await page.goto("/t/demo/field/receive");
    await shot("receive-pick");
    await page.goto(`/t/demo/field/receive?receipt=${fx.receiptId}`);
    await page.waitForLoadState("networkidle");
    await shot("receive-scan");
    await scan(page, "0000000000000");
    await expect(page.getByTestId("scan-alert")).toBeVisible();
    const a = await page.getByTestId("scan-alert").boundingBox();
    metrics[`${size.name}-alert`] = a;
    if (mobile) await page.screenshot({ path: path.join(OUT, `final-${size.name}-wrong-scan-alert.png`) });
    await page.getByRole("button", { name: "Anladım, tekrar okut" }).click();
    await scan(page, BARCODE.koli);
    await expect(page.getByRole("textbox", { name: /^Gelen \(/ })).toBeVisible();
    await page.getByRole("button", { name: "Hasarlı var" }).click();
    await shot("receive-qty");
    await page.goto(`/t/demo/field/putaway?wh=${fx.warehouseId}`);
    await page.waitForLoadState("networkidle");
    await shot("putaway-source");
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
  writeFileSync(path.join(OUT, `metrics-screens-${testInfo.project.name}.json`), JSON.stringify(metrics, null, 2));
});
