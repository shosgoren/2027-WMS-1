// `withMembership` ailesi (T-103, ADR-016 §5-6, §8): tenant bağlamını DOĞRULANMIŞ üyelikten kurar (I-01) ve
// üyelik/tenant durumunu YAZMAYLA AYNI transaction'da `FOR SHARE` ile okur (doğrulama ile yazma arasında yarış yok).
//
// Akış (`withMembership`): BEGIN → set_config('app.current_tenant_id', $tenant, true) → tenant satırı FOR SHARE →
// üyelik satırı FOR SHARE → roller FOR SHARE → (izin denetimi) → fn(tx, membership) → COMMIT. Eşzamanlı çıkarma, rol
// değişimi (üyelik satırı UPDATE + roles_version), rol satırı silme/ekleme (membership_roles) ve askıya alma (tenant
// satırı UPDATE) bu transaction bitene kadar bekler; tersi sırada yazma güncel durumu görür. Kilit sırası sabittir
// (tenants → tenant_memberships → membership_roles): deadlock yok.
//
// m1: `withMembership` YALNIZCA `app.current_tenant_id` kurar; `app.current_user_id` `withUser`'da ve `withNewTenant`'ın
// idempotent mevcut-tenant araması sırasında (tenant bağlamı boşken, kısa süreli; bulununca temizlenir) kurulur;
// `app.system_reason` yalnızca `withSystemTenant`'te. Hepsi `set_config(..., true)` + aynı `tx` (I-02); `SET` ve
// string birleştirme yok, değerler parametredir. Geçersiz UUID/gerekçe veritabanına sorgu gönderilmeden reddedilir.
//
// db iş kuralı bilmez: izin matrisi PARAMETRE olarak gelir (T-113'te `packages/domain`).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { isUuid, rawDb, type DbClient, type TenantTx } from "./client.ts";
import type { RoleKey } from "./schema/tenancy.ts";

/** 15 §Hata kodları: üyelik/tenant reddi. */
export type MembershipErrorCode = "FORBIDDEN" | "TENANT_SUSPENDED" | "TENANT_CLOSING" | "SLUG_TAKEN" | "IDEMPOTENCY_MISMATCH";

export class MembershipError extends Error {
  override name = "MembershipError";
  readonly code: MembershipErrorCode;
  constructor(code: MembershipErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Doğrulanmış üyelik (withMembership callback'ine verilir). */
export interface Membership {
  readonly membershipId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly isOwner: boolean;
  readonly roles: readonly RoleKey[];
  readonly rolesVersion: number;
}

/**
 * İzin denetimi: matrisin kendisi `packages/domain`'dedir. Fonksiyon rolleri alır ve izin varsa `true` döndürür;
 * ya da `allowedRoles` (rollerden en az biri listede olmalı). Boş liste her zaman reddeder.
 */
export type MembershipPermission =
  | ((roles: readonly RoleKey[]) => boolean)
  | { readonly allowedRoles: readonly RoleKey[] };

export interface WithMembershipParams {
  readonly client: DbClient;
  readonly userId: string;
  readonly tenantId: string;
  readonly permission?: MembershipPermission;
}

function assertUuid(value: unknown, what: string): asserts value is string {
  if (!isUuid(value)) {
    throw new MembershipError("FORBIDDEN", `membership rejected: ${what} is not a UUID`);
  }
}

function assertReason(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MembershipError("FORBIDDEN", "system tenant context rejected: reason is empty");
  }
}

function permits(permission: MembershipPermission, roles: readonly RoleKey[]): boolean {
  if (typeof permission === "function") return permission(roles) === true;
  return roles.some((r) => permission.allowedRoles.includes(r));
}

function rejectInactiveTenant(status: string): void {
  if (status === "SUSPENDED") throw new MembershipError("TENANT_SUSPENDED", "tenant is suspended");
  if (status === "CLOSING") throw new MembershipError("TENANT_CLOSING", "tenant is closing");
  if (status !== "ACTIVE") throw new MembershipError("FORBIDDEN", "tenant status is not active");
}

/** Tenant satırını FOR SHARE okur (askıya alma/kapatma bu transaction bitene kadar bekler). */
async function lockTenantRow(tx: TenantTx, tenantId: string): Promise<string | undefined> {
  const rows = await tx.execute<{ status: string }>(
    sql`SELECT status FROM public.tenants WHERE id = ${tenantId}::uuid FOR SHARE`,
  );
  return rows[0]?.status;
}

/**
 * `fn`'i tek transaction'da, doğrulanmış üyelikle çalıştırır (ADR-016 §5).
 *
 * - Üyelik yok / `REMOVED` / tenant yok → `FORBIDDEN` (tenant durumu üye olmayana sızdırılmaz).
 * - Tenant `SUSPENDED` → `TENANT_SUSPENDED`; `CLOSING` → `TENANT_CLOSING`.
 * - `permission` verilmişse ve rollerle karşılanmıyorsa → `FORBIDDEN`.
 * - `fn` hata fırlatırsa transaction geri alınır ve hata AYNEN yeniden fırlatılır (G-07).
 */
export async function withMembership<T>(
  params: WithMembershipParams,
  fn: (tx: TenantTx, membership: Membership) => Promise<T>,
): Promise<T> {
  const { client, userId, tenantId, permission } = params ?? ({} as Partial<WithMembershipParams>);
  assertUuid(tenantId, "tenantId");
  assertUuid(userId, "userId");
  const db = rawDb(client as DbClient);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    const tenantStatus = await lockTenantRow(tx, tenantId);
    const rows = await tx.execute<{ id: string; is_owner: boolean; status: string; roles_version: number }>(
      sql`SELECT id, is_owner, status, roles_version
            FROM public.tenant_memberships
           WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
             FOR SHARE`,
    );
    const m = rows[0];
    if (tenantStatus === undefined || m === undefined || m.status !== "ACTIVE") {
      throw new MembershipError("FORBIDDEN", "no active membership");
    }
    rejectInactiveTenant(tenantStatus);
    const roleRows = await tx.execute<{ role_key: RoleKey }>(
      sql`SELECT role_key FROM public.membership_roles
           WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${m.id}::uuid
           ORDER BY role_key
             FOR SHARE`,
    );
    const roles = roleRows.map((r) => r.role_key);
    if (permission !== undefined && !permits(permission, roles)) {
      throw new MembershipError("FORBIDDEN", "permission denied");
    }
    return fn(tx, {
      membershipId: m.id,
      userId,
      tenantId,
      isOwner: m.is_owner,
      roles,
      rolesVersion: Number(m.roles_version),
    });
  });
}

