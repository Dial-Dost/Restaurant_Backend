/**
 * THE PAYMENT MODES A RESTAURANT SETTLES WITH — one source of truth.
 *
 * PURE module: no database, no clock, no network. Same discipline as
 * billing_math.ts / mis_capture.ts, and for the same reason: every rule below is
 * decided by value, so jest proves it without a pg pool.
 *
 * WHY THIS EXISTS. The set of payment modes used to be COMPILED IN, three times
 * over: an alias table (normalizePaymentMethod) that every writer and every
 * reader ran the method through, a hard-coded set of modes that must carry a
 * screenshot, and a "merge" of the stored config that kept only the eight
 * built-in ids. So the owner's settings could switch a built-in on or off for
 * the guest QR page and could do nothing else: a new mode sent by the app was
 * dropped by the merge with a 200, and a bill settled with one was refused by
 * the alias table. The storage never was the obstacle — Bills.payment_method,
 * BillTenders.method and SettlementBatches.method are free text, and migration
 * 037 anticipated a tenant adding a mode "without a migration". This module is
 * what lets the CONFIG decide instead.
 *
 * THE SHAPE, stored in "Restaurant".payment_config and backward compatible with
 * every row already there:
 *   * Built-ins keep their ids (Upi, Cash, Card, Dineout, Zomato, Eazydiner,
 *     District, Razorpay). Their label, enabled, requires_screenshot and
 *     show_to_guests are the owner's to change; their id and `online` are not.
 *   * A CUSTOM mode carries `custom: true`. Its id is taken from the name the
 *     owner typed and is IMMUTABLE, because the id is the string that lands in
 *     Bills.payment_method and the string every report groups by. Renaming
 *     changes only the label, so a year of "Swiggy Dineout" takings does not
 *     split in two the day someone fixes a typo.
 *   * Nothing is ever hard-deleted through settings. Removing a mode is
 *     `enabled: false`: the entry stays, so the bills settled with it keep their
 *     label, and a save from an older client that has never heard of the mode
 *     cannot wipe it (see planPaymentConfigSave).
 *
 * WHAT A MODE MAY NOT BE CALLED — and this is money, not tidiness:
 *   * A built-in id or alias. "Zomato Pay" would silently fold into Zomato
 *     through the alias table the moment it was settled.
 *   * A report bucket: Split, Other, Unallocated. `lower(payment_method) =
 *     'split'` is how the sales report, the settlement allocation and the drawer
 *     cut find a split bill's parts; "Other" and "Unallocated" are the rows the
 *     cash-up sheet uses for money with no mode and money a split failed to
 *     account for.
 *   * Something that is NOT MONEY COLLECTED. "Complimentary" settled as a paid
 *     mode books the whole grand total as gross sales, takings, GST output and
 *     APC revenue for a meal nobody paid for — the non-chargeable flow
 *     (migration 034) exists for exactly that. "Credit" / "On account" / "Due"
 *     close a bill as collected while no money has arrived, and there is no
 *     receivables ledger behind them.
 *
 * CUSTOM MODES ARE NOT CASH. The drawer, the headline "Cash collection" and the
 * cash-up compare the stored string to 'cash' literally, and no custom id can
 * ever equal it (it is reserved). A "Cash - USD" is therefore non-cash; the
 * editors say so.
 */

// ============================================================================
// THE BUILT-INS
// ============================================================================

/** The eight built-in ids plus 'Split', the mirror's word for "N tenders". */
export type BuiltinPaymentMethod =
  | "Upi"       // 1
  | "Cash"      // 2
  | "Card"      // 3
  | "Dineout"   // 4 (screenshot)
  | "Zomato"    // 5 (screenshot)
  | "Eazydiner" // 6 (screenshot)
  | "District"  // 7 (screenshot)
  | "Razorpay"  // online (auto-verified)
  | "Split";    // split tender — real modes live in Bills.payment_splits

