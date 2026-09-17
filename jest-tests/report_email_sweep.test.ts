// REPORT EMAIL THROUGH THE REAL SWEEP (client item 9).
//
// report_schedules.test.ts proves at-most-once for the 2.0.1 inbox path over
// the same fixture. This suite drives the EMAIL path end to end — claim, render,
// store the files, commit 'sending', one message per address, record each
// outcome, mark delivered, ring the bell — against the fixture's model of
// migrations 056-058, with nodemailer replaced by a transport the test scripts
// per address. Nothing here re-implements a guard: each is a statement the
// fixture checks by text and enforces by value.
//
// What would go wrong, silently, without each test:
//   * a box with no mail transport (the laptop against the cloud database)
//     claiming the owner's occurrences and burning their retries;
//   * two sweepers, or a sweep outside production;
//   * an address removed from the book still receiving the next report;
//   * one refusal taking the whole delivery down, or a retry re-mailing the
//     addresses that already had it;
//   * a crash mid-send hidden, instead of flagged "may have been sent twice";
//   * addresses in the bell, which every employee can read;
//   * Send now's work running on the REQUEST's connection.

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import {
  RES_ID,
  OUTLET_ID,
  resetStore,
  addSchedule,
  addDelivery,
  addRecipient,
  deliveries,
  notifications,
  recipients,
  files,
  lease,
  setLease,
  billsReads,
  sqlJournal,
} from "./report_fixtures";
import { readXlsx } from "./xlsx_reader";

interface FixtureGlobal {
  __reportFixtureConnect?: () => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };
  __mailScript?: { calls: Record<string, unknown>[]; behave: (msg: Record<string, unknown>) => Promise<unknown> };
  __connects?: { n: number };
}

jest.mock("pg", () => {
  const g = globalThis as unknown as FixtureGlobal;
  const conn = () => {
    const make = g.__reportFixtureConnect;
    if (!make) {throw new Error("report fixture harness was not loaded");}
    return make();
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return conn().query(sql, params); }
    connect(): Promise<unknown> {
      g.__connects = g.__connects ?? { n: 0 };
      g.__connects.n += 1;
      return Promise.resolve(conn());
    }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

// The SMTP transport, scripted per message. createTransport is what mailer.ts's
// default factory calls, so the real sendMail / sendReportMessage run.
jest.mock("nodemailer", () => {
  const g = globalThis as unknown as FixtureGlobal;
  const createTransport = () => ({
    sendMail: (msg: Record<string, unknown>) => {
      const script = g.__mailScript;
      if (!script) {throw new Error("no mail script");}
      script.calls.push(msg);
      return script.behave(msg);
    },
    close: () => undefined,
  });
  return { __esModule: true, default: { createTransport }, createTransport };
});

const g = globalThis as unknown as FixtureGlobal;
const mailCalls = (): Record<string, unknown>[] => g.__mailScript?.calls ?? [];
const acceptAll = async (msg: Record<string, unknown>) => ({ accepted: [String(msg.to)], messageId: String(msg.messageId ?? "") });
function scriptMail(behave: (msg: Record<string, unknown>) => Promise<unknown>): void {
  g.__mailScript = { calls: [], behave };
}

type Sweep = typeof import("../report_schedules");
type Db = typeof import("../database_supabase");
let mod: Sweep;
let db: Db;

const SMTP_ENV = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "reports@mail.example.test",
  SMTP_PASS: "not-a-real-password",
  SMTP_FROM: "reports@mail.example.test",
  SMTP_TIMEOUT_MS: "500",
};
const MAIL_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_TIMEOUT_MS", "SMTP_URL", "MAIL_TRANSPORT", "MAIL_FROM", "RESEND_API_KEY"];
function mailOn(): void { Object.assign(process.env, SMTP_ENV); delete process.env.MAIL_TRANSPORT; }
function mailOff(): void { for (const k of MAIL_KEYS) { delete process.env[k]; } }

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  process.env.REPORT_SCHEDULER = "true";
  process.env.REPORT_SCHEDULER_ALLOW_NON_PROD = "true";
  db = await import("../database_supabase");
  mod = await import("../report_schedules");
});

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval",
      "setImmediate", "clearImmediate", "nextTick", "queueMicrotask"],
  });
  resetStore();
  db.resetReportEmailSchemaCache();
  mailOn();
  scriptMail(acceptAll);
  process.env.REPORT_SCHEDULER = "true";
  process.env.REPORT_SCHEDULER_ALLOW_NON_PROD = "true";
});
afterEach(() => { jest.useRealTimers(); mailOff(); });

