// THE PAYMENT MODES A RESTAURANT SETTLES WITH — the pure rules.
//
// "there has to be an option to add mode of payments, it's not there." The fix
// is that the set of modes is CONFIGURED: payment_methods.ts decides what a save
// stores, what a settle accepts, what needs a screenshot and what a report calls
// a mode. Every rule it decides is a money rule in disguise, so each describe
// below names the money it protects.

import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PAYMENT_METHODS,
  MAX_CUSTOM_PAYMENT_MODES,
  PaymentConfigError,
  displayPaymentMethod,
  mergePaymentConfig,
  methodRequiresProof,
  normalizeBuiltinPaymentMethod,
  notMoneyKind,
  paymentConfigForUndo,
  paymentMethodLabel,
  paymentMethodRefusal,
  planPaymentConfigSave,
  reservedReason,
  resolvePaymentMethod,
  splitPartsNeedingProof,
  validatePaymentConfigInput,
  type PaymentMethodConfig,
} from "../payment_methods";

const swiggy = { id: "Swiggy Dineout", label: "Swiggy Dineout", enabled: true, requires_screenshot: true, custom: true };

/** Save `incoming` against `stored` and hand back what would be written. */
function saved(incoming: unknown, stored: unknown = null): PaymentMethodConfig[] {
  const plan = planPaymentConfigSave(incoming, stored);
  if (!plan.ok) {throw new Error(`save refused: ${plan.errors.join(" | ")}`);}
  return plan.config;
}

describe("a NULL config is exactly today — eight of nine tenants have one", () => {
  test("merge(null) is the eight built-ins, in order, with the old flags", () => {
    const cfg = mergePaymentConfig(null);
    expect(cfg.map((m) => m.id)).toEqual(["Razorpay", "Upi", "Cash", "Card", "Dineout", "Zomato", "Eazydiner", "District"]);
    expect(cfg.filter((m) => m.requires_screenshot).map((m) => m.id)).toEqual(["Dineout", "Zomato", "Eazydiner", "District"]);
    expect(cfg.every((m) => m.enabled && m.custom === false && m.show_to_guests === true)).toBe(true);
    expect(cfg.filter((m) => m.online).map((m) => m.id)).toEqual(["Razorpay"]);
  });

  test("the CSR Organics row (the only stored config in prod) reads back as the defaults", () => {
    const csr = DEFAULT_PAYMENT_METHODS.map(({ id, label, enabled, requires_screenshot, online }) => ({ id, label, enabled, requires_screenshot, ...(online ? { online } : {}) }));
    expect(mergePaymentConfig(csr)).toEqual(mergePaymentConfig(null));
  });

  test("the alias table is unchanged: every spelling the old normaliser took still resolves", () => {
    const cfg = mergePaymentConfig(null);
    const cases: [string, string][] = [
      ["upi", "Upi"], [" CASH ", "Cash"], ["card", "Card"], ["dine out", "Dineout"], ["dineout", "Dineout"],
      ["zomato pay", "Zomato"], ["zomatopay", "Zomato"], ["easy diner", "Eazydiner"], ["easydiner", "Eazydiner"],
      ["district", "District"], ["razorpay", "Razorpay"], ["split", "Split"],
    ];
    for (const [raw, id] of cases) {
      expect(normalizeBuiltinPaymentMethod(raw)).toBe(id);
      expect(resolvePaymentMethod(raw, cfg)?.id).toBe(id);
    }
    // …and what it refused, a NULL config still refuses.
    for (const raw of ["Swiggy", "Online Transfer", "Wallet", "Zomatoo", ""]) {
      expect(resolvePaymentMethod(raw, cfg)).toBeNull();
    }
  });

  test("the screenshot rule with no config is the old four exactly", () => {
    const cfg = mergePaymentConfig(null);
    for (const id of ["Dineout", "Zomato", "Eazydiner", "District"]) {expect(methodRequiresProof(id, cfg)).toBe(true);}
    for (const id of ["Upi", "Cash", "Card", "Razorpay", "Split", "Unknown"]) {expect(methodRequiresProof(id, cfg)).toBe(false);}
  });
});