/**
 * A stored payment method: a built-in, 'Split', or a custom mode's id. The
 * `(string & {})` keeps editor completion for the built-ins without pretending
 * a custom id is one of them.
 */
export type SettleMethod = BuiltinPaymentMethod | (string & {});

export interface PaymentMethodConfig {
  id: string;
  label: string;
  enabled: boolean;
  requires_screenshot: boolean;
  /** Settled through a gateway (Razorpay). Built-in only; a custom mode never is. */
  online?: boolean;
  /** True for a mode the owner added. Its id is immutable. */
  custom?: boolean;
  /** Offered on the guest QR page. Built-ins default on (today's behaviour), customs off. */
  show_to_guests?: boolean;
}

// Default payment methods. Razorpay (online) on by default; alternate methods
// 4–7 require a screenshot by default. Restaurants override via settings.
export const DEFAULT_PAYMENT_METHODS: readonly PaymentMethodConfig[] = [
  { id: "Razorpay", label: "Pay online (Razorpay)", enabled: true, requires_screenshot: false, online: true, custom: false, show_to_guests: true },
  { id: "Upi", label: "UPI", enabled: true, requires_screenshot: false, custom: false, show_to_guests: true },
  { id: "Cash", label: "Cash", enabled: true, requires_screenshot: false, custom: false, show_to_guests: true },
  { id: "Card", label: "Card", enabled: true, requires_screenshot: false, custom: false, show_to_guests: true },
  { id: "Dineout", label: "Dineout", enabled: true, requires_screenshot: true, custom: false, show_to_guests: true },
  { id: "Zomato", label: "Zomato", enabled: true, requires_screenshot: true, custom: false, show_to_guests: true },
  { id: "Eazydiner", label: "EasyDiner", enabled: true, requires_screenshot: true, custom: false, show_to_guests: true },
  { id: "District", label: "District", enabled: true, requires_screenshot: true, custom: false, show_to_guests: true },
];

/**
 * The alias table, UNCHANGED from the function it replaces. Built-in aliases
 * always win over a custom mode, which is safe only because no custom id may
 * collide with any of these (see reservedReason).
 */
const BUILTIN_ALIASES: Readonly<Record<string, BuiltinPaymentMethod>> = {
  "upi": "Upi",
  "cash": "Cash",
  "card": "Card",
  "dineout": "Dineout",
  "dine out": "Dineout",
  "zomato": "Zomato",
  "zomato pay": "Zomato",
  "zomatopay": "Zomato",
  "eazydiner": "Eazydiner",
  "easydiner": "Eazydiner",
  "easy diner": "Eazydiner",
  "district": "District",
  "razorpay": "Razorpay",
  "split": "Split",
};

/**
 * The built-in canonical id for a raw method string, or null. Exactly the old
 * normalizePaymentMethod: trimmed, lower-cased, looked up.
 */
export function normalizeBuiltinPaymentMethod(raw: unknown): BuiltinPaymentMethod | null {
  const n = String(raw ?? "").trim().toLowerCase();
  if (!n) {return null;}
  return BUILTIN_ALIASES[n] ?? null;
}

/**
 * What a reader shows for a stored method: the built-in canonical form when it
 * is one, otherwise the stored string itself. A custom mode's bills therefore
 * read back as their id instead of as no method at all — which is what every
 * reader did while the alias table was the only way in.
 */
