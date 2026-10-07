// T-304: görev komutları + sorgular (ADR-021 §6, A-132). Gerçek wms_app bağlantısı + RLS. Fikstürler sentetik (G-09).
// AC-04 komut katmanı: başka tenant'ın görev kimliği NOT_FOUND (bağımsız kanıt T-318).
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../../packages/db/src/index.ts";
import { DB_CLIENT_SETTINGS, type DbClient } from "../../../packages/db/src/client.ts";
import { AppError } from "../../../packages/shared/src/errors.ts";
import * as ops from "../../../packages/domain/src/operations/index.ts";
import { assignTask, cancelTask, claimTask, listMyTasks, listTasks, type TaskKind } from "../../../packages/domain/src/operations/index.ts";
import { completeTask, createTasks } from "../../../packages/domain/src/operations/tasks.ts";
import { runTenantCommand } from "../../../packages/domain/src/identity/access.ts";
import { mkMembership, mkUser, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { readIntEnv } from "../harness/env.ts";

const env = readIntEnv(process.env);
const reg = newRegistry();
let app: DbClient;
let adm: pg.Client;
let A: TenantWorld;
let B: TenantWorld;
let counterUserId: string;
let counterMembershipId: string;

const admin = (w: TenantWorld) => ({ db: app, principal: { userId: w.ownerUserId, mfaVerified: true }, tenantSlug: w.slug });
const picker = (w: TenantWorld) => ({ db: app, principal: { userId: w.memberUserId, mfaVerified: true }, tenantSlug: w.slug });
const counter = (w: TenantWorld) => ({ db: app, principal: { userId: counterUserId, mfaVerified: true }, tenantSlug: w.slug });

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}

/** Görevler yalnızca iç yardımcıyla doğar (saha komutu transaction'ı taklidi). */
async function mkTasks(w: TenantWorld, kinds: readonly TaskKind[]): Promise<string[]> {
  const ids = await runTenantCommand({ ...admin(w), permission: "stock.post" }, (tx, m) =>
    createTasks(tx, m, kinds.map((kind) => ({ warehouseId: w.warehouseId, kind }))),
  );
  return [...ids];
}
async function row(id: string) {
  const r = await adm.query<{ status: string; version: number; assigned_membership_id: string | null; completed_at: Date | null }>(
    "SELECT status, version, assigned_membership_id, completed_at FROM public.warehouse_tasks WHERE id = $1",
    [id],
  );
  return r.rows[0] as { status: string; version: number; assigned_membership_id: string | null; completed_at: Date | null };
}
async function audits(tenantId: string, action: string, entityId: string) {
  const r = await adm.query<{ reason: string | null; actor_user_id: string | null; change_summary: Record<string, unknown> }>(
    "SELECT reason, actor_user_id, change_summary FROM public.audit_logs WHERE tenant_id = $1 AND action = $2 AND entity_id = $3",
    [tenantId, action, entityId],
  );
  return r.rows;
}

beforeAll(async () => {
  app = createDbClient({ url: env.databaseUrl, poolMax: DB_CLIENT_SETTINGS.poolMax, prepare: env.prepare ?? DB_CLIENT_SETTINGS.prepare });
  adm = new pg.Client({ connectionString: env.databaseUrlDirect });
  adm.on("error", () => undefined);
  await adm.connect();
  A = await seedWorld(adm, reg, "A304");
  B = await seedWorld(adm, reg, "B304");
  counterUserId = await mkUser(adm, reg, "A304 counter");
  counterMembershipId = await mkMembership(adm, A.tenantId, counterUserId, { roles: ["COUNTER"] });
}, 120_000);

afterAll(async () => {
  await adm.end();
  await app.close();
}, 60_000);

