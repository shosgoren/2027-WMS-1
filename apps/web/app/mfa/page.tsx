import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { MfaNotice, MfaSetupForm, MfaVerifyForm } from "../auth-forms.tsx";
import { safeNext } from "../../lib/safe-redirect.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

const TWO_FACTOR_COOKIE = /^(?:__Secure-)?better-auth\.two_factor$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function sessionUser(h: Headers): Promise<{ email: string; twoFactorEnabled: boolean }> {
  const { getAuthService } = await import("@wms/auth");
  const base = process.env.BETTER_AUTH_URL;
  if (base === undefined || base.trim() === "") throw new Error("BETTER_AUTH_URL is not configured");
  const res = await getAuthService().handler(
    new Request(new URL("/api/auth/get-session", base), { headers: { cookie: h.get("cookie") ?? "" } }),
  );
  if (!res.ok) throw new Error(`get-session failed: ${res.status}`);
  const body = (await res.json()) as { user?: { email?: unknown; twoFactorEnabled?: unknown } } | null;
  const email = typeof body?.user?.email === "string" ? body.user.email.toLowerCase() : "";
  return { email, twoFactorEnabled: body?.user?.twoFactorEnabled === true };
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
  // Karar sunucuda: oturumdaki kullanıcıyı Better Auth'tan oku (principal yalnızca kimlik/MFA durumu taşır).
  const user = await sessionUser(await headers());
  const demoDomain = process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null;
  if (demoDomain !== null && user.email.endsWith(`@${demoDomain}`)) return <MfaNotice kind="demo" next={next} />; // M9
  if (principal.mfaVerified || user.twoFactorEnabled) return <MfaNotice kind="enabled" next={next} />;
  return <MfaSetupForm next={next} />;
}
