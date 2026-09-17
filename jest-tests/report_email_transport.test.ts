// THE MAIL TRANSPORTS — which one, and what each one promises.
//
// report_email_channel.test.ts pins the SMTP path that shipped with 044 (the
// bound, the close, the never-a-fake-success rule). This suite pins what item 9
// added on top: a switch between SMTP, an HTTPS API for a box whose provider
// blocks the SMTP ports, a development log, and off — and the report path's
// ONE-MESSAGE-PER-ADDRESS contract, whose three outcomes (accepted, refused,
// thrown) are what the delivery row records per recipient.

import { describe, test, expect } from "@jest/globals";
import {
  addressTag,
  isMailNotConfiguredError,
  mailTransportStatus,
  mailerConfigured,
  MailTimeoutError,
  readMailTransport,
  safeDisplayName,
  scrubAddresses,
  sendMail,
  sendReportMessage,
  stableMessageId,
  withDisplayName,
  type FetchLike,
  type TransportFactory,
} from "../mailer";

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;

const SMTP = { SMTP_HOST: "smtp.example.test", SMTP_USER: "reports@gaia.test", SMTP_PASS: "hunter2", SMTP_FROM: "reports@gaia.test", SMTP_TIMEOUT_MS: "150" };
const RESEND = { MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_test_key", MAIL_FROM: "Experio Reports <reports@mail.gaia.test>", SMTP_TIMEOUT_MS: "150", RESEND_API_URL: "https://resend.invalid/emails" };

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }

const fakeFetch = (status: number, reply: unknown, sink: Captured[] = []): FetchLike => async (url, init) => {
  sink.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => reply,
    text: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
  };
};

const smtpFactory = (behave: (msg: Record<string, unknown>) => Promise<unknown>, sink: Record<string, unknown>[] = []): TransportFactory => () => ({
  sendMail: (msg: Record<string, unknown>) => { sink.push(msg); return behave(msg); },
  close: () => undefined,
} as unknown as ReturnType<TransportFactory>);

