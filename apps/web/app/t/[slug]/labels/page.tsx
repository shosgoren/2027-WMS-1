import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { getAppDb } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import {
  LABEL_TEMPLATE_VERSION,
  LabelCharsetError,
  LabelTooLongError,
  MAX_LABELS_PER_DOCUMENT,
  loadLabelSource,
  toSvgPages,
  toZplDocument,
} from "@wms/domain/labels";
import { LabelPreview } from "./label-preview.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("labels");
  return { title: t("title") };
}

type Search = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
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
    const source = await loadLabelSource(call, { itemId: one(sp.item), warehouseId: one(sp.warehouse), locationId: one(sp.location), subtree: one(sp.subtree) === "1" });
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
