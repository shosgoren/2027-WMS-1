// Taşıma birimi (koli/palet, LPN) kart komutları (T-212; ADR-011, A-87, A-89). Yazma `document.create`, okuma `stock.view`.
//
// - Taşıma birimi stok DEĞİLDİR; bu dosya yalnızca YENİ ve BOŞ bir birim açar ve ağacı okur (G-01).
// - A-89: `handling_units.parent_id/location_id` UPDATE'i yalnızca domain STOK komutlarıyla yapılır. Bu yüzden burada
//   `nestHandlingUnit` YOKTUR (kart maddesi 3 ile A-89 çelişir; Supervisor/kullanıcı kararı bekler — raporda "Bulgular").
//   `createHandlingUnit` ebeveyni yalnızca INSERT anında bağlar (yeni satır: döngü ve içerik hareketi imkânsız;
//   DB döngü tetikleyicisi yine de çalışır).
// - `kind` ve `code` değişmez (A-87). Konum ve ebeveyn tutarlılığı (A-89: DB zorlamaz) komutta denetlenir:
//   ebeveynin konumu varsa çocuğunki aynı olmalı; çocuk konum vermezse ebeveynin konumunu devralır.
import { sql } from "drizzle-orm";
import type { HandlingUnitKind } from "@wms/db";
import { appendAudit } from "@wms/db";
import { AppError } from "@wms/shared/errors";
import { runTenantCommand, runTenantQuery } from "../identity/access.ts";
import { parseNfcText } from "./lots.ts";
import { parseUuid, type CatalogCommandParams } from "./units.ts";

const KINDS: readonly HandlingUnitKind[] = ["KOLI", "PALET"];
export const HANDLING_UNIT_TREE_MAX_DEPTH = 32;

export interface CreateHandlingUnitInput {
  readonly kind: HandlingUnitKind;
  readonly code: string;
  readonly parentId?: string;
  readonly locationId?: string;
}

export interface HandlingUnitNode {
  readonly id: string;
  readonly kind: HandlingUnitKind;
  readonly code: string;
  readonly parentId: string | null;
  readonly locationId: string | null;
  readonly status: "OPEN" | "CLOSED" | "EMPTIED";
  /** Kökten uzaklık (kök = 0). */
  readonly depth: number;
}

function parseKind(raw: unknown): HandlingUnitKind {
  if (typeof raw !== "string" || !(KINDS as readonly string[]).includes(raw)) throw new AppError("VALIDATION_FAILED");
  return raw as HandlingUnitKind;
}

export async function createHandlingUnit(params: CatalogCommandParams, input: CreateHandlingUnitInput): Promise<{ readonly handlingUnitId: string }> {
  const kind = parseKind(input.kind);
  const code = parseNfcText(input.code, 64);
  const parentId = input.parentId === undefined ? undefined : parseUuid(input.parentId);
  let locationId = input.locationId === undefined ? undefined : parseUuid(input.locationId);
  const { requestId, ...access } = params;
  return runTenantCommand({ ...access, permission: "document.create" }, async (tx, actor) => {
    if (parentId !== undefined) {
      const parent = await tx.execute<{ location_id: string | null }>(
        sql`SELECT location_id FROM public.handling_units WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${parentId}::uuid FOR SHARE`,
      );
      if (parent[0] === undefined) throw new AppError("NOT_FOUND");
      const parentLoc = parent[0].location_id;
      if (parentLoc !== null) {
        if (locationId !== undefined && locationId !== parentLoc) throw new AppError("VALIDATION_FAILED", { detail: "PARENT_INVALID" });
        locationId = parentLoc;
      }
    }
    if (locationId !== undefined) {
      const loc = await tx.execute<{ status: string }>(
        sql`SELECT status FROM public.locations WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${locationId}::uuid FOR SHARE`,
      );
      if (loc[0] === undefined) throw new AppError("NOT_FOUND");
      if (loc[0].status !== "ACTIVE") throw new AppError("VALIDATION_FAILED");
    }
    const rows = await tx.execute<{ id: string }>(
      sql`INSERT INTO public.handling_units (tenant_id, id, kind, code, parent_id, location_id)
          VALUES (${actor.tenantId}::uuid, gen_random_uuid(), ${kind}, ${code}, ${parentId ?? null}::uuid, ${locationId ?? null}::uuid)
          ON CONFLICT ON CONSTRAINT handling_units_tenant_code_key DO NOTHING
          RETURNING id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new AppError("VALIDATION_FAILED", { detail: "CODE_TAKEN" });
    await appendAudit(tx, {
      action: "handling_unit.created",
      actorUserId: actor.userId,
      entityType: "handling_unit",
      entityId: id,
      requestId: requestId ?? null,
      changeSummary: { kind, parent_id: parentId ?? null, location_id: locationId ?? null },
    });
    return { handlingUnitId: id };
  });
}

/** Kök ve altındaki tüm birimler (derinlik sıralı; derinlik sınırı güvenlik içindir, döngü DB'de imkânsızdır). */
export async function getHandlingUnitTree(
  params: Omit<CatalogCommandParams, "requestId">,
  input: { readonly rootId: string },
): Promise<readonly HandlingUnitNode[]> {
  const rootId = parseUuid(input.rootId);
  return runTenantQuery({ ...params, permission: "stock.view" }, async (tx, actor) => {
    const rows = await tx.execute<{
      id: string;
      kind: HandlingUnitKind;
      code: string;
      parent_id: string | null;
      location_id: string | null;
      status: "OPEN" | "CLOSED" | "EMPTIED";
      depth: number;
    }>(
      sql`WITH RECURSIVE tree AS (
            SELECT h.id, h.kind, h.code, h.parent_id, h.location_id, h.status, 0 AS depth
              FROM public.handling_units h
             WHERE h.tenant_id = ${actor.tenantId}::uuid AND h.id = ${rootId}::uuid
            UNION ALL
            SELECT c.id, c.kind, c.code, c.parent_id, c.location_id, c.status, t.depth + 1
              FROM public.handling_units c JOIN tree t ON c.parent_id = t.id
             WHERE c.tenant_id = ${actor.tenantId}::uuid AND t.depth < ${HANDLING_UNIT_TREE_MAX_DEPTH}
          )
          SELECT id, kind, code, parent_id, location_id, status, depth FROM tree ORDER BY depth, code, id`,
    );
    if (rows[0] === undefined) throw new AppError("NOT_FOUND");
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      code: r.code,
      parentId: r.parent_id,
      locationId: r.location_id,
      status: r.status,
      depth: Number(r.depth),
    }));
  });
}
