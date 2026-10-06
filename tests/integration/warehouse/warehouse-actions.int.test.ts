// T-207: depo/lokasyon Server Action'larında yetki ve köken reddi — GERÇEK sorgu yolu (gerçek `wms_app`, RLS, `runTenantCommand`).
// `apps/web/app/t/[slug]/warehouses/actions.test.ts` domain'i sahteler ve yetkiyi KANITLAMAZ; bu dosya kanıtlar.
// Mock'lar yalnızca Next çalışma zamanı ve kimlik çözümüdür (`x-test-user` başlığı = oturumdaki kullanıcı). Fikstürler sentetik (G-09).
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown, headers: new Headers() }));

vi.mock("../../../apps/web/node_modules/next/headers.js", () => ({
  headers: () => Promise.resolve(h.headers),
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("../../../packages/db/src/index.ts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAppDb: () => h.db }));
vi.mock("../../../apps/web/lib/auth-service.ts", () => ({
  getAuthService: () => ({
    getPrincipal: (headers: Headers) => {
      const u = headers.get("x-test-user");
      return Promise.resolve(u === null ? null : { userId: u, mfaVerified: true });
    },
  }),
}));

import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const ORIGIN = "https://app.example.test";
const WEB = path.resolve(import.meta.dirname, "../../../apps/web");
const reg = newRegistry();
const rnd = (): string => randomBytes(4).toString("hex");

type Result = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; detail?: string } };
type Actions = Record<string, (arg: unknown) => Promise<Result>>;

let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let actions: Actions;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "WMS_ENV"] as const;

let ipN = 0;
function as(user: string | null, origin: string | null = ORIGIN): void {
  const hd = new Headers({ "fly-client-ip": `198.51.100.${(++ipN % 250) + 1}`, "user-agent": "t207-qa" });
  if (origin !== null) hd.set("origin", origin);
  if (user !== null) hd.set("x-test-user", user);
  h.headers = hd;
}

/** Tenant'ın depo/lokasyon durumu ve ilgili denetim kayıtları (etki yok kanıtı için önce/sonra). */
async function state(): Promise<unknown> {
  const q = async (text: string): Promise<unknown[]> => (await adm.query(text, [A.tenantId])).rows;
  return {
    warehouses: await q("SELECT id, code, name, status FROM public.warehouses WHERE tenant_id = $1 ORDER BY id"),
    locations: await q("SELECT id, code, name, kind, status FROM public.locations WHERE tenant_id = $1 ORDER BY id"),
    audit: await q("SELECT action, entity_id FROM public.audit_logs WHERE tenant_id = $1 AND action LIKE 'warehouse.%' OR tenant_id = $1 AND action LIKE 'location.%' ORDER BY action, entity_id"),
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), WMS_ENV: "ci" });
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  h.db = app;
  A = await seedWorld(adm, reg, "A207");
  actions = (await import(/* @vite-ignore */ path.join(WEB, "app/t/[slug]/warehouses/actions.ts"))) as Actions;
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await app?.close().catch(() => undefined);
  await adm?.end().catch(() => undefined);
}, 60_000);

describe("warehouses/actions.ts yetki ve köken (gerçek sorgu yolu)", () => {
  it("olumlu kontrol: yönetici depo oluşturur (testin geçersiz kılınmadığının kanıtı)", async () => {
    const code = `T207-${rnd()}`.toUpperCase();
    as(A.ownerUserId);
    const res = await actions.createWarehouseAction!({ slug: A.slug, code, name: "Yönetici deposu" });
    expect(res.ok).toBe(true);
    const rows = await adm.query<{ code: string }>("SELECT code FROM public.warehouses WHERE tenant_id = $1 AND code = $2", [A.tenantId, code]);
    expect(rows.rows).toEqual([{ code }]);
  });

  it("PICKER: her yazma eylemi FORBIDDEN, veritabanında ve denetim kaydında hiçbir değişiklik yok", async () => {
    const before = await state();
    const calls: Array<[string, () => Promise<Result>]> = [
      ["createWarehouseAction", () => actions.createWarehouseAction!({ slug: A.slug, code: `X-${rnd()}`, name: "Yetkisiz" })],
      ["archiveWarehouseAction", () => actions.archiveWarehouseAction!({ slug: A.slug, warehouseId: A.warehouseId })],
      ["createLocationAction", () => actions.createLocationAction!({ slug: A.slug, warehouseId: A.warehouseId, parentId: null, code: `L-${rnd()}`, name: "Yetkisiz", kind: "STORAGE" })],
      ["archiveLocationAction", () => actions.archiveLocationAction!({ slug: A.slug, locationId: A.childLocationId })],
    ];
    for (const [name, call] of calls) {
      as(A.memberUserId);
      const res = await call();
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.error.code, name).toBe("FORBIDDEN");
    }
    expect(await state()).toEqual(before);
  });

  it("yanlış, farklı ve eksik Origin: FORBIDDEN, yönetici bile olsa hiçbir değişiklik yok", async () => {
    const before = await state();
    for (const origin of ["https://evil.example.test", `${ORIGIN}.evil.test`, null]) {
      as(A.ownerUserId, origin);
      const res = await actions.createWarehouseAction!({ slug: A.slug, code: `O-${rnd()}`, name: "Köken" });
      expect(res.ok, String(origin)).toBe(false);
      if (!res.ok) expect(res.error.code, String(origin)).toBe("FORBIDDEN");
    }
    expect(await state()).toEqual(before);
  });

  it("oturumsuz: UNAUTHENTICATED, değişiklik yok", async () => {
    const before = await state();
    as(null);
    const res = await actions.createWarehouseAction!({ slug: A.slug, code: `U-${rnd()}`, name: "Oturumsuz" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
    expect(await state()).toEqual(before);
  });
});

