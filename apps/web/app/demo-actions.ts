"use server";
// Demo girişi (T-122; A-43, güvenlik incelemesi M10). Yalnızca `WMS_ENV=staging` + `DEMO_MODE=1` + geçerli `DEMO_PASSWORD`
// varken çalışır; aksi halde `FORBIDDEN`. İstemciden YALNIZCA rol anahtarı gelir (e-posta/parola gelmez): hesap, T-123'teki
// `DEMO_ROLES` sabitinden seçilir; parola sunucuda `DEMO_PASSWORD`'den okunur ve normal Better Auth girişine (`/sign-in/email`,
// kendi hız sınırı ve güvenlik olaylarıyla) verilir. Parola yanıta, hata mesajına ve loga HİÇBİR yolda girmez (hata yolu
// dahil yalnızca genel kod döner). Eylem `action-guard` ile sarılır (Origin, IP/kullanıcı hız sınırı, hata maskeleme).
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { getAuthService } from "@wms/auth";
import { DEMO_ROLES, loadDemoSeedConfig } from "@wms/domain/demo/seed";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { AppError } from "@wms/shared/errors";
import { createProductionGuard } from "../lib/action-guard.ts";

const schema = z.object({ role: z.enum(ROLE_KEYS) }).strict();

const guardedAction = createProductionGuard(() => headers());

/** Landing ve eylem aynı koşulu kullanır (login sayfasındaki "Demo ortamı" bandıyla aynı: A-43). */
function demoLoginAllowed(env: NodeJS.ProcessEnv): string | undefined {
  if (env.WMS_ENV?.trim() !== "staging" || env.DEMO_MODE?.trim() !== "1") return undefined;
  const config = loadDemoSeedConfig(env);
  return config.enabled ? config.password : undefined;
}

interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "lax" | "strict" | "none";
  readonly domain?: string;
}

/** `Set-Cookie` satırı → `cookies().set` seçenekleri. Değer `cookies().set` tarafından yeniden kodlanır, bu yüzden çözülür. */
function parseSetCookie(raw: string): ParsedCookie | undefined {
  const [pair = "", ...attrs] = raw.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(pair.slice(eq + 1));
  } catch {
    return undefined;
  }
  let out: ParsedCookie = { name: pair.slice(0, eq), value };
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i === -1 ? attr : attr.slice(0, i)).toLowerCase();
    const val = i === -1 ? "" : attr.slice(i + 1);
    if (key === "path") out = { ...out, path: val };
    else if (key === "max-age" && Number.isFinite(Number(val))) out = { ...out, maxAge: Number(val) };
    else if (key === "expires" && !Number.isNaN(Date.parse(val))) out = { ...out, expires: new Date(val) };
    else if (key === "httponly") out = { ...out, httpOnly: true };
    else if (key === "secure") out = { ...out, secure: true };
    else if (key === "domain") out = { ...out, domain: val };
    else if (key === "samesite") {
      const s = val.toLowerCase();
      if (s === "lax" || s === "strict" || s === "none") out = { ...out, sameSite: s };
    }
  }
  return out;
}

export async function demoSignInAction(raw: unknown) {
  return guardedAction({ schema, requireAuth: false }, async (input, ctx) => {
    const password = demoLoginAllowed(process.env);
    if (password === undefined) throw new AppError("FORBIDDEN");
    const incoming = await headers();
    const forward = new Headers({ "content-type": "application/json", origin: ctx.origin });
    // Better Auth hız sınırı `fly-client-ip`ten anahtarlanır (auth `ipAddressHeaders`): gerçek istemci adresi iletilir.
    for (const name of ["user-agent", "fly-client-ip"]) {
      const v = incoming.get(name);
      if (v !== null) forward.set(name, v);
    }
    const response = await getAuthService().handler(
      new Request(`${ctx.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: forward,
        body: JSON.stringify({ email: DEMO_ROLES[input.role], password }),
      }),
    );
    if (response.status === 429) throw new AppError("RATE_LIMITED", { retryable: true });
    if (response.status >= 500) throw new AppError("INTERNAL");
    if (response.status !== 200) throw new AppError("UNAUTHENTICATED");
    const body = (await response.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null;
    // Demo hesaplarında 2FA kurulamaz (A-43); 2FA istenirse oturum kurulmadı demektir.
    if (body === null || body.twoFactorRedirect === true) throw new AppError("UNAUTHENTICATED");
    const store = await cookies();
    let sessionSet = false;
    for (const line of response.headers.getSetCookie()) {
      const c = parseSetCookie(line);
      if (c === undefined) continue;
      const { name, value, ...options } = c;
      store.set(name, value, options);
      if (/session_token$/.test(name)) sessionSet = true;
    }
    if (!sessionSet) throw new AppError("INTERNAL");
    return { redirectTo: "/" as const };
  })(raw);
}