describe("the owner's screenshot switch is obeyed for BUILT-INS too, at the till", () => {
  // The behaviour change a staff settle actually feels: the proof rule used to
  // be the compiled-in four whatever Settings said. Both directions matter —
  // an aggregator the owner no longer wants proof for must settle without one,
  // and cash the owner DOES want proof for must not settle without it.
  const cfg = saved([
    { id: "Zomato", requires_screenshot: false },
    { id: "Cash", requires_screenshot: true },
  ]);

  test("Zomato with the switch OFF needs no screenshot, whatever the till's spelling", () => {
    expect(methodRequiresProof("Zomato", cfg)).toBe(false);
    expect(methodRequiresProof("zomato pay", cfg)).toBe(false);
  });

  test("Cash with the switch ON needs one", () => {
    expect(methodRequiresProof("cash", cfg)).toBe(true);
    expect(methodRequiresProof("Cash", cfg)).toBe(true);
  });

  test("the built-ins nobody touched keep their defaults", () => {
    expect(methodRequiresProof("Dineout", cfg)).toBe(true);
    expect(methodRequiresProof("Upi", cfg)).toBe(false);
  });
});

describe("a split answers to its PARTS' screenshot rules", () => {
  const cfg = saved([swiggy, { id: "Zomato", label: "Zomato Pay" }]);

  test("the parts that need proof, by label, each once, in the order sent", () => {
    expect(splitPartsNeedingProof([
      { method: "Cash" }, { method: "zomato" }, { method: "Swiggy Dineout" }, { method: "Zomato" },
    ], cfg)).toEqual(["Zomato Pay", "Swiggy Dineout"]);
  });

  test("Cash + UPI needs none — and 'Split' itself never did", () => {
    expect(splitPartsNeedingProof([{ method: "Cash" }, { method: "Upi" }], cfg)).toEqual([]);
    expect(methodRequiresProof("Split", cfg)).toBe(false);
  });

  test("the owner's switch decides a part too", () => {
    const off = saved([{ id: "Zomato", requires_screenshot: false }]);
    expect(splitPartsNeedingProof([{ method: "Cash" }, { method: "Zomato" }], off)).toEqual([]);
  });
});

describe("adding a mode — the client's ask", () => {
  test("a custom mode is appended after the built-ins and keeps its flags", () => {
    const cfg = saved([swiggy]);
    expect(cfg).toHaveLength(9);
    expect(cfg[8]).toEqual({ id: "Swiggy Dineout", label: "Swiggy Dineout", enabled: true, requires_screenshot: true, custom: true, show_to_guests: false });
  });

  test("it settles: resolved to its stored id whatever the till's spelling, and its screenshot rule is its own", () => {
    const cfg = saved([swiggy]);
    expect(resolvePaymentMethod("swiggy dineout", cfg)?.id).toBe("Swiggy Dineout");
    expect(resolvePaymentMethod("Swiggy-Dineout", cfg)?.id).toBe("Swiggy Dineout");
    expect(methodRequiresProof("Swiggy Dineout", cfg)).toBe(true);
    expect(paymentMethodRefusal("Swiggy Dineout", cfg)).toBeNull();
  });

  test("a custom mode is accepted ONLY where it is configured", () => {
    expect(resolvePaymentMethod("Swiggy Dineout", mergePaymentConfig(null))).toBeNull();
    expect(paymentMethodRefusal("Swiggy Dineout", mergePaymentConfig(null))).toMatch(/not a payment mode this restaurant settles with/);
  });

  test("a custom mode is off the guest QR page unless the owner says otherwise", () => {
    expect(saved([swiggy])[8].show_to_guests).toBe(false);
    expect(saved([{ ...swiggy, show_to_guests: true }])[8].show_to_guests).toBe(true);
  });

  test("an unknown id without custom:true is refused, not quietly created (a typo of a built-in)", () => {
    const errors = validatePaymentConfigInput([{ id: "Zomatoo", enabled: true }]);
    expect(errors.join(" ")).toMatch(/custom: true/);
  });

  test("the id is tidied: whitespace collapsed and trimmed", () => {
    expect(saved([{ ...swiggy, id: "  Swiggy    Dineout " , label: "" }])[8]).toMatchObject({ id: "Swiggy Dineout", label: "Swiggy Dineout" });
  });
});

