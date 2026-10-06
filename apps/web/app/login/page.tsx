import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Banner } from "@wms/ui";
import { LoginForm } from "../auth-forms.tsx";
import { safeNext } from "../../lib/safe-redirect.ts";

// Ortam bayrakları istek anında okunur (derleme anında değil).
export const dynamic = "force-dynamic";

// `next` davet belirteci taşıyabilir: dış kaynaklara Referer sızmasın.
export const metadata: Metadata = { referrer: "no-referrer" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext(first((await searchParams).next));

  const { getAuthService } = await import("@wms/auth");
  if ((await getAuthService().getPrincipal(await headers())) !== null) redirect(next);

  // A-43: demo uyarısı yalnızca sunucuda karar verilir; bayraklar yokken demo metni hiç render edilmez.
  const demo = process.env.DEMO_MODE === "1" && process.env.WMS_ENV === "staging";
  const socialEnabled = process.env.AUTH_SOCIAL_ENABLED === "true";
  const t = await getTranslations("auth");

  return <LoginForm next={next} socialEnabled={socialEnabled} banner={demo ? <Banner kind="warning">{t("login.demoBanner")}</Banner> : undefined} />;
}
