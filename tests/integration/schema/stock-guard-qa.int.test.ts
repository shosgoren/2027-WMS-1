// katman: db — yalnızca DB katmanı (RLS/GRANT/FK/tetikleyici/ertelenmiş denetim); komut katmanı T-220, belge şeması T-209.
// Stok yazma koruması (0013) — BAĞIMSIZ doğrulama (T-233, qa-verifier). Uygulayıcının testine (stock-ledger-schema) dayanmaz;
// ADR-017 §2-§6 + I-04/I-05 metninden yeniden türetilmiş senaryolardır. Beklenen değerler elle hesaplanmaz: ya ADR'de yazılı
// kural (mutlak eşitlik: bakiye = Σ defter, rezerve = Σ ACTIVE rezervasyon) ya da fikstürün kendi tohumudur.
//
// Roller: uygulama rolü wms_app (DATABASE_URL, PgBouncer transaction mode). Migration rolü (DATABASE_URL_DIRECT) fikstür kurulumu ve
// "tablo sahibi/süper kullanıcı/wms_ops da değiştiremez" denemeleri içindir. Reddedilmesi beklenen yazımlar gerçek COMMIT ile
// denenir (denetim ertelenmiştir; commit anında çalışır). Sentetik veri (G-09).
//
// Etiket politikası: @AC-04 yalnızca tenant-izolasyonu kanıtlarında (B kimliği/anahtarı reddi, RLS/FORCE taraması); koruma ve
// değişmezlik testleri AC değildir ve etiketlenmez (AC-09 kanıtı ac-09-db-serial.int.test.ts'tedir).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupRegistry, newRegistry, seedWorld, type TenantWorld } from "../fixtures/tenants.ts";
import { APP_ROLE, readIntEnv, redactErrorChain } from "../harness/env.ts";

const env = readIntEnv(process.env);
const INSUFFICIENT_PRIVILEGE = "42501";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const MISMATCH = "STOCK_BALANCE_LEDGER_MISMATCH";
const CTX_MISMATCH = "STOCK_TENANT_CONTEXT_MISMATCH";
const RLS_MESSAGE = /row-level security/i;
const STOCK_TABLES = ["stock_dimensions", "stock_balances", "stock_ledger", "reservations"] as const;

const reg = newRegistry();
const clients: pg.Client[] = [];
let admin: pg.Client;
let app: pg.Client;
let A: TenantWorld;
let B: TenantWorld;

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => undefined);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`connect failed: ${redactErrorChain(e, [url])}`);
  }
  clients.push(c);
  return c;
}

type Attempt =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { ok: false; code: string | undefined; message: string; constraint: string | undefined; detail: string | undefined };
type Q = (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
/** commit: gerçek COMMIT (ertelenmiş denetim burada); check: SET CONSTRAINTS ALL IMMEDIATE + ROLLBACK; rollback: yalnızca ROLLBACK. */
type End = "commit" | "check" | "rollback";

async function tx(client: pg.Client, tenantId: string | null, work: (q: Q) => Promise<unknown>, end: End = "rollback"): Promise<Attempt> {
  await client.query("BEGIN");
  try {
    if (tenantId !== null) await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    let last: pg.QueryResult | undefined;
    await work(async (sql, p) => {
      last = await client.query(sql, p);
      return last;
    });
    if (end === "commit") {
      await client.query("COMMIT");
    } else {
      if (end === "check") await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("ROLLBACK");
    }
    return { ok: true, rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string; constraint?: string; detail?: string };
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, code: err.code, message: String(err.message), constraint: err.constraint, detail: err.detail };
  }
}
const asApp = (tenantId: string | null, work: (q: Q) => Promise<unknown>, end: End = "rollback"): Promise<Attempt> => tx(app, tenantId, work, end);
const asAdmin = (tenantId: string | null, work: (q: Q) => Promise<unknown>, end: End = "rollback"): Promise<Attempt> => tx(admin, tenantId, work, end);

function expectFail(r: Attempt, code: string, label: string, msg?: string): void {
  expect(r.ok, `${label}: ret (${code}) beklenirdi ama kabul edildi`).toBe(false);
  if (!r.ok) {
    expect(r.code, `${label}: ${r.message}`).toBe(code);
    if (msg !== undefined) expect(r.message, label).toContain(msg);
  }
}
function expectOk(r: Attempt, label: string): void {
  expect(r.ok, `${label}: ${JSON.stringify(r)}`).toBe(true);
}

const SQL_DIM = "INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, serial_id, stock_status) VALUES ($1, $2, $3, $4, $5, $6, $7)";
const SQL_LEDGER = `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date)
   VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 't233', '2026-02-01')`;
const SQL_BAL = "INSERT INTO public.stock_balances (tenant_id, stock_dimension_id, quantity, reserved_quantity) VALUES ($1, $2, $3, $4)";
const SQL_RES = "INSERT INTO public.reservations (tenant_id, id, stock_dimension_id, document_line_id, quantity) VALUES ($1, $2, $3, $4, $5)";

const ledgerRow = (q: Q, w: TenantWorld, dim: string, qty: number): Promise<pg.QueryResult> => q(SQL_LEDGER, [w.tenantId, w.documentId, w.documentLineId, dim, qty]);
/** Fikstürde bulunmayan (itemTwo, kök lokasyon) boyutu; yalnızca geri alınan işlemlerde kullanılır. */
async function freshDim(q: Q, w: TenantWorld, status = "AVAILABLE"): Promise<string> {
  const id = randomUUID();
  await q(SQL_DIM, [w.tenantId, id, w.itemTwoId, w.rootLocationId, null, null, status]);
  return id;
}
const bump = (q: Q, w: TenantWorld, dim: string, dq: number, dr = 0): Promise<pg.QueryResult> =>
  q("UPDATE public.stock_balances SET quantity = quantity + $3, reserved_quantity = reserved_quantity + $4 WHERE tenant_id = $1 AND stock_dimension_id = $2", [w.tenantId, dim, dq, dr]);

beforeAll(async () => {
  admin = await connect(env.databaseUrlDirect);
  app = await connect(env.databaseUrl);
  A = await seedWorld(admin, reg, "A");
  B = await seedWorld(admin, reg, "B");
}, 60_000);