const MIN = 60_000;
const at = (iso: string): Date => new Date(iso);
// 08:00 IST on 2026-08-11 == 02:30Z.
const FIRE = "2026-08-11T02:30:00.000Z";
const t = (offsetMin: number): Date => new Date(Date.parse(FIRE) + offsetMin * MIN);

function emailSchedule(over: Record<string, unknown> = {}) {
  addRecipient("owner@gaia.test");
  addRecipient("Accounts@Firm.test");
  return addSchedule({
    created_at: at("2026-08-10T04:00:00Z"),
    name: "Morning pack",
    channel: "email",
    report_key: "sales",
    report_keys: ["sales"],
    formats: ["xlsx", "csv"],
    recipients: ["owner@gaia.test", "Accounts@Firm.test"],
    ...over,
  });
}

async function sweep(when: Date): Promise<void> {
  jest.setSystemTime(when);
  await mod.runReportScheduleSweep(when);
}

describe("an email schedule, delivered", () => {
  test("one delivery, two messages (one per address), files stored, per-address outcome, a bell with no address", async () => {
    emailSchedule();
    await sweep(t(1));

    expect(deliveries()).toHaveLength(1);
    const d = deliveries()[0];
    expect(d.status).toBe("delivered");
    expect(d.kind).toBe("scheduled");
    expect(d.report_keys).toEqual(["sales"]);
    expect(d.provider).toBe("smtp");
    expect(d.delivered_to).toEqual(["owner@gaia.test", "Accounts@Firm.test"]);
    expect(d.rejected_to).toBeNull();
    expect(d.window_start_at).toBe("2026-08-09T18:30:00.000Z");
    expect(d.window_end_at).toBe("2026-08-10T18:30:00.000Z");

    // ONE MESSAGE PER ADDRESS — nobody sees anybody else's.
    expect(mailCalls().map((m) => m.to)).toEqual(["owner@gaia.test", "Accounts@Firm.test"]);
    for (const m of mailCalls()) {
      expect(String(m.subject)).toBe("ZZTEST Reports · Main Street — Sales (accounting) — Mon 10 Aug 2026");
      expect(String(m.text)).toContain(`added ${String(m.to)} to its report address book`);
      expect(String(m.from)).toBe("\"ZZTEST Reports via Experio Reports\" <reports@mail.example.test>");
      expect(String(m.messageId)).toMatch(new RegExp(`^<rd-${d.id}-[0-9a-f]{10}@mail\\.example\\.test>$`));
      const names = (m.attachments as { filename: string }[]).map((a) => a.filename);
      expect(names).toEqual([
        "reports_Main-Street_2026-08-10_to_2026-08-10.xlsx",
        "sales_Main-Street_2026-08-10_to_2026-08-10.csv",
      ]);
    }
    expect(mailCalls()[0].messageId).not.toBe(mailCalls()[1].messageId);

    // The files are the delivery's, stored once, and the workbook opens.
    expect(files().map((f) => [f.report_key, f.format])).toEqual([["bundle", "xlsx"], ["sales", "csv"]]);
    const wb = readXlsx(files()[0].body as Buffer);
    expect(wb.sheetNames).toEqual(["Summary", "Sales (accounting)", "Notes"]);
    expect(wb.sheets["Sales (accounting)"][0]).toEqual(["Date", "Bills", "Gross sales", "Tax", "Service Charge", "Refunds", "Net sales"]);
    expect((files()[1].body as Buffer).toString("utf8")).toBe("Date,Bills,Gross sales,Tax,Service Charge,Refunds,Net sales\nTotal,0,0,0,0,0,0");

    // The render read the schedule's outlet, calendar day of the 10th in IST.
    expect(billsReads()[0]).toEqual({ outlet_id: OUTLET_ID, from: "2026-08-09T18:30:00.000Z", to: "2026-08-10T18:30:00.000Z" });

    // THE BELL: how many, never who, never a figure.
    expect(notifications()).toHaveLength(1);
    const n = notifications()[0];
    expect(n.title).toBe("Daily reports sent — Mon 10 Aug (2 recipients)");
    expect(`${n.title} ${n.body ?? ""}`).not.toMatch(/@|[₹$]|\d+\.\d{2}/);
    expect(n.meta.module).toBe("Reports");
  });

  test("'sending' is committed before the first message, and each outcome right after its own", async () => {
    emailSchedule();
    const seen: string[] = [];
    scriptMail(async (msg) => {
      seen.push(`${deliveries()[0].status}:${(deliveries()[0].delivered_to ?? []).length}`);
      return { accepted: [String(msg.to)], messageId: "x" };
    });
    await sweep(t(1));
    expect(seen).toEqual(["sending:0", "sending:1"]);
    const sql = sqlJournal();
    const sending = sql.findIndex((q) => /set status = 'sending'/.test(q));
    const firstOutcome = sql.findIndex((q) => /set delivered_to = case/.test(q));
    const delivered = sql.findIndex((q) => /set status = 'delivered'/.test(q));
    expect(sending).toBeGreaterThan(-1);
    expect(firstOutcome).toBeGreaterThan(sending);
    expect(delivered).toBeGreaterThan(firstOutcome);
  });

  test("a trading-day schedule claims the 24 hours ending at its send time, and reads exactly those", async () => {
    addRecipient("owner@gaia.test");
    addSchedule({
      created_at: at("2026-08-10T04:00:00Z"),
      channel: "email", report_key: "sales", report_keys: ["sales"], formats: ["csv"],
      recipients: ["owner@gaia.test"], window_mode: "trading_day", hour_local: 2, minute_local: 0,
    });
    // 02:05 IST on the 11th == 20:35Z on the 10th.
    await sweep(at("2026-08-10T20:35:00Z"));
    const d = deliveries()[0];
    expect(d.occurrence_key).toBe("2026-08-11");
    expect([d.period_from, d.period_to, d.day_close]).toEqual(["2026-08-10", "2026-08-10", "02:00"]);
    // 10 Aug 02:00 IST -> 11 Aug 02:00 IST.
    expect([d.window_start_at, d.window_end_at]).toEqual(["2026-08-09T20:30:00.000Z", "2026-08-10T20:30:00.000Z"]);
    expect(billsReads()[0]).toMatchObject({ from: "2026-08-09T20:30:00.000Z", to: "2026-08-10T20:30:00.000Z" });
    expect(files()[0].filename).toBe("sales_Main-Street_2026-08-10_to_2026-08-10_close-0200.csv");
    expect(String(mailCalls()[0].text)).toContain("Trading day closing at 02:00");
    expect(d.status).toBe("delivered");
  });
});

