import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { MfaSetupForm, MfaVerifyForm } from "../auth-forms.tsx";
import { safeNext } from "../../lib/safe-redirect.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

const TWO_FACTOR_COOKIE = /^(?:__Secure-)?better-auth\.two_factor$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Mod sunucuda belirlenir: oturum var → kurulum (zorunlu rolde MFA_REQUIRED sonrası buraya gelinir, A-38/M5);
// oturum yok ama geçici 2FA çerezi var → giriş ikinci adımı; hiçbiri yok → giriş.
export default async function MfaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeNext(first((await searchParams).next));
  const { getAuthService } = await import("@wms/auth");
  const principal = await getAuthService().getPrincipal(await headers());

  if (principal === null) {
    const pending = (await cookies()).getAll().some((c) => TWO_FACTOR_COOKIE.test(c.name) && c.value !== "");
    if (!pending) redirect(`/login?next=${encodeURIComponent(next)}`);
    return <MfaVerifyForm next={next} />;
  }
  const demoEmailDomain = process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null;
  return <MfaSetupForm next={next} demoEmailDomain={demoEmailDomain} />;
}