describe("MAIL_TRANSPORT picks exactly one transport, or says why none", () => {
  test("unset: SMTP when its settings are complete — every existing deployment unchanged", () => {
    expect(readMailTransport(env(SMTP)).kind).toBe("smtp");
    expect(readMailTransport(env({})).kind).toBe("off");
    expect(readMailTransport(env({})).reason).toMatch(/No mail transport is configured/);
  });

  test("smtp named but incomplete is OFF with the reason, never a guess", () => {
    const t = readMailTransport(env({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h.test" }));
    expect(t.kind).toBe("off");
    expect(t.reason).toMatch(/SMTP settings are incomplete/);
  });

  test("resend needs a key and a From; with both it is on", () => {
    expect(readMailTransport(env({ ...RESEND, RESEND_API_KEY: "" })).reason).toMatch(/RESEND_API_KEY/);
    expect(readMailTransport(env({ ...RESEND, MAIL_FROM: "" })).reason).toMatch(/From/);
    const t = readMailTransport(env(RESEND));
    expect(t.kind).toBe("resend");
    expect(t.fromAddress).toBe("reports@mail.gaia.test");
  });

  test("resend does NOT fall back to SMTP when it cannot work", () => {
    expect(readMailTransport(env({ ...SMTP, MAIL_TRANSPORT: "resend" })).kind).toBe("off");
  });

  test("log works in development and is REFUSED in production", () => {
    expect(readMailTransport(env({ MAIL_TRANSPORT: "log" })).kind).toBe("log");
    const prod = readMailTransport(env({ MAIL_TRANSPORT: "log", NODE_ENV: "production" }));
    expect(prod.kind).toBe("off");
    expect(prod.reason).toMatch(/refused in production/);
  });

  test("off and unknown words are off, named", () => {
    expect(readMailTransport(env({ ...SMTP, MAIL_TRANSPORT: "off" })).kind).toBe("off");
    expect(readMailTransport(env({ ...SMTP, MAIL_TRANSPORT: "sendgrid" })).reason).toMatch(/sendgrid is not a transport/);
  });

  test("MAIL_FROM overrides the SMTP From for the message", () => {
    expect(readMailTransport(env({ ...SMTP, MAIL_FROM: "reports@other.test" })).fromAddress).toBe("reports@other.test");
  });

  test("the status says the NAME and whether it works — never a host, user, key or From", () => {
    for (const e of [SMTP, RESEND, { MAIL_TRANSPORT: "log" }, {}]) {
      const status = mailTransportStatus(env(e));
      const json = JSON.stringify(status);
      for (const secret of ["smtp.example.test", "hunter2", "re_test_key", "reports@", "resend.invalid"]) {
        expect(json).not.toContain(secret);
      }
      expect(Object.keys(status).sort()).toEqual(["available", "reason", "transport"]);
    }
    expect(mailerConfigured(env(RESEND))).toBe(true);
    expect(mailerConfigured(env({ MAIL_TRANSPORT: "off" }))).toBe(false);
  });
});

describe("the HTTPS transport", () => {
  const msg = {
    to: ["accounts@firm.test"],
    subject: "Gaia — Daily reports — Wed 16 Sep 2026",
    text: "body",
    html: "<p>body</p>",
    messageId: "<rd-abc-123@mail.gaia.test>",
    idempotencyKey: "rd-abc-123",
    fromName: "Gaia via Experio Reports",
    attachments: [{ filename: "reports.xlsx", content: Buffer.from([1, 2, 3]), contentType: "application/octet-stream" }],
  };

  test("posts one message to one address with the key, the idempotency key and a base64 attachment", async () => {
    const sink: Captured[] = [];
    const r = await sendReportMessage(msg, { env: env(RESEND), fetchImpl: fakeFetch(200, { id: "re_1" }, sink) });
    expect(r).toEqual({ status: "accepted", messageId: "<rd-abc-123@mail.gaia.test>", provider: "resend", detail: null });
    expect(sink).toHaveLength(1);
    expect(sink[0].url).toBe("https://resend.invalid/emails");
    expect(sink[0].headers.Authorization).toBe("Bearer re_test_key");
    expect(sink[0].headers["Idempotency-Key"]).toBe("rd-abc-123");
    expect(sink[0].body.to).toEqual(["accounts@firm.test"]);
    expect(sink[0].body.from).toBe("\"Gaia via Experio Reports\" <reports@mail.gaia.test>");
    expect(sink[0].body.headers).toEqual({ "Message-ID": "<rd-abc-123@mail.gaia.test>" });
    expect((sink[0].body.attachments as { content: string }[])[0].content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  test("a 4xx about the message is a REFUSAL for that address, with the address scrubbed", async () => {
    const r = await sendReportMessage(msg, { env: env(RESEND), fetchImpl: fakeFetch(422, { message: "accounts@firm.test is invalid" }) });
    expect(r.status).toBe("refused");
    expect(r.detail).toContain("422");
    expect(r.detail).not.toContain("accounts@firm.test");
  });

  test.each([429, 500, 503, 401, 403])("a %i is TRANSIENT or the operator's — it throws, so the delivery retries", async (status) => {
    await expect(sendReportMessage(msg, { env: env(RESEND), fetchImpl: fakeFetch(status, "busy") })).rejects.toThrow(String(status));
  });

  test("a request that never answers is bounded and aborted", async () => {
    let aborted = false;
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    });
    const started = Date.now();
    await expect(sendReportMessage(msg, { env: env(RESEND), fetchImpl: hang })).rejects.toBeInstanceOf(MailTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(aborted).toBe(true);
  }, 10_000);
});

describe("the development log transport", () => {
  test("accepts without contacting anything", async () => {
    let contacted = 0;
    const r = await sendReportMessage({ to: ["a@b.test"], subject: "s", text: "t" }, {
      env: env({ MAIL_TRANSPORT: "log" }),
      fetchImpl: async () => { contacted += 1; throw new Error("no"); },
      factory: () => { contacted += 1; throw new Error("no"); },
    });
    expect(r.status).toBe("accepted");
    expect(r.provider).toBe("log");
    expect(contacted).toBe(0);
  });

  test("in production it is not a transport at all — the send is refused, named", async () => {
    const err = await sendReportMessage({ to: ["a@b.test"], subject: "s", text: "t" }, { env: env({ MAIL_TRANSPORT: "log", NODE_ENV: "production" }) })
      .then(() => null, (e: unknown) => e);
    expect(isMailNotConfiguredError(err)).toBe(true);
  });
});

describe("one address, one message, one outcome — over SMTP", () => {
  test("accepted: the Message-ID and the display name ride the message", async () => {
    const sink: Record<string, unknown>[] = [];
    const r = await sendReportMessage(
      { to: ["owner@gaia.test"], subject: "s", text: "t", messageId: "<rd-1-x@gaia.test>", fromName: "Gaia via Experio Reports" },
      { env: env(SMTP), factory: smtpFactory(async (m) => ({ accepted: [m.to], messageId: "<ignored@x>" }), sink) },
    );
    expect(r).toEqual({ status: "accepted", messageId: "<rd-1-x@gaia.test>", provider: "smtp", detail: null });
    expect(sink[0]).toMatchObject({ to: "owner@gaia.test", messageId: "<rd-1-x@gaia.test>", from: "\"Gaia via Experio Reports\" <reports@gaia.test>" });
  });

  test("a 550 is a REFUSAL, scrubbed", async () => {
    const r = await sendReportMessage({ to: ["gone@gaia.test"], subject: "s", text: "t" }, {
      env: env(SMTP),
      factory: smtpFactory(async () => { throw Object.assign(new Error("550 5.1.1 <gone@gaia.test>: user unknown"), { responseCode: 550 }); }),
    });
    expect(r.status).toBe("refused");
    expect(r.detail).toMatch(/550/);
    expect(r.detail).not.toContain("gone@gaia.test");
  });

  test("the server's own rejected list is a REFUSAL too", async () => {
    const r = await sendReportMessage({ to: ["gone@gaia.test"], subject: "s", text: "t" }, {
      env: env(SMTP),
      factory: smtpFactory(async () => { throw Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: "EENVELOPE", rejected: ["gone@gaia.test"] }); }),
    });
    expect(r.status).toBe("refused");
  });

  test("a 421 greylist and a timeout THROW — they may pass later", async () => {
    await expect(sendReportMessage({ to: ["a@gaia.test"], subject: "s", text: "t" }, {
      env: env(SMTP),
      factory: smtpFactory(async () => { throw Object.assign(new Error("421 try later"), { responseCode: 421 }); }),
    })).rejects.toThrow(/421/);
    await expect(sendReportMessage({ to: ["a@gaia.test"], subject: "s", text: "t" }, {
      env: env(SMTP),
      factory: smtpFactory(() => new Promise(() => { /* never */ })),
    })).rejects.toBeInstanceOf(MailTimeoutError);
  }, 10_000);

  test("exactly one address, never a list", async () => {
    await expect(sendReportMessage({ to: ["a@gaia.test", "b@gaia.test"], subject: "s", text: "t" }, { env: env(SMTP), factory: smtpFactory(async () => ({})) }))
      .rejects.toThrow(/exactly one address/);
  });

  test("sendMail over the HTTPS transport still returns only what was accepted", async () => {
    let n = 0;
    const alternating: FetchLike = async () => {
      n += 1;
      return n % 2 === 1
        ? { status: 200, ok: true, json: async () => ({ id: "x" }), text: async () => "" }
        : { status: 422, ok: false, json: async () => ({}), text: async () => "bad" };
    };
    const r = await sendMail({ to: ["a@x.test", "b@x.test", "c@x.test"], subject: "s", text: "t" }, { env: env(RESEND), fetchImpl: alternating });
    expect(r.accepted).toEqual(["a@x.test", "c@x.test"]);
  });
});

describe("what a report message carries about its addresses", () => {
  test("the Message-ID is stable per delivery AND address, and differs across either", () => {
    const a = stableMessageId("5b1c-uuid", "Owner@Gaia.test", "reports@mail.gaia.test");
    expect(a).toBe(stableMessageId("5b1c-uuid", "owner@gaia.test", "reports@mail.gaia.test"));
    expect(a).not.toBe(stableMessageId("5b1c-uuid", "accounts@gaia.test", "reports@mail.gaia.test"));
    expect(a).not.toBe(stableMessageId("other-uuid", "owner@gaia.test", "reports@mail.gaia.test"));
    expect(a).toMatch(/^<rd-5b1c-uuid-[0-9a-f]{10}@mail\.gaia\.test>$/);
    expect(a).not.toContain("owner");
    expect(stableMessageId("x", "a@b.test", null)).toMatch(/@reports\.invalid>$/);
  });

  test("scrubAddresses removes every address, and caps the length", () => {
    expect(scrubAddresses("550 <a.b+c@x.co.in> and d@e.test refused")).toBe("550 <<address>> and <address> refused");
    expect(scrubAddresses("x".repeat(2000))).toHaveLength(600);
  });

  test("addressTag is short, stable and case-blind", () => {
    expect(addressTag("A@B.test")).toBe(addressTag(" a@b.test "));
    expect(addressTag("a@b.test")).toMatch(/^[0-9a-f]{10}$/);
  });

  test("a display name cannot inject a header or a second address", () => {
    expect(safeDisplayName("Gaia\r\nBcc: evil@x.test")).toBe("Gaia Bcc: evil@x.test");
    expect(withDisplayName("reports@gaia.test", "A \"quoted\" <name>")).toBe("\"A quoted name\" <reports@gaia.test>");
    expect(withDisplayName("Ops <reports@gaia.test>", "")).toBe("Ops <reports@gaia.test>");
    expect(safeDisplayName("x".repeat(200))).toHaveLength(80);
  });
});