describe("no transport, no claim — and one bell a day", () => {
  test("an email schedule is not claimed on a box that cannot send, and the owner hears once", async () => {
    mailOff();
    emailSchedule();
    await sweep(t(1));
    await sweep(t(6));
    expect(deliveries()).toHaveLength(0);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].title).toBe("Scheduled email reports are waiting");
    expect(notifications()[0].body ?? "").toMatch(/Email is not set up on this server/);
    expect(mailCalls()).toHaveLength(0);

    // …and the moment mail works, inside the catch-up window, it goes.
    mailOn();
    await sweep(t(11));
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].status).toBe("delivered");
  });

  test("a process without a transport never takes an attempt on an existing email row", async () => {
    const s = emailSchedule();
    addDelivery({ schedule_id: s.id, channel: "email", report_keys: ["sales"], formats: ["csv"], attempts: 1, status: "failed", next_attempt_at: t(-5) });
    mailOff();
    await sweep(t(1));
    expect(deliveries()[0].attempts).toBe(1);
    expect(deliveries()[0].status).toBe("failed");
  });

  test("an inbox schedule is unaffected by the missing transport", async () => {
    mailOff();
    addSchedule({ created_at: at("2026-08-10T04:00:00Z") });
    await sweep(t(1));
    expect(deliveries()[0].status).toBe("delivered");
  });
});

