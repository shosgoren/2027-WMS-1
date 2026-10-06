// Barkod komutları ve çözümleme (T-208; A-68, A-69, A-88, 04 §Ürün).
//
// - Yazma `settings.manage`, çözümleme `stock.view`. `tenant_id` bağlamdan; tüm erişim `tx` üzerinden.
// - A-69: barkod tenant içinde tekil DEĞİLDİR; aynı (ürün, birim, barkod) üçlüsü tekildir. Çözümleme tek (ürün, birim,
//   miktar) eşleşmesi vermiyorsa SESSİZCE ilk ürüne atanmaz: `VALIDATION_FAILED`/`BARCODE_AMBIGUOUS` + aday listesi.
//   Adaylar yalnızca çağıranın tenant'ındandır (RLS).
// - A-88: `removeBarcode` gerçek silmedir.
// - Çözümleme: ham metin tam eşleşme + (GS1 önek/GS varsa her zaman, yoksa yalnızca tam eşleşme yokken) GTIN'in
//   depodaki biçimleriyle (GTIN-14/13/12; 8 hane yalnızca önekle) eşleşme; ikisi birleştirilip belirsizlik denetimi yapılır (A-108 önerisi). ARŞİVLİ ürünler çözümlemeye girmez (A-107 önerisi).
import { sql } from "drizzle-orm";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery, type AccessTx } from "../identity/access.ts";
import { gtinLookupForms, parseGs1, type Gs1FailureReason, type Gs1Parsed } from "./gs1.ts";
import { assertQuantityScale } from "./quantity.ts";
import { loadItem, parseText, parseUuid, type CatalogCommandParams } from "./units.ts";

const BARCODE_MAX = 128;
const MAX_CANDIDATES = 20;

export interface BarcodeCandidate {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitId: string;
  readonly unitCode: string;
  /** Okutma başına miktar (kanonik; barkodda yoksa `"1"`). */
  readonly quantity: string;
}

/** `BARCODE_AMBIGUOUS`; gövdeye yalnızca `code`/`detail` girer, adaylar çağıran kodun (UI) kullanımı içindir. */
export class BarcodeAmbiguousError extends AppError {
  override name = "BarcodeAmbiguousError";
  readonly candidates: readonly BarcodeCandidate[];
  constructor(candidates: readonly BarcodeCandidate[]) {
    super("VALIDATION_FAILED", { detail: "BARCODE_AMBIGUOUS" });
    this.candidates = candidates;
  }
}

export interface ResolvedBarcode {
  readonly itemId: string;
  /** Barkodun birimi; barkodda birim yoksa ürünün temel birimi. */
  readonly unitId: string;
  /** Okutma başına miktar (barkodun birimi cinsinden); barkodda yoksa `"1"`. */
  readonly quantity: string;
  /** Çözümleme GS1 GTIN'i üzerinden yapıldıysa ayrıştırılmış öğeler (lot, SKT, seri, adet). */
  readonly gs1?: Gs1Parsed;
}

function parseBarcode(raw: unknown): string {
  const v = parseText(raw, BARCODE_MAX);
  if (v.includes("\u001d")) throw new AppError("VALIDATION_FAILED");
  return v;
}

export async function addBarcode(
  params: CatalogCommandParams,
  input: { readonly itemId: string; readonly unitId?: string | null; readonly barcode: string; readonly quantity?: string | null },
): Promise<{ readonly barcodeId: string }> {
  const itemId = parseUuid(input.itemId);
  const unitId = input.unitId === undefined || input.unitId === null ? null : parseUuid(input.unitId);
  const barcode = parseBarcode(input.barcode);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const item = await loadItem(tx, actor.tenantId, itemId, "share");
    if (item === undefined) throw new AppError("NOT_FOUND");
    if (item.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    if (unitId !== null) {
      const unit = await tx.execute<{ status: string }>(
        sql`SELECT status FROM public.units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${unitId}::uuid`,
      );
      if (unit[0] === undefined) throw new AppError("NOT_FOUND");
      if (unit[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    }
    let quantity: string | null = null;
    if (input.quantity !== undefined && input.quantity !== null) {
      const inBase = unitId === null || unitId === item.base_unit_id;
      // Temel birimde ürünün ölçeği; başka birimde en çok 6 ondalık (numeric(20,6) sınırı). > 0 ve ≤ 14 tam hane.
      quantity = assertQuantityScale(input.quantity, inBase ? item.quantity_scale : 6, "positive");
    }
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.item_barcodes (tenant_id, id, item_id, unit_id, barcode, quantity)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${itemId}::uuid, ${unitId}::uuid, ${barcode}, ${quantity}::numeric)
          ON CONFLICT ON CONSTRAINT item_barcodes_tenant_item_unit_barcode_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "item_barcode.added",
      actorUserId: actor.userId,
      entityType: "item_barcode",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { item_id: itemId, unit_id: unitId, barcode, quantity },
    });
    return { barcodeId: id };
  });
}

export async function removeBarcode(params: CatalogCommandParams, input: { readonly barcodeId: string }): Promise<{ readonly barcodeId: string }> {
  const barcodeId = parseUuid(input.barcodeId);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "settings.manage" }, async (tx, actor) => {
    const rows = await tx.execute<{ item_id: string; unit_id: string | null; barcode: string }>(
      sql`DELETE FROM public.item_barcodes WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${barcodeId}::uuid
          RETURNING item_id, unit_id, barcode`,
    );
    const r = rows[0];
    if (r === undefined) throw new AppError("NOT_FOUND");
    await appendAudit(tx, {
      action: "item_barcode.removed",
      actorUserId: actor.userId,
      entityType: "item_barcode",
      entityId: barcodeId,
      requestId: requestId ?? null,
      changeSummary: { item_id: r.item_id, unit_id: r.unit_id, barcode: r.barcode },
    });
    return { barcodeId };
  });
}

