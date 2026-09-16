// "WHEN WAIVING A SERVICE CHARGE, THE REASON SHOULD NOT BE MANDATORY" — the
// data layer and the schema it depends on (migration 051).
//
// The client asked for the free-text reason on a service-charge waiver to be
// optional. The kind and the second name stay required. What can go wrong is
// almost all in the database, and all of it is quiet:
//
//   * "NO REASON" STORED AS A WORD. '' is refused by 036's CHECK, and a
//     placeholder would be text nobody typed in a control ledger. The insert
//     must carry NULL, for blank, whitespace, null and absent alike.
//   * A NULL INSERT AGAINST A NOT NULL COLUMN. Production is NOT NULL until 051
//     is applied, and the insert runs inside a transaction a 23502 would abort.
//     So the data layer decides BEFORE the transaction, from the column's
//     actual nullability, and refuses exactly as it always did when the column
//     cannot hold NULL.
//   * THE RUNTIME DDL. Production runs as the table owner, so the backend
//     issues 051's DROP NOT NULL itself: once, only while it is still needed,
//     with a short lock_timeout, never inside a transaction, and a refused or
//     timed-out ALTER must leave the feature off rather than on.
//   * THE LATCH NEVER TURNING ON. A 051 applied by hand after boot must switch
//     the feature on at the next reasonless waiver, not at the next restart.
//
// Drives the SHIPPED WaiveServiceCharge, resolveServiceChargeWaiverReasonOptional,
// and InitServiceChargeWaiverReasonSchema over a fake
// `pg` (the db_pool_hygiene.test.ts pattern) that answers only the statements
// these paths issue and throws on anything else.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteServiceChargeWaiver } from "../../billing_math";

const IDS = {
  res: "5a5a5a5a-0000-4000-8000-000000000001",
  outlet: "5a5a5a5a-0000-4000-8000-000000000002",
  table: "5a5a5a5a-0000-4000-8000-000000000003",
  bill: "5a5a5a5a-0000-4000-8000-000000000004",
};

interface Logged { sql: string; params: unknown[]; via: "pool" | "client" }

const mockPg: {
  log: Logged[];
  /** What information_schema says about "ServiceChargeWaivers".reason. null = no such column. */
  nullable: "YES" | "NO" | null;
  /** What the runtime's ALTER does: take effect (the owner), 42501 (not the owner), 55P03 (busy). */
  alter: "applies" | "refused" | "times_out";
  /** The probe itself fails (a dropped connection). */
  probeFails: boolean;
  /** The INSERT raises this instead of returning the row. */
  insertError: Record<string, unknown> | null;
  subtotal: number;
  taxConfig: Record<string, number>;
  scPct: number;
} = {
  log: [], nullable: "NO", alter: "refused", probeFails: false, insertError: null,
  subtotal: 5499, taxConfig: { SGST: 2.5, CGST: 2.5 }, scPct: 10,
};

