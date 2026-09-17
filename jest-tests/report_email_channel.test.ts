// AUTOMATED EMAIL REPORTS — the sender, the bound, and the wiring.
//
// ============================================================================
// WHY THE BOUND IS TESTED HARDEST
// ============================================================================
// Everything needed to produce a scheduled report already existed; what was
// missing was a mail transport, and adding one to a background sweep is the
// exact shape of a bug this project has already shipped and paid for:
//
//   REDIS_URL pointed at nothing. That did not fail — node-redis's default
//   reconnect strategy retries forever, so `await connect()` never settled, the
//   catch written to degrade was unreachable, and CI hung for 33 minutes. In
//   production it would have been a backend that never finished booting.
//
// A wedged SMTP server is the same hazard in a worse place. It hangs inside
// runReportScheduleSweep holding a claimed occurrence whose lease keeps other
// replicas off it, so ONE misconfigured restaurant stops every restaurant's
// reports. The tests below therefore point sendMail at transports that never
// resolve and assert it comes back anyway, in bounded time — which is a thing no
// test against a real server can prove.
//
// ============================================================================
// AND THE OTHER HALF: DOES ANYTHING ACTUALLY SEND IT
// ============================================================================
// This codebase's single most repeated defect is something correct built on the
// server that no caller reaches — a migration with nothing writing to it, a
// renderer field no caller passed, capability flags nobody parsed. So the
// sweep's wiring is asserted too: that the delivery is marked delivered only
// AFTER a send that resolved, that a failed send never marks it delivered, and
// that the route hands the schedule's recipients to the sender at all.