describe("one sweeper, in production, on a migrated database", () => {
  test("another process holding the lease: this tick does nothing", async () => {
    emailSchedule();
    setLease({ holder: "another-process", until: t(30) });
    await sweep(t(1));
    expect(deliveries()).toHaveLength(0);
    expect(lease().holder).toBe("another-process");
  });

  test("a lapsed lease is taken, and renewed on the next tick by the same process", async () => {
    emailSchedule();
    setLease({ holder: "another-process", until: t(0) });
    await sweep(t(1));
    const holder = lease().holder;
    expect(holder).not.toBe("another-process");
    expect(lease().until.getTime()).toBe(t(1 + 4).getTime());
    expect(lease().mail_ready).toBe(true);
    await sweep(t(3));
    expect(lease().holder).toBe(holder);
  });

  test("outside production, without the explicit override, nothing runs", async () => {
    emailSchedule();
    delete process.env.REPORT_SCHEDULER_ALLOW_NON_PROD;
    await sweep(t(1));
    expect(deliveries()).toHaveLength(0);
    expect(mod.schedulerPermitted({ REPORT_SCHEDULER: "true", NODE_ENV: "production" } as never)).toEqual({ ok: true, reason: null });
    expect(mod.schedulerPermitted({ REPORT_SCHEDULER: "true" } as never).ok).toBe(false);
    expect(mod.schedulerPermitted({ NODE_ENV: "production" } as never).ok).toBe(false);
  });

  test("a database without 056-058: the sweep waits rather than running a path it cannot promise", async () => {
    resetStore({ schema: { m056: true, m057: true, m058: false } });
    db.resetReportEmailSchemaCache();
    addSchedule({ created_at: at("2026-08-10T04:00:00Z") });
    await sweep(t(1));
    expect(deliveries()).toHaveLength(0);
  });
});