describe("names that are not money — refused with a sentence that says what to do", () => {
  test.each(["Complimentary", "comp", "NC", "N/C", "Non Chargeable", "non-chargeable", "Staff Meal"])(
    "%s points at Mark as non-chargeable",
    (name) => {
      const errors = validatePaymentConfigInput([{ id: name, custom: true }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/Mark as non-chargeable/);
    },
  );

  test.each(["Credit", "On Account", "due", "Pay later"])("%s would close a bill as paid with no money", (name) => {
    expect(validatePaymentConfigInput([{ id: name, custom: true }]).join(" ")).toMatch(/no money has arrived/);
  });

  // The whole-name match let every one of these through, and each books the same
  // free or unpaid bill as takings. Whole WORDS, anywhere in the name.
  test.each(["Staff Meals", "Complimentary Meal", "Comps", "FOC", "Non Chargeable Bill", "Guest (Comp)", "Staff-Meal Friday", "NonChargeable"])(
    "%s is still a comp, and still points at Mark as non-chargeable",
    (name) => {
      expect(notMoneyKind(name)).toBe("comp");
      const errors = validatePaymentConfigInput([{ id: name, custom: true }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/Mark as non-chargeable/);
    },
  );

  test.each(["On Credit", "Due Payment", "Credit/Due", "Customer Credit", "Pay Later - Regulars", "PayLater", "On Account (Corporate)"])(
    "%s is still money that has not arrived",
    (name) => {
      expect(notMoneyKind(name)).toBe("credit");
      expect(validatePaymentConfigInput([{ id: name, custom: true }]).join(" ")).toMatch(/no money has arrived/);
    },
  );

  test("a LABEL gets the same whole-word rule", () => {
    expect(validatePaymentConfigInput([{ ...swiggy, label: "Staff Meals" }]).join(" ")).toMatch(/non-chargeable/);
    expect(validatePaymentConfigInput([{ id: "Card", label: "Card on Credit" }]).join(" ")).toMatch(/no money has arrived/);
  });

  test.each(["Split", "Other", "Unallocated"])("%s is a report bucket", (name) => {
    expect(validatePaymentConfigInput([{ id: name, custom: true }]).join(" ")).toMatch(/reports already use that name/);
  });

  test.each(["Zomato Pay", "zomato-pay", "Dine Out", "Easy Diner", "UPI", "cash", "Razorpay"])(
    "%s would fold into a built-in through the alias table",
    (name) => {
      expect(reservedReason(name)).toMatch(/built-in payment mode/);
      expect(validatePaymentConfigInput([{ id: name, custom: true }]).join(" ")).toMatch(/built-in/);
    },
  );

  test("a LABEL cannot say something the mode is not either", () => {
    expect(validatePaymentConfigInput([{ ...swiggy, label: "Complimentary" }]).join(" ")).toMatch(/non-chargeable/);
    expect(validatePaymentConfigInput([{ id: "Card", label: "Cash" }]).join(" ")).toMatch(/built-in Cash/);
    // A built-in may be labelled with its own alias.
    expect(validatePaymentConfigInput([{ id: "Zomato", label: "Zomato Pay" }])).toEqual([]);
  });

  test("names that merely CONTAIN a reserved word are fine", () => {
    expect(validatePaymentConfigInput([
      { id: "Credit Card (Amex)", custom: true },
      { id: "Cash - USD", custom: true },
      { id: "Paytm & Co", custom: true },
    ])).toEqual([]);
  });

  test("whole words, not letters: a credit CARD is money, and so is anything a reserved word only spells into", () => {
    for (const name of ["Credit Card", "HDFC Credit/Debit Card", "Credit Cards (Visa)", "Company Card", "Compass Pay", "Duet Pay", "NCB Bank", "Focus Wallet", "Staffing Co"]) {
      expect(notMoneyKind(name)).toBeNull();
      expect(validatePaymentConfigInput([{ id: name, custom: true }])).toEqual([]);
    }
    // …but "card" only rescues a "credit" that comes before it.
    expect(notMoneyKind("Card Credit")).toBe("credit");
  });
});

describe("the id is what history is keyed by — immutable, bounded, unique", () => {
  test("charset and length", () => {
    expect(validatePaymentConfigInput([{ id: "Swiggy;Dineout", custom: true }]).join(" ")).toMatch(/characters/);
    expect(validatePaymentConfigInput([{ id: "x".repeat(33), custom: true }]).join(" ")).toMatch(/too long/);
    expect(validatePaymentConfigInput([{ id: "&&", custom: true }]).join(" ")).toMatch(/letter or number/);
    expect(validatePaymentConfigInput([{ id: "HDFC (EDC)/2 - Rupay+", custom: true }])).toEqual([]);
  });

  test("renaming changes the LABEL only; the stored id stays", () => {
    const first = saved([swiggy]);
    const renamed = saved([{ id: "swiggy dineout", label: "Swiggy Dine-Out", custom: true }], first);
    expect(renamed[8]).toMatchObject({ id: "Swiggy Dineout", label: "Swiggy Dine-Out", requires_screenshot: true });
    expect(paymentMethodLabel("Swiggy Dineout", renamed)).toBe("Swiggy Dine-Out");
  });

  test("a built-in can be relabelled without splitting its history", () => {
    const cfg = saved([{ id: "Dineout", label: "Swiggy Dineout" }]);
    expect(cfg.find((m) => m.id === "Dineout")?.label).toBe("Swiggy Dineout");
    expect(resolvePaymentMethod("dine out", cfg)?.id).toBe("Dineout");
    // …and an empty label puts the default back.
    expect(saved([{ id: "Dineout", label: "" }], cfg).find((m) => m.id === "Dineout")?.label).toBe("Dineout");
  });

  test("two entries for one mode, and two modes wearing one label, are refused", () => {
    expect(validatePaymentConfigInput([swiggy, { ...swiggy, id: "swiggy-dineout" }]).join(" ")).toMatch(/twice/);
    expect(validatePaymentConfigInput([swiggy, { id: "Magicpin", label: "Swiggy Dineout", custom: true }]).join(" ")).toMatch(/used by two payment modes/);
  });

  test(`at most ${String(MAX_CUSTOM_PAYMENT_MODES)} custom modes`, () => {
    const many = Array.from({ length: MAX_CUSTOM_PAYMENT_MODES + 1 }, (_, i) => ({ id: `Mode ${String(i + 1)}`, custom: true }));
    expect(validatePaymentConfigInput(many).join(" ")).toMatch(/at most 24/);
    expect(validatePaymentConfigInput(many.slice(0, MAX_CUSTOM_PAYMENT_MODES))).toEqual([]);
  });

  test("a built-in cannot be made custom or online; a custom cannot be online", () => {
    expect(validatePaymentConfigInput([{ id: "Cash", custom: true }]).join(" ")).toMatch(/built-in/);
    expect(validatePaymentConfigInput([{ ...swiggy, online: true }]).join(" ")).toMatch(/online/);
    expect(saved([{ id: "Cash", online: true }]).find((m) => m.id === "Cash")?.online).toBeUndefined();
  });

  test("a non-boolean flag is refused rather than read as the default", () => {
    // "false" as a string would otherwise ENABLE a mode the caller meant to switch off.
    expect(validatePaymentConfigInput([{ ...swiggy, enabled: "false" }]).join(" ")).toMatch(/enabled must be true or false/);
  });

  test("the thrown error carries every sentence", () => {
    const err = new PaymentConfigError(["one.", "two."]);
    expect(err.errors).toEqual(["one.", "two."]);
    expect(err.message).toBe("one. two.");
  });
});

/**
 * EXACTLY what the installed 1.9.7 app's Settings > Payments card posts
 * (git show v1.9.7:lib/screens/modules.dart, _PaymentSettingsCardState): every
 * row GET /restaurant/settings gave it — custom modes INCLUDED — mapped to five
 * keys, `custom` and `show_to_guests` dropped, `online` forced to a boolean.
 */
const v197CardRows = (modes: readonly PaymentMethodConfig[]): Record<string, unknown>[] =>
  modes.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    enabled: m.enabled !== false,
    requires_screenshot: m.requires_screenshot === true,
    online: m.online === true,
  }));