jest.mock("pg", () => {
  const pgError = (message: string, fields: Record<string, unknown>): Error => Object.assign(new Error(message), fields);
  const answer = (sql: string, params: unknown[]): unknown[] => {
    const q = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(q) || /^\s*(SAVEPOINT|RELEASE|ROLLBACK TO)\b/i.test(q)) { return []; }
    if (/set_config\('app\./.test(q)) { return []; }
    if (/^\s*do \$\$/i.test(q) && q.includes('alter table "ServiceChargeWaivers" alter column reason drop not null')) {
      if (mockPg.nullable !== "NO") { return []; } // the guard inside the DO block: nothing to do
      if (mockPg.alter === "refused") { throw pgError('must be owner of table ServiceChargeWaivers', { code: "42501" }); }
      if (mockPg.alter === "times_out") { throw pgError("canceling statement due to lock timeout", { code: "55P03" }); }
      mockPg.nullable = "YES";
      return [];
    }
    if (q.includes("select is_nullable from information_schema.columns") && q.includes("table_name = 'ServiceChargeWaivers'")) {
      if (mockPg.probeFails) { throw pgError("Connection terminated unexpectedly", {}); }
      return mockPg.nullable === null ? [] : [{ is_nullable: mockPg.nullable }];
    }
    if (q.includes('from "Restaurant" r')) {
      return [{
        res_id: IDS.res, outlet_id: IDS.outlet, restaurant_slug: "fixture", restaurant_name: "Fixture Diner",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: "Asia/Kolkata",
      }];
    }
    if (q.includes('select table_id, closed_at from "Bills"')) { return [{ table_id: IDS.table, closed_at: null }]; }
    if (q.includes('select food, status from "Orders"')) { return [{ food: { subtotal: mockPg.subtotal }, status: 1 }]; }
    if (q.includes('select discount_type, discount_value from "Bills"')) { return []; }
    if (q.includes('select default_tax from "Outlets"')) { return [{ default_tax: mockPg.taxConfig }]; }
    if (q.includes('select service_charge from "Restaurant"')) { return [{ service_charge: mockPg.scPct }]; }
    if (q.includes('insert into "ServiceChargeWaivers"')) {
      if (mockPg.insertError) { throw pgError("insert refused", mockPg.insertError); }
      const p = params;
      // What Postgres would hand back: the row as inserted, reduction GENERATED.
      return [{
        id: p[0], created_at: new Date("2026-09-16T10:00:00Z"), outlet_id: p[2], bill_id: p[3], table_id: p[4],
        waived_at: new Date("2026-09-16T10:00:00Z"), basis: p[5], basis_percent: p[6], basis_amount: p[7],
        amount_waived: p[8], tax_on_waived: p[9],
        grand_total_reduction: Number(p[8]) + Number(p[9]),
        waiver_kind: p[10], reason: p[11],
        waived_by_username: p[13], authorised_by_username: p[15],
        reversed_at: null, reversed_by_username: null, reversal_reason: null,
      }];
    }
    throw new Error(`reason-optional fixture: no answer for: ${q.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  };
  const run = (via: "pool" | "client", sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    mockPg.log.push({ sql: String(sql), params, via });
    try { return Promise.resolve({ rows: answer(sql, params) }); } catch (err) { return Promise.reject(err); }
  };
  class FakeClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run("client", sql, params ?? []); }
    release(): void { /* returned to the fake pool */ }
    on(): this { return this; }
  }
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return run("pool", sql, params ?? []); }
    connect(): Promise<FakeClient> { return Promise.resolve(new FakeClient()); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

type Db = typeof import("../../database_supabase");
let db: Db;

const ACTOR = { username: "cashier1", authorised_by_username: "manager01" };
const ddls = (): Logged[] => mockPg.log.filter((l) => /^\s*do \$\$/i.test(l.sql));
const probes = (): Logged[] => mockPg.log.filter((l) => l.sql.includes("select is_nullable from information_schema.columns"));
const inserts = (): Logged[] => mockPg.log.filter((l) => l.sql.includes('insert into "ServiceChargeWaivers"'));
const begins = (): Logged[] => mockPg.log.filter((l) => /^\s*BEGIN\b/i.test(l.sql));
const waive = (reason: unknown): ReturnType<Db["WaiveServiceCharge"]> =>
  db.WaiveServiceCharge(IDS.res, { bill_id: IDS.bill, waiver_kind: "guest_request", reason: reason as string | null, actor: ACTOR });

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../../database_supabase");
});

beforeEach(() => {
  db.__scWaiverReasonTestSeam.reset();
  mockPg.log = [];
  mockPg.nullable = "NO";
  mockPg.alter = "refused";
  mockPg.probeFails = false;
  mockPg.insertError = null;
  mockPg.subtotal = 5499;
  mockPg.taxConfig = { SGST: 2.5, CGST: 2.5 };
  mockPg.scPct = 10;
});

afterEach(() => { jest.restoreAllMocks(); });

// ============================================================================
// THE INSERT — what "no reason" is stored as
// ============================================================================

describe("a waiver without a reason stores NULL, where the column can hold it", () => {
  beforeEach(() => { mockPg.nullable = "YES"; });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   \t "],
  ])("reason %s -> the INSERT carries NULL (never ''), and the record says null", async (_label, reason) => {
    const result = await waive(reason);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.params[11]).toBeNull();
    expect(inserts()[0]!.params[10]).toBe("guest_request");
    expect(result.record.reason).toBeNull();
    expect(result.record.waiver_kind).toBe("guest_request");
    expect(result.record.authorised_by_username).toBe("manager01");
  });

  test("the money is the same waiver's money: the reason is not an input to any amount", async () => {
    const quote = quoteServiceChargeWaiver(5499, { SGST: 2.5, CGST: 2.5 }, 10);
    const without = await waive(null);
    const withOne = await waive("Guest asked");
    for (const r of [without, withOne]) {
      expect(r.record.amount_waived).toBe(quote.amount_waived);
      expect(r.record.tax_on_waived).toBe(quote.tax_on_waived);
      expect(r.record.grand_total_reduction).toBe(quote.grand_total_reduction);
      expect(r.grand_total_before).toBe(quote.grand_total_with);
      expect(r.grand_total_after).toBe(quote.grand_total_without);
    }
  });

  test("a typed reason is stored as typed — trimmed and whitespace-collapsed, exactly as before", async () => {
    const result = await waive("  Guest   asked \n at the table ");
    expect(inserts()[0]!.params[11]).toBe("Guest asked at the table");
    expect(result.record.reason).toBe("Guest asked at the table");
  });

  test("the KIND is still required", async () => {
    await expect(db.WaiveServiceCharge(IDS.res, { bill_id: IDS.bill, waiver_kind: "", actor: ACTOR }))
      .rejects.toThrow("waiver_kind must be one of:");
    expect(inserts()).toHaveLength(0);
  });

  test("the SECOND NAME is still required", async () => {
    await expect(db.WaiveServiceCharge(IDS.res, {
      bill_id: IDS.bill, waiver_kind: "guest_request", actor: { username: "cashier1", authorised_by_username: "  " },
    })).rejects.toThrow("requires an authoriser");
    expect(inserts()).toHaveLength(0);
  });
});

describe("where the column is still NOT NULL, a reasonless waiver is refused exactly as before", () => {
  test.each([["absent", undefined], ["null", null], ["empty", ""], ["whitespace", "   "]])(
    "reason %s -> today's sentence, and no transaction is ever opened",
    async (_label, reason) => {
      await expect(waive(reason)).rejects.toThrow(/^A reason is required to waive the service charge\.$/);
      expect(begins()).toHaveLength(0);
      expect(inserts()).toHaveLength(0);
    },
  );

  test("a waiver WITH a reason is today's statement: the schema is never asked", async () => {
    const result = await waive("Guest asked");
    expect(result.record.reason).toBe("Guest asked");
    expect(ddls()).toHaveLength(0);
    expect(probes()).toHaveLength(0);
  });

  test("the column went back to NOT NULL under a running process: the 23502 is the old refusal, not a 500", async () => {
    db.__scWaiverReasonTestSeam.setOptional(true); // latched on before 051 was rolled back by hand
    mockPg.insertError = { code: "23502", table: "ServiceChargeWaivers", column: "reason" };
    await expect(waive(null)).rejects.toThrow(/^A reason is required to waive the service charge\.$/);
    // The transaction rolled back before the refusal was raised...
    const tail = mockPg.log.slice(mockPg.log.indexOf(inserts()[0]!));
    expect(tail.some((l) => /^\s*ROLLBACK\b/i.test(l.sql))).toBe(true);
    // ...and the latch learned it, so the next request is refused before any SQL.
    expect(db.isServiceChargeWaiverReasonOptional()).toBe(false);
  });

  test("a 23502 on any OTHER column is not dressed up as a missing reason", async () => {
    db.__scWaiverReasonTestSeam.setOptional(true);
    mockPg.insertError = { code: "23502", table: "ServiceChargeWaivers", column: "waiver_kind" };
    await expect(waive(null)).rejects.toThrow("insert refused");
    expect(db.isServiceChargeWaiverReasonOptional()).toBe(true);
  });

  test("a waiver that HAD a reason is never re-labelled, whatever the insert raised", async () => {
    db.__scWaiverReasonTestSeam.setOptional(true);
    mockPg.insertError = { code: "23502", table: "ServiceChargeWaivers", column: "reason" };
    await expect(waive("Guest asked")).rejects.toThrow("insert refused");
  });
});

// ============================================================================
// THE RUNTIME ENSURE AND THE LATCH
// ============================================================================

describe("the runtime issues 051's DROP NOT NULL itself, carefully", () => {
  test("as the table owner: one guarded ALTER with a 2s lock_timeout, then the column's own answer", async () => {
    mockPg.alter = "applies";
    expect(await db.InitServiceChargeWaiverReasonSchema()).toBe(true);
    expect(ddls()).toHaveLength(1);
    const sql = ddls()[0]!.sql.replace(/\s+/g, " ");
    // Only while it is still needed: the ALTER takes ACCESS EXCLUSIVE even as a no-op.
    expect(sql).toContain("if exists (select 1 from information_schema.columns");
    expect(sql).toContain("and column_name = 'reason' and is_nullable = 'NO') then");
    // The timeout is set IN THE SAME STATEMENT, transaction-local, before the ALTER.
    expect(sql.indexOf("perform set_config('lock_timeout', '2s', true);"))
      .toBeLessThan(sql.indexOf('alter table "ServiceChargeWaivers" alter column reason drop not null;'));
    expect(sql).toContain("perform set_config('lock_timeout', '2s', true);");
    // Nothing else about the table changes: the CHECK that refuses '' stays.
    expect(sql).not.toMatch(/drop constraint|add constraint|set not null|set default/i);
    // The latch is read AFTER the ensure.
    const ddlAt = mockPg.log.indexOf(ddls()[0]!);
    expect(mockPg.log.indexOf(probes()[0]!)).toBeGreaterThan(ddlAt);
    // Outside any transaction: autocommit on the pool, no BEGIN.
    expect(ddls()[0]!.via).toBe("pool");
    expect(begins()).toHaveLength(0);
  });

  test("true is sticky: a latched process asks nothing more", async () => {
    mockPg.alter = "applies";
    await db.InitServiceChargeWaiverReasonSchema();
    mockPg.log = [];
    expect(await db.resolveServiceChargeWaiverReasonOptional()).toBe(true);
    await waive(null);
    expect(ddls()).toHaveLength(0);
    expect(probes()).toHaveLength(0);
  });

  test("already nullable (051 applied): no ALTER is issued at all", async () => {
    mockPg.nullable = "YES";
    mockPg.alter = "times_out"; // would fail if it were issued
    expect(await db.InitServiceChargeWaiverReasonSchema()).toBe(true);
    // The DO block runs, but its guard skips the ALTER — the fixture throws if it did not.
    expect(db.isServiceChargeWaiverReasonOptional()).toBe(true);
  });

  test("NOT the owner (42501): memoised as the migration's job, latch OFF, loud at boot, never throws", async () => {
    mockPg.alter = "refused";
    const warn = jest.spyOn((await import("../../observability")).logger, "warn");
    expect(await db.InitServiceChargeWaiverReasonSchema()).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("reason is still REQUIRED"))).toBe(true);
    // A second ask does not issue the ALTER again (the house 42501 rule)...
    await db.resolveServiceChargeWaiverReasonOptional();
    expect(ddls()).toHaveLength(1);
    // ...but it DOES read the column again, which is how a hand-applied 051 is seen.
    expect(probes()).toHaveLength(2);
  });

  test("051 applied by hand AFTER boot switches the feature on at the next reasonless waiver — no restart", async () => {
    mockPg.alter = "refused";
    expect(await db.InitServiceChargeWaiverReasonSchema()).toBe(false);
    await expect(waive(null)).rejects.toThrow("A reason is required to waive the service charge.");

    mockPg.nullable = "YES"; // the operator runs migrate.ts on the VPS
    const result = await waive(null);
    expect(result.record.reason).toBeNull();
    expect(inserts()[0]!.params[11]).toBeNull();
  });

  test("a lock timeout (55P03) is NOT memoised: the feature stays off, and the ALTER is retried only after a cooldown", async () => {
    mockPg.alter = "times_out";
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await db.InitServiceChargeWaiverReasonSchema()).toBe(false);
    expect(ddls()).toHaveLength(1);

    // A burst of reasonless waivers inside the cooldown: refused, and no ALTER
    // queues another ACCESS EXCLUSIVE request behind the bill reads.
    now.mockReturnValue(1_000_000 + 60_000);
    await expect(waive(null)).rejects.toThrow("A reason is required");
    await expect(waive("")).rejects.toThrow("A reason is required");
    expect(ddls()).toHaveLength(1);

    // After it, the table is quiet and the owner's ALTER lands.
    now.mockReturnValue(1_000_000 + 5 * 60_000 + 1);
    mockPg.alter = "applies";
    const result = await waive(null);
    expect(ddls()).toHaveLength(2);
    expect(result.record.reason).toBeNull();
  });

  test("never inside an open transaction: a caller in withTenant gets the probe, not the DDL", async () => {
    mockPg.alter = "applies";
    const answer = await db.withTenant(
      { res_id: IDS.res, outlet_id: IDS.outlet, employeeId: "e1", role: "admin" },
      () => db.resolveServiceChargeWaiverReasonOptional(),
    );
    expect(answer).toBe(false);
    expect(ddls()).toHaveLength(0);
    expect(probes()).toHaveLength(1);
  });

  test("a probe that fails answers false and never throws", async () => {
    mockPg.nullable = "YES";
    mockPg.probeFails = true;
    await expect(db.resolveServiceChargeWaiverReasonOptional()).resolves.toBe(false);
    await expect(db.InitServiceChargeWaiverReasonSchema()).resolves.toBe(false);
  });

  test("a database with no such column (036 never applied) answers false", async () => {
    mockPg.nullable = null;
    await expect(db.resolveServiceChargeWaiverReasonOptional()).resolves.toBe(false);
  });
});

// ============================================================================
// ONLY THE WAIVER'S REASON — and it is wired
// ============================================================================

describe("every other capture still requires its reason", () => {
  test("putting the charge back needs one, and is refused before any SQL", async () => {
    mockPg.nullable = "YES";
    db.__scWaiverReasonTestSeam.setOptional(true);
    await expect(db.ReverseServiceChargeWaiver(IDS.res, IDS.bill, { reason: "   ", by_username: "manager01" }))
      .rejects.toThrow("A reason is required to reverse a service-charge waiver.");
    expect(mockPg.log).toHaveLength(0);
  });

  test("the comp, its reversal, the void and the tender void keep their own refusals, untouched by the latch", () => {
    const src = readFileSync(join(__dirname, "..", "..", "database_supabase.ts"), "utf8").replace(/\r\n/g, "\n");
    for (const sentence of [
      'if (!reason) {throw new Error("A reason is required to make an item non-chargeable.");}',
      'if (!reason) {throw new Error("A reason is required to reverse a non-chargeable.");}',
      'if (!reason) {throw new Error("A reason is required to void an order.");}',
      'if (!reason) {throw new Error("A reason is required to reverse a service-charge waiver.");}',
      'if (!reason) {throw new Error("A reason is required to void a tender.");}',
    ]) {
      expect(src).toContain(sentence);
    }
    // The latch is asked from the waiver, the boot step and the composite route — nowhere else.
    expect((src.match(/await resolveServiceChargeWaiverReasonOptional\(\)/g) ?? []).length).toBe(2);
    const waiveFn = src.slice(src.indexOf("export async function WaiveServiceCharge("), src.indexOf("// --- migration 051:"));
    // Asked BEFORE the transaction opens, never inside it.
    expect(waiveFn.indexOf("await resolveServiceChargeWaiverReasonOptional()"))
      .toBeLessThan(waiveFn.indexOf("return withTransaction("));
    expect(waiveFn).toContain("if (!reason && !(await resolveServiceChargeWaiverReasonOptional())) {");
  });
});

describe("wiring", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

  test("the boot step runs before the server listens, outside any request", () => {
    const index = read("index.ts");
    const boot = index.indexOf("if (await InitServiceChargeWaiverReasonSchema()) {");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(index.indexOf("httpServer.listen("));
  });

  test("if migration 051 is present, it drops the same NOT NULL, under a LOCAL lock_timeout, and leaves the CHECK", () => {
    const file = join(ROOT, "migrations", "051_service_charge_waiver_reason_optional.sql");
    if (!existsSync(file)) { return; } // shipped in its own commit, applied by hand
    const sql = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(sql).toMatch(/ALTER TABLE "ServiceChargeWaivers" ALTER COLUMN reason DROP NOT NULL;/);
    expect(sql).not.toMatch(/DROP CONSTRAINT|SET NOT NULL|UPDATE /i);
    expect(sql.indexOf("SET LOCAL lock_timeout")).toBeLessThan(sql.indexOf("ALTER TABLE"));
  });
});