describe("görev komutları", () => {
  it("PICKER atama yapamaz (FORBIDDEN), iptal edemez; durum değişmez", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const taskId = id as string;
    const e1 = await failure(assignTask(picker(A), { taskId, membershipId: A.memberMembershipId, expectedVersion: 1 }));
    expect(e1.code).toBe("FORBIDDEN");
    const e2 = await failure(cancelTask(picker(A), { taskId, expectedVersion: 1, reason: "x" }));
    expect(e2.code).toBe("FORBIDDEN");
    expect(await row(taskId)).toMatchObject({ status: "OPEN", version: 1 });
  });

  it("iki kullanıcı aynı görevi eşzamanlı üstlenir: biri VERSION_CONFLICT", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const taskId = id as string;
    const results = await Promise.allSettled([
      claimTask(admin(A), { taskId, expectedVersion: 1 }),
      claimTask(picker(A), { taskId, expectedVersion: 1 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.reason).toBeInstanceOf(AppError);
    expect((bad[0]?.reason as AppError).code).toBe("VERSION_CONFLICT");
    const after = await row(taskId);
    expect(after).toMatchObject({ status: "ASSIGNED", version: 2 });
    expect([A.ownerMembershipId, A.memberMembershipId]).toContain(after.assigned_membership_id);
    expect(await audits(A.tenantId, "warehouse_task.claimed", taskId)).toHaveLength(1);
  });

  it("B tenant'ının görev kimliği NOT_FOUND (assign/claim/cancel); B görevi değişmez ve A listesinde görünmez (AC-04 komut katmanı)", async () => {
    const [idB] = await mkTasks(B, ["PICK"]);
    const taskId = idB as string;
    expect((await failure(assignTask(admin(A), { taskId, membershipId: A.ownerMembershipId, expectedVersion: 1 }))).code).toBe("NOT_FOUND");
    expect((await failure(claimTask(admin(A), { taskId, expectedVersion: 1 }))).code).toBe("NOT_FOUND");
    expect((await failure(cancelTask(admin(A), { taskId, expectedVersion: 1, reason: "x" }))).code).toBe("NOT_FOUND");
    expect(await row(taskId)).toMatchObject({ status: "OPEN", version: 1 });
    const listedA = await listTasks(admin(A), { limit: 200 });
    expect(listedA.items.some((t) => t.id === taskId)).toBe(false);
    expect((await listTasks(admin(B), { limit: 200 })).items.some((t) => t.id === taskId)).toBe(true);
    // Olmayan kimlik ile aynı yanıt.
    expect((await failure(claimTask(admin(A), { taskId: randomUUID(), expectedVersion: 1 }))).code).toBe("NOT_FOUND");
  });

  it("B üyeliğine atama NOT_FOUND (başka tenant üyeliği)", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const e = await failure(assignTask(admin(A), { taskId: id as string, membershipId: B.memberMembershipId, expectedVersion: 1 }));
    expect(e.code).toBe("NOT_FOUND");
  });

  it("atama: audit + ASSIGNED; yeniden atama serbest; eski sürüm VERSION_CONFLICT", async () => {
    const [id] = await mkTasks(A, ["PUTAWAY"]);
    const taskId = id as string;
    expect(await assignTask(admin(A), { taskId, membershipId: A.memberMembershipId, expectedVersion: 1 })).toEqual({ version: 2 });
    expect(await row(taskId)).toMatchObject({ status: "ASSIGNED", assigned_membership_id: A.memberMembershipId });
    const [audit] = await audits(A.tenantId, "warehouse_task.assigned", taskId);
    expect(audit?.actor_user_id).toBe(A.ownerUserId);
    expect(audit?.change_summary).toMatchObject({ from_status: "OPEN", to_status: "ASSIGNED", to_membership_id: A.memberMembershipId });
    expect((await failure(assignTask(admin(A), { taskId, membershipId: A.ownerMembershipId, expectedVersion: 1 }))).code).toBe("VERSION_CONFLICT");
    expect(await assignTask(admin(A), { taskId, membershipId: A.ownerMembershipId, expectedVersion: 2 })).toEqual({ version: 3 });
    expect((await row(taskId)).assigned_membership_id).toBe(A.ownerMembershipId);
  });

  it("türün iznini taşımayan üyeye atanamaz / sayım görevini PICKER üstlenemez (A-132)", async () => {
    const [count, pick] = await mkTasks(A, ["COUNT", "PICK"]);
    const countId = count as string;
    const pickId = pick as string;
    expect((await failure(claimTask(picker(A), { taskId: countId, expectedVersion: 1 }))).code).toBe("FORBIDDEN");
    expect((await failure(assignTask(admin(A), { taskId: countId, membershipId: A.memberMembershipId, expectedVersion: 1 }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(claimTask(counter(A), { taskId: pickId, expectedVersion: 1 }))).code).toBe("FORBIDDEN");
    expect(await claimTask(counter(A), { taskId: countId, expectedVersion: 1 })).toEqual({ version: 2 });
    expect((await row(countId)).assigned_membership_id).toBe(counterMembershipId);
    expect(await row(pickId)).toMatchObject({ status: "OPEN", version: 1 });
  });

  it("üstlenme yalnızca OPEN: ASSIGNED görev DOCUMENT_STATE", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const taskId = id as string;
    await claimTask(picker(A), { taskId, expectedVersion: 1 });
    const e = await failure(claimTask(admin(A), { taskId, expectedVersion: 2 }));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" });
  });

  it("iptal: gerekçe zorunlu, audit reason'a yazılır, stok etkisi yok; CANCELLED sonrası her komut DOCUMENT_STATE", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const taskId = id as string;
    expect((await failure(cancelTask(admin(A), { taskId, expectedVersion: 1, reason: "   " }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(cancelTask(admin(A), { taskId, expectedVersion: 1, reason: "x".repeat(501) }))).code).toBe("VALIDATION_FAILED");
    expect(await row(taskId)).toMatchObject({ status: "OPEN", version: 1 });
    expect(await cancelTask(admin(A), { taskId, expectedVersion: 1, reason: " Sipariş iptal edildi " })).toEqual({ version: 2 });
    expect(await row(taskId)).toMatchObject({ status: "CANCELLED" });
    const [audit] = await audits(A.tenantId, "warehouse_task.cancelled", taskId);
    expect(audit?.reason).toBe("Sipariş iptal edildi");
    for (const p of [
      assignTask(admin(A), { taskId, membershipId: A.memberMembershipId, expectedVersion: 2 }),
      claimTask(admin(A), { taskId, expectedVersion: 2 }),
      cancelTask(admin(A), { taskId, expectedVersion: 2, reason: "tekrar" }),
    ]) {
      expect(await failure(p)).toMatchObject({ code: "VALIDATION_FAILED", detail: "DOCUMENT_STATE" });
    }
  });

  it("completeTask (iç yardımcı): DONE + completed_at + audit; sonrasında komutlar DOCUMENT_STATE; eski sürüm VERSION_CONFLICT", async () => {
    const [id] = await mkTasks(A, ["PICK"]);
    const taskId = id as string;
    await claimTask(picker(A), { taskId, expectedVersion: 1 });
    const stale = await failure(runTenantCommand({ ...picker(A), permission: "stock.post" }, (tx, m) => completeTask(tx, taskId, 1, m)));
    expect(stale.code).toBe("VERSION_CONFLICT");
    expect(await runTenantCommand({ ...picker(A), permission: "stock.post" }, (tx, m) => completeTask(tx, taskId, 2, m))).toEqual({ version: 3 });
    const done = await row(taskId);
    expect(done.status).toBe("DONE");
    expect(done.completed_at).not.toBeNull();
    expect(await audits(A.tenantId, "warehouse_task.completed", taskId)).toHaveLength(1);
    expect(await failure(cancelTask(admin(A), { taskId, expectedVersion: 3, reason: "geç" }))).toMatchObject({ detail: "DOCUMENT_STATE" });
    expect(await failure(runTenantCommand({ ...picker(A), permission: "stock.post" }, (tx, m) => completeTask(tx, taskId, 3, m)))).toMatchObject({ detail: "DOCUMENT_STATE" });
  });

  it("completeTask ve createTasks dış yüzeyden çağrılamaz (export testi)", () => {
    expect("completeTask" in ops).toBe(false);
    expect("createTasks" in ops).toBe(false);
    expect(Object.keys(ops).sort()).toEqual(
      ["REASON_MAX", "TASK_KINDS", "TASK_KIND_PERMISSION", "TASK_LIST_LIMIT_DEFAULT", "TASK_LIST_LIMIT_MAX", "TASK_SOURCE_KINDS", "TASK_STATUSES", "assignTask", "cancelTask", "claimTask", "listMyTasks", "listTasks", "nextTaskStatus"].sort(),
    );
    const pkg = JSON.parse(readFileSync(new URL("../../../packages/domain/package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["./operations"]).toBe("./src/operations/index.ts");
    expect(Object.keys(pkg.exports).filter((k) => k.startsWith("./operations"))).toEqual(["./operations"]);
  });
});

describe("görev sorguları", () => {
  it("listMyTasks: bana atanmış + izinli OPEN; başkasına atanmış, izinsiz tür ve sonlanmış görünmez", async () => {
    const w = await seedWorld(adm, reg, "L304");
    const wCounter = await mkUser(adm, reg, "L304 counter");
    await mkMembership(adm, w.tenantId, wCounter, { roles: ["COUNTER"] });
    const [open, mine, others, count, cancelled] = await mkTasks(w, ["PICK", "PUTAWAY", "PICK", "COUNT", "PICK"]);
    await assignTask(admin(w), { taskId: mine as string, membershipId: w.memberMembershipId, expectedVersion: 1 });
    await assignTask(admin(w), { taskId: others as string, membershipId: w.ownerMembershipId, expectedVersion: 1 });
    await cancelTask(admin(w), { taskId: cancelled as string, expectedVersion: 1, reason: "iptal" });
    const ids = (await listMyTasks(picker(w), { limit: 200 })).items.map((t) => t.id);
    expect(ids).toContain(open);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(others);
    expect(ids).not.toContain(count);
    expect(ids).not.toContain(cancelled);
    // Fikstürdeki tohum görevi (PUTAWAY, OPEN) de üstlenilebilirdir.
    const counterIds = (await listMyTasks({ db: app, principal: { userId: wCounter, mfaVerified: true }, tenantSlug: w.slug }, { limit: 200 })).items.map((t) => t.id);
    expect(counterIds).toEqual([count]);
  });

  it("listTasks: tür/durum süzgeci ve keyset sayfalama (OFFSET yok); sayfalar çakışmaz", async () => {
    const w = await seedWorld(adm, reg, "K304");
    const made = await mkTasks(w, ["PICK", "PICK", "PICK", "PICK", "PICK", "COUNT"]);
    const seen: string[] = [];
    let after: ops.TaskCursor | undefined;
    for (let i = 0; i < 10; i++) {
      const p = await listTasks(admin(w), { kind: "PICK", status: "OPEN", limit: 2, ...(after === undefined ? {} : { after }) });
      expect(p.items.length).toBeLessThanOrEqual(2);
      seen.push(...p.items.map((t) => t.id));
      if (p.next === null) break;
      after = p.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(made.slice(0, 5).sort());
    const counts = await listTasks(admin(w), { kind: "COUNT" });
    expect(counts.items.map((t) => t.id)).toEqual([made[5]]);
    expect((await failure(listTasks(admin(w), { limit: 0 }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(listTasks(admin(w), { after: { createdKey: "bozuk", id: randomUUID() } }))).code).toBe("VALIDATION_FAILED");
  });
});
