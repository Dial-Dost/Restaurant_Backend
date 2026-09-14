// A FEEDBACK-FORM SAVE WRITES ONLY WHAT IT SENT.
//
// The valet toggle (web dashboard Settings) saves `{feedback_config:
// {valet_enabled: <bool>}}` — one key. feedback_config used to be REPLACED on
// every save with mergeFeedbackConfig(body), which fills a DEFAULT for every key
// the body left out, so that one click would have reset the owner's form title,
// welcome text, review link and rating categories. The owner app never showed
// the problem because its card always sends the whole form.
//
// Pinned here: feedbackConfigPatch keeps exactly the keys sent (normalized the
// way the read path normalizes them), and SetRestaurantSettings concatenates the
// patch onto the stored object instead of replacing it. The SQL half is a source
// guard because database_supabase.ts cannot run SQL under jest; its semantics
// (stored || patch, NULL stored -> patch, no patch -> unchanged, categories
// replaced whole) were proven against Postgres when this was written.

import { describe, test, expect, beforeAll, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("pg", () => {
  class FakePool {
    on(): this { return this; }
    query(): Promise<never> { return Promise.reject(new Error("feedback_config_patch: no SQL expected")); }
    connect(): Promise<never> { return Promise.reject(new Error("feedback_config_patch: no SQL expected")); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

let feedbackConfigPatch: (input: unknown) => Record<string, unknown>;

beforeAll(async () => {
  process.env.SUPABASE_DIRECT_URL = process.env.SUPABASE_DIRECT_URL || "postgres://fixture:fixture@localhost:5432/fixture";
  const db = await import("../database_supabase");
  feedbackConfigPatch = db.feedbackConfigPatch as unknown as typeof feedbackConfigPatch;
});

describe("feedbackConfigPatch", () => {
  test("THE TOGGLE: a valet-only save carries ONLY valet_enabled", () => {
    expect(feedbackConfigPatch({ valet_enabled: false })).toEqual({ valet_enabled: false });
    expect(feedbackConfigPatch({ valet_enabled: true })).toEqual({ valet_enabled: true });
  });

  test("a whole-form save (the owner app's card) is a patch of every key — today's behaviour", () => {
    const whole = {
      title: "  Gaia Feedback  ",
      subtitle: "Tell us",
      valet_enabled: true,
      require_image: false,
      review_url: "https://g.page/gaia",
      categories: [{ label: "Food Quality", key: "food" }, { label: "Valet Parking" }],
    };
    expect(feedbackConfigPatch(whole)).toEqual({
      title: "Gaia Feedback",
      subtitle: "Tell us",
      valet_enabled: true,
      require_image: false,
      review_url: "https://g.page/gaia",
      categories: [{ key: "food", label: "Food Quality" }, { key: "valet_parking", label: "Valet Parking" }],
    });
  });

  test("a key of the wrong type is not written — it cannot turn into a default by accident", () => {
    expect(feedbackConfigPatch({ valet_enabled: "false", title: 7, categories: "food" })).toEqual({});
  });

  test("nothing usable is nothing — not an empty object that would still be concatenated", () => {
    expect(feedbackConfigPatch(null)).toEqual({});
    expect(feedbackConfigPatch([])).toEqual({});
    expect(feedbackConfigPatch("x")).toEqual({});
  });
});

describe("SetRestaurantSettings concatenates the patch onto the stored form", () => {
  const db = readFileSync(join(__dirname, "..", "database_supabase.ts"), "utf8");

  test("the SQL is stored || patch, and an absent patch leaves the column alone", () => {
    expect(db).toContain("feedback_config = case when $8::jsonb is null then feedback_config else coalesce(feedback_config, '{}'::jsonb) || $8::jsonb end,");
    expect(db).not.toContain("feedback_config = coalesce($8::jsonb, feedback_config),");
  });

  test("$8 is the PATCH, not the defaulted whole", () => {
    expect(db).toContain("const feedbackPatch = opts.feedback_config !== undefined ? feedbackConfigPatch(opts.feedback_config) : {};");
    expect(db).not.toContain("JSON.stringify(mergeFeedbackConfig(opts.feedback_config))");
  });
});