/**
 * Yalnızca `app.current_user_id` kurar: kullanıcının kendi üyelik listesini okumak içindir (tenant bağlamı yok →
 * tenant tablolarından başka satır gelmez; RLS ek SELECT politikaları). Yazma politikaları kullanıcı kimliğine
 * dayanmaz.
 */
export async function withUser<T>(client: DbClient, userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  assertUuid(userId, "userId");
  const db = rawDb(client);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export interface NewTenantParams {
  /** Tenant'ı kuran ve sahibi olacak kullanıcı. */
  readonly userId: string;
  readonly slug: string;
  readonly name: string;
  /** Onboarding idempotency: `UNIQUE (created_by_user_id, creation_request_id)`. */
  readonly creationRequestId: string;
}

export interface NewTenantOwner {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  /** `false`: aynı (kullanıcı, creationRequestId) ile daha önce kurulmuş tenant döndü; `fn` yine çalışır (idempotent olmalı). */
  readonly created: boolean;
}

/** `tenants_slug_chk` ile aynı biçim (veritabanı da zorlar); `demo` yalnızca demo tenant'a ayrılmıştır. */
const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Sürücü hata zincirinde (`cause`) belirli bir kısıtın benzersizlik ihlalini arar. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const o = cur as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === "23505" && (o.constraint_name === constraint || o.constraint === constraint)) return true;
    cur = o.cause;
  }
  return false;
}

/**
 * Yeni tenant + sahip üyeliği (`is_owner`, `TENANT_ADMIN`) TEK transaction'da, RLS atlanmadan (bağlam yeni tenant
 * kimliğiyle kurulur; `tenants` yazma politikası `id = current_tenant`). `fn` aynı transaction'da çalışır
 * (ayarlar, audit …); hata → hepsi geri alınır.
 *
 * - Tenant kimliği burada üretilir (çağıran veremez).
 * - Idempotent: aynı `(userId, creationRequestId)` ile tekrar çağrı mevcut tenant'ı döndürür (`created: false`); ikinci
 *   tenant oluşmaz. Eşzamanlı iki çağrıda `INSERT ... ON CONFLICT DO NOTHING` ikincisini birincinin commit'ine bekletir.
 * - Slug başka tenant'ta kullanımda → `SLUG_TAKEN` (PostgreSQL ayrıntısı sızdırılmaz).
 */
