import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { getItem, listItemBarcodes } from "@wms/domain/catalog";
import { listUnits } from "@wms/domain/catalog/units";
import { getLocationTree } from "@wms/domain/warehouse";
import type { LocationRow } from "@wms/domain/warehouse";
import { AppError } from "@wms/shared/errors";
// `@wms/domain/labels` dışa aktarımı kart dosya listesinde olmayan packages/domain/package.json'a ihtiyaç duyar (Bulgu); o zamana dek göreli içe aktarım.
import {
  LABEL_TEMPLATE_VERSION,
  LabelCharsetError,
  LabelTooLongError,
  MAX_LABELS_PER_DOCUMENT,
  toSvgPages,
  toZplDocument,
  type LabelData,
  type LabelTemplate,
} from "../../../../../../packages/domain/src/labels/index.ts";
import { LabelPreview } from "./label-preview.tsx";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TREE_PAGE = 200;
const TREE_MAX_PAGES = 20;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("labels");
  return { title: t("title") };
}

type Search = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

interface Source {
  readonly template: LabelTemplate;
  readonly datas: readonly LabelData[];
  readonly name: string;
}

/** Kaynak seçimi: `?item=<id>` ya da `?warehouse=<id>&location=<id>[&subtree=1]` (kök olmadan: depodaki tüm lokasyonlar). A-T312-5. */
async function loadSource(call: { db: ReturnType<typeof getAppDb>; principal: never; tenantSlug: string }, sp: Search): Promise<Source | null> {
  const itemId = one(sp.item);
  const warehouseId = one(sp.warehouse);
  const locationId = one(sp.location);
  if (itemId !== undefined) {
    if (!UUID_RE.test(itemId)) notFound();
    const item = await getItem(call, { itemId });
    const [barcodes, units] = await Promise.all([listItemBarcodes(call, item.id), listUnits(call)]);
    const base = units.find((u) => u.id === item.baseUnitId);
    // Birincil barkod (A-T312-6): temel birimde, okutma başına 1 olan ilk barkod; yoksa ilk barkod; hiç yoksa ürün kodu basılır.
    const primary = barcodes.find((b) => b.unitId === item.baseUnitId && b.quantity === "1") ?? barcodes[0];
    return { template: "product", name: `urun-${item.code}`, datas: [{ code: item.code, name: item.name, unit: base?.code ?? "", barcode: primary?.barcode ?? null }] };
  }
  if (warehouseId !== undefined) {
    if (!UUID_RE.test(warehouseId) || (locationId !== undefined && !UUID_RE.test(locationId))) notFound();
    const all: LocationRow[] = [];
    let after: { depth: number; code: string; id: string } | undefined;
    for (let p = 0; p < TREE_MAX_PAGES; p++) {
      const page = await getLocationTree(call, { warehouseId, limit: TREE_PAGE, ...(after === undefined ? {} : { after }) });
      all.push(...page.items);
      if (page.next === null) break;
      after = page.next;
    }
    let chosen: readonly LocationRow[] = all;
    if (locationId !== undefined) {
      const root = all.find((l) => l.id === locationId);
      if (root === undefined) notFound();
      if (one(sp.subtree) === "1") {
        const ids = new Set([root.id]);
        // Ağaç derinlik sıralıdır: ebeveyn her zaman çocuktan önce gelir.
        const sub = all.filter((l) => {
          if (l.id === root.id) return true;
          if (l.parentId !== null && ids.has(l.parentId)) {
            ids.add(l.id);
            return true;
          }
          return false;
        });
        chosen = sub;
      } else chosen = [root];
    }
    if (chosen.length === 0) notFound();
    return { template: "location", name: `lokasyon-${chosen[0]?.code ?? "etiket"}`, datas: chosen.map((l) => ({ code: l.code, name: l.name })) };
  }
  return null;
}

export default async function LabelsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await getTranslations("labels");
  const { getAuthService } = await import("../../../../lib/auth-service.ts");
  const principal = await getAuthService().getPrincipal(await headers());
  const qs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
  const returnTo = `/t/${encodeURIComponent(slug)}/labels${qs.size > 0 ? `?${qs.toString()}` : ""}`;
  if (principal === null) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const copiesRaw = one(sp.copies);
  const copies = copiesRaw === undefined ? 1 : /^\d{1,4}$/.test(copiesRaw) ? Number(copiesRaw) : 0;
  const call = { db: getAppDb(), principal, tenantSlug: slug };

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <h1 className="break-words text-2xl font-extrabold text-ink">{t("title")}</h1>
      {children}
    </main>
  );

  try {
    if (copies < 1) return shell(<Banner kind="error"><p>{t("errors.copies", { max: MAX_LABELS_PER_DOCUMENT })}</p></Banner>);
    const source = await loadSource(call as never, sp);
    if (source === null) {
      return shell(
        <Banner kind="info">
          <p>{t("noSource")}</p>
          <p className="mt-1">{t("noSourceAction")}</p>
        </Banner>,
      );
    }
    let pages: readonly string[];
    let zpl: string;
    try {
      pages = toSvgPages(source.template, source.datas, copies);
      zpl = toZplDocument(source.template, source.datas, copies);
    } catch (e) {
      if (e instanceof LabelCharsetError) return shell(<Banner kind="error"><p>{t("errors.charset")}</p><p className="mt-1">{t("errors.charsetAction")}</p></Banner>);
      if (e instanceof LabelTooLongError) return shell(<Banner kind="error"><p>{t("errors.tooLong")}</p><p className="mt-1">{t("errors.tooLongAction")}</p></Banner>);
      if (e instanceof AppError && e.code === "VALIDATION_FAILED") return shell(<Banner kind="error"><p>{t("errors.copies", { max: MAX_LABELS_PER_DOCUMENT })}</p></Banner>);
      throw e;
    }
    return shell(
      <LabelPreview
        pages={pages}
        zpl={zpl}
        fileName={`${source.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.zpl`}
        templateVersion={LABEL_TEMPLATE_VERSION[source.template]}
        bridgeEnabled={process.env.LABEL_LOCAL_BRIDGE_ENABLED === "true"}
      />,
    );
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "NOT_FOUND") notFound();
      if (e.code === "FORBIDDEN" && e.detail === "MFA_REQUIRED") redirect(`/mfa?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(returnTo)}`);
      if (e.code === "FORBIDDEN") {
        return shell(<Banner kind="warning"><p>{t("locked")}</p><p className="mt-1">{t("lockedAction")}</p></Banner>);
      }
    }
    throw e;
  }
}
