// AC-04 — bağımsız kabul testi (T-128, qa-verifier). Uygulayıcının testlerinden (T-126/T-127) bağımsız yazıldı.
// katman: api-route, export
//
// AC-04: "Tenant A, B'nin ID'sini kullanır → API, DB, dosya, cache, export reddeder". Bu dosya `/api/t/[slug]/**` route
// handler'larını (dosya sisteminden DİNAMİK listelenir) ve denetim kaydı export'unu kanıtlar. Mock'lar YALNIZCA kimlik/oturum
// çözümüdür (`lib/auth-service`); route sarmalayıcısı (`routeGuard`: hız sınırı, kimlik), yetki, RLS, sayaç ve akış GERÇEKTİR.
// Veriler sentetik (G-09). Sonda "güvenlik (AC-04 değil)" bölümü: T-127 hız sınırı eşiği ve CSP başlığı.
//
// Gövde notu: kart "404 gövdesiz" ister; uygulama güvenli JSON hata gövdesi döner ({error:{code:NOT_FOUND,…,requestId}}).
// Test varlık SIZMAMASINI doğrular: B'nin slug'ı ile var olmayan slug yanıtı (durum, başlıklar, gövde) birebir aynıdır ve
// B'ye özgü hiçbir veri içermez.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { readIntEnv, redactErrorChain } from "../harness/env.ts";

// Kimlik: istek başlığı `x-test-user` = oturumun kullanıcı kimliği (yok = oturumsuz). Başka hiçbir bağımlılık taklit edilmez.
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../../packages/db/src/index.ts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAppDb: () => h.db }));
vi.mock("../../../apps/web/lib/auth-service.ts", () => ({
  ensureRecentAuth: () => Promise.resolve(),
  getAuthService: () => ({
    getPrincipal: (headers: Headers) => {
      const u = headers.get("x-test-user");
      return Promise.resolve(u === null ? null : { userId: u, mfaVerified: true });
    },
  }),
}));
import { createRateLimiter, createDbRateLimitStore, RateLimitedError } from "../../../apps/web/lib/rate-limit.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const WEB_ROOT = path.resolve(import.meta.dirname, "../../../apps/web");
const ROUTES_ROOT = path.resolve(import.meta.dirname, "../../../apps/web/app/api/t/[slug]");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];
type Handler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;

let app: DbClient;
let adm: pg.Client;
const rnd = (): string => randomBytes(6).toString("hex");

interface Fx {
  tenant: string;
  slug: string;
  admin: string;
  manager: string;
  picker: string;
  marker: string;
  rows: number;
}

async function mkMember(tenant: string, role: string, name: string): Promise<string> {
  const r = await adm.query<{ id: string }>("INSERT INTO public.users (name, email, email_verified) VALUES ($1, $2, true) RETURNING id", [name, `t128-${rnd()}@example.test`]);
  const userId = (r.rows[0] as { id: string }).id;
  const m = await adm.query<{ id: string }>("INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', false) RETURNING id", [tenant, userId]);
  await adm.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [tenant, (m.rows[0] as { id: string }).id, role]);
  return userId;
}

async function mkTenant(label: string, rows: number): Promise<Fx> {
  const tenant = randomUUID();
  const slug = `t128-${label.toLowerCase()}-${rnd()}`;
  const marker = `SECRET-${label}-${rnd()}`; // yalnızca bu tenant'ın satırlarında bulunur
  await adm.query("INSERT INTO public.tenants (id, slug, name) VALUES ($1, $2, $3)", [tenant, slug, `T128 ${label} ${marker}`]);
  await adm.query("INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status) VALUES ($1, 'tr', 'Europe/Istanbul', 'COMPLETED')", [tenant]);
  const admin = await mkMember(tenant, "TENANT_ADMIN", `Yonetici ${label}`);
  const manager = await mkMember(tenant, "WAREHOUSE_MANAGER", `Depocu ${label}`);
  const picker = await mkMember(tenant, "PICKER", `Toplayici ${label}`);
  await adm.query(
    `INSERT INTO public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, reason, change_summary)
     SELECT $1, $2, 'member.invited', 'invitation', gen_random_uuid()::text, $3, jsonb_build_object('marker', $3::text) FROM generate_series(1, $4)`,
    [tenant, admin, marker, rows],
  );
  return { tenant, slug, admin, manager, picker, marker, rows };
}

