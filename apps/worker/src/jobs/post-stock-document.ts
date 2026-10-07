// `stock.document.post` işi (T-222; ADR-018 §6, ADR-019 §1-§3): eşik üstü belgeyi istek sahibi adına tek transaction'da işler.
// Handler yalnızca bağlar: iş kuralı `@wms/domain/stock/jobs`'tadır (UI ve worker aynı domain komutunu çağırır).
//
// Süresi dolan `active` işlerin kurtarılması (pg-boss bakım eşdeğeri) tür bağımsızdır: `queue-maintenance.ts` (T-281).
import { type AsyncPostingContext, type ConsumeOnceFn, runAsyncPosting } from "@wms/domain/stock/jobs";
import type { AccessDbClient } from "@wms/domain/identity/access";
import type { Logger } from "@wms/shared/log";
import type { JobHandler } from "@wms/shared/queue";

export interface PostStockDocumentDeps {
  readonly db: AccessDbClient;
  readonly consumeOnce: ConsumeOnceFn;
  readonly logger: Logger;
}

/** Kuyruk işi → domain. Hata sınıflandırması (kalıcı/geçici) domain'dedir; kalıcı hata `permanent: true` taşır. */
export function createPostStockDocumentHandler(deps: PostStockDocumentDeps): JobHandler<"stock.document.post"> {
  return (ctx) => runAsyncPosting(deps, ctx as unknown as AsyncPostingContext);
}