type MatchRow = {
  readonly item_id: string;
  readonly item_code: string;
  readonly item_name: string;
  readonly unit_id: string;
  readonly unit_code: string;
  readonly quantity: string | null;
};

async function findMatches(tx: AccessTx, tenantId: string, values: readonly string[]): Promise<MatchRow[]> {
  const list = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  const rows = await tx.execute<MatchRow>(
    sql`SELECT b.item_id, i.code AS item_code, i.name AS item_name,
               COALESCE(b.unit_id, i.base_unit_id) AS unit_id, u.code AS unit_code, b.quantity::text AS quantity
          FROM public.item_barcodes b
          JOIN public.items i ON i.tenant_id = b.tenant_id AND i.id = b.item_id
          JOIN public.units u ON u.tenant_id = i.tenant_id AND u.id = COALESCE(b.unit_id, i.base_unit_id)
         WHERE b.tenant_id = ${tenantId}::uuid AND b.barcode IN (${list}) AND i.status = 'ACTIVE'
         ORDER BY i.code, u.code, b.id
         LIMIT ${MAX_CANDIDATES + 1}`,
  );
  return [...rows];
}

/** `numeric(20,6)` metni (`"12.000000"`) → kanonik (`"12"`); boş miktar `"1"`. */
function canonicalQuantity(q: string | null): string {
  if (q === null) return "1";
  return q.includes(".") ? q.replace(/0+$/, "").replace(/\.$/, "") : q;
}

/** GS1 çözümleme başarısız ve eşleşme yok: `NOT_FOUND`; GS1 neden reddedildi `gs1Reason` ile görünür (gövdeye girmez). */
export class BarcodeNotFoundError extends AppError {
  override name = "BarcodeNotFoundError";
  readonly gs1Reason: Gs1FailureReason | null;
  constructor(gs1Reason: Gs1FailureReason | null) {
    super("NOT_FOUND");
    this.gs1Reason = gs1Reason;
  }
}

/**
 * Ham taranan metni tek (ürün, birim, miktar) eşleşmesine çözer. Çağıranın açık tenant transaction'ında (`tx`)
 * çalışır; `tenantId` açıkça verilir ve sorguda `b.tenant_id` filtresi + RLS birlikte uygulanır (yanlış/başka tenant
 * kimliği → `NOT_FOUND`). Eşleşme yok → `NOT_FOUND`; birden çok farklı (ürün, birim, miktar) → `BarcodeAmbiguousError`.
 *
 * GS1 önceliği: metin ÖNEK (`]C1`/`]d2`) ya da FNC1 (GS) taşıyorsa GS1 yorumu güçlüdür → ham metin eşleşmesi VE GTIN
 * eşleşmesi birleştirilip belirsizlik denetiminden geçer (tam eşleşme sessizce kazanmaz). Önek/GS yoksa ("01…" ile
 * başlayan düz barkod olabilir) GS1 yalnızca tam eşleşme YOKSA denenir; tam eşleşme varsa GS1 yorumlanmaz.
 */
export async function resolveBarcode(tx: AccessTx, tenantId: string, raw: string): Promise<ResolvedBarcode> {
  const code = typeof raw === "string" ? raw.trim() : "";
  if (code === "" || code.length > 256) throw new AppError("VALIDATION_FAILED");
  const tenant = parseUuid(tenantId);

  let matches = await findMatches(tx, tenant, [code]);
  let gs1: Gs1Parsed | undefined;
  let gs1Reason: Gs1FailureReason | null = null;
  const parsed = parseGs1(code);
  if (parsed.ok) {
    const strong = parsed.symbologyPrefix || parsed.hasFnc1;
    if (parsed.gtin !== undefined && (strong || matches.length === 0)) {
      const viaGtin = await findMatches(tx, tenant, gtinLookupForms(parsed.gtin, parsed.symbologyPrefix));
      if (viaGtin.length > 0) {
        gs1 = parsed;
        matches = [...matches, ...viaGtin];
      }
    }
  } else if (matches.length === 0 && parsed.reason !== "EMPTY") {
    gs1Reason = parsed.reason;
  }
  if (matches.length === 0) throw new BarcodeNotFoundError(gs1Reason);

  const distinct = new Map<string, MatchRow>();
  for (const m of matches) distinct.set(`${m.item_id}|${m.unit_id}|${canonicalQuantity(m.quantity)}`, m);
  if (distinct.size > 1) {
    const candidates: BarcodeCandidate[] = [...distinct.values()].slice(0, MAX_CANDIDATES).map((m) => ({
      itemId: m.item_id,
      itemCode: m.item_code,
      itemName: m.item_name,
      unitId: m.unit_id,
      unitCode: m.unit_code,
      quantity: canonicalQuantity(m.quantity),
    }));
    throw new BarcodeAmbiguousError(candidates);
  }
  const only = [...distinct.values()][0] as MatchRow;
  return { itemId: only.item_id, unitId: only.unit_id, quantity: canonicalQuantity(only.quantity), ...(gs1 === undefined ? {} : { gs1 }) };
}

export function resolveBarcodeQuery(params: Omit<CatalogCommandParams, "requestId">, raw: string): Promise<ResolvedBarcode> {
  return runTenantQuery({ ...params, permission: "stock.view" }, (tx, actor) => resolveBarcode(tx, actor.tenantId, raw));
}