afterAll(async () => {
  try {
    if (admin !== undefined) await cleanupRegistry(admin, reg);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
}, 60_000);

describe("T-233 (1a-c) mutlak denetim: aynı satıra çoklu UPDATE, defter'siz INSERT, defter-yalnız INSERT", () => {
  it("kontrol: tutarlı defter + tek UPDATE kabul edilir (SET CONSTRAINTS ALL IMMEDIATE)", async () => {
    expectOk(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 5); await bump(q, A, A.dimensionId, 5); }, "check"), "tutarlı");
  });

  for (const n of [2, 3]) {
    it(`aynı bakiye satırına ${n} UPDATE (+5 her biri) + tek defter +5 → commit'te ${MISMATCH}`, async () => {
      const r = await asApp(
        A.tenantId,
        async (q) => {
          await ledgerRow(q, A, A.dimensionId, 5);
          for (let i = 0; i < n; i++) await bump(q, A, A.dimensionId, 5);
        },
        "commit",
      );
      expectFail(r, CHECK_VIOLATION, `N=${n}`, MISMATCH);
    });
  }

  it("N UPDATE'in toplamı defterle eşitse kabul (yalnız olay sayısı değil mutlak toplam: 3 defter + 3 UPDATE)", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        for (let i = 0; i < 3; i++) {
          await ledgerRow(q, A, A.dimensionId, 2);
          await bump(q, A, A.dimensionId, 2);
        }
      },
      "check",
    );
    expectOk(r, "3+3");
  });

  it("defter olmadan pozitif bakiye INSERT'i (quantity=100) → ret", async () => {
    const r = await asApp(A.tenantId, async (q) => { const d = await freshDim(q, A); await q(SQL_BAL, [A.tenantId, d, 100, 0]); }, "commit");
    expectFail(r, CHECK_VIOLATION, "defter'siz INSERT", MISMATCH);
  });

  it("kontrol: defter'siz SIFIR bakiye satırı kabul (Σ defter = 0)", async () => {
    expectOk(await asApp(A.tenantId, async (q) => { const d = await freshDim(q, A); await q(SQL_BAL, [A.tenantId, d, 0, 0]); }, "check"), "sıfır bakiye");
  });

  it("defter-yalnız INSERT: mevcut bakiyeli boyuta ve bakiyesiz yeni boyuta → ret", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 3); }, "commit"), CHECK_VIOLATION, "mevcut boyut", MISMATCH);
    expectFail(await asApp(A.tenantId, async (q) => { const d = await freshDim(q, A); await ledgerRow(q, A, d, 7); }, "commit"), CHECK_VIOLATION, "yeni boyut", MISMATCH);
  });

  it("defter satırı eksi miktarlı ve bakiye düşürülmeden → ret; bakiye düşürüldüyse kabul", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, -2); }, "commit"), CHECK_VIOLATION, "eksi defter", MISMATCH);
    expectOk(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, -2); await bump(q, A, A.dimensionId, -2); }, "check"), "eksi tutarlı");
  });

  it("bakiye farklı miktarla güncellenirse (defter +5, bakiye +4) → ret", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 5); await bump(q, A, A.dimensionId, 4); }, "commit"), CHECK_VIOLATION, "+5/+4", MISMATCH);
  });

  it("yalnız bakiye UPDATE'i (defter yok) → ret", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await bump(q, A, A.dimensionId, 1); }, "commit"), CHECK_VIOLATION, "yalnız UPDATE", MISMATCH);
  });
});

describe("T-233 (1d-e) rezervasyon ve reserved_quantity", () => {
  it("bakiye-yalnız reserved_quantity artışı ve azalışı → ret", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await bump(q, A, A.dimensionId, 0, 1); }, "commit"), CHECK_VIOLATION, "reserved +1", MISMATCH);
    expectFail(await asApp(A.tenantId, async (q) => { await bump(q, A, A.dimensionId, 0, -1); }, "commit"), CHECK_VIOLATION, "reserved -1", MISMATCH);
  });

  it("rezervasyon-yalnız INSERT (reserved_quantity güncellenmeden) → ret; güncellenirse kabul", async () => {
    const ins = (q: Q): Promise<pg.QueryResult> => q(SQL_RES, [A.tenantId, randomUUID(), A.dimensionId, A.documentLineId, 1]);
    expectFail(await asApp(A.tenantId, async (q) => { await ins(q); }, "commit"), CHECK_VIOLATION, "yalnız INSERT", MISMATCH);
    expectOk(await asApp(A.tenantId, async (q) => { await ins(q); await bump(q, A, A.dimensionId, 0, 1); }, "check"), "tutarlı rezervasyon");
  });

  it("rezervasyon-yalnız status UPDATE'i (ACTIVE→RELEASED) → ret; bakiye rezerve düşerse kabul", async () => {
    const rel = (q: Q): Promise<pg.QueryResult> =>
      q("UPDATE public.reservations SET status = 'RELEASED', closed_at = now() WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.reservationId]);
    expectFail(await asApp(A.tenantId, async (q) => { await rel(q); }, "commit"), CHECK_VIOLATION, "yalnız status", MISMATCH);
    expectFail(await asApp(A.tenantId, async (q) => { await q("UPDATE public.reservations SET quantity = 1 WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.reservationId]); }, "commit"), CHECK_VIOLATION, "yalnız quantity", MISMATCH);
    expectOk(await asApp(A.tenantId, async (q) => { await rel(q); await bump(q, A, A.dimensionId, 0, -4); }, "check"), "tutarlı serbest bırakma");
  });

  it("rezervasyonun stock_dimension_id değişimi: yeni boyut tutarlı ama ESKİ boyut tutarsız kalırsa → ret", async () => {
    const move = (q: Q, to: string): Promise<pg.QueryResult> =>
      q("UPDATE public.reservations SET stock_dimension_id = $3 WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.reservationId, to]);
    // Yeni boyut: defter 5 + bakiye 5/rezerve 4 (kendi içinde tutarlı); eski boyut reserved=4 ama Σ ACTIVE = 0.
    const setupNew = async (q: Q): Promise<string> => {
      const d = await freshDim(q, A);
      await ledgerRow(q, A, d, 5);
      await q(SQL_BAL, [A.tenantId, d, 5, 4]);
      return d;
    };
    expectFail(await asApp(A.tenantId, async (q) => { const d = await setupNew(q); await move(q, d); }, "commit"), CHECK_VIOLATION, "eski boyut tutarsız", MISMATCH);
    // Kontrol: eski boyutun rezerve'i de düşürülürse kabul.
    expectOk(await asApp(A.tenantId, async (q) => { const d = await setupNew(q); await move(q, d); await bump(q, A, A.dimensionId, 0, -4); }, "check"), "her iki boyut tutarlı");
    // Yeni boyutun rezerve'i güncellenmezse (eski düzeltilmiş) → ret.
    expectFail(
      await asApp(A.tenantId, async (q) => {
        const d = await freshDim(q, A);
        await ledgerRow(q, A, d, 5);
        await q(SQL_BAL, [A.tenantId, d, 5, 0]);
        await move(q, d);
        await bump(q, A, A.dimensionId, 0, -4);
      }, "commit"),
      CHECK_VIOLATION, "yeni boyut tutarsız", MISMATCH,
    );
  });
});

describe("T-233 (1f) defter değişmezliği her rolde", () => {
  const stmts: [string, string][] = [
    ["UPDATE miktar", "UPDATE public.stock_ledger SET quantity = quantity + 1 WHERE id = '%L'"],
    ["UPDATE reason", "UPDATE public.stock_ledger SET reason = 'x' WHERE id = '%L'"],
    ["DELETE", "DELETE FROM public.stock_ledger WHERE id = '%L'"],
    ["TRUNCATE", "TRUNCATE public.stock_ledger"],
  ];
  const sqlFor = (s: string): string => s.replace("%L", A.ledgerId);

  it("wms_app: UPDATE/DELETE/TRUNCATE → 42501", async () => {
    for (const [name, s] of stmts) expectFail(await asApp(A.tenantId, async (q) => { await q(sqlFor(s)); }), INSUFFICIENT_PRIVILEGE, `wms_app ${name}`);
  });

  it("wms_app session_replication_role=replica kuramaz (42501)", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await q("SET LOCAL session_replication_role = replica"); }), INSUFFICIENT_PRIVILEGE, "SET LOCAL");
    expectFail(await asApp(A.tenantId, async (q) => { await q("SELECT set_config('session_replication_role', 'replica', true)"); }), INSUFFICIENT_PRIVILEGE, "set_config");
  });

  it("migration rolü (tablo sahibi): UPDATE/DELETE/TRUNCATE tetikleyiciyle 42501 (append-only)", async () => {
    for (const [name, s] of stmts) expectFail(await asAdmin(A.tenantId, async (q) => { await q(sqlFor(s)); }), INSUFFICIENT_PRIVILEGE, `owner ${name}`, "append-only");
  });

  it("migration rolü + session_replication_role=replica altında da ret", async () => {
    for (const [name, s] of stmts) {
      expectFail(
        await asAdmin(A.tenantId, async (q) => { await q("SET LOCAL session_replication_role = replica"); await q(sqlFor(s)); }),
        INSUFFICIENT_PRIVILEGE, `owner+replica ${name}`, "append-only",
      );
    }
  });

  it("wms_ops (SET ROLE): UPDATE/DELETE/TRUNCATE ret, replica modu dahil", async () => {
    for (const [name, s] of stmts) {
      expectFail(await asAdmin(A.tenantId, async (q) => { await q("SET LOCAL ROLE wms_ops"); await q(sqlFor(s)); }), INSUFFICIENT_PRIVILEGE, `ops ${name}`);
      expectFail(
        await asAdmin(A.tenantId, async (q) => { await q("SET LOCAL session_replication_role = replica"); await q("SET LOCAL ROLE wms_ops"); await q(sqlFor(s)); }),
        INSUFFICIENT_PRIVILEGE, `ops+replica ${name}`,
      );
    }
  });

  it("defter satırı değişmedi ve silinmedi (sahip düzeyi denemelerden sonra)", async () => {
    const r = await asApp(A.tenantId, async (q) => q("SELECT quantity::text AS q, reason FROM public.stock_ledger WHERE id = $1", [A.ledgerId]));
    expectOk(r, "okuma");
    if (r.ok) expect(r.rows).toEqual([{ q: "10.000000", reason: "T232 fikstur" }]);
  });

  it("boyut tablosu da değişmez (sahip: UPDATE/DELETE → 42501)", async () => {
    expectFail(await asAdmin(A.tenantId, async (q) => { await q("UPDATE public.stock_dimensions SET stock_status = 'BLOCKED' WHERE id = $1", [A.dimensionId]); }), INSUFFICIENT_PRIVILEGE, "dim UPDATE");
    expectFail(await asAdmin(A.tenantId, async (q) => { await q("DELETE FROM public.stock_dimensions WHERE id = $1", [A.dimensionId]); }), INSUFFICIENT_PRIVILEGE, "dim DELETE");
  });
});

