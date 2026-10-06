// İki tenantlı sentetik fikstür (T-104, qa-verifier). YALNIZCA TEST; üretim şeması/migration değildir.
//
// Migration rolüyle (DATABASE_URL_DIRECT) kurulur: süper kullanıcı RLS'i aşar (Neon'da sahip rol BYPASSRLS gerektirir).
// Her dünya (world): 1 tenant + sahip kullanıcı/üyelik (TENANT_ADMIN) + ikinci üye (PICKER) + 1 davet + tenant_settings.
// Tohum tamamen sentetiktir (G-09): rastgele UUID, `@example.test` e-posta, rastgele slug/token özeti.
// Temizlik FK sırasıyla yapılır; `security_events` append-only olduğundan fikstür oraya satır bırakmaz.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

export interface TenantWorld {
  label: string;
  tenantId: string;
  slug: string;
  ownerUserId: string;
  ownerMembershipId: string;
  memberUserId: string;
  memberMembershipId: string;
  invitationId: string;
  warehouseId: string;
  rootLocationId: string;
  childLocationId: string;
  // T-204: katalog + izlenebilirlik.
  unitId: string;
  boxUnitId: string;
  itemId: string;
  itemTwoId: string;
  lotId: string;
  lotTwoId: string;
  serialId: string;
  ownerId: string;
  handlingUnitId: string;
  // T-206: stok belgeleri (DRAFT STOCK_IN belgesi, 1 satır, durum geçmişi, idempotency kaydı; numara serisi).
  documentId: string;
  documentLineId: string;
  statusHistoryId: string;
  idempotencyRecordId: string;
}

export interface WorldRegistry {
  worlds: TenantWorld[];
  /** Dünyaya ait olmayan, ayrıca kurulan kullanıcılar (ör. çok-tenantlı kullanıcı). */
  extraUsers: string[];
}

export function newRegistry(): WorldRegistry {
  return { worlds: [], extraUsers: [] };
}

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

export async function mkUser(c: pg.Client, reg: WorldRegistry, tag: string): Promise<string> {
  const r = await c.query<{ id: string }>("INSERT INTO public.users (name, email) VALUES ($1, $2) RETURNING id", [
    `T104 ${tag}`,
    `t104-${hex(6)}@example.test`,
  ]);
  const id = (r.rows[0] as { id: string }).id;
  reg.extraUsers.push(id);
  return id;
}

export async function mkMembership(
  c: pg.Client,
  tenantId: string,
  userId: string,
  opts: { isOwner?: boolean; roles: string[] },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_owner) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
    [tenantId, userId, opts.isOwner ?? false],
  );
  const id = (r.rows[0] as { id: string }).id;
  for (const role of opts.roles) {
    await c.query("INSERT INTO public.membership_roles (tenant_id, membership_id, role_key) VALUES ($1, $2, $3)", [
      tenantId,
      id,
      role,
    ]);
  }
  return id;
}