describe("an older client's save must not wipe what a newer one added", () => {
  test("the 1.9.7 card's round trip — customs sent back WITHOUT custom:true — is accepted and keeps them", () => {
    const stored = saved([swiggy, { id: "Magicpin", custom: true }]);
    const oldCard = v197CardRows(mergePaymentConfig(stored));
    expect(oldCard.some((r) => r.id === "Swiggy Dineout" && !("custom" in r))).toBe(true);
    oldCard[2] = { ...oldCard[2], enabled: false }; // the owner switched Cash off on the old screen
    expect(planPaymentConfigSave(oldCard, stored).ok).toBe(true);
    const after = saved(oldCard, stored);
    expect(after.map((m) => m.id)).toEqual([...stored.map((m) => m.id)]);
    expect(after.find((m) => m.id === "Cash")?.enabled).toBe(false);
    // Nothing the old card cannot see is lost: custom stays custom, the guest switch stays.
    expect(after.find((m) => m.id === "Swiggy Dineout")).toEqual(stored.find((m) => m.id === "Swiggy Dineout"));
    expect(after.find((m) => m.id === "Magicpin")).toEqual(stored.find((m) => m.id === "Magicpin"));
  });

  test("…and the old card can switch a custom mode off, which is the only removal there is", () => {
    const stored = saved([swiggy]);
    const oldCard = v197CardRows(mergePaymentConfig(stored)).map((r) => (r.id === "Swiggy Dineout" ? { ...r, enabled: false } : r));
    expect(saved(oldCard, stored).find((m) => m.id === "Swiggy Dineout")).toMatchObject({ enabled: false, custom: true });
  });

  test("a genuinely NEW name still needs custom: true — only a stored mode is spared it", () => {
    const stored = saved([swiggy]);
    expect(validatePaymentConfigInput([{ id: "Magicpin", enabled: true, online: false }], stored).join(" ")).toMatch(/custom: true/);
    expect(validatePaymentConfigInput([{ id: "Swiggy Dineout", online: true }], stored).join(" ")).toMatch(/online/);
  });

  test("a client that sends only the eight built-ins KEEPS the stored custom modes", () => {
    const stored = saved([swiggy, { id: "Magicpin", custom: true }]);
    const builtinsOnly = v197CardRows(mergePaymentConfig(stored).filter((m) => !m.custom));
    expect(saved(builtinsOnly, stored).map((m) => m.id)).toEqual(stored.map((m) => m.id));
  });

  test("removal is enabled:false — the entry stays, so history keeps its label", () => {
    const stored = saved([swiggy]);
    const off = saved([{ id: "Swiggy Dineout", custom: true, enabled: false }], stored);
    expect(off[8]).toMatchObject({ id: "Swiggy Dineout", label: "Swiggy Dineout", enabled: false });
    expect(paymentMethodLabel("Swiggy Dineout", off)).toBe("Swiggy Dineout");
  });

  test("omitted built-ins keep what was stored, not the defaults", () => {
    const stored = saved([{ id: "Zomato", requires_screenshot: false }]);
    expect(saved([swiggy], stored).find((m) => m.id === "Zomato")?.requires_screenshot).toBe(false);
  });
});