describe("T-233 (1g) DELETE/TRUNCATE yasağı stok tablolarında (wms_app)", () => {
  for (const t of STOCK_TABLES) {
    it(`${t}: DELETE ve TRUNCATE → 42501`, async () => {
      expectFail(await asApp(A.tenantId, async (q) => { await q(`DELETE FROM public.${t} WHERE tenant_id = $1`, [A.tenantId]); }), INSUFFICIENT_PRIVILEGE, `${t} DELETE`);
      expectFail(await asApp(A.tenantId, async (q) => { await q(`TRUNCATE public.${t}`); }), INSUFFICIENT_PRIVILEGE, `${t} TRUNCATE`);
    });
  }
  it("bakiye/rezervasyon sütun yetkisi: kimlik sütunları UPDATE edilemez (42501)", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await q("UPDATE public.stock_balances SET stock_dimension_id = $2 WHERE tenant_id = $1 AND stock_dimension_id = $3", [A.tenantId, A.serialDimensionId, A.dimensionId]); }), INSUFFICIENT_PRIVILEGE, "bal dim");
    expectFail(await asApp(A.tenantId, async (q) => { await q("UPDATE public.reservations SET document_line_id = $2 WHERE tenant_id = $1", [A.tenantId, A.documentLineId]); }), INSUFFICIENT_PRIVILEGE, "res line");
    expectFail(await asApp(A.tenantId, async (q) => { await q("UPDATE public.stock_balances SET tenant_id = $1", [B.tenantId]); }), INSUFFICIENT_PRIVILEGE, "bal tenant");
  });
});

describe("T-233 (1h) created_xid sunucu değeri", () => {
  it("wms_app created_xid / occurred_at sütununu INSERT listesine koyamaz (42501)", async () => {
    for (const col of ["created_xid", "occurred_at"]) {
      const val = col === "created_xid" ? "'1'::text::xid8" : "'2000-01-01'::timestamptz";
      const r = await asApp(A.tenantId, async (q) => {
        const d = await freshDim(q, A);
        await q(
          `INSERT INTO public.stock_ledger (tenant_id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, ${col})
           VALUES ($1, $2, $3, $4, 1, 't233', '2026-02-01', ${val})`,
          [A.tenantId, A.documentId, A.documentLineId, d],
        );
      });
      expectFail(r, INSUFFICIENT_PRIVILEGE, col);
    }
  });

  it("sahip düzeyinde bile istemci created_xid/occurred_at değeri yok sayılır (tetikleyici sunucu değerini yazar)", async () => {
    const r = await asAdmin(A.tenantId, async (q) => {
      const d = await freshDim(q, A);
      await q(
        `INSERT INTO public.stock_ledger (tenant_id, id, document_id, document_line_id, stock_dimension_id, quantity, reason, business_date, created_xid, occurred_at)
         VALUES ($1, $5, $2, $3, $4, 1, 't233', '2026-02-01', '1'::text::xid8, '2000-01-01'::timestamptz)`,
        [A.tenantId, A.documentId, A.documentLineId, d, randomUUID()],
      );
      await q(SQL_BAL, [A.tenantId, d, 1, 0]);
      await q("SELECT (created_xid = pg_current_xact_id()) AS xid_ok, (occurred_at >= now() - interval '1 minute') AS at_ok FROM public.stock_ledger WHERE stock_dimension_id = $1", [d]);
    }, "check");
    expectOk(r, "owner insert");
    if (r.ok) expect(r.rows).toEqual([{ xid_ok: true, at_ok: true }]);
  });

  it("fikstür defter satırlarının created_xid'si 1 değildir ve boş değildir", async () => {
    const r = await asApp(A.tenantId, async (q) => q("SELECT count(*)::int AS n FROM public.stock_ledger WHERE created_xid IS NULL OR created_xid::text = '1'"));
    expectOk(r, "xid");
    if (r.ok) expect(r.rows[0]).toEqual({ n: 0 });
  });
});

