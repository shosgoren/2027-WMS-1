// T-117b birim testleri: son sahip / son yönetici / kendi rolünü yükseltme kuralları (saf işlevler) ve ret nedeninin
// yanıta sızmaması. Veritabanı gerektiren davranış `tests/integration/identity/memberships.int.test.ts` içindedir.
import { describe, expect, it } from "vitest";
import { AppError } from "@wms/shared/errors";
import { MembershipDenied, checkDeparture, checkRoleChange, changeRole, issuePasswordResetLink, type RuleTarget } from "./memberships.ts";
import { ROLE_KEYS, type RoleKey } from "./permissions.ts";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const owner = (userId = OTHER): RuleTarget => ({ userId, isOwner: true, roles: ["TENANT_ADMIN"] });
const admin = (userId = OTHER): RuleTarget => ({ userId, isOwner: false, roles: ["TENANT_ADMIN"] });
const member = (role: RoleKey, userId = OTHER): RuleTarget => ({ userId, isOwner: false, roles: [role] });

describe("checkDeparture (çıkarma / ayrılma)", () => {
  it("son sahip çıkarılamaz / ayrılamaz", () => {
    expect(checkDeparture({ target: owner(), ownerCount: 1, otherAdminCount: 5 })).toBe("LAST_OWNER");
  });
  it("başka sahip varsa sahip ayrılabilir", () => {
    expect(checkDeparture({ target: owner(), ownerCount: 2, otherAdminCount: 1 })).toBeNull();
  });
  it("tenant yöneticisiz bırakılamaz", () => {
    expect(checkDeparture({ target: admin(), ownerCount: 1, otherAdminCount: 0 })).toBe("LAST_ADMIN");
    expect(checkDeparture({ target: admin(), ownerCount: 1, otherAdminCount: 1 })).toBeNull();
  });
  it("yönetici olmayan üye serbestçe ayrılır", () => {
    for (const role of ROLE_KEYS.filter((r) => r !== "TENANT_ADMIN")) {
      expect(checkDeparture({ target: member(role), ownerCount: 1, otherAdminCount: 1 })).toBeNull();
    }
  });
});

describe("checkRoleChange (rol geçişleri)", () => {
  const base = { actorUserId: ME, ownerCount: 2, otherAdminCount: 2 } as const;
  it("sahibin rolü TENANT_ADMIN dışına düşürülemez (önce devir)", () => {
    expect(checkRoleChange({ ...base, target: owner(), newRole: "PICKER" })).toBe("OWNER_ROLE");
    expect(checkRoleChange({ ...base, ownerCount: 1, target: owner(), newRole: "READ_ONLY" })).toBe("LAST_OWNER");
    expect(checkRoleChange({ ...base, target: owner(), newRole: "TENANT_ADMIN" })).toBeNull();
  });
  it("son yönetici yöneticilikten düşürülemez", () => {
    expect(checkRoleChange({ ...base, otherAdminCount: 0, target: admin(), newRole: "COUNTER" })).toBe("LAST_ADMIN");
    expect(checkRoleChange({ ...base, otherAdminCount: 1, target: admin(), newRole: "COUNTER" })).toBeNull();
  });
  it("kendi rolünü yükseltme yok; eşit/alt küme serbest", () => {
    expect(checkRoleChange({ ...base, target: member("PICKER", ME), newRole: "TENANT_ADMIN" })).toBe("SELF_ESCALATION");
    expect(checkRoleChange({ ...base, target: member("COUNTER", ME), newRole: "WAREHOUSE_MANAGER" })).toBe("SELF_ESCALATION");
    expect(checkRoleChange({ ...base, target: member("WAREHOUSE_MANAGER", ME), newRole: "READ_ONLY" })).toBeNull();
    expect(checkRoleChange({ ...base, target: admin(ME), newRole: "WAREHOUSE_MANAGER" })).toBeNull();
  });
  it("başkasının rolü yükseltilebilir / değiştirilebilir", () => {
    expect(checkRoleChange({ ...base, target: member("READ_ONLY"), newRole: "TENANT_ADMIN" })).toBeNull();
    expect(checkRoleChange({ ...base, target: member("PICKER"), newRole: "COUNTER" })).toBeNull();
  });
});

describe("girdi doğrulaması ve ret nedeni", () => {
  const principal = { userId: ME, mfaVerified: true };
  const noDb = {} as never;
  it("geçersiz üye kimliği / rol veritabanına gitmeden VALIDATION_FAILED", async () => {
    await expect(changeRole({ db: noDb, principal, tenantSlug: "x", memberId: "nope", roleKey: "PICKER" }, { demoEmailDomain: null })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(changeRole({ db: noDb, principal, tenantSlug: "x", memberId: OTHER, roleKey: "ROOT" }, { demoEmailDomain: null })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("issuePasswordResetLink yeniden doğrulama kancası olmadan çalışmaz (fail-closed)", async () => {
    const port = { createToken: () => Promise.reject(new Error("unreachable")), discardToken: () => Promise.resolve(), recordIssued: () => Promise.resolve() };
    const err = await issuePasswordResetLink({ db: noDb, principal, tenantSlug: "x", memberId: OTHER }, { demoEmailDomain: null, port }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "UNAUTHENTICATED", detail: "RECENT_AUTH_REQUIRED" });
  });
  it("MembershipDenied nedeni yanıt gövdesine girmez", () => {
    const e = new AppError("FORBIDDEN");
    e.cause = new MembershipDenied("IDENTITY_SHARED");
    expect(JSON.stringify(e.toBody())).not.toContain("IDENTITY_SHARED");
    expect((e.cause as MembershipDenied).reason).toBe("IDENTITY_SHARED");
  });
});