describe("a DISABLED mode: refused for a new payment, never strands a paid bill", () => {
  const cfg = saved([{ ...swiggy, enabled: false }, { id: "Card", enabled: false }]);

  test("a new settle or tender in it is refused, naming the label", () => {
    expect(paymentMethodRefusal("Swiggy Dineout", cfg)).toMatch(/Swiggy Dineout is switched off/);
    expect(paymentMethodRefusal("card", cfg)).toMatch(/Card is switched off/);
  });

  test("the settle that mirrors tenders already recorded in it is allowed", () => {
    expect(paymentMethodRefusal("Swiggy Dineout", cfg, { mirrorsLedger: true })).toBeNull();
    expect(paymentMethodRefusal("Card", cfg, { mirrorsLedger: true })).toBeNull();
  });

  test("mirroring does not make an UNKNOWN mode acceptable", () => {
    expect(paymentMethodRefusal("Bitcoin", cfg, { mirrorsLedger: true })).toMatch(/not a payment mode/);
  });
});

describe("undoing a save that ADDED a mode switches it off — it never deletes it", () => {
  const before = mergePaymentConfig(null);
  const after = saved([swiggy, { id: "Zomato", label: "Zomato Pay" }], before);

  test("the prior list comes back, with the added mode kept and off", () => {
    const restored = paymentConfigForUndo(before, after);
    expect(restored.find((m) => m.id === "Zomato")?.label).toBe("Zomato");
    expect(restored.find((m) => m.id === "Swiggy Dineout")).toEqual({ ...after.find((m) => m.id === "Swiggy Dineout"), enabled: false });
  });

  test("so a bill with a tender already in it still settles from its ledger, and no new money is taken in it", () => {
    const restored = paymentConfigForUndo(before, after);
    expect(paymentMethodRefusal("Swiggy Dineout", restored, { mirrorsLedger: true })).toBeNull();
    expect(paymentMethodRefusal("Swiggy Dineout", restored)).toMatch(/switched off/);
    expect(paymentMethodLabel("Swiggy Dineout", restored)).toBe("Swiggy Dineout");
  });

  test("a mode that existed before the save is restored as it was, not switched off", () => {
    const withMode = saved([swiggy]);
    const renamed = saved([{ id: "Swiggy Dineout", custom: true, label: "Swiggy DO" }], withMode);
    expect(paymentConfigForUndo(withMode, renamed).find((m) => m.id === "Swiggy Dineout")).toMatchObject({ label: "Swiggy Dineout", enabled: true });
  });

  test("an undo that adds nothing is exactly the prior list", () => {
    const off = saved([{ id: "Cash", enabled: false }]);
    expect(paymentConfigForUndo(before, off)).toEqual(before);
  });
});