/** Her çağrı ayrı kullanıcı (export sayacı kullanıcı başınadır) ve ayrı IP (IP kovası paylaşılmaz). */
let ipCounter = 0;
const nextIp = (): string => `198.51.100.${(ipCounter++ % 250) + 1}`;
function request(url: string, init: { method?: Method; user?: string | null; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers({ "fly-client-ip": nextIp(), "sec-fetch-site": "same-origin", accept: "*/*", ...init.headers });
  if (init.user !== undefined && init.user !== null) headers.set("x-test-user", init.user);
  if ((init.method ?? "GET") !== "GET") headers.set("origin", ORIGIN);
  return new Request(url, { method: init.method ?? "GET", headers });
}
const exportUrl = (slug: string, query = ""): string => `${ORIGIN}/api/t/${slug}/audit/export${query}`;

/** requestId gövdeden çıkarılır: iki yanıtın karşılaştırılabilir yüzü. */
async function face(res: Response): Promise<{ status: number; type: string | null; body: unknown }> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
    const err = (body as { error?: Record<string, unknown> }).error;
    if (err !== undefined) delete err.requestId;
  } catch {
    /* gövde JSON değil: ham metin karşılaştırılır */
  }
  return { status: res.status, type: res.headers.get("content-type"), body };
}

/** `apps/web/app/api/t/[slug]` altındaki her route.ts (dinamik). */
function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (/^route\.[cm]?[jt]sx?$/.test(name)) out.push(full);
  }
  return out.sort();
}

