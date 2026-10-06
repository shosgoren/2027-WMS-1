"use server";
// Davet kabul eylemi (T-117). Oturum varsa mevcut hesapla (e-posta birebir ve doğrulanmış), yoksa `newAccount` ile hesap
// açılarak kabul edilir. Dönüş yolu YALNIZCA `safeNext` ile (M10).
import { z } from "zod";
import { createInvitedAccount } from "@wms/auth";
import { acceptInvitation } from "@wms/domain/identity/invitations";
import { getAppDb } from "@wms/db";
import { headers } from "next/headers";
import { createProductionGuard } from "../../../lib/action-guard.ts";
import { safeNext } from "../../../lib/safe-redirect.ts";

const acceptSchema = z
  .object({
    token: z.string().min(1).max(256),
    name: z.string().min(1).max(200).optional(),
    password: z.string().min(1).max(128).optional(),
    next: z.string().max(2048).optional(),
  })
  .strict();

const guardedAction = createProductionGuard(() => headers());

export async function acceptInvitationAction(raw: unknown) {
  return guardedAction({ schema: acceptSchema, requireAuth: false }, async (input, ctx) => {
    const demoDomain = process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null;
    const newAccount = input.name !== undefined && input.password !== undefined ? { name: input.name, password: input.password } : undefined;
    const result = await acceptInvitation(
      {
        db: getAppDb(),
        token: input.token,
        principal: ctx.principal,
        ...(newAccount === undefined ? {} : { newAccount }),
        requestId: ctx.requestId,
      },
      { createInvitedAccount, demoEmailDomain: demoDomain },
    );
    const next = input.next === undefined ? "/" : safeNext(input.next);
    return {
      tenantSlug: result.tenantSlug,
      // Hesap bu akışta açıldıysa oturum yoktur (giriş ayrı adım); dönüş yolu doğrulanmış `next` ya da çalışma alanı.
      redirectTo: next !== "/" ? next : `/t/${result.tenantSlug}`,
      signedIn: ctx.principal !== null,
    };
  })(raw);
}