describe("T-233 (1i) istemci GUC'ları denetimi atlatamaz", () => {
  const names = ["wms.stock_checked", "wms.stock_check_skip", "wms.skip_stock_assert", "app.stock_checked", "app.skip_stock_check", "app.stock_assert_off", "stock.checked", "wms.dimension"];
  for (const [label, value] of [["boyut kimliği", "DIM"], ["'true'", "true"], ["'1'", "1"], ["tenant kimliği", "TENANT"], ["boş", ""]] as const) {
    it(`GUC'lar (${label}, transaction-local) kurulup defter'siz yazım → ret`, async () => {
      const v = (d: string): string => (value === "DIM" ? d : value === "TENANT" ? A.tenantId : value);
      const r = await asApp(
        A.tenantId,
        async (q) => {
          for (const n of names) await q("SELECT set_config($1, $2, true)", [n, v(A.dimensionId)]);
          await bump(q, A, A.dimensionId, 3);
        },
        "commit",
      );
      expectFail(r, CHECK_VIOLATION, label, MISMATCH);
    });
  }

  it("oturum düzeyi GUC (is_local=false) ve rastgele GUC'lar da etkisiz; sonra bağlantı temizlenir", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        for (const n of names) await q("SELECT set_config($1, $2, false)", [n, A.dimensionId]);
        await q("SELECT set_config($1, 'on', true)", [`wms.g${randomBytes(4).toString("hex")}`]);
        await q("SELECT set_config($1, $2, true)", [`app.g${randomBytes(4).toString("hex")}`, A.dimensionId]);
        await ledgerRow(q, A, A.serialDimensionId, 1);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "session GUC", MISMATCH);
    await app.query("RESET ALL");
  });

  it("GUC kurulmadan kabul edilen kontrol: tutarlı yazım GUC varlığına bağlı değildir", async () => {
    expectOk(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 1); await bump(q, A, A.dimensionId, 1); }, "check"), "tutarlı");
  });
});

describe("T-233 (1j) tenant bağlamı değişimi: STOCK_TENANT_CONTEXT_MISMATCH", () => {
  const switchTo = (q: Q, v: string): Promise<pg.QueryResult> => q("SELECT set_config('app.current_tenant_id', $1, true)", [v]);

  it("A'da defter'siz bakiye yazıp commit'ten önce bağlam B'ye / boşa çevrilirse → ret", async () => {
    for (const [label, v] of [["B", B.tenantId], ["boş", ""]] as const) {
      expectFail(await asApp(A.tenantId, async (q) => { await bump(q, A, A.dimensionId, 3); await switchTo(q, v); }, "commit"), CHECK_VIOLATION, `bakiye -> ${label}`, CTX_MISMATCH);
    }
  });

  it("defter-yalnız ve rezervasyon-yalnız yazım için de aynı", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 3); await switchTo(q, B.tenantId); }, "commit"), CHECK_VIOLATION, "defter -> B", CTX_MISMATCH);
    expectFail(
      await asApp(A.tenantId, async (q) => { await q(SQL_RES, [A.tenantId, randomUUID(), A.dimensionId, A.documentLineId, 1]); await switchTo(q, B.tenantId); }, "commit"),
      CHECK_VIOLATION, "rezervasyon -> B", CTX_MISMATCH,
    );
  });

  it("bağlam başka tenant'a çevrilince tutarlı yazım bile commit edilemez (bağlam yazımla aynı olmak zorunda)", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await ledgerRow(q, A, A.dimensionId, 1); await bump(q, A, A.dimensionId, 1); await switchTo(q, B.tenantId); }, "commit"), CHECK_VIOLATION, "tutarlı -> B", CTX_MISMATCH);
  });

  it("bağlamsız (hiç set_config yok) oturum: INSERT RLS ile reddedilir, UPDATE hiçbir satıra dokunamaz", async () => {
    const r = await asApp(null, async (q) => { await q(SQL_DIM, [A.tenantId, randomUUID(), A.itemTwoId, A.rootLocationId, null, null, "AVAILABLE"]); });
    expectFail(r, INSUFFICIENT_PRIVILEGE, "bağlamsız INSERT");
    if (!r.ok) expect(r.message).toMatch(RLS_MESSAGE);
    const u = await asApp(null, async (q) => q("UPDATE public.stock_balances SET quantity = quantity + 1 WHERE tenant_id = $1", [A.tenantId]), "commit");
    expectOk(u, "bağlamsız UPDATE");
    if (u.ok) expect(u.rowCount).toBe(0);
  });
});

describe("T-233 (1k) SET CONSTRAINTS ile denetimi öne çekmek / yeniden ertelemek denetimi kapatmaz", () => {
  it("SET CONSTRAINTS ALL IMMEDIATE sonrası defter'siz ek bakiye yazımı → ret", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await ledgerRow(q, A, A.dimensionId, 2);
        await bump(q, A, A.dimensionId, 2);
        await q("SET CONSTRAINTS ALL IMMEDIATE");
        await bump(q, A, A.dimensionId, 3);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "bakiye ek", MISMATCH);
  });

  it("SET CONSTRAINTS ALL IMMEDIATE sonrası defter'siz ek rezervasyon yazımı → ret", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await q("SET CONSTRAINTS ALL IMMEDIATE");
        await q(SQL_RES, [A.tenantId, randomUUID(), A.dimensionId, A.documentLineId, 1]);
      },
      "commit",
    );
    expectFail(r, CHECK_VIOLATION, "rezervasyon ek", MISMATCH);
  });

  it("kontrol: tutarlı yazım + SET CONSTRAINTS ALL IMMEDIATE (denetim öne çekilir, geçer) + gerçek COMMIT kabul edilir (+2 sonra -2)", async () => {
    const r = await asApp(
      A.tenantId,
      async (q) => {
        await ledgerRow(q, A, A.dimensionId, 2);
        await bump(q, A, A.dimensionId, 2);
        await ledgerRow(q, A, A.dimensionId, -2);
        await bump(q, A, A.dimensionId, -2);
        await q("SET CONSTRAINTS ALL IMMEDIATE");
      },
      "commit",
    );
    expectOk(r, "tutarlı");
  });

  for (const trg of ["stock_balances_assert", "stock_ledger_assert", "reservations_assert"]) {
    it(`SET CONSTRAINTS ${trg} DEFERRED ile yeniden erteleme sonrası defter'siz yazım → ret`, async () => {
      const r = await asApp(
        A.tenantId,
        async (q) => {
          await q("SET CONSTRAINTS ALL IMMEDIATE");
          await q(`SET CONSTRAINTS public.${trg} DEFERRED`);
          await bump(q, A, A.dimensionId, 1);
          await q(SQL_RES, [A.tenantId, randomUUID(), A.serialDimensionId, A.documentLineId, 1]);
        },
        "commit",
      );
      expectFail(r, CHECK_VIOLATION, trg, MISMATCH);
    });
  }

  it("tek bir tetikleyici ertelenmiş kalsa bile diğer tablonun yazımı commit'te denetlenir (tüm üç tetikleyici INITIALLY DEFERRED + DEFERRABLE)", async () => {
    const r = await admin.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean; tgenabled: string }>(
      `SELECT tgname, tgdeferrable, tginitdeferred, tgenabled FROM pg_trigger
        WHERE tgname IN ('stock_balances_assert', 'stock_ledger_assert', 'reservations_assert') ORDER BY tgname`,
    );
    expect(r.rows).toEqual(["reservations_assert", "stock_balances_assert", "stock_ledger_assert"].map((tgname) => ({ tgname, tgdeferrable: true, tginitdeferred: true, tgenabled: "A" })));
  });
});