describe("readers pass a custom mode through instead of showing no method", () => {
  test("displayPaymentMethod", () => {
    expect(displayPaymentMethod("upi")).toBe("Upi");
    expect(displayPaymentMethod("  Swiggy Dineout ")).toBe("Swiggy Dineout");
    expect(displayPaymentMethod("")).toBeNull();
    expect(displayPaymentMethod(null)).toBeNull();
  });

  test("paymentMethodLabel falls back to the stored string for anything the config does not know", () => {
    const cfg = mergePaymentConfig(null);
    expect(paymentMethodLabel("Upi", cfg)).toBe("UPI");
    expect(paymentMethodLabel("Other", cfg)).toBe("Other");
    expect(paymentMethodLabel("Unallocated", cfg)).toBe("Unallocated");
    expect(paymentMethodLabel("Split", cfg)).toBe("Split");
    expect(paymentMethodLabel("Legacy Mode", cfg)).toBe("Legacy Mode");
  });
});

describe("the source stays text", () => {
  test("no raw control bytes (a NUL makes grep call the module binary and hide it from the wiring grep)", () => {
    const text = readFileSync(join(__dirname, "..", "payment_methods.ts"), "utf8");
    const raw = [...text].filter((ch) => {
      const c = ch.charCodeAt(0);
      return (c < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") || c === 127;
    });
    expect(raw).toEqual([]);
  });

  test("a label with a control character is still refused", () => {
    expect(validatePaymentConfigInput([{ ...swiggy, label: `Swiggy${String.fromCharCode(7)}Dineout` }]).join(" ")).toMatch(/label must be/);
    expect(validatePaymentConfigInput([{ ...swiggy, label: `Swiggy${String.fromCharCode(127)}Dineout` }]).join(" ")).toMatch(/label must be/);
  });
});

describe("the read path never throws and never lets junk in", () => {
  test("malformed, reserved, duplicate and flagless custom entries are dropped on read", () => {
    const cfg = mergePaymentConfig([
      "nonsense", null, 7,
      { id: "Complimentary", custom: true },
      { id: "Swiggy Dineout", custom: true },
      { id: "swiggy-dineout", custom: true },
      { id: "NoFlag" },
      { id: "Bad;Chars", custom: true },
      { id: "Magicpin", custom: true, online: true },
    ]);
    expect(cfg.filter((m) => m.custom).map((m) => m.id)).toEqual(["Swiggy Dineout", "Magicpin"]);
    expect(cfg.find((m) => m.id === "Magicpin")?.online).toBeUndefined();
  });

  test("a non-array is the defaults", () => {
    expect(mergePaymentConfig({ id: "Cash" })).toEqual(mergePaymentConfig(null));
    expect(mergePaymentConfig("[]")).toEqual(mergePaymentConfig(null));
  });
});
