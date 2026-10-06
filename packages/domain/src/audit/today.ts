// "Bugün yaptıkların" genel yüzeyi (T-122a; A-65). Uygulama `today-impl.ts`'tedir; `now` enjeksiyonu genel API'de YOK.
import type { TenantAccessParams } from "../identity/access.ts";
import { listMyActionsTodayAt, type ListMyActionsOptions, type MyActionsPage } from "./today-impl.ts";

export { AUDIT_OTHER_KEY, TODAY_ACTIONS_DEFAULT_LIMIT, TODAY_ACTIONS_MAX_LIMIT, summaryKeyFor } from "./today-impl.ts";
export type { MyActionRow, MyActionsCursor, MyActionsPage } from "./today-impl.ts";
export type PublicListMyActionsOptions = ListMyActionsOptions;

export function listMyActionsToday(
  params: Omit<TenantAccessParams, "permission" | "recentAuth">,
  options: ListMyActionsOptions = {},
): Promise<MyActionsPage> {
  return listMyActionsTodayAt(params, { limit: options.limit, cursor: options.cursor } as ListMyActionsOptions, new Date());
}
