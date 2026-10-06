// Denetim kaydı CSV export (T-126; I-13, I-14, I-16). İnce giriş: yetki/kesit/parçalama `@wms/domain` `openAuditExport`'ta.
// Sıra: routeGuard (IP/kullanıcı sınırı) → `audit.view` + A-39 yeniden doğrulama (yetkisiz/süresi dolmuş çağıran sayaç tüketmez)
// → kullanıcı başına dakikada 2 export → akış. İstemci slug'ı hiçbir sayaç anahtarı değildir (T-127).
import { ensureRecentAuth, getAuthService } from "../../../../../../lib/auth-service.ts";
import { getAppDb } from "@wms/db";
import { openAuditExport, validateAuditFilters, type AuditFilters } from "@wms/domain/audit/audit-query";
import { runTenantQuery } from "@wms/domain/identity/access";
import { AppError } from "@wms/shared/errors";
import { createProductionRouteGuard } from "../../../../../../lib/action-guard.ts";
import { RateLimitedError, createDbRateLimitStore, createRateLimiter } from "../../../../../../lib/rate-limit.ts";

export const dynamic = "force-dynamic";

const EXPORTS_PER_MINUTE = 2;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const guard = createProductionRouteGuard();

function filtersOf(url: URL): AuditFilters {
  const f: { from?: string; to?: string; action?: string } = {};
  for (const k of ["from", "to", "action"] as const) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== "") f[k] = v;
  }
  return f;
}

/** Tarayıcı gezinmesinde (indirme bağlantısı) hata sayfaya taşınır; API istemcileri JSON alır. */
function wantsHtml(request: Request): boolean {
  return request.headers.get("sec-fetch-dest") === "document" || (request.headers.get("accept") ?? "").includes("text/html");
}

function back(slug: string, code: string): Response {
  return new Response(null, { status: 303, headers: { location: `/t/${encodeURIComponent(slug)}/audit?error=${code}`, "cache-control": "no-store" } });
}

export async function GET(request: Request, nextCtx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await nextCtx.params;
  return guard({}, async (req, ctx) => {
    const principal = ctx.principal;
    if (principal === null) throw new AppError("UNAUTHENTICATED");
    // CSRF/çapraz site indirme: GET durum değiştirir (export olayı + sayaç); yalnızca aynı site gezinmesi/doğrudan açma. Sayaç tüketmez.
    const site = req.headers.get("sec-fetch-site");
    if (site !== "same-origin" && site !== "none") throw new AppError("FORBIDDEN");
    if (!SLUG_RE.test(slug)) throw new AppError("NOT_FOUND");
    const db = getAppDb();
    const access = { db, principal, tenantSlug: slug, recentAuth: () => ensureRecentAuth(req.headers) };
    try {
      // Ön denetim: üyelik + `audit.view` + MFA + yeniden doğrulama; geçmeyen çağıran export sayacı tüketmez.
      await runTenantQuery({ ...access, permission: "audit.view" }, () => Promise.resolve());
      const filters = validateAuditFilters(filtersOf(new URL(req.url))); // sayaçtan ÖNCE (geçersiz istek hak yemez)
      try {
        await createRateLimiter({
          store: createDbRateLimitStore(db),
          secret: process.env.BETTER_AUTH_SECRET ?? "",
          limits: { user: EXPORTS_PER_MINUTE },
        }).check("user", `audit-export:${principal.userId}`);
      } catch (e) {
        if (e instanceof RateLimitedError && wantsHtml(req)) return back(slug, "rate_limited");
        throw e;
      }
      const { stream } = await openAuditExport(access, {
        filters,
        requestId: ctx.requestId,
        // Sonraki parçalardan önce oturum hâlâ geçerli mi (çıkış/iptal akışı keser).
        revalidate: async () => {
          if ((await getAuthService().getPrincipal(req.headers)) === null) throw new AppError("UNAUTHENTICATED");
        },
        // Başlıklar gönderildikten sonra durum değişmez: dosya kesik kalır; maskeli günlük (yalnızca ad/kod, G-09).
        onError: (e) => {
          console.error(JSON.stringify({ level: "error", msg: "audit export stream failed", requestId: ctx.requestId, error: e instanceof Error ? e.name : typeof e, code: e instanceof AppError ? e.code : undefined }));
        },
      });
      const day = new Date().toISOString().slice(0, 10);
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="audit-${slug}-${day}.csv"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": ctx.requestId,
        },
      });
    } catch (e) {
      if (e instanceof AppError && wantsHtml(req)) {
        if (e.code === "UNAUTHENTICATED" && e.detail === "RECENT_AUTH_REQUIRED") return back(slug, "recent_auth_required");
        if (e.code === "FORBIDDEN" && e.detail !== "MFA_REQUIRED") return back(slug, "forbidden");
      }
      throw e;
    }
  })(request);
}