/** Bir tenant dünyası kurar (tek transaction değil; her ifade migration rolünün otomatik commit'i). */
export async function seedWorld(
  c: pg.Client,
  reg: WorldRegistry,
  label: string,
  opts: { status?: "ACTIVE" | "SUSPENDED" | "CLOSING" } = {},
): Promise<TenantWorld> {
  const tenantId = randomUUID();
  const slug = `t104-${label.toLowerCase()}-${hex(5)}`;
  const ownerUserId = await mkUser(c, reg, `${label} owner`);
  const memberUserId = await mkUser(c, reg, `${label} member`);
  await c.query("INSERT INTO public.tenants (id, slug, name, status) VALUES ($1, $2, $3, $4)", [
    tenantId,
    slug,
    `T104 Tenant ${label}`,
    opts.status ?? "ACTIVE",
  ]);
  const ownerMembershipId = await mkMembership(c, tenantId, ownerUserId, { isOwner: true, roles: ["TENANT_ADMIN"] });
  const memberMembershipId = await mkMembership(c, tenantId, memberUserId, { roles: ["PICKER"] });
  const invitationId = randomUUID();
  await c.query(
    `INSERT INTO public.invitations
       (tenant_id, id, email_normalized, role_key, token_hash, delivered_via, expires_at, invited_by_membership_id)
     VALUES ($1, $2, $3, 'PICKER', $4, 'SCREEN', now() + interval '1 day', $5)`,
    [tenantId, invitationId, `t104-inv-${hex(6)}@example.test`, createHash("sha256").update(hex(16)).digest("hex"), ownerMembershipId],
  );
  await c.query(
    `INSERT INTO public.tenant_settings (tenant_id, locale, time_zone, onboarding_status)
     VALUES ($1, 'tr-TR', 'Europe/Istanbul', 'PENDING')`,
    [tenantId],
  );
  // T-202: depo + kök/çocuk lokasyon (kilit satırı tetikleyiciyle doğar) + sahip üyeliği için depo kapsamı.
  const warehouseId = randomUUID();
  const rootLocationId = randomUUID();
  const childLocationId = randomUUID();
  await c.query("INSERT INTO public.warehouses (tenant_id, id, code, name) VALUES ($1, $2, 'D1', $3)", [
    tenantId,
    warehouseId,
    `T202 Depo ${label}`,
  ]);
  await c.query(
    `INSERT INTO public.locations (tenant_id, id, warehouse_id, parent_id, code, name, depth, kind)
     VALUES ($1, $2, $3, NULL, 'Z1', 'Bolge 1', 0, 'STORAGE'), ($1, $4, $3, $2, 'Z1-R1', 'Raf 1', 1, 'STORAGE')`,
    [tenantId, rootLocationId, warehouseId, childLocationId],
  );
  await c.query("INSERT INTO public.membership_warehouse_scopes (tenant_id, membership_id, warehouse_id) VALUES ($1, $2, $3)", [
    tenantId,
    ownerMembershipId,
    warehouseId,
  ]);
  // T-204: ADET + KOLI birimi, iki ürün (ikisi de LOT_AND_SERIAL), dönüşüm, barkod, sahip, ürün başına lot, seri, taşıma birimi.
  const unitId = randomUUID();
  const boxUnitId = randomUUID();
  const itemId = randomUUID();
  const itemTwoId = randomUUID();
  const lotId = randomUUID();
  const lotTwoId = randomUUID();
  const serialId = randomUUID();
  const ownerId = randomUUID();
  const handlingUnitId = randomUUID();
  await c.query("INSERT INTO public.units (tenant_id, id, code, name) VALUES ($1, $2, 'ADET', 'Adet'), ($1, $3, 'KOLI', 'Koli')", [
    tenantId,
    unitId,
    boxUnitId,
  ]);
  await c.query(
    `INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode)
     VALUES ($1, $2, 'U1', 'Urun 1', $4, 'LOT_AND_SERIAL'), ($1, $3, 'U2', 'Urun 2', $4, 'LOT_AND_SERIAL')`,
    [tenantId, itemId, itemTwoId, unitId],
  );
  await c.query("INSERT INTO public.unit_conversions (tenant_id, item_id, unit_id, to_base_factor) VALUES ($1, $2, $3, 12)", [
    tenantId,
    itemId,
    boxUnitId,
  ]);
  await c.query("INSERT INTO public.item_barcodes (tenant_id, item_id, unit_id, barcode) VALUES ($1, $2, NULL, $3)", [tenantId, itemId, `BC-${hex(6)}`]);
  await c.query("INSERT INTO public.inventory_owners (tenant_id, id, code, name) VALUES ($1, $2, 'S1', $3)", [tenantId, ownerId, `T204 Sahip ${label}`]);
  await c.query("INSERT INTO public.lots (tenant_id, id, item_id, lot_code) VALUES ($1, $2, $4, 'L1'), ($1, $3, $5, 'L1')", [
    tenantId,
    lotId,
    lotTwoId,
    itemId,
    itemTwoId,
  ]);
  await c.query("INSERT INTO public.serials (tenant_id, id, item_id, serial_no, lot_id) VALUES ($1, $2, $3, 'SN1', $4)", [
    tenantId,
    serialId,
    itemId,
    lotId,
  ]);
  await c.query("INSERT INTO public.handling_units (tenant_id, id, kind, code, location_id) VALUES ($1, $2, 'PALET', 'P1', $3)", [
    tenantId,
    handlingUnitId,
    rootLocationId,
  ]);
  // T-206: DRAFT STOCK_IN belgesi (POSTED değil: değişmezlik testleri kendi belgesini işlem içinde kurar), tek satır, ilk durum
  // geçmişi, IN_PROGRESS idempotency kaydı ve numara serisi. Sistem fiş tipi sürümü migration tohumundan okunur (tenant_id NULL).
  const documentId = randomUUID();
  const documentLineId = randomUUID();
  const statusHistoryId = randomUUID();
  const idempotencyRecordId = randomUUID();
  const tv = await c.query<{ id: string }>("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'STOCK_IN' AND version = 1");
  const typeVersionId = (tv.rows[0] as { id: string }).id;
  await c.query(
    `INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, reason, created_by)
     VALUES ($1, $2, 'STOCK_IN', $3, $4, '2026-01-15', 'T206 fikstur', $5)`,
    [tenantId, documentId, typeVersionId, warehouseId, ownerUserId],
  );
  await c.query(
    `INSERT INTO public.document_lines
       (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id, lot_id, serial_id)
     VALUES ($1, $2, $3, 1, $4, $5, 1, 1, 1, $6, $7, $8)`,
    [tenantId, documentLineId, documentId, itemId, unitId, rootLocationId, lotId, serialId],
  );
  await c.query(
    "INSERT INTO public.document_status_history (tenant_id, id, document_id, from_status, to_status, actor_user_id) VALUES ($1, $2, $3, NULL, 'DRAFT', $4)",
    [tenantId, statusHistoryId, documentId, ownerUserId],
  );
  await c.query(
    "INSERT INTO public.idempotency_records (tenant_id, id, command_type, client_key, actor_user_id, request_hash) VALUES ($1, $2, 'stock.document.create', $3, $4, $5)",
    [tenantId, idempotencyRecordId, randomUUID(), ownerUserId, createHash("sha256").update(hex(16)).digest("hex")],
  );
  await c.query("INSERT INTO public.number_sequences (tenant_id, document_kind, period) VALUES ($1, 'STOCK_IN', '2026')", [tenantId]);
  const world: TenantWorld = {
    label,
    tenantId,
    slug,
    ownerUserId,
    ownerMembershipId,
    memberUserId,
    memberMembershipId,
    invitationId,
    warehouseId,
    rootLocationId,
    childLocationId,
    unitId,
    boxUnitId,
    itemId,
    itemTwoId,
    lotId,
    lotTwoId,
    serialId,
    ownerId,
    handlingUnitId,
    documentId,
    documentLineId,
    statusHistoryId,
    idempotencyRecordId,
  };
  reg.worlds.push(world);
  return world;
}

