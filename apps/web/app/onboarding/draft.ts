// Sihirbaz taslağı (T-122): ad + `requestId`, kısa ömürlü httpOnly çerezde (URL'de ad yok). "use server" DEĞİL:
// yalnızca sunucu bileşeni/eylemleri içe aktarır, dışa açık uç nokta değildir.
import { cookies } from "next/headers";

export interface WizardDraft {
  readonly name: string;
  readonly requestId: string;
}

export const DRAFT_COOKIE = "wms_onboarding";
export const DRAFT_COOKIE_PATH = "/onboarding";
export const DRAFT_TTL_SECONDS = 60 * 30;
export const NAME_MAX = 120; // domain `NAME_MAX` ile aynı; asıl doğrulama domain'dedir.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validDraftName(name: string): boolean {
  const n = name.trim();
  return n !== "" && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(n);
}

/** Çerezdeki taslak; yok/bozuksa `null`. */
export async function readWizardDraft(): Promise<WizardDraft | null> {
  const raw = (await cookies()).get(DRAFT_COOKIE)?.value;
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as { name?: unknown; requestId?: unknown };
    if (typeof v.name !== "string" || typeof v.requestId !== "string" || !validDraftName(v.name) || !UUID_RE.test(v.requestId)) return null;
    return { name: v.name.trim(), requestId: v.requestId };
  } catch {
    return null;
  }
}