let A: Fx;
let B: Fx;
let exportGet: Handler;

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  try {
    await adm.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [env.databaseUrl, env.databaseUrlDirect])}`);
  }
  h.db = app;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex"); // sentetik, koşu başına (gitleaks: literal sır yok)
  process.env.BETTER_AUTH_URL = ORIGIN;
  A = await mkTenant("A", 30);
  B = await mkTenant("B", 20);
  exportGet = (await import("../../../apps/web/app/api/t/[slug]/audit/export/route.ts")).GET as Handler;
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

const callExport = (slug: string, user: string | null, query = "", headers: Record<string, string> = {}): Promise<Response> =>
  exportGet(request(exportUrl(slug, query), { user, headers }), { params: Promise.resolve({ slug }) });

describe("AC-04 API route katmanı: /api/t/[slug]/** (dinamik liste)", () => {
  it("@AC-04 her route handler: A oturumu + B slug'ı -> 404, B'ye özgü veri yok, var olmayan slug ile birebir aynı yanıt; oturumsuz -> 401", async () => {
    const files = listRouteFiles(ROUTES_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(path.join("audit", "export", "route.ts")))).toBe(true);
    const missingSlug = `t128-yok-${rnd()}`;
    let exercised = 0;
    for (const file of files) {
      const rel = path.relative(ROUTES_ROOT, path.dirname(file)).split(path.sep).join("/");
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      const methods = METHODS.filter((m) => typeof mod[m] === "function");
      expect(methods.length, `${rel}: hiç HTTP yöntemi dışa verilmemiş`).toBeGreaterThan(0);
      for (const m of methods) {
        const handler = mod[m] as Handler;
        const url = (slug: string): string => `${ORIGIN}/api/t/${slug}/${rel}`;
        const call = (slug: string, user: string | null): Promise<Response> => handler(request(url(slug), { method: m, user }), { params: Promise.resolve({ slug }) });
        const onB = await call(B.slug, A.admin);
        const bodyOnB = await onB.clone().text();
        expect(onB.status, `${m} ${rel} A->B`).toBe(404);
        for (const leak of [B.marker, B.tenant, B.admin, B.slug, "T128 B"]) expect(bodyOnB, `${m} ${rel}: ${leak}`).not.toContain(leak);
        // Varlık sızmaz: B'nin slug'ı ile hiç var olmamış slug aynı yüzü gösterir.
        expect(await face(onB)).toEqual(await face(await call(missingSlug, A.admin)));
        // Oturumsuz: slug var olsun ya da olmasın 401, aynı yüz.
        const anonB = await call(B.slug, null);
        expect(anonB.status, `${m} ${rel} anon`).toBe(401);
        expect(await face(anonB)).toEqual(await face(await call(missingSlug, null)));
        expect((await call(A.slug, null)).status).toBe(401);
        exercised++;
      }
    }
    expect(exercised).toBeGreaterThan(0);
  }, 120_000);

  it("@AC-04 yetkisiz kullanıcı hiçbir yanıtta B'nin varlığını ayırt ettirmez: A'nın PICKER'ı B slug'ında 404, kendi slug'ında 403", async () => {
    const onB = await callExport(B.slug, A.picker);
    expect(onB.status).toBe(404);
    expect(await face(onB)).toEqual(await face(await callExport(`t128-yok-${rnd()}`, A.picker)));
    expect((await callExport(A.slug, A.picker)).status).toBe(403);
  });
});

describe("AC-04 export katmanı", () => {
  it("@AC-04 A'nın export'unda B'ye ait hiçbir satır/işaret yok; satır sayısı = A'nın satırları", async () => {
    const res = await callExport(A.slug, A.admin);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain(A.marker);
    for (const leak of [B.marker, B.tenant, B.admin, B.slug, "T128 B", "Yonetici B"]) expect(csv, leak).not.toContain(leak);
    const dataLines = csv.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "").slice(1);
    const stored = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action <> 'audit.exported'", [A.tenant])).rows[0]?.n);
    expect(dataLines.filter((l) => l.includes(A.marker))).toHaveLength(A.rows);
    expect(dataLines.length).toBeGreaterThanOrEqual(stored);
  });

  it("@AC-04 sorgu parametresiyle tenant zorlama yok sayılır: A slug'ı + tenant_id=B yalnızca A verisi; B slug'ı + tenant_id=A -> 404", async () => {
    const forced = `?tenant_id=${B.tenant}&tenantId=${B.tenant}&tenant=${B.slug}&slug=${B.slug}&tenant_id[]=${B.tenant}`;
    const own = await callExport(A.slug, A.manager, forced);
    expect(own.status).toBe(200);
    const csv = await own.text();
    expect(csv).toContain(A.marker);
    for (const leak of [B.marker, B.tenant, B.slug]) expect(csv, leak).not.toContain(leak);
    const cross = await callExport(B.slug, A.admin, `?tenant_id=${A.tenant}&tenantId=${A.tenant}&tenant=${A.slug}`);
    expect(cross.status).toBe(404);
    const body = await cross.text();
    for (const leak of [B.marker, B.tenant, "member.invited"]) expect(body, leak).not.toContain(leak);
    // Filtre alanı da tenant sızdırmaz: action filtresi tenant kapsamını genişletmez.
    const filtered = await callExport(A.slug, A.admin, `?action=member.invited&to=${new Date().toISOString().slice(0, 10)}`);
    expect(filtered.status).toBe(200);
    expect(await filtered.text()).not.toContain(B.marker);
  });

  it("@AC-04 yetkisiz rol 403 (export olayı yazılmaz); A kullanıcısı B slug'ında 404 ve B'de audit.exported olayı oluşmaz", async () => {
    const beforeB = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'audit.exported'", [B.tenant])).rows[0]?.n);
    expect((await callExport(A.slug, A.picker)).status).toBe(403);
    expect((await callExport(B.slug, A.admin)).status).toBe(404);
    expect((await callExport(B.slug, A.picker)).status).toBe(404);
    const afterB = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE tenant_id = $1 AND action = 'audit.exported'", [B.tenant])).rows[0]?.n);
    expect(afterB).toBe(beforeB);
    const pickerEvents = Number((await adm.query<{ n: string }>("SELECT count(*) AS n FROM public.audit_logs WHERE action = 'audit.exported' AND actor_user_id = $1", [A.picker])).rows[0]?.n);
    expect(pickerEvents).toBe(0);
  });

  it("@AC-04 aynı kullanıcıdan eşzamanlı 6 export: tam 2'si 200 (dakikada 2), kalanı 429; hiçbir yanıtta B verisi yok", async () => {
    // Dakika sınırına yakınsa pencere kayar: bir sonraki dakikayı bekle (deterministik sayım).
    const s = new Date().getSeconds();
    if (s >= 54) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
    const user = await mkMember(A.tenant, "WAREHOUSE_MANAGER", "Eszamanli Depocu");
    const results = await Promise.all(Array.from({ length: 6 }, () => callExport(A.slug, user)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
    for (const r of results) {
      const text = await r.text();
      expect(text).not.toContain(B.marker);
      if (r.status === 429) expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    }
  }, 120_000);
});

describe("güvenlik (AC-04 değil): T-127 hız sınırı eşiği ve CSP", () => {
  const RL_SECRET = randomBytes(32).toString("hex"); // sentetik, koşu başına
  const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
  const limiter = (limits: { ip?: number; user?: number; tenant?: number }) =>
    createRateLimiter({ store: createDbRateLimitStore(app as unknown as Parameters<typeof createDbRateLimitStore>[0]), secret: RL_SECRET, now: () => NOW, limits });

  it("eşik: N izinli, N+1 RATE_LIMITED (retryAfterSeconds 1..60); başka özne bağımsız", async () => {
    const l = limiter({ ip: 3 });
    const subject = `t128-${rnd()}`;
    for (let i = 0; i < 3; i++) await l.check("ip", subject);
    const err = await l.check("ip", subject).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((err as RateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(60);
    await l.check("ip", `t128-${rnd()}`);
  });

  it("eşzamanlı 25 istek, eşik 7: tam 7 izinli (atomik sayaç, iki ayrı sınırlayıcı örneği)", async () => {
    const l1 = limiter({ user: 7 });
    const l2 = limiter({ user: 7 });
    const subject = `t128-${rnd()}`;
    const out = await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? l1 : l2).check("user", subject).then(() => "ok", (e: unknown) => (e instanceof RateLimitedError ? "limited" : "err"))));
    expect(out.filter((x) => x === "ok")).toHaveLength(7);
    expect(out.filter((x) => x === "limited")).toHaveLength(18);
  });

  it("CSP: nonce'lu, betikte unsafe-inline yok, frame-ancestors 'none'; her istekte farklı nonce; yönlendirme ve API yolunda da var", async () => {
    // `proxy.ts`/`next/server` kök typecheck kapsamına sokulmaz: dinamik yükleme (tip yok, yalnızca kullanılan yüzey bildirilir).
    const { NextRequest } = (await import(/* @vite-ignore */ path.join(WEB_ROOT, "node_modules/next/server.js"))) as { NextRequest: new (url: string) => Request };
    const { buildCsp, config: proxyConfig, proxy } = (await import(/* @vite-ignore */ path.join(WEB_ROOT, "proxy.ts"))) as {
      buildCsp: (nonce: string, dev?: boolean) => string;
      config: { matcher: { source: string }[] };
      proxy: (r: Request) => Response;
    };
    const req = (p: string): Request => new NextRequest(`${ORIGIN}${p}`);
    const csp = (res: Response): string => res.headers.get("content-security-policy") ?? "";
    const r1 = proxy(req("/login"));
    const r2 = proxy(req("/login"));
    const nonce = (c: string): string => /'nonce-([^']+)'/.exec(c)?.[1] ?? "";
    expect(nonce(csp(r1))).not.toBe("");
    expect(nonce(csp(r1))).not.toBe(nonce(csp(r2)));
    const script = csp(r1).split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    expect(script).not.toContain("'unsafe-inline'");
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp(r1)).toContain(directive);
    // `wasm-unsafe-eval` (T-286) yalnızca WASM derlemesine izin verir; JS `unsafe-eval` yasak sürer.
    expect(buildCsp("n", false)).not.toMatch(/(?<!wasm-)unsafe-eval/);
    const redirect = proxy(req(`/t/${B.slug}/audit`));
    expect(redirect.status).toBe(307);
    expect(csp(redirect)).toContain("nonce-");
    const api = proxy(req(`/api/t/${B.slug}/audit/export`));
    expect(api.status).toBe(200); // geçiş: yetki route'ta (401), proxy'de değil
    expect(csp(api)).toContain("nonce-");
    const source = proxyConfig.matcher[0]?.source ?? "";
    const re = new RegExp(`^${source}$`);
    expect(re.test(`/api/t/${B.slug}/audit/export`)).toBe(true);
    expect(re.test("/_next/static/chunk.js")).toBe(false);
  });
});