/** Fikstür satırlarını siler (FK sırası: davet → rol → üyelik → ayar → tenant → kullanıcı). Hataları yutmaz. */
export async function cleanupRegistry(c: pg.Client, reg: WorldRegistry): Promise<void> {
  const tenantIds = reg.worlds.map((w) => w.tenantId);
  const userIds = [...reg.worlds.flatMap((w) => [w.ownerUserId, w.memberUserId]), ...reg.extraUsers];
  if (tenantIds.length > 0) {
    await cleanupDocuments(c, tenantIds);
    // T-204 tabloları (FK sırası: taşıma birimi [lokasyona bağlı, T-202'den önce] → seri → lot → barkod/dönüşüm → sahip → ürün → birim).
    for (const t of ["handling_units", "serials", "lots", "item_barcodes", "unit_conversions", "inventory_owners", "items", "units"]) {
      await c.query(`DELETE FROM public.${t} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
    }
    // T-202 tabloları (FK sırası: kapsam → kilit → lokasyon [tek ifade; NO ACTION FK ifade sonunda denetlenir] → depo).
    await c.query("DELETE FROM public.membership_warehouse_scopes WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.location_count_locks WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.locations WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.warehouses WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.invitations WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.membership_roles WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenant_settings WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
    await c.query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
  }
  if (userIds.length > 0) {
    await c.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [userIds]);
  }
  reg.worlds.length = 0;
  reg.extraUsers.length = 0;
}

/**
 * T-206 tabloları (tek transaction). document_status_history append-only tetikleyicisi (ENABLE ALWAYS DEĞİL, 0012 notu) ve
 * POSTED silme reddi `session_replication_role = replica` ile atlanır (tablo sahibi + süper kullanıcı; wms_app yapamaz). Replica
 * modunda FK denetimi de kapalıdır; bu yüzden yalnızca bu tenant'ların satırları ve FK sırasıyla silinir. Hatalar yutulmaz.
 */
export async function cleanupDocuments(c: pg.Client, tenantIds: string[]): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL session_replication_role = replica");
    for (const t of ["idempotency_records", "number_sequences", "document_status_history", "document_lines", "documents"]) {
      await c.query(`DELETE FROM public.${t} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