describe("per-address outcomes", () => {
  test("an address removed from the book gets nothing — the send-time check", async () => {
    emailSchedule();
    recipients()[1].removed_at = t(0);
    await sweep(t(1));
    const d = deliveries()[0];
    expect(mailCalls().map((m) => m.to)).toEqual(["owner@gaia.test"]);
    expect(d.delivered_to).toEqual(["owner@gaia.test"]);
    expect(d.skipped_to).toEqual(["Accounts@Firm.test"]);
    expect(d.status).toBe("delivered");
    expect(notifications()[0].body ?? "").toMatch(/1 address was skipped/);
  });

  test("a paused (suppressed) address is skipped the same way", async () => {
    emailSchedule();
    recipients()[0].status = "suppressed";
    await sweep(t(1));
    expect(mailCalls().map((m) => m.to)).toEqual(["Accounts@Firm.test"]);
    expect(deliveries()[0].skipped_to).toEqual(["owner@gaia.test"]);
  });

  test("a 550 for one address is recorded as refused; the other is delivered", async () => {
    emailSchedule();
    scriptMail(async (msg) => {
      if (String(msg.to) === "owner@gaia.test") {
        throw Object.assign(new Error("550 5.1.1 <owner@gaia.test> user unknown"), { responseCode: 550 });
      }
      return { accepted: [String(msg.to)], messageId: "x" };
    });
    await sweep(t(1));
    const d = deliveries()[0];
    expect(d.status).toBe("delivered");
    expect(d.rejected_to).toEqual(["owner@gaia.test"]);
    expect(d.delivered_to).toEqual(["Accounts@Firm.test"]);
    expect(notifications()[0].title).toBe("Daily reports sent — Mon 10 Aug (1 recipient)");
    expect(notifications()[0].body ?? "").toMatch(/1 address was refused/);
  });

  test("every address refused: a FINAL failure (no retries burnt on it), one bell", async () => {
    emailSchedule();
    scriptMail(async () => { throw Object.assign(new Error("550 no such user"), { responseCode: 550 }); });
    await sweep(t(1));
    const d = deliveries()[0];
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(3);
    expect(d.error).toMatch(/No address accepted this report: 2 refused/);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].title).toMatch(/could not be delivered/);
    await sweep(t(200));
    expect(mailCalls()).toHaveLength(2);
  });

  test("a transient failure mid-list retries LATER, and the retry mails only who is left — same bytes, same Message-ID", async () => {
    emailSchedule();
    let secondFails = true;
    scriptMail(async (msg) => {
      if (String(msg.to) === "Accounts@Firm.test" && secondFails) {
        throw Object.assign(new Error("421 4.7.0 try again later"), { responseCode: 421 });
      }
      return { accepted: [String(msg.to)], messageId: "x" };
    });
    await sweep(t(1));
    let d = deliveries()[0];
    expect(d.status).toBe("failed");
    expect(d.delivered_to).toEqual(["owner@gaia.test"]);
    expect(d.next_attempt_at.getTime()).toBe(t(1 + 5).getTime());
    expect(notifications()).toHaveLength(0);
    const firstAttemptId = mailCalls()[1].messageId;
    const firstBytes = (mailCalls()[1].attachments as { content: Buffer }[])[0].content;

    secondFails = false;
    await sweep(t(7));
    d = deliveries()[0];
    expect(d.status).toBe("delivered");
    expect(d.attempts).toBe(2);
    expect(mailCalls().map((m) => m.to)).toEqual(["owner@gaia.test", "Accounts@Firm.test", "Accounts@Firm.test"]);
    expect(mailCalls()[2].messageId).toBe(firstAttemptId);
    expect((mailCalls()[2].attachments as { content: Buffer }[])[0].content.equals(firstBytes)).toBe(true);
    expect(d.delivered_to).toEqual(["owner@gaia.test", "Accounts@Firm.test"]);
    expect(d.maybe_duplicate).toBe(false);
  });

  test("a process that died MID-SEND: the retry resumes, skips who had it, and says it may be a duplicate", async () => {
    const s = emailSchedule();
    addDelivery({
      schedule_id: s.id, channel: "email", status: "sending", attempts: 1,
      report_keys: ["sales"], formats: ["csv"], delivered_to: ["owner@gaia.test"],
      next_attempt_at: t(-1), occurrence_key: "2026-08-11",
      window_start_at: "2026-08-09T18:30:00.000Z", window_end_at: "2026-08-10T18:30:00.000Z",
    });
    await sweep(t(1));
    const d = deliveries()[0];
    expect(deliveries()).toHaveLength(1);
    expect(mailCalls().map((m) => m.to)).toEqual(["Accounts@Firm.test"]);
    expect(d.status).toBe("delivered");
    expect(d.maybe_duplicate).toBe(true);
    expect(notifications()[0].body ?? "").toMatch(/may have received it twice/);
  });

  test("the restaurant's daily cap: past it, addresses are skipped, not sent", async () => {
    const s = emailSchedule();
    addDelivery({
      schedule_id: s.id, channel: "email", status: "delivered", occurrence_key: "old",
      delivered_to: Array.from({ length: 200 }, (_v, i) => `p${String(i)}@x.test`), created_at: t(-60),
    });
    await sweep(t(1));
    const d = deliveries().find((x) => x.occurrence_key === "2026-08-11");
    expect(mailCalls()).toHaveLength(0);
    expect(d?.status).toBe("failed");
    expect(d?.skipped_to).toEqual(["owner@gaia.test", "Accounts@Firm.test"]);
    expect(d?.error).toMatch(/daily email limit/);
  });

  test("the platform's daily cap, counted on the lease row, stops the next message", async () => {
    emailSchedule();
    process.env.REPORT_EMAIL_PLATFORM_DAILY_CAP = "1";
    try {
      await sweep(t(1));
    } finally {
      delete process.env.REPORT_EMAIL_PLATFORM_DAILY_CAP;
    }
    expect(mailCalls()).toHaveLength(1);
    expect(lease().sent_count).toBe(1);
    expect(deliveries()[0].skipped_to).toEqual(["Accounts@Firm.test"]);
  });
});