import { describe, test, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import {
  sendMail,
  readMailerConfig,
  mailerConfigured,
  normalizeRecipients,
  isPlausibleEmail,
  isMailNotConfiguredError,
  MailTimeoutError,
  type TransportFactory,
} from "../mailer";

// ===========================================================================
// A FAKE POOL, so the REAL CreateReportSchedule runs
// ===========================================================================
// A mutation survey killed everything here except one: gutting the "an email
// schedule needs a recipient" refusal left the suite green, because that rule
// was only ever asserted as SOURCE TEXT and `if (false && …)` still contains the
// text. A rule tested by reading the code is not tested. So the write itself is
// observed: `insert into "ReportSchedules"` either ran or it did not.
const dbfx: {
  inserts: { channel: unknown; recipients: unknown; report_keys?: unknown; window_mode?: unknown }[];
  /** What the runtime's probe finds for migrations 056-058. */
  ready: boolean;
  /** The restaurant's address book: [email, status]. */
  book: [string, "active" | "suppressed"][];
} = { inserts: [], ready: false, book: [] };

jest.mock("pg", () => {
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/from "Restaurant" r/i.test(q)) {
      return { rows: [{
        res_id: "11111111-1111-1111-1111-111111111111",
        outlet_id: "22222222-2222-2222-2222-222222222222",
        restaurant_slug: "gaia", restaurant_name: "Gaia",
        restaurant_main_office_add: null, restaurant_logo_url: null, timezone: null,
      }] };
    }
    if (/to_regclass\('"ReportEmailRecipients"'\) is not null as m056/i.test(q)) {
      return { rows: [{ m056: dbfx.ready, m057: dbfx.ready, m058: dbfx.ready }] };
    }
    if (/^select email_norm, status from "ReportEmailRecipients"/i.test(q)) {
      return { rows: dbfx.book.map(([email, status]) => ({ email_norm: email.toLowerCase(), status })) };
    }
    if (/from "ReportSchedules" where res_id = \$1 and outlet_id = \$2 and channel = 'email'/i.test(q)) {
      return { rows: [{ n: 0 }] };
    }
    if (/^insert into "ReportSchedules"/i.test(q)) {
      const p2 = (params ?? []) as unknown[];
      dbfx.inserts.push({ channel: p2[9], recipients: p2[10], report_keys: p2[14], window_mode: p2[16] });
      return { rows: [{
        id: "33333333-3333-3333-3333-333333333333",
        outlet_id: "22222222-2222-2222-2222-222222222222",
        name: "x", report_key: "sales", frequency: "daily", hour_local: 8, minute_local: 0,
        weekday: null, day_of_month: null, channel: p2[9], recipients: p2[10],
        format: "csv", enabled: true, last_occurrence_key: null, last_status: null,
        last_error: null, last_run_at: null, consecutive_failures: 0,
        created_at: new Date(), updated_at: new Date(),
      }] };
    }
    return { rows: [] };
  };
  class FakePool {
    on(): this { return this; }
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> { return query(sql, params); }
    connect(): Promise<unknown> { return Promise.resolve({ query, release: () => undefined }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

jest.mock("../realtime", () => ({ __esModule: true, emitRestaurant: jest.fn(), emitOutlet: jest.fn() }));
jest.mock("../auth/sessions", () => ({ __esModule: true, destroyAllForEmployee: jest.fn() }));
jest.mock("../auth/store", () => ({ __esModule: true, getStore: () => null }));

let db: typeof import("../database_supabase");
const RES_ID = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.SUPABASE_DIRECT_URL =
    process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  db = await import("../database_supabase");
});

beforeEach(() => {
  dbfx.inserts = [];
  dbfx.ready = false;
  dbfx.book = [];
  db.resetReportEmailSchemaCache();
});

/** A transport whose sendMail never settles — the failure the bound exists for. */
const hangingTransport = (): TransportFactory => () => ({
  sendMail: () => new Promise(() => { /* never */ }),
  close: () => undefined,
} as unknown as ReturnType<TransportFactory>);

/** A transport that resolves, recording what it was asked to send. */
const recordingTransport = (sink: Record<string, unknown>[]): TransportFactory => () => ({
  sendMail: (msg: Record<string, unknown>) => {
    sink.push(msg);
    return Promise.resolve({ accepted: String(msg.to).split(", "), messageId: "<test@local>" });
  },
  close: () => undefined,
} as unknown as ReturnType<TransportFactory>);

const CONFIGURED = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "reports@gaia.test",
  SMTP_PASS: "hunter2",
  SMTP_FROM: "GAIA Reports <reports@gaia.test>",
  SMTP_TIMEOUT_MS: "150",
} as unknown as NodeJS.ProcessEnv;

// ===========================================================================
// READING THE TRANSPORT OUT OF THE ENVIRONMENT
// ===========================================================================
describe("a deployment either can send mail or says it cannot", () => {
  test("nothing configured is not configured", () => {
    expect(readMailerConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(mailerConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("a host with no From is not configured — the header is not optional", () => {
    expect(readMailerConfig({ SMTP_HOST: "smtp.example.test" } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("the SMTP user stands in for From, which is what most providers require anyway", () => {
    const c = readMailerConfig({ SMTP_HOST: "h.test", SMTP_USER: "a@b.test" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ host: "h.test", from: "a@b.test", port: 587, secure: false });
  });

  test("port 465 implies implicit TLS without another env var to get wrong", () => {
    const c = readMailerConfig({ SMTP_HOST: "h.test", SMTP_USER: "a@b.test", SMTP_PORT: "465" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ port: 465, secure: true });
  });

  test("SMTP_SECURE=true still wins on a non-465 port", () => {
    const c = readMailerConfig({ SMTP_HOST: "h.test", SMTP_USER: "a@b.test", SMTP_PORT: "2525", SMTP_SECURE: "true" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ port: 2525, secure: true });
  });

  test("a URL is broken into the SAME fields, so the timeouts cannot be skipped", () => {
    // nodemailer's createTransport(urlString, defaults) treats its second
    // argument as MESSAGE defaults, not transport options — a URL transport
    // handed straight to it would receive none of the bounds. One shape, one
    // code path; this is the assertion that keeps it that way.
    const c = readMailerConfig({ SMTP_URL: "smtps://user%40gaia.test:p%40ss@mail.test:465", SMTP_FROM: "r@gaia.test" } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ host: "mail.test", port: 465, secure: true, user: "user@gaia.test", pass: "p@ss", from: "r@gaia.test" });
  });

  test("a URL without an explicit port picks the right default for its scheme", () => {
    expect(readMailerConfig({ SMTP_URL: "smtp://u:p@mail.test", SMTP_FROM: "r@x.test" } as NodeJS.ProcessEnv)).toMatchObject({ port: 587, secure: false });
    expect(readMailerConfig({ SMTP_URL: "smtps://u:p@mail.test", SMTP_FROM: "r@x.test" } as NodeJS.ProcessEnv)).toMatchObject({ port: 465, secure: true });
  });

  test("a malformed or wrong-scheme URL reports unavailable rather than killing boot", () => {
    for (const SMTP_URL of ["not a url", "http://mail.test", "smtp://", ""]) {
      expect(readMailerConfig({ SMTP_URL, SMTP_FROM: "r@x.test" } as NodeJS.ProcessEnv)).toBeNull();
    }
  });
});

// ===========================================================================
// THE BOUND
// ===========================================================================
describe("a mail server that never answers costs one occurrence, not the sweep", () => {
  test("a send that never settles still returns — bounded, and named", async () => {
    const started = Date.now();
    await expect(
      sendMail({ to: ["a@b.test"], subject: "s", text: "t" }, { env: CONFIGURED, factory: hangingTransport() }),
    ).rejects.toBeInstanceOf(MailTimeoutError);
    // The assertion that matters is that it CAME BACK. The generous ceiling is
    // deliberate: a tight one would make this flaky on a loaded machine and a
    // flaky bound test gets deleted, which is how the Redis hang survived.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  test("the timeout is the configured one, not a hardcoded default", async () => {
    const started = Date.now();
    await expect(
      sendMail({ to: ["a@b.test"], subject: "s", text: "t" },
        { env: { ...CONFIGURED, SMTP_TIMEOUT_MS: "60" }, factory: hangingTransport() }),
    ).rejects.toBeInstanceOf(MailTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);

  test("the transport is CLOSED even on the timeout path", async () => {
    // A transport abandoned mid-send keeps its socket and its timers, and the
    // process then will not exit — the same class of leak as an unbounded
    // connect, just quieter.
    let closed = 0;
    const factory: TransportFactory = () => ({
      sendMail: () => new Promise(() => { /* never */ }),
      close: () => { closed += 1; },
    } as unknown as ReturnType<TransportFactory>);
    await expect(sendMail({ to: ["a@b.test"], subject: "s", text: "t" }, { env: CONFIGURED, factory }))
      .rejects.toBeInstanceOf(MailTimeoutError);
    expect(closed).toBe(1);
  }, 10_000);

  test("and closed on the happy path too", async () => {
    let closed = 0;
    const factory: TransportFactory = () => ({
      sendMail: () => Promise.resolve({ accepted: ["a@b.test"], messageId: "<x>" }),
      close: () => { closed += 1; },
    } as unknown as ReturnType<TransportFactory>);
    await sendMail({ to: ["a@b.test"], subject: "s", text: "t" }, { env: CONFIGURED, factory });
    expect(closed).toBe(1);
  });
});

// ===========================================================================
// NOT CONFIGURED IS A FAILURE, NEVER A SILENT SUCCESS
// ===========================================================================
describe("an unconfigured deployment says so instead of pretending", () => {
  test("sendMail throws a NAMED error rather than resolving", async () => {
    const err = await sendMail({ to: ["a@b.test"], subject: "s", text: "t" }, { env: {} as NodeJS.ProcessEnv })
      .then(() => null, (e: unknown) => e);
    expect(isMailNotConfiguredError(err)).toBe(true);
  });

  test("it never reaches a transport at all", async () => {
    const sent: Record<string, unknown>[] = [];
    await sendMail({ to: ["a@b.test"], subject: "s", text: "t" },
      { env: {} as NodeJS.ProcessEnv, factory: recordingTransport(sent) }).catch(() => undefined);
    expect(sent).toHaveLength(0);
  });

  test("a configured deployment with no usable address also refuses, and does not retry a typo forever", async () => {
    const sent: Record<string, unknown>[] = [];
    await expect(
      sendMail({ to: ["not-an-address", "  "], subject: "s", text: "t" },
        { env: CONFIGURED, factory: recordingTransport(sent) }),
    ).rejects.toThrow(/recipient/i);
    expect(sent).toHaveLength(0);
  });
});

// ===========================================================================
// WHAT ACTUALLY GOES OUT
// ===========================================================================
describe("the message carries the report and the From the operator configured", () => {
  test("the attachment is the rendered artifact, byte for byte", async () => {
    const sent: Record<string, unknown>[] = [];
    await sendMail({
      to: ["owner@gaia.test"],
      subject: "Sales report ready — 2026-09-11",
      text: "The report is attached.",
      attachments: [{ filename: "sales-2026-09-11.csv", content: "date,total\n2026-09-11,1234.50\n", contentType: "text/csv" }],
    }, { env: CONFIGURED, factory: recordingTransport(sent) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "GAIA Reports <reports@gaia.test>",
      to: "owner@gaia.test",
      subject: "Sales report ready — 2026-09-11",
    });
    const attachments = sent[0].attachments as { filename: string; content: string }[];
    expect(attachments[0].filename).toBe("sales-2026-09-11.csv");
    expect(attachments[0].content).toBe("date,total\n2026-09-11,1234.50\n");
  });

  test("several recipients go on one message, comma-joined", async () => {
    const sent: Record<string, unknown>[] = [];
    await sendMail({ to: ["a@x.test", "b@x.test"], subject: "s", text: "t" }, { env: CONFIGURED, factory: recordingTransport(sent) });
    expect(sent[0].to).toBe("a@x.test, b@x.test");
  });

  test("the accepted list comes back, so the delivery row can record where it went", async () => {
    const sent: Record<string, unknown>[] = [];
    const r = await sendMail({ to: ["a@x.test", "b@x.test"], subject: "s", text: "t" }, { env: CONFIGURED, factory: recordingTransport(sent) });
    expect(r.accepted).toEqual(["a@x.test", "b@x.test"]);
    expect(r.messageId).toBe("<test@local>");
  });
});

// ===========================================================================
// THE RECIPIENT LIST
// ===========================================================================
describe("the recipient list is cleaned once, where it is saved", () => {
  test("plausible addresses pass", () => {
    for (const ok of ["a@b.co", "owner+gst@gaia.test", "first.last@sub.domain.example"]) {
      expect(isPlausibleEmail(ok)).toBe(true);
    }
  });

  test("things that cannot be an address are refused", () => {
    for (const bad of ["", "   ", "no-at-sign", "a@b", "a@@b.co", "a b@c.co", "a@.co", "a@b..co", "a@b.", null, undefined, 42]) {
      expect(isPlausibleEmail(bad)).toBe(false);
    }
  });

  test("a plus tag and a long TLD are NOT rejected — that would refuse real people", () => {
    expect(isPlausibleEmail("accounts+2026@restaurant.technology")).toBe(true);
  });

  test("trimmed, de-duplicated case-insensitively, order kept", () => {
    expect(normalizeRecipients([" Owner@Gaia.test ", "owner@gaia.test", "accounts@gaia.test"]))
      .toEqual(["Owner@Gaia.test", "accounts@gaia.test"]);
  });

  test("a pasted string is split on commas, semicolons and newlines", () => {
    expect(normalizeRecipients("a@x.test, b@x.test; c@x.test\nd@x.test"))
      .toEqual(["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
  });

  test("rubbish entries are dropped rather than failing the whole list", () => {
    expect(normalizeRecipients(["a@x.test", "oops", "", "b@x.test"])).toEqual(["a@x.test", "b@x.test"]);
  });

  test("capped at ten — a report of a restaurant's takings is not a mailing list", () => {
    const many = Array.from({ length: 25 }, (_v, i) => `p${i}@x.test`);
    expect(normalizeRecipients(many)).toHaveLength(10);
  });

  test("anything that is not a list or a string is an empty list, never a throw", () => {
    for (const junk of [null, undefined, 42, {}, true]) {
      expect(normalizeRecipients(junk)).toEqual([]);
    }
  });
});

// ===========================================================================
// THE WIRING — does anything actually send it
// ===========================================================================
describe("the sweep sends before it marks delivered, and the form can reach it", () => {
  function readSource(relative: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const base of [process.cwd(), path.join(__dirname, "..")]) {
      const full = path.join(base, relative);
      if (fs.existsSync(full)) { return fs.readFileSync(full, "utf8"); }
    }
    throw new Error(`readSource could not find ${relative} from ${process.cwd()}`);
  }

  // Since item 9 the sweep sends ONE message per address (sendReportMessage),
  // from runBundle; the three assertions below follow it there.
  const bundleBody = (): string => {
    const src = readSource("report_schedules.ts").replace(/\r\n/g, "\n");
    const start = src.indexOf("async function runBundle(");
    const end = src.indexOf("\nasync function runReportFor(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  test("report_schedules.ts imports the sender and calls it", () => {
    const src = readSource("report_schedules.ts");
    expect(src).toMatch(/from "\.\/mailer\.js"/);
    expect(bundleBody()).toMatch(/const one = await sendReportMessage\(\{/);
  });

  test("THE ORDER: 'sending' commits, THEN the send, THEN the row is marked delivered", () => {
    // A row that says 'delivered' for mail that never left is the same defect as
    // a print job that acked paper nobody printed — and that one shipped here.
    const body = bundleBody();
    const sending = body.indexOf("MarkReportDeliverySending(resId, p.delivery_id, attempts, transport.kind)");
    const send = body.indexOf("await sendReportMessage({");
    const recorded = body.indexOf("await record(addr, \"delivered\")");
    const mark = body.lastIndexOf("MarkReportDelivered(resId, {");
    expect(sending).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(sending);
    expect(recorded).toBeGreaterThan(send);
    expect(mark).toBeGreaterThan(recorded);
    // The inbox branch marks delivered BEFORE any of that — and returns.
    const inbox = body.indexOf("if (p.channel === \"inbox\") {");
    const inboxEnd = body.indexOf("return { accepted: 0, refused: 0, skipped: 0, maybeDuplicate: false };");
    expect(inbox).toBeGreaterThan(-1);
    expect(inboxEnd).toBeGreaterThan(inbox);
    expect(inboxEnd).toBeLessThan(sending);
  });

  test("the send happens OUTSIDE withTenant — no pooled client across an SMTP round trip", () => {
    // A pool of fifteen connections held across somebody else's server is how
    // this project produced a full standstill once already, so this is a real
    // property and not a style note.
    //
    // Asserted structurally: EVERY withTenant opened in runBundle before the send
    // has CLOSED before it — its parentheses balance before the send begins.
    // Since item 9 there are several (the render, 'sending', the book check, the
    // per-address outcome, the cap count); none may still be open.
    const body = bundleBody();
    const send = body.indexOf("await sendReportMessage({");
    expect(send).toBeGreaterThan(-1);
    let opened = 0;
    for (let at = body.indexOf("withTenant("); at !== -1 && at < send; at = body.indexOf("withTenant(", at + 1)) {
      opened += 1;
      let depth = 0;
      let close = -1;
      for (let i = at + "withTenant".length; i < body.length; i += 1) {
        if (body[i] === "(") { depth += 1; }
        else if (body[i] === ")") { depth -= 1; if (depth === 0) { close = i; break; } }
      }
      expect(close).toBeGreaterThan(at);
      expect(close).toBeLessThan(send);
    }
    expect(opened).toBeGreaterThan(3);
  });

  test("the 2.0.1 inbox path still renders inside its own transaction, closed before the bell", () => {
    const src = readSource("report_schedules.ts").replace(/\r\n/g, "\n");
    const body = src.slice(src.indexOf("async function runLegacyInbox("), src.indexOf("async function runBundle("));
    const open = body.indexOf("const artifact = await withTenant(ctx, async () => {");
    const deliver = body.indexOf("DeliverReportToInbox(resId, {");
    expect(open).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(open);
    // The callback's closing line, at the statement indent the opening sits on.
    const between = body.slice(open, deliver);
    expect(between).toMatch(/\n {2}\}\);/);
  });

  test("the schedule's recipients reach the sender, one address per message", () => {
    const body = bundleBody();
    expect(body).toMatch(/for \(const addr of normalizeRecipients\(p\.recipients\)\) \{/);
    expect(body).toMatch(/to: \[addr\],/);
  });

  test("'email' is a storable channel, because something now delivers it", () => {
    expect(readSource("database_supabase.ts")).toMatch(/REPORT_SCHEDULE_CHANNELS = \["inbox", "email"\]/);
  });

  test("an email schedule with no recipients is refused BEFORE any row is written", async () => {
    await expect(db.CreateReportSchedule(RES_ID, {
      name: "daily sales", report_key: "sales", channel: "email",
    })).rejects.toThrow(/recipient/i);
    // The assertion that matters: nothing was stored. A 400 proves a message was
    // sent; only the absent INSERT proves the schedule does not exist.
    expect(dbfx.inserts).toHaveLength(0);
  });

  test("…and the refusal tells the person what to do about it", async () => {
    const err = await db.CreateReportSchedule(RES_ID, {
      name: "daily sales", report_key: "sales", channel: "email", recipients: ["not-an-address"],
    }).then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/in-app inbox/i);
  });

  test("since item 9, an email schedule on a database without 056-058 is refused — nothing written", async () => {
    // Addresses are CHOSEN from the restaurant's address book (migration 056);
    // until it exists there is nothing to choose from, and the refusal says the
    // database is behind rather than pretending the address was wrong.
    const err = await db.CreateReportSchedule(RES_ID, {
      name: "daily sales", report_key: "sales", channel: "email", recipients: ["owner@gaia.test"],
    }).then(() => null, (e: unknown) => e);
    expect(db.isReportEmailSchemaPending(err)).toBe(true);
    expect(dbfx.inserts).toHaveLength(0);
  });

  test("with 056-058 in place, the addresses must be in the book — and are stored trimmed, de-duplicated", async () => {
    dbfx.ready = true;
    dbfx.book = [["Owner@Gaia.test", "active"], ["accounts@gaia.test", "active"]];
    const created = await db.CreateReportSchedule(RES_ID, {
      name: "daily sales", report_key: "sales", channel: "email",
      recipients: [" Owner@Gaia.test ", "owner@gaia.test", "accounts@gaia.test"],
    });
    expect(dbfx.inserts).toHaveLength(1);
    expect(dbfx.inserts[0]).toMatchObject({
      channel: "email",
      recipients: ["Owner@Gaia.test", "accounts@gaia.test"],
      report_keys: ["sales"],
    });
    expect(created.recipients).toEqual(["Owner@Gaia.test", "accounts@gaia.test"]);
  });

  test("an address that is NOT in the book is refused by name — never silently dropped", async () => {
    dbfx.ready = true;
    dbfx.book = [["owner@gaia.test", "active"]];
    const err = await db.CreateReportSchedule(RES_ID, {
      name: "daily sales", report_key: "sales", channel: "email",
      recipients: ["owner@gaia.test", "stranger@elsewhere.test"],
    }).then(() => null, (e: unknown) => e);
    expect(db.isReportEmailRequestError(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/stranger@elsewhere\.test is not in this restaurant's address book/);
    expect(dbfx.inserts).toHaveLength(0);
  });

  test("a paused (suppressed) address is refused too, and eleven are refused rather than cut to ten", async () => {
    dbfx.ready = true;
    dbfx.book = [["owner@gaia.test", "suppressed"]];
    await expect(db.CreateReportSchedule(RES_ID, {
      name: "x", report_key: "sales", channel: "email", recipients: ["owner@gaia.test"],
    })).rejects.toThrow(/paused in the address book/);
    const many = Array.from({ length: 11 }, (_v, i) => `p${String(i)}@x.test`);
    dbfx.book = many.map((e) => [e, "active"]);
    await expect(db.CreateReportSchedule(RES_ID, {
      name: "x", report_key: "sales", channel: "email", recipients: many,
    })).rejects.toThrow(/at most 10/);
    expect(dbfx.inserts).toHaveLength(0);
  });

  test("a new daily bundle closes its day at the send time; GST on one is refused, not stored", async () => {
    dbfx.ready = true;
    dbfx.book = [["owner@gaia.test", "active"]];
    await db.CreateReportSchedule(RES_ID, {
      name: "night pack", channel: "email", recipients: ["owner@gaia.test"],
      report_keys: ["sales_summary", "settlement_summary"], formats: ["xlsx"], hour_local: 2, minute_local: 0,
    });
    expect(dbfx.inserts[0]).toMatchObject({ report_keys: ["sales_summary", "settlement_summary"], window_mode: "trading_day" });
    await expect(db.CreateReportSchedule(RES_ID, {
      name: "bad", channel: "inbox", report_keys: ["sales_summary", "gst"], window_mode: "trading_day",
    })).rejects.toThrow(/GST can only be sent for calendar days/);
    expect(dbfx.inserts).toHaveLength(1);
  });

  test("the all-outlets scope is for an admin or a manager only", async () => {
    dbfx.ready = true;
    const err = await db.CreateReportSchedule(RES_ID, {
      name: "group", channel: "inbox", report_keys: ["executive_summary"], outlet_scope: "all",
    }, undefined, { allowAllOutlets: false }).then(() => null, (e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    await db.CreateReportSchedule(RES_ID, {
      name: "group", channel: "inbox", report_keys: ["executive_summary"], outlet_scope: "all",
    }, undefined, { allowAllOutlets: true });
    expect(dbfx.inserts).toHaveLength(1);
  });

  test("an INBOX schedule still needs no recipients — nobody loses anything", async () => {
    await expect(db.CreateReportSchedule(RES_ID, { name: "bell only", report_key: "pnl" }))
      .resolves.toMatchObject({ channel: "inbox" });
    expect(dbfx.inserts).toHaveLength(1);
  });

  test("a channel with no sender behind it is still refused", async () => {
    await expect(db.CreateReportSchedule(RES_ID, {
      name: "sms", report_key: "sales", channel: "sms", recipients: ["a@b.test"],
    })).rejects.toThrow(/channel/i);
    expect(dbfx.inserts).toHaveLength(0);
  });

  test("and migration 044 refuses it in the database too, with cardinality not array_length", () => {
    // array_length('{}', 1) is NULL, and a CHECK that evaluates to NULL PASSES —
    // proven against a real Postgres before this shipped. cardinality() returns 0.
    const sql = readSource("migrations/044_report_email_channel.sql");
    // Comments are stripped first: the migration's own header QUOTES the broken
    // form as the thing it is warning about, and an assertion that cannot tell a
    // warning from the code would fail on the documentation.
    const statements = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).toMatch(/cardinality\(recipients\) >= 1/);
    expect(statements).not.toMatch(/array_length\(recipients/);
  });

  test("GET /reports/schedules tells the client whether mail is available at all", () => {
    // A capability the client has to guess at is this project's most repeated
    // bug. The server answers; the form obeys.
    expect(readSource("routes/accounting.ts")).toMatch(/email_available: mailerConfigured\(\)/);
  });
});