describe("T-233 (2) bileşik FK: tenant ve ürün sınırı", () => {
  const stripIds = (s: string | undefined): string => (s ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");

  const attempts: [string, (q: Q, dim: string) => Promise<unknown>][] = [
    ["stock_balances", (q, d) => q(SQL_BAL, [A.tenantId, d, 0, 0])],
    ["reservations", (q, d) => q(SQL_RES, [A.tenantId, randomUUID(), d, A.documentLineId, 1])],
    ["stock_ledger", (q, d) => ledgerRow(q, A, d, 1)],
  ];

  for (const [table, doIt] of attempts) {
    it(`@AC-04 ${table}: A bağlamında B'nin boyut kimliği → 23503; hata, B satırının varlığını ayırt ettirmez`, async () => {
      const real = await asApp(A.tenantId, async (q) => { await doIt(q, B.dimensionId); });
      const ghost = await asApp(A.tenantId, async (q) => { await doIt(q, randomUUID()); });
      expectFail(real, FK_VIOLATION, `${table} B boyutu`);
      expectFail(ghost, FK_VIOLATION, `${table} olmayan boyut`);
      if (!real.ok && !ghost.ok) {
        expect(real.constraint, table).toBe(ghost.constraint);
        expect(stripIds(real.message), table).toBe(stripIds(ghost.message));
        expect(stripIds(real.detail), table).toBe(stripIds(ghost.detail));
        expect(real.message + (real.detail ?? "")).not.toContain(B.tenantId);
      }
    });
  }

  it("@AC-04 B'nin tenant_id'si ile A bağlamında stok yazımı → RLS (42501), B boyutu kullanılsa da", async () => {
    for (const [name, sql, params] of [
      ["bakiye", SQL_BAL, [B.tenantId, B.dimensionId, 0, 0]],
      ["rezervasyon", SQL_RES, [B.tenantId, randomUUID(), B.dimensionId, B.documentLineId, 1]],
      ["defter", SQL_LEDGER, [B.tenantId, B.documentId, B.documentLineId, B.dimensionId, 1]],
      ["boyut", SQL_DIM, [B.tenantId, randomUUID(), B.itemTwoId, B.rootLocationId, null, null, "AVAILABLE"]],
    ] as [string, string, unknown[]][]) {
      const r = await asApp(A.tenantId, async (q) => { await q(sql, params); });
      expectFail(r, INSUFFICIENT_PRIVILEGE, name);
      if (!r.ok) expect(r.message, name).toMatch(RLS_MESSAGE);
    }
  });

  it("@AC-04 boyut: B'nin ürün/lokasyon/lot/sahip/taşıma birimi kimlikleri A'da → 23503", async () => {
    const mk = (item: string, loc: string, lot: string | null, owner: string | null, hu: string | null) => async (q: Q): Promise<void> => {
      await q(
        "INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, lot_id, inventory_owner_id, handling_unit_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [A.tenantId, randomUUID(), item, loc, lot, owner, hu],
      );
    };
    expectFail(await asApp(A.tenantId, mk(B.itemTwoId, A.rootLocationId, null, null, null)), FK_VIOLATION, "B ürünü");
    expectFail(await asApp(A.tenantId, mk(A.itemTwoId, B.rootLocationId, null, null, null)), FK_VIOLATION, "B lokasyonu");
    expectFail(await asApp(A.tenantId, mk(A.itemTwoId, A.rootLocationId, B.lotTwoId, null, null)), FK_VIOLATION, "B lotu");
    expectFail(await asApp(A.tenantId, mk(A.itemTwoId, A.rootLocationId, null, B.ownerId, null)), FK_VIOLATION, "B sahibi");
    expectFail(await asApp(A.tenantId, mk(A.itemTwoId, A.rootLocationId, null, null, B.handlingUnitId)), FK_VIOLATION, "B taşıma birimi");
  });

  it("aynı tenant'ta başka ürünün lot/seri kimliğiyle boyut → 23503", async () => {
    // lotId/serialId item1'e, lotTwoId item2'ye aittir.
    const ins = (item: string, lot: string | null, serial: string | null) => async (q: Q): Promise<void> => {
      await q(SQL_DIM, [A.tenantId, randomUUID(), item, A.rootLocationId, lot, serial, "AVAILABLE"]);
    };
    expectFail(await asApp(A.tenantId, ins(A.itemTwoId, A.lotId, null)), FK_VIOLATION, "item2 + item1 lotu");
    expectFail(await asApp(A.tenantId, ins(A.itemId, A.lotTwoId, null)), FK_VIOLATION, "item1 + item2 lotu");
    expectFail(await asApp(A.tenantId, ins(A.itemTwoId, null, A.serialId)), FK_VIOLATION, "item2 + item1 serisi");
    expectOk(await asApp(A.tenantId, ins(A.itemTwoId, A.lotTwoId, null)), "kontrol: item2 + kendi lotu");
    expectOk(await asApp(A.tenantId, ins(A.itemId, A.lotId, A.serialId)), "kontrol: item1 + kendi lot/serisi (farklı lokasyonda değil; kök lokasyon serbest)");
  });

  it("NULL lot/seri/sahip/taşıma birimli iki özdeş boyut → tekillik (23505); farklı durum/sahip serbest", async () => {
    expectFail(await asApp(A.tenantId, async (q) => { await freshDim(q, A); await freshDim(q, A); }), UNIQUE_VIOLATION, "özdeş NULL boyut");
    // Fikstür boyutunun (item1, kök, lot, serisiz) özdeşi → tekillik.
    expectFail(await asApp(A.tenantId, async (q) => { await q(SQL_DIM, [A.tenantId, randomUUID(), A.itemId, A.rootLocationId, null, null, "AVAILABLE"]); }), UNIQUE_VIOLATION, "fikstür özdeşi");
    expectOk(
      await asApp(A.tenantId, async (q) => {
        await freshDim(q, A, "AVAILABLE");
        await freshDim(q, A, "QUARANTINE");
        await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, inventory_owner_id) VALUES ($1, $2, $3, $4, $5)", [A.tenantId, randomUUID(), A.itemTwoId, A.rootLocationId, A.ownerId]);
      }),
      "kontrol: farklı durum/sahip",
    );
  });
});