describe("Send now's rows: retried through the LEFT JOIN, kicked outside the request", () => {
  function adhoc(over: Record<string, unknown> = {}) {
    addRecipient("owner@gaia.test");
    return addDelivery({
      schedule_id: null, kind: "adhoc", channel: "email", occurrence_key: "adhoc:1b4e28ba-2fa1-41d2-883f-0016d3cca427",
      report_keys: ["sales"], formats: ["xlsx"], recipients: ["owner@gaia.test"], status: "failed", attempts: 1,
      period_from: "2026-08-10", period_to: "2026-08-10",
      window_start_at: "2026-08-09T18:30:00.000Z", window_end_at: "2026-08-10T18:30:00.000Z",
      next_attempt_at: t(-1), created_at: t(-10), ...over,
    });
  }

  test("a failed Send now has no schedule, and is retried anyway", async () => {
    adhoc();
    await sweep(t(1));
    const d = deliveries()[0];
    expect(d.status).toBe("delivered");
    expect(d.delivered_to).toEqual(["owner@gaia.test"]);
    expect(String(mailCalls()[0].text)).toContain("Sent on request from the Reports screen.");
    expect(notifications()[0].meta.schedule_id).toBe("");
  });

  test("kickReportDelivery runs the delivery on connections of its own, never the caller's", async () => {
    adhoc({ status: "claimed", attempts: 0, next_attempt_at: t(0) });
    jest.setSystemTime(t(1));
    const before = g.__connects?.n ?? 0;
    let insideRequest = 0;
    await db.withTenant({ res_id: RES_ID, outlet_id: OUTLET_ID, employeeId: "e", role: "admin" }, async () => {
      insideRequest = g.__connects?.n ?? 0;
      await mod.kickReportDelivery(RES_ID, deliveries()[0].id);
    });
    // The request took ONE connection; the kick's withTenant calls took their own.
    expect(insideRequest).toBe(before + 1);
    expect((g.__connects?.n ?? 0) - insideRequest).toBeGreaterThan(3);
    expect(deliveries()[0].status).toBe("delivered");
  });

  test("a test email (no reports) carries no attachment and no figure", async () => {
    adhoc({ report_keys: [], formats: ["csv"], status: "claimed", attempts: 0, next_attempt_at: t(0) });
    jest.setSystemTime(t(1));
    await mod.kickReportDelivery(RES_ID, deliveries()[0].id);
    const m = mailCalls()[0];
    expect(String(m.subject)).toBe("ZZTEST Reports — Test email from Reports");
    expect(m.attachments).toEqual([]);
    expect(String(m.text)).not.toMatch(/[₹]|\d+\.\d{2}/);
    expect(files()).toHaveLength(0);
    expect(notifications()[0].title).toBe("Test email sent (1 recipient)");
  });

  test("the boot scan resumes a recent orphaned Send now, and leaves an old one alone", async () => {
    adhoc({ status: "sending", attempts: 1, created_at: t(-30), next_attempt_at: t(-1) });
    adhoc({ occurrence_key: "adhoc:2c5f1a9e-7e1b-4c55-9d0a-1a2b3c4d5e6f", status: "claimed", created_at: t(-180), next_attempt_at: t(-1) });
    jest.setSystemTime(t(1));
    const n = await mod.recoverOrphanReportSends();
    expect(n).toBe(1);
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50 && deliveries()[0].status !== "delivered"; i += 1) { await new Promise((r) => setImmediate(r)); }
    expect(deliveries()[0].status).toBe("delivered");
    expect(deliveries()[1].status).toBe("claimed");
  });
});

describe("housekeeping", () => {
  test("file bodies past the retention window are purged once a day; the rows stay", async () => {
    addSchedule({ created_at: at("2026-08-10T04:00:00Z"), enabled: false });
    files().push({
      id: "old", res_id: RES_ID, delivery_id: "d-old", report_key: "sales", format: "csv", filename: "a.csv",
      mime: "text/csv", bytes: 3, rows: 1, truncated: false, body: Buffer.from("abc"), created_at: t(-91 * 24 * 60),
    }, {
      id: "new", res_id: RES_ID, delivery_id: "d-new", report_key: "sales", format: "csv", filename: "b.csv",
      mime: "text/csv", bytes: 3, rows: 1, truncated: false, body: Buffer.from("abc"), created_at: t(-10),
    });
    await sweep(t(1));
    expect(files().map((f) => [f.id, f.body === null])).toEqual([["old", true], ["new", false]]);
    expect(lease().purged_day).toBe("2026-08-11");
  });
});