export async function withNewTenant<T>(
  client: DbClient,
  params: NewTenantParams,
  fn: (tx: TenantTx, membership: NewTenantOwner) => Promise<T>,
): Promise<T> {
  const { userId, slug, name, creationRequestId } = params ?? ({} as Partial<NewTenantParams>);
  assertUuid(userId, "userId");
  assertUuid(creationRequestId, "creationRequestId");
  if (typeof slug !== "string" || !SLUG_FORMAT.test(slug) || slug === "demo") {
    throw new MembershipError("FORBIDDEN", "new tenant rejected: slug is not a valid tenant slug");
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new MembershipError("FORBIDDEN", "new tenant rejected: name is empty");
  }
  const newTenantId = randomUUID();
  const db = rawDb(client);
  return db.transaction(async (tx) => {
    // Mevcut kurulumu bul: bağlam YALNIZCA kullanıcı kimliği (tenant bağlamı boş → ek SELECT politikaları), bulununca
    // bağlam tenant'a çevrilir ve kullanıcı bağlamı temizlenir.
    const findExisting = async (): Promise<{ tenantId: string; membershipId: string } | undefined> => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', '', true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      const found = await tx.execute<{ id: string; slug: string; name: string }>(
        sql`SELECT id, slug, name FROM public.tenants
             WHERE created_by_user_id = ${userId}::uuid AND creation_request_id = ${creationRequestId}::uuid`,
      );
      const existingId = found[0]?.id;
      await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
      if (existingId === undefined) return undefined;
      // D: aynı istek kimliği başka slug/ad ile tekrarlanmış → sessizce eski tenant dönmez.
      if (found[0]?.slug !== slug || found[0]?.name !== name) {
        throw new MembershipError("IDEMPOTENCY_MISMATCH", "creation request was already used with different parameters");
      }
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${existingId}, true)`);
      const owner = await tx.execute<{ id: string }>(
        sql`SELECT id FROM public.tenant_memberships
             WHERE tenant_id = ${existingId}::uuid AND user_id = ${userId}::uuid AND is_owner`,
      );
      const membershipId = owner[0]?.id;
      if (membershipId === undefined) return undefined;
      // C: tekrar yolunda da withMembership ile aynı tenant durumu denetimi (fn çalışmaz).
      const status = await lockTenantRow(tx, existingId);
      if (status === undefined) return undefined;
      rejectInactiveTenant(status);
      return { tenantId: existingId, membershipId };
    };

    const existing = await findExisting();
    if (existing !== undefined) {
      return fn(tx, { ...existing, userId, created: false });
    }

    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${newTenantId}, true)`);
    let insertedTenant: readonly { id: string }[];
    try {
      insertedTenant = await tx.execute<{ id: string }>(
        sql`INSERT INTO public.tenants (id, slug, name, created_by_user_id, creation_request_id)
            VALUES (${newTenantId}::uuid, ${slug}, ${name}, ${userId}::uuid, ${creationRequestId}::uuid)
            ON CONFLICT (created_by_user_id, creation_request_id) DO NOTHING
            RETURNING id`,
      );
    } catch (e) {
      if (isUniqueViolation(e, "tenants_slug_key")) {
        throw new MembershipError("SLUG_TAKEN", "tenant slug is already taken");
      }
      throw e;
    }
    if (insertedTenant.length === 0) {
      // Eşzamanlı aynı istek kazandı (commit edildi): onu döndür.
      const raced = await findExisting();
      if (raced === undefined) {
        throw new MembershipError("FORBIDDEN", "new tenant rejected: creation request already used");
      }
      return fn(tx, { ...raced, userId, created: false });
    }
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner)
          VALUES (${newTenantId}::uuid, ${userId}::uuid, 'ACTIVE', true)
          RETURNING id`,
    );
    const membershipId = inserted[0]?.id;
    if (membershipId === undefined) {
      throw new Error("withNewTenant: owner membership insert returned no row");
    }
    await tx.execute(
      sql`INSERT INTO public.membership_roles (tenant_id, membership_id, role_key)
          VALUES (${newTenantId}::uuid, ${membershipId}::uuid, 'TENANT_ADMIN')`,
    );
    return fn(tx, { membershipId, tenantId: newTenantId, userId, created: true });
  });
}

/**
 * Kullanıcıya bağlı olmayan sistem işleri (e-posta gönderimi, demo bootstrap …): tenant ACTIVE değilse ret
 * (`TENANT_SUSPENDED` / `TENANT_CLOSING` / yok → `FORBIDDEN`). `app.system_reason` yalnızca burada kurulur; üyelik/rol
 * yazan tetikleyici bekçisi `demo.bootstrap` dışındaki gerekçeleri ve demo olmayan tenant'ı reddeder (ADR-016 4. tur
 * eki MINOR-6). Boş/boşluk gerekçe sorgusuz reddedilir.
 */
export async function withSystemTenant<T>(
  client: DbClient,
  tenantId: string,
  reason: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  assertReason(reason);
  const db = rawDb(client);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`SELECT set_config('app.system_reason', ${reason}, true)`);
    const status = await lockTenantRow(tx, tenantId);
    if (status === undefined) {
      throw new MembershipError("FORBIDDEN", "tenant not found");
    }
    rejectInactiveTenant(status);
    return fn(tx);
  });
}

/**
 * Son sahip kuralının DB tarafı (ADR-016 §8): tenant'ın ACTIVE sahip üyeliklerini `FOR UPDATE` ile kilitler
 * (eşzamanlı iki ayrılma sırayla çalışır) ve döndürür. Kuralın kararı T-117'dedir. Kilit sırası: kimliğe göre.
 */
export async function lockOwners(
  tx: TenantTx,
  tenantId: string,
): Promise<readonly { readonly membershipId: string; readonly userId: string }[]> {
  assertUuid(tenantId, "tenantId");
  const rows = await tx.execute<{ id: string; user_id: string }>(
    sql`SELECT id, user_id FROM public.tenant_memberships
         WHERE tenant_id = ${tenantId}::uuid AND is_owner AND status = 'ACTIVE'
         ORDER BY id
           FOR UPDATE`,
  );
  return rows.map((r) => ({ membershipId: r.id, userId: r.user_id }));
}