describe("T-233 (3) @AC-04 DB katmanı: dinamik stok tablosu taraması", () => {
  const ADR017_TABLES = [...STOCK_TABLES, "documents", "document_lines", "document_status_history", "number_sequences", "idempotency_records"];
  const GLOBAL_SYSTEM_TABLES = new Set(["document_type_versions"]);

  async function tenantTables(): Promise<string[]> {
    const r = await admin.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`,
    );
    return r.rows.map((x) => x.table_name);
  }

  it("@AC-04 tenant_id'li tablolar listesi ADR-017 tablolarını içerir (eksik = FAIL)", async () => {
    const found = await tenantTables();
    const missing = ADR017_TABLES.filter((t) => !found.includes(t));
    expect(missing, `taramada yok: ${missing.join(", ")}`).toEqual([]);
  });

  it("@AC-04 her tenant tablosu: ENABLE + FORCE RLS, ≥1 politika, sahibi wms_app değil, PUBLIC yetkisi yok", async () => {
    const found = await tenantTables();
    for (const t of found) {
      const m = await admin.query<{ rls: boolean; force: boolean; owner: string; policies: number; pub: boolean }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner)::text AS owner,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                (SELECT count(*) > 0 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0) AS pub
           FROM pg_class c WHERE c.oid = ('public.' || quote_ident($1))::regclass`,
        [t],
      );
      const row = m.rows[0];
      expect(row, t).toBeDefined();
      expect({ t, rls: row?.rls, force: row?.force, ownerIsApp: row?.owner === APP_ROLE, policies: (row?.policies ?? 0) > 0, pub: row?.pub }, t).toEqual({
        t, rls: true, force: true, ownerIsApp: false, policies: true, pub: false,
      });
    }
  });

  it("@AC-04 ADR-017 tablolarında A bağlamı yalnız A satırı görür (fikstürde satır var), B satırı yok", async () => {
    for (const t of ADR017_TABLES.filter((x) => !GLOBAL_SYSTEM_TABLES.has(x))) {
      const r = await asApp(A.tenantId, async (q) => q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id <> $1)::int AS other FROM public.${t}`, [A.tenantId]));
      expectOk(r, t);
      if (r.ok) {
        const row = r.rows[0] as { n: number; other: number };
        expect(row.other, `${t}: yabancı satır görünüyor`).toBe(0);
        expect(row.n, `${t}: fikstürde A satırı yok (T-232 fikstür bulgusu)`).toBeGreaterThan(0);
      }
    }
  });

  it("@AC-04 stok tablolarında B satırı kimlikle de görünmez ve A bağlamından değiştirilemez", async () => {
    const probes: [string, string, string][] = [
      ["stock_dimensions", "id", B.dimensionId],
      ["stock_ledger", "id", B.ledgerId],
      ["reservations", "id", B.reservationId],
      ["stock_balances", "stock_dimension_id", B.dimensionId],
    ];
    for (const [t, col, id] of probes) {
      const r = await asApp(A.tenantId, async (q) => q(`SELECT count(*)::int AS n FROM public.${t} WHERE ${col} = $1`, [id]));
      expectOk(r, t);
      if (r.ok) expect(r.rows[0], t).toEqual({ n: 0 });
    }
    const up = await asApp(A.tenantId, async (q) => q("UPDATE public.stock_balances SET quantity = quantity WHERE stock_dimension_id = $1", [B.dimensionId]));
    expectOk(up, "UPDATE");
    if (up.ok) expect(up.rowCount).toBe(0);
    const seenFromB = await asApp(B.tenantId, async (q) => q("SELECT quantity::text AS q, reserved_quantity::text AS r FROM public.stock_balances WHERE stock_dimension_id = $1", [B.dimensionId]));
    if (seenFromB.ok) expect(seenFromB.rows).toEqual([{ q: "10.000000", r: "4.000000" }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Özellik tabanlı test: rastgele işlem dizilerinde (tohumlu PRNG, fast-check kurulu değil) her commit sonrası
// bakiye = Σ defter ve rezerve = Σ ACTIVE rezervasyon. Geçerli işlemler commit olur, bozuk olanlar reddedilir ve modeli değiştirmez.
// ---------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelDim {
  id: string;
  hasBalance: boolean;
  qty: number;
  reserved: number;
  ledgerSum: number;
}
interface ModelRes {
  id: string;
  dim: ModelDim;
  qty: number;
  active: boolean;
}

describe("T-233 özellik tabanlı: defter toplamı == bakiye (ve rezerve == Σ ACTIVE rezervasyon) her commit sonrası", () => {
  const STEPS = 45;
  const SEEDS = [0x233a, 0x233b, 0x233c];

  async function invariantViolations(tenantId: string): Promise<Record<string, unknown>[]> {
    const r = await asApp(tenantId, async (q) =>
      q(
        `SELECT d.id::text AS id, COALESCE(b.quantity, 0)::text AS bal, (SELECT COALESCE(sum(l.quantity), 0) FROM public.stock_ledger l WHERE l.tenant_id = d.tenant_id AND l.stock_dimension_id = d.id)::text AS led,
                COALESCE(b.reserved_quantity, 0)::text AS rsv, (SELECT COALESCE(sum(r.quantity), 0) FROM public.reservations r WHERE r.tenant_id = d.tenant_id AND r.stock_dimension_id = d.id AND r.status = 'ACTIVE')::text AS act
           FROM public.stock_dimensions d LEFT JOIN public.stock_balances b ON b.tenant_id = d.tenant_id AND b.stock_dimension_id = d.id
          WHERE d.tenant_id = $1 AND (COALESCE(b.quantity, 0) <> (SELECT COALESCE(sum(l.quantity), 0) FROM public.stock_ledger l WHERE l.tenant_id = d.tenant_id AND l.stock_dimension_id = d.id)
                OR COALESCE(b.reserved_quantity, 0) <> (SELECT COALESCE(sum(r.quantity), 0) FROM public.reservations r WHERE r.tenant_id = d.tenant_id AND r.stock_dimension_id = d.id AND r.status = 'ACTIVE'))`,
        [tenantId],
      ),
    );
    expect(r.ok).toBe(true);
    return r.ok ? r.rows : [];
  }

  for (const seed of SEEDS) {
    it(`tohum 0x${seed.toString(16)}: ${STEPS} rastgele işlem; geçerliler commit, bozuklar ret, model = DB, ihlal sayısı 0`, async () => {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const seedIdx = SEEDS.indexOf(seed);
      // Boyutlar: (konum × durum × sahip) kombinasyonundan tohum başına 4 benzersiz boyut (item2; fikstür boyutlarıyla çakışmaz).
      const combos: { loc: string; status: string; owner: string | null }[] = [];
      for (const loc of [A.rootLocationId, A.childLocationId]) for (const status of ["AVAILABLE", "QUARANTINE", "DAMAGED", "BLOCKED"]) for (const owner of [null, A.ownerId]) combos.push({ loc, status, owner });
      const dims: ModelDim[] = [];
      const created = await asApp(A.tenantId, async (q) => {
        for (const c of combos.slice(seedIdx * 4, seedIdx * 4 + 4)) {
          const id = randomUUID();
          await q("INSERT INTO public.stock_dimensions (tenant_id, id, item_id, location_id, stock_status, inventory_owner_id) VALUES ($1, $2, $3, $4, $5, $6)", [A.tenantId, id, A.itemTwoId, c.loc, c.status, c.owner]);
          dims.push({ id, hasBalance: false, qty: 0, reserved: 0, ledgerSum: 0 });
        }
      }, "commit");
      expectOk(created, "boyutlar");
      const resv: ModelRes[] = [];
      let accepted = 0;
      let rejected = 0;

      for (let step = 0; step < STEPS; step++) {
        const d = pick(dims);
        const kind = pick(["receive", "receive", "issue", "reserve", "release", "corrupt", "corrupt", "corrupt"]);
        const quarter = (): number => (1 + Math.floor(rnd() * 12)) / 4;
        let commit: (() => void) | undefined; // başarılı commit sonrası modeli ilerletir
        let expectReject = false;
        const work = async (q: Q): Promise<void> => {
          const setBal = async (nq: number, nr: number): Promise<void> => {
            if (d.hasBalance) await q("UPDATE public.stock_balances SET quantity = $3, reserved_quantity = $4, version = version + 1 WHERE tenant_id = $1 AND stock_dimension_id = $2", [A.tenantId, d.id, nq, nr]);
            else await q(SQL_BAL, [A.tenantId, d.id, nq, nr]);
          };
          if (kind === "receive") {
            const x = quarter();
            await ledgerRow(q, A, d.id, x);
            await setBal(d.qty + x, d.reserved);
            commit = () => { d.hasBalance = true; d.qty += x; d.ledgerSum += x; };
          } else if (kind === "issue") {
            const free = d.qty - d.reserved;
            const x = Math.min(quarter(), free);
            if (x <= 0) { commit = () => undefined; return; }
            await ledgerRow(q, A, d.id, -x);
            await setBal(d.qty - x, d.reserved);
            commit = () => { d.qty -= x; d.ledgerSum -= x; };
          } else if (kind === "reserve") {
            const x = Math.min(quarter(), d.qty - d.reserved);
            if (x <= 0) { commit = () => undefined; return; }
            const id = randomUUID();
            await q(SQL_RES, [A.tenantId, id, d.id, A.documentLineId, x]);
            await setBal(d.qty, d.reserved + x);
            commit = () => { d.reserved += x; resv.push({ id, dim: d, qty: x, active: true }); };
          } else if (kind === "release") {
            const cand = resv.filter((r) => r.active);
            if (cand.length === 0) { commit = () => undefined; return; }
            const r = pick(cand);
            await q("UPDATE public.reservations SET status = $3, closed_at = now() WHERE tenant_id = $1 AND id = $2", [A.tenantId, r.id, pick(["RELEASED", "CONSUMED"])]);
            await q("UPDATE public.stock_balances SET reserved_quantity = reserved_quantity - $3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [A.tenantId, r.dim.id, r.qty]);
            commit = () => { r.active = false; r.dim.reserved -= r.qty; };
          } else {
            // Bozuk işlem: mutlak eşitliği bozan beş biçimden biri.
            expectReject = true;
            const variant = pick(["no-ledger", "wrong-amount", "double-update", "reserved-only", "reservation-only"]);
            const x = quarter();
            if (variant === "no-ledger") await setBal(d.qty + x, d.reserved);
            else if (variant === "wrong-amount") { await ledgerRow(q, A, d.id, x); await setBal(d.qty + x + 0.25, d.reserved); }
            else if (variant === "double-update") { await ledgerRow(q, A, d.id, x); await setBal(d.qty + x, d.reserved); await q("UPDATE public.stock_balances SET quantity = quantity + $3 WHERE tenant_id = $1 AND stock_dimension_id = $2", [A.tenantId, d.id, x]); }
            else if (variant === "reserved-only") {
              if (!d.hasBalance || d.qty <= 0) { await ledgerRow(q, A, d.id, x); return; } // defter-yalnız
              const nr = d.reserved === d.qty ? 0 : d.qty;
              await setBal(d.qty, nr);
            } else await q(SQL_RES, [A.tenantId, randomUUID(), d.id, A.documentLineId, x]);
          }
        };
        const r = await asApp(A.tenantId, work, "commit");
        if (expectReject) {
          expectFail(r, CHECK_VIOLATION, `tohum ${seed} adım ${step} bozuk`, MISMATCH);
          rejected++;
        } else {
          expectOk(r, `tohum ${seed} adım ${step} ${kind}`);
          commit?.();
          accepted++;
        }
        const bad = await invariantViolations(A.tenantId);
        expect(bad, `tohum ${seed} adım ${step}: bakiye != defter`).toEqual([]);
      }

      // Model = DB (kesin eşitlik; çeyrek değerler ikili tabanda tam).
      const st = await asApp(A.tenantId, async (q) =>
        q("SELECT stock_dimension_id::text AS id, quantity::float8 AS qty, reserved_quantity::float8 AS rsv FROM public.stock_balances WHERE tenant_id = $1 AND stock_dimension_id = ANY($2::uuid[])", [A.tenantId, dims.map((x) => x.id)]),
      );
      expectOk(st, "bakiye okuma");
      if (st.ok) {
        const byId = new Map(st.rows.map((x) => [x.id as string, x]));
        for (const m of dims) {
          const row = byId.get(m.id);
          if (!m.hasBalance) expect(row, "bakiyesiz boyutta satır olmamalı").toBeUndefined();
          else expect({ qty: row?.qty, rsv: row?.rsv }, m.id).toEqual({ qty: m.qty, rsv: m.reserved });
        }
      }
      // Diğer tenant'ın (B) fikstür bakiyesi dokunulmamış.
      const bBal = await asApp(B.tenantId, async (q) => q("SELECT quantity::text AS q FROM public.stock_balances WHERE stock_dimension_id = $1", [B.dimensionId]));
      if (bBal.ok) expect(bBal.rows).toEqual([{ q: "10.000000" }]);
      expect(accepted, "geçerli işlem üretilmedi").toBeGreaterThan(5);
      expect(rejected, "bozuk işlem üretilmedi").toBeGreaterThan(5);
    }, 120_000);
  }

  it("fikstür boyutları dahil bütün tenant'lar için ihlal yok (A ve B)", async () => {
    expect(await invariantViolations(A.tenantId)).toEqual([]);
    expect(await invariantViolations(B.tenantId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Supervisor bulguları (0013, T-232 dalında düzeltilecek). Bu bloktaki testler düzeltme gelene kadar KIRMIZI kalır (G-11: gevşetme/skip yok).
// Her biri kendi kurulumunu tutarlı yapar: doğru ürün, tracking_mode'a uygun lot/seri; yalnızca denenen kural ihlal edilir.
// ---------------------------------------------------------------------------------------------
describe("T-233 bulgular: ürün/izlenebilirlik/belge tutarlılığı (MAJOR-1, MAJOR-2, MINOR)", () => {
  const rndCode = (): string => `Q${randomBytes(4).toString("hex")}`;

  async function mkItem(tracking: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO public.items (tenant_id, id, code, name, base_unit_id, tracking_mode) VALUES ($1, $2, $3, 'T233', $4, $5)", [A.tenantId, id, rndCode(), A.unitId, tracking]);
    return id;
  }
  async function mkDoc(itemId: string): Promise<{ documentId: string; lineId: string }> {
    const documentId = randomUUID();
    const lineId = randomUUID();
    const tv = await admin.query<{ id: string }>("SELECT id FROM public.document_type_versions WHERE tenant_id IS NULL AND key = 'STOCK_IN' AND version = 1");
    await admin.query(
      "INSERT INTO public.documents (tenant_id, id, kind, type_version_id, warehouse_id, business_date, reason, created_by) VALUES ($1, $2, 'STOCK_IN', $3, $4, '2026-01-20', 'T233 bulgu', $5)",
      [A.tenantId, documentId, (tv.rows[0] as { id: string }).id, A.warehouseId, A.ownerUserId],
    );
    await admin.query(
      `INSERT INTO public.document_lines (tenant_id, id, document_id, line_no, item_id, unit_id, quantity, conversion_factor, base_quantity, target_location_id)
       VALUES ($1, $2, $3, 1, $4, $5, 1, 1, 1, $6)`,
      [A.tenantId, lineId, documentId, itemId, A.unitId, A.rootLocationId],
    );
    return { documentId, lineId };
  }
  const dimOf = (q: Q, item: string, lot: string | null, serial: string | null): Promise<string> => {
    const id = randomUUID();
    return q(SQL_DIM, [A.tenantId, id, item, A.rootLocationId, lot, serial, "AVAILABLE"]).then(() => id);
  };

  it("MAJOR-1: defter satırının belge satırı ürünü, boyutun ürününden farklıysa ret", async () => {
    const itemNone = await mkItem("NONE");
    const other = await mkItem("NONE");
    const doc = await mkDoc(other);
    const r = await asApp(A.tenantId, async (q) => {
      const d = await dimOf(q, itemNone, null, null);
      await q(SQL_LEDGER, [A.tenantId, doc.documentId, doc.lineId, d, 1]);
      await q(SQL_BAL, [A.tenantId, d, 1, 0]);
    }, "commit");
    expect(r.ok, "ürün uyuşmazlığı kabul edildi (MAJOR-1)").toBe(false);
  });

  it("MAJOR-1: rezervasyonun belge satırı ürünü, boyutun ürününden farklıysa ret", async () => {
    const itemNone = await mkItem("NONE");
    const other = await mkItem("NONE");
    const doc = await mkDoc(other);
    const r = await asApp(A.tenantId, async (q) => {
      const d = await dimOf(q, itemNone, null, null);
      await q(SQL_RES, [A.tenantId, randomUUID(), d, doc.lineId, 1]);
    });
    expect(r.ok, "rezervasyon ürün uyuşmazlığı kabul edildi (MAJOR-1)").toBe(false);
  });

  it("MAJOR-2: izlenebilirlik uyumsuz boyut reddedilir (SERIAL ürüne serisiz, LOT ürüne lotsuz, NONE ürüne lotlu)", async () => {
    const itemSerial = await mkItem("SERIAL");
    const itemLot = await mkItem("LOT");
    const itemNone = await mkItem("NONE");
    const r1 = await asApp(A.tenantId, async (q) => { await dimOf(q, itemSerial, null, null); });
    expect(r1.ok, "SERIAL ürüne serisiz boyut kabul edildi (MAJOR-2)").toBe(false);
    const r2 = await asApp(A.tenantId, async (q) => { await dimOf(q, itemLot, null, null); });
    expect(r2.ok, "LOT ürüne lotsuz boyut kabul edildi (MAJOR-2)").toBe(false);
    const r3 = await asApp(A.tenantId, async (q) => { await dimOf(q, itemNone, A.lotId, null); });
    expect(r3.ok, "NONE ürüne lot (başka ürünün lotu zaten FK) — NONE ürüne kendi lotu").toBe(false);
  });

  it("MINOR: seri ile lot tutarlı olmalı (serinin lot_id'si lotId iken boyut lotsuz / başka lotla)", async () => {
    const r = await asApp(A.tenantId, async (q) => { await dimOf(q, A.itemId, null, A.serialId); });
    expect(r.ok, "serinin lotuyla çelişen boyut kabul edildi").toBe(false);
  });

  it("MINOR: reservations.closed_at sunucuda yazılır (istemci değeri yok sayılır / zorlanır)", async () => {
    const r = await asApp(A.tenantId, async (q) => {
      await q("UPDATE public.reservations SET status = 'RELEASED', closed_at = '2000-01-01'::timestamptz WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.reservationId]);
      await q("SELECT (closed_at >= now() - interval '1 minute') AS server FROM public.reservations WHERE tenant_id = $1 AND id = $2", [A.tenantId, A.reservationId]);
    });
    expectOk(r, "UPDATE");
    if (r.ok) expect(r.rows, "closed_at istemci değeriyle yazıldı").toEqual([{ server: true }]);
  });

  it("MINOR: defter yalnızca APPROVED + posting_job_id dolu belgeye yazılabilir (DRAFT belge → ret)", async () => {
    const itemNone = await mkItem("NONE");
    const doc = await mkDoc(itemNone);
    const r = await asApp(A.tenantId, async (q) => {
      const d = await dimOf(q, itemNone, null, null);
      await q(SQL_LEDGER, [A.tenantId, doc.documentId, doc.lineId, d, 1]);
      await q(SQL_BAL, [A.tenantId, d, 1, 0]);
    }, "commit");
    expect(r.ok, "DRAFT belgeye defter yazıldı").toBe(false);
  });
});
