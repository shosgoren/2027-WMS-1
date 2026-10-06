import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb } from "@wms/db";
import { listMembers, listPendingInvitations } from "@wms/domain/identity/member-queries";
import { ROLE_KEYS } from "@wms/domain/identity/permissions";
import { AppError } from "@wms/shared/errors";
import { MembersView } from "./members-view.tsx";
import type { PendingView } from "./members-view.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members");
  return { title: t("title") };
}

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { getAuthService } = await import("@wms/auth");
  const principal = await getAuthService().getPrincipal(await headers());
  if (principal === null) redirect(`/login?next=${encodeURIComponent(`/t/${slug}/members`)}`);
  const db = getAppDb();
  const members = await listMembers({ db, principal, tenantSlug: slug }, { demoEmailDomain: process.env.DEMO_EMAIL_DOMAIN?.trim().toLowerCase() || null });

  // Yönetim yetkisi kararı sunucudadır: bekleyen davet listesi `users.manage` ister; FORBIDDEN → eylemler kilitli.
  let pending: PendingView[] | null = null;
  try {
    const rows = await listPendingInvitations({ db, principal, tenantSlug: slug });
    pending = rows.map((r) => ({ invitationId: r.invitationId, email: r.email, role: r.role, expiresAt: r.expiresAt.toISOString(), invitedBy: r.invitedBy }));
  } catch (e) {
    if (!(e instanceof AppError && e.code === "FORBIDDEN" && e.detail === undefined)) throw e;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <MembersView slug={slug} selfUserId={principal.userId} members={members.map((m) => ({ membershipId: m.membershipId, userId: m.userId, displayName: m.displayName, email: m.email, roles: m.roles, isOwner: m.isOwner, isDemo: m.isDemo, resetLinkAvailable: m.resetLinkAvailable }))} pending={pending} roleKeys={[...ROLE_KEYS]} />
    </main>
  );
}