export function displayPaymentMethod(raw: unknown): SettleMethod | null {
  const builtin = normalizeBuiltinPaymentMethod(raw);
  if (builtin) {return builtin;}
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

// ============================================================================
// NAMES
// ============================================================================

/** How long a custom mode's id may be — it is stored on every bill it settles. */
export const PAYMENT_MODE_ID_MAX = 32;
/** How long a label may be — it is a pill at a till, not a sentence. */
export const PAYMENT_MODE_LABEL_MAX = 40;
/** How many custom modes one restaurant may add. */
export const MAX_CUSTOM_PAYMENT_MODES = 24;

/**
 * The characters a custom id may carry: letters, digits, space and the handful
 * of marks real mode names use ("Swiggy Dineout", "HDFC (EDC)", "Amex/Diners",
 * "Pine Labs - 2", "Paytm & Co", "Rupay+"). Nothing that could be a delimiter
 * in a CSV export, a quote in a Tally voucher or a control character.
 */
const ID_CHARSET = /^[A-Za-z0-9 &+.\-/()']+$/;

/** Collapse whitespace and trim — the spelling a name is stored in. */
export function tidyPaymentName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The comparison key two names collide on: lower-cased, punctuation and spaces
 * removed. "Zomato-Pay", "zomato pay" and "ZomatoPay" are one key, so none of
 * them can slip past the alias check by spelling.
 */
export function paymentNameKey(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Names that would book free food as revenue. The editors point at NC instead. */
const NOT_MONEY_COMP = ["complimentary", "comp", "comps", "nc", "foc", "non chargeable", "nonchargeable", "staff meal", "staff meals"];
/** Names that would close a bill as collected while no money has arrived. */
const NOT_MONEY_CREDIT = ["credit", "on account", "due", "pay later", "paylater"];
/** The cash-up sheet's own rows. */
const REPORT_BUCKETS = ["split", "other", "unallocated"];

const COMP_KEYS = new Set(NOT_MONEY_COMP.map(paymentNameKey));
const CREDIT_KEYS = new Set(NOT_MONEY_CREDIT.map(paymentNameKey));
const BUCKET_KEYS = new Set(REPORT_BUCKETS.map(paymentNameKey));
const BUILTIN_KEYS = new Map<string, BuiltinPaymentMethod>(
  Object.entries(BUILTIN_ALIASES).map(([alias, id]) => [paymentNameKey(alias), id]),
);

/** A name's words, lower-cased: "Staff-Meals (FOC)" is staff, meals, foc. */
function paymentNameWords(raw: unknown): string[] {
  return String(raw ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whether `phrase` (one or more words) sits anywhere in `words` as whole words. */
function hasPhraseAt(words: readonly string[], phrase: readonly string[], i: number): boolean {
  return phrase.every((w, j) => words[i + j] === w);
}

/**
 * Whether a name says it is NOT MONEY COLLECTED — "comp" (free food booked as
 * sales and tax) or "credit" (a bill closed as paid with nothing received) — or
 * null.
 *
 * WHOLE WORDS, ANYWHERE IN THE NAME. Matching the whole name only let "Staff
 * Meals", "Complimentary Meal", "FOC", "On Credit", "Due Payment", "Credit/Due"
 * and "Non Chargeable Bill" through, and every one of them books the same free
 * or unpaid bill as takings. Whole words rather than substrings, so "Company
 * Card" is not a comp and "Duet Pay" is not a due. The whole-name key is still
 * checked too, which is what catches "N/C" and "Non-Chargeable".
 *
 * ONE REAL PAYMENT NAME CARRIES A RESERVED WORD: a credit CARD is money the
 * acquirer pays out, so "credit" with "card" after it ("Credit Card", "HDFC
 * Credit/Debit Card") is not the on-account meaning.
 *
 * Mirrored word for word in the dashboard's src/lib/payment-methods.ts and the
 * app's lib/models/payment_modes.dart, so the editors refuse what the save will.
 */
export function notMoneyKind(name: string): "comp" | "credit" | null {
  const key = paymentNameKey(name);
  if (COMP_KEYS.has(key)) {return "comp";}
  if (CREDIT_KEYS.has(key)) {return "credit";}
  const words = paymentNameWords(name);
  for (let i = 0; i < words.length; i++) {
    if (NOT_MONEY_COMP.some((p) => hasPhraseAt(words, paymentNameWords(p), i))) {return "comp";}
  }
  for (let i = 0; i < words.length; i++) {
    for (const p of NOT_MONEY_CREDIT) {
      if (!hasPhraseAt(words, paymentNameWords(p), i)) {continue;}
      if (p === "credit" && words.slice(i + 1).some((w) => w === "card" || w === "cards")) {continue;}
      return "credit";
    }
  }
  return null;
}

/**
 * Why a name cannot be a custom payment mode's id, or null when it can. The
 * sentence is shown to the owner verbatim, so it says what to do instead.
 */
export function reservedReason(name: string): string | null {
  const key = paymentNameKey(name);
  const notMoney = notMoneyKind(name);
  if (notMoney === "comp") {
    return `"${name}" can't be a payment mode: a free meal is not money collected, and settling it as paid books it as sales and tax. Use "Mark as non-chargeable" on the bill instead.`;
  }
  if (notMoney === "credit") {
    return `"${name}" can't be a payment mode: it would close the bill as paid while no money has arrived.`;
  }
  if (BUCKET_KEYS.has(key)) {
    return `"${name}" can't be a payment mode: reports already use that name for their own rows.`;
  }
  const builtin = BUILTIN_KEYS.get(key);
  if (builtin) {
    return `"${name}" is already a built-in payment mode (${builtin}). Rename or switch on the built-in one instead of adding a copy.`;
  }
  return null;
}

// ============================================================================
// READING THE STORED CONFIG — lenient, never throws
// ============================================================================

const BUILTIN_BY_KEY = new Map<string, PaymentMethodConfig>(
  DEFAULT_PAYMENT_METHODS.map((d) => [paymentNameKey(d.id), d]),
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A usable label, or null. */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") {return null;}
  const s = tidyPaymentName(raw);
  if (!s || s.length > PAYMENT_MODE_LABEL_MAX) {return null;}
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) {return null;}
  return s;
}

/** A usable custom id, or null. Charset, length, at least one letter or digit, not reserved. */
function cleanCustomId(raw: unknown): string | null {
  if (typeof raw !== "string") {return null;}
  const s = tidyPaymentName(raw);
  if (!s || s.length > PAYMENT_MODE_ID_MAX || !ID_CHARSET.test(s) || !paymentNameKey(s)) {return null;}
  if (reservedReason(s)) {return null;}
  return s;
}

const boolOr = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/**
 * The effective config: the eight built-ins in their fixed order with the
 * owner's overrides, then the owner's custom modes in the order they were added.
 *
 * LENIENT BY DESIGN — it runs on every settle and every settings read, so it
 * never throws. A malformed or reserved custom entry is dropped (its bills still
 * display their stored string), a duplicate keeps its first spelling, a built-in
 * can never become online or custom, and a custom can never become online.
 *
 * A NULL config — eight of nine tenants in production — is exactly the defaults,
 * which is what makes this change invisible to a restaurant that never opens the
 * editor.
 */
export function mergePaymentConfig(stored: unknown): PaymentMethodConfig[] {
  const list = Array.isArray(stored) ? stored.filter(isRecord) : [];
  const builtinOverride = new Map<string, Record<string, unknown>>();
  const customs: PaymentMethodConfig[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    const key = paymentNameKey(m.id);
    if (!key) {continue;}
    if (BUILTIN_BY_KEY.has(key)) {
      if (!builtinOverride.has(key)) {builtinOverride.set(key, m);}
      continue;
    }
    if (m.custom !== true || seen.has(key) || customs.length >= MAX_CUSTOM_PAYMENT_MODES) {continue;}
    const id = cleanCustomId(m.id);
    if (!id) {continue;}
    seen.add(key);
    customs.push({
      id,
      label: cleanLabel(m.label) ?? id,
      enabled: boolOr(m.enabled, true),
      requires_screenshot: boolOr(m.requires_screenshot, false),
      custom: true,
      show_to_guests: boolOr(m.show_to_guests, false),
    });
  }
  const builtins = DEFAULT_PAYMENT_METHODS.map((def): PaymentMethodConfig => {
    const ov = builtinOverride.get(paymentNameKey(def.id));
    return {
      ...def,
      label: (ov && cleanLabel(ov.label)) ?? def.label,
      enabled: boolOr(ov?.enabled, def.enabled),
      requires_screenshot: boolOr(ov?.requires_screenshot, def.requires_screenshot),
      show_to_guests: boolOr(ov?.show_to_guests, def.show_to_guests ?? true),
    };
  });
  return [...builtins, ...customs];
}

// ============================================================================
// SAVING — strict, refuses out loud
// ============================================================================

/** Thrown by the data layer so the route can answer 400 with the sentences. */
export class PaymentConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "PaymentConfigError";
    this.errors = errors;
  }
}

export type PaymentConfigPlan =
  | { ok: true; config: PaymentMethodConfig[] }
  | { ok: false; errors: string[] };

/**
 * Validate a save and work out what gets stored.
 *
 * MERGE, NOT REPLACE. `incoming` is what one client sent; `stored` is what the
 * restaurant already has.
 *   * A built-in keeps, field by field: what this save sent, else what was
 *     stored, else the default.
 *   * A stored custom mode that this save OMITS IS KEPT, unchanged. A client
 *     written before custom modes existed may send only the eight built-ins;
 *     without this, its first "Save payments & currency" would erase every mode
 *     the owner added on a newer screen. Removal is explicit: `enabled: false`.
 *   * An entry whose name matches (by paymentNameKey) a stored custom mode is an
 *     UPDATE of that mode — with or without `custom: true`, because an older
 *     card round-trips the rows it was given without that flag — and the stored
 *     id is kept, because the id is immutable. Only a genuinely new name needs
 *     `custom: true`, and it is appended.
 *
 * REFUSED, each with a sentence the editors show verbatim: an entry with no id;
 * an unknown id sent without `custom: true` (a typo of a built-in must not
 * quietly become a new mode); a custom id that is too long, has characters
 * outside the charset or is reserved; `custom: true` or `online: true` where it
 * cannot apply; a non-boolean flag; a bad label; two entries for one mode; two
 * modes showing the same label; more than MAX_CUSTOM_PAYMENT_MODES customs.
 */
export function planPaymentConfigSave(incoming: unknown, stored: unknown): PaymentConfigPlan {
  const errors: string[] = [];
  if (!Array.isArray(incoming)) {
    return { ok: false, errors: ["payment_methods must be a list of payment modes."] };
  }
  const base = mergePaymentConfig(stored);
  const byKey = new Map<string, PaymentMethodConfig>(base.map((m) => [paymentNameKey(m.id), { ...m }]));
  const order: string[] = base.map((m) => paymentNameKey(m.id));
  const sentKeys = new Set<string>();

  incoming.forEach((entry, i) => {
    const where = `Payment mode ${String(i + 1)}`;
    if (!isRecord(entry)) {
      errors.push(`${where} is not a payment mode.`);
      return;
    }
    const rawId = typeof entry.id === "string" ? tidyPaymentName(entry.id) : "";
    if (!rawId) {
      errors.push(`${where} has no name.`);
      return;
    }
    const key = paymentNameKey(rawId);
    if (!key) {
      errors.push(`"${rawId}" needs at least one letter or number.`);
      return;
    }
    if (sentKeys.has(key)) {
      errors.push(`"${rawId}" appears twice in this save.`);
      return;
    }
    sentKeys.add(key);

    for (const flag of ["enabled", "requires_screenshot", "show_to_guests"] as const) {
      if (entry[flag] !== undefined && entry[flag] !== null && typeof entry[flag] !== "boolean") {
        errors.push(`"${rawId}": ${flag} must be true or false.`);
      }
    }
    let label: string | null = null;
    if (entry.label !== undefined && entry.label !== null && !(typeof entry.label === "string" && entry.label.trim() === "")) {
      label = cleanLabel(entry.label);
      if (!label) {
        errors.push(`"${rawId}": the label must be 1-${String(PAYMENT_MODE_LABEL_MAX)} characters.`);
      }
    }

    const builtin = BUILTIN_BY_KEY.get(key);
    const existing = byKey.get(key);
    if (builtin) {
      if (entry.custom === true) {
        errors.push(`"${rawId}" is a built-in payment mode and can't be added as a custom one.`);
        return;
      }
      const cur = existing ?? { ...builtin };
      byKey.set(key, {
        ...cur,
        label: label ?? (typeof entry.label === "string" && entry.label.trim() === "" ? builtin.label : cur.label),
        enabled: boolOr(entry.enabled, cur.enabled),
        requires_screenshot: boolOr(entry.requires_screenshot, cur.requires_screenshot),
        show_to_guests: boolOr(entry.show_to_guests, cur.show_to_guests ?? true),
      });
      return;
    }

    if (entry.online === true) {
      errors.push(`"${rawId}" can't be an online payment mode: only the built-in gateway settles online.`);
      return;
    }
    if (existing) {
      // An update of a mode the restaurant already has. Id immutable.
      //
      // Decided BEFORE the `custom: true` rule, and whatever `custom` says. The
      // installed 1.9.7 app's Settings card maps every row it is given to
      // {id, label, enabled, requires_screenshot, online: false} — `custom`
      // dropped — and posts the whole list back with the currency. Refusing that
      // as "not a mode this restaurant has" locked a 1.9.7 owner out of Settings >
      // Payments, currency included, the day a newer screen added a mode.
      byKey.set(key, {
        ...existing,
        label: label ?? (typeof entry.label === "string" && entry.label.trim() === "" ? existing.id : existing.label),
        enabled: boolOr(entry.enabled, existing.enabled),
        requires_screenshot: boolOr(entry.requires_screenshot, existing.requires_screenshot),
        show_to_guests: boolOr(entry.show_to_guests, existing.show_to_guests ?? false),
      });
      return;
    }
    if (entry.custom !== true) {
      errors.push(`"${rawId}" is not a payment mode this restaurant has. To add a new one, send it with custom: true.`);
      return;
    }
    const reserved = reservedReason(rawId);
    if (reserved) {
      errors.push(reserved);
      return;
    }
    if (rawId.length > PAYMENT_MODE_ID_MAX) {
      errors.push(`"${rawId}" is too long — a payment mode name can be at most ${String(PAYMENT_MODE_ID_MAX)} characters.`);
      return;
    }
    if (!ID_CHARSET.test(rawId)) {
      errors.push(`"${rawId}" has characters a payment mode name can't use. Letters, numbers, spaces and & + . - / ( ) ' are allowed.`);
      return;
    }
    byKey.set(key, {
      id: rawId,
      label: label ?? rawId,
      enabled: boolOr(entry.enabled, true),
      requires_screenshot: boolOr(entry.requires_screenshot, false),
      custom: true,
      show_to_guests: boolOr(entry.show_to_guests, false),
    });
    order.push(key);
  });

  const config = order.map((k) => byKey.get(k)).filter((m): m is PaymentMethodConfig => Boolean(m));
  const customCount = config.filter((m) => m.custom === true).length;
  if (customCount > MAX_CUSTOM_PAYMENT_MODES) {
    errors.push(`A restaurant can have at most ${String(MAX_CUSTOM_PAYMENT_MODES)} payment modes of its own. Switch off one you no longer use and rename it instead of adding another.`);
  }

  // LABELS. A label is what a cashier taps, so it may not say something the
  // mode is not: a comp or credit name, a report bucket, or another mode's
  // name. Two pills reading the same word is a coin toss at a till.
  const labelOwner = new Map<string, string>();
  for (const m of config) {
    const lk = paymentNameKey(m.label);
    const notMoney = notMoneyKind(m.label);
    if (notMoney || BUCKET_KEYS.has(lk)) {
      errors.push(`"${m.label}" can't be used as a label: ${notMoney === "comp" ? "a free meal is not money collected — use \"Mark as non-chargeable\" on the bill instead" : notMoney === "credit" ? "it would close the bill as paid while no money has arrived" : "reports already use that name for their own rows"}.`);
      continue;
    }
    const aliasOf = BUILTIN_KEYS.get(lk);
    if (aliasOf && paymentNameKey(aliasOf) !== paymentNameKey(m.id)) {
      errors.push(`"${m.label}" can't label ${m.id}: that is the name of the built-in ${aliasOf} mode.`);
      continue;
    }
    const other = labelOwner.get(lk);
    if (other && other !== m.id) {
      errors.push(`"${m.label}" is used by two payment modes (${other} and ${m.id}). Give each a different label.`);
      continue;
    }
    labelOwner.set(lk, m.id);
    const idClash = config.find((o) => o.id !== m.id && paymentNameKey(o.id) === lk);
    if (idClash) {
      errors.push(`"${m.label}" can't label ${m.id}: another payment mode is called ${idClash.id}.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config };
}

/**
 * What UNDOING a payment-modes save writes back: the list as it was before the
 * save, EXCEPT that a custom mode the undone save added — stored now, absent
 * before — stays, switched off.
 *
 * Restoring the prior list whole deleted that mode outright, which is the one
 * thing Settings may never do (removal is `enabled: false`), and it did real
 * damage: a bill with a tender already recorded in the mode could no longer
 * settle, because the settle that mirrors its ledger resolves the method against
 * the config and a mode that no longer exists resolves to nothing. Switched off,
 * the mode takes no new money (paymentMethodRefusal) while that bill still closes
 * (mirrorsLedger), and every bill settled with it keeps its label.
 */
export function paymentConfigForUndo(prior: unknown, current: unknown): PaymentMethodConfig[] {
  const restored = mergePaymentConfig(prior);
  const have = new Set(restored.map((m) => paymentNameKey(m.id)));
  for (const m of mergePaymentConfig(current)) {
    const key = paymentNameKey(m.id);
    if (m.custom !== true || have.has(key)) {continue;}
    restored.push({ ...m, enabled: false });
    have.add(key);
  }
  return restored;
}

/** Just the refusals of planPaymentConfigSave — empty when the save is valid. */
export function validatePaymentConfigInput(incoming: unknown, stored: unknown = null): string[] {
  const plan = planPaymentConfigSave(incoming, stored);
  return plan.ok ? [] : plan.errors;
}

// ============================================================================
// SETTLING — what the writers ask
// ============================================================================

export interface ResolvedPaymentMethod {
  /** The string to store: a built-in canonical id, 'Split', or the custom mode's own id. */
  id: SettleMethod;
  /** The config entry, or null for 'Split' (which is not a mode anyone pays with). */
  entry: PaymentMethodConfig | null;
}

/**
 * Resolve a method a client sent against the restaurant's config.
 *
 * Built-in aliases FIRST, unchanged ('dine out' is still Dineout). Otherwise a
 * CUSTOM mode matched by paymentNameKey, answering with the stored id — so a
 * client that sends "swiggy dineout" settles as "Swiggy Dineout" and the reports
 * see one mode, not two. Otherwise null: not a mode this restaurant settles with.
 *
 * Whether the mode is ENABLED is deliberately the caller's question, not this
 * one's: a new settle must refuse a disabled mode, while a settle mirroring a
 * tender ledger recorded before the owner disabled it must not (see
 * paymentMethodRefusal).
 */
export function resolvePaymentMethod(raw: unknown, config: readonly PaymentMethodConfig[]): ResolvedPaymentMethod | null {
  const builtin = normalizeBuiltinPaymentMethod(raw);
  if (builtin) {
    if (builtin === "Split") {return { id: "Split", entry: null };}
    const entry = config.find((m) => m.custom !== true && paymentNameKey(m.id) === paymentNameKey(builtin));
    return { id: builtin, entry: entry ?? DEFAULT_PAYMENT_METHODS.find((d) => d.id === builtin) ?? null };
  }
  const key = paymentNameKey(raw);
  if (!key) {return null;}
  const custom = config.find((m) => m.custom === true && paymentNameKey(m.id) === key);
  return custom ? { id: custom.id, entry: custom } : null;
}

/** The label to show for a stored method: the config's, else the string itself. */
export function paymentMethodLabel(method: string | null | undefined, config: readonly PaymentMethodConfig[]): string {
  const s = String(method ?? "").trim();
  if (!s) {return "";}
  const resolved = resolvePaymentMethod(s, config);
  return resolved?.entry?.label ?? s;
}

/** Built-ins whose screenshot rule applies when a restaurant has no config at all. */
const DEFAULT_PROOF_METHODS: ReadonlySet<string> = new Set(
  DEFAULT_PAYMENT_METHODS.filter((d) => d.requires_screenshot).map((d) => d.id),
);

/**
 * Whether settling with this method needs a payment screenshot. The config's
 * `requires_screenshot` — which mergePaymentConfig fills from the defaults for a
 * tenant with no config, so a NULL config demands a screenshot for exactly
 * Dineout, Zomato, EasyDiner and District, as it always has.
 */
export function methodRequiresProof(method: string | null | undefined, config: readonly PaymentMethodConfig[]): boolean {
  const resolved = resolvePaymentMethod(method, config);
  if (!resolved) {return false;}
  if (resolved.entry) {return resolved.entry.requires_screenshot === true;}
  return DEFAULT_PROOF_METHODS.has(resolved.id);
}

/**
 * The labels of the parts of a split that need a payment screenshot, each once,
 * in the order they were sent — empty when none does.
 *
 * A split is stored as the method 'Split', which is no mode and needs no
 * screenshot of its own; the rule lives on its parts. Asking only about 'Split'
 * let a bill take Zomato money with no proof just by being split (Cash 1 +
 * Zomato 999), which is exactly the owner's "Require payment screenshot" switch
 * skipped.
 */
export function splitPartsNeedingProof(
  parts: readonly { method: string }[],
  config: readonly PaymentMethodConfig[],
): string[] {
  const labels: string[] = [];
  for (const p of parts) {
    if (!methodRequiresProof(p.method, config)) {continue;}
    const label = paymentMethodLabel(p.method, config);
    if (!labels.includes(label)) {labels.push(label);}
  }
  return labels;
}

/**
 * Why a method cannot be used for a settle, or null when it can.
 *
 * `mirrorsLedger` is true ONLY when the method being written came from tenders
 * already recorded on the bill. A mode the owner switches off after a guest has
 * paid part of a bill with it must not strand that bill open: the money is
 * already in, so the settle that closes it is allowed. A NEW payment in a
 * disabled mode is refused.
 */
export function paymentMethodRefusal(
  raw: unknown,
  config: readonly PaymentMethodConfig[],
  opts: { mirrorsLedger?: boolean } = {},
): string | null {
  const resolved = resolvePaymentMethod(raw, config);
  if (!resolved) {
    const shown = String(raw ?? "").trim();
    return shown
      ? `"${shown}" is not a payment mode this restaurant settles with.`
      : "A payment method is required.";
  }
  if (resolved.entry && resolved.entry.enabled === false && opts.mirrorsLedger !== true) {
    return `${resolved.entry.label} is switched off in Settings > Payments. Choose another payment mode, or switch it back on.`;
  }
  return null;
}
