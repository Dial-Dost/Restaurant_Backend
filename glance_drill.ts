// TODAY AT A GLANCE — WHERE EVERY ELEMENT OF THE HEADLINE BOX LEADS.
//
// Client item 10: "The entire 'Today at a glance' section needs to be made
// clickable; each option in it must be clickable."
//
// Each element of the box opens an explanation both clients build from the
// payload they already hold, footed by a "View in <Module>" jump; a pure count
// jumps straight there. This file is the one answer to "where", shipped on
// GET /analytics/headline as `drill` on each figure and as the `drills` block
// for everything else. Pure: no database, no request, no clock.
//
// WHY THE SERVER NAMES THE DESTINATION. The same reason needs_attention carries
// a deep_link (AttentionDeepLink): the place that computes a number is the place
// that knows which screen computes it the same way. Both clients mirror this
// table as their fallback for an older backend, and a staleness test on each
// side pins the copy to this file.
//
// WHY REPORTS, AND NOT ACCOUNTING, IS THE PRIMARY DESTINATION. Every figure in
// the box is computed by the MIS readers' own functions — composeMisBills and
// misLadder for net, gross and month to date; settlementByMethod for cash and
// the modes; misNcTotals for NC; misSettledPredicate for the bill count — so the
// report a jump lands on shows the SAME number, and
// test/money/headline_drill_agreement.test.ts proves it. Accounting's "By
// payment method" is /reports/sales by_method, which has no Unallocated row and
// takes no refunds off, and its bill list filters on the stored payment_method
// exactly, so a split bill's cash part is not under Cash there. Accounting is
// therefore the SECONDARY jump, for the bill list, and a fallback.
//
// EVERY JUMP IS PINNED TO THE SERVER'S DAY, ALL DAY. `from`/`to` are the
// restaurant's own day keys (never the device's), and `slot` is always 'all':
// a Reports screen that remembered "Lunch" would otherwise show a slice that
// cannot equal the tile the owner tapped.
//
// PERMISSIONS ARE UNCHANGED. A drill only NAMES a destination. The route that
// ships it keeps its own gate, every destination route keeps its own, and each
// client drops a destination the signed-in user cannot open (the nav's own
// rule) and tries the next fallback — the sheet still opens, so a gated jump is
// never a dead tap.

/** How a jump's window is cut. */
export type GlanceWindow = "day" | "month" | "none";

/**
 * The query a jump carries. ONLY the parameters the web dashboard actually
 * parses may appear (GLANCE_WEB_PARAMS): an invented one would look like a
 * working filter and be silently ignored — the AttentionDeepLink rule.
 */
export interface GlanceParams {
  report?: string;
  from?: string;
  to?: string;
  slot?: "all";
  method?: string;
}

/** One destination, fully resolved: the AttentionDeepLink shape. */
export interface GlanceTarget {
  /**
   * App module label. Must be one the Flutter shell registers verbatim, or the
   * tap is a silent no-op there (GLANCE_APP_MODULES; pinned by test).
   */
  module: string;
  params: GlanceParams;
  /** Web path, query and (for the bill list) anchor included. */
  href: string;
  /** True when the destination should scroll to its settled-bill list. */
  bills?: true;
}

/**
 * What one element leads to: its destination, the ones to try in order when
 * that module is not open to this user, and — where the element has one — a
 * second destination with a different question behind it.
 *
 * The fallbacks are RESOLVED here, params and all, rather than named: the Cash
 * collection tile falls back to Accounting's bill list filtered to Cash, and a
 * bare "Accounting" would have lost the filter on the way.
 */
export interface GlanceDrill extends GlanceTarget {
  fallbacks: GlanceTarget[];
  secondary?: GlanceTarget;
}

/** The query parameters the web dashboard parses on the pages drills reach. */
export const GLANCE_WEB_PARAMS = ["report", "from", "to", "slot", "method"] as const;

/**
 * Every module a drill may name, spelled as the Flutter shell registers it
 * (restaurant_owner_app/lib/screens/home_shell.dart), with the web page it maps
 * to. The two clients carry the same map.
 */
export const GLANCE_APP_MODULES: Readonly<Record<string, string>> = {
  Reports: "/dashboard/reports",
  Accounting: "/dashboard/accounting",
  "Cash register": "/dashboard/cash",
  Analytics: "/dashboard/analytics",
  History: "/dashboard/history",
  Tables: "/dashboard/tables",
  Orders: "/dashboard/orders",
  Settings: "/dashboard/settings",
};

/** The MIS report keys a drill may open. The report pack's own keys. */
export const GLANCE_REPORTS = ["sales_summary", "order_summary", "settlement_summary", "nc_summary"] as const;

/** One row of the table: a destination, before it is given a day. */
export interface GlanceRoute {
  module: string;
  /** The report the Reports module opens on — for the primary or a fallback. */
  report?: (typeof GLANCE_REPORTS)[number];
  window: GlanceWindow;
  /** Accounting's bill-list filter. "row" = the tapped mode's own filter. */
  method?: string;
  bills?: true;
  fallbacks: string[];
  secondary?: Omit<GlanceRoute, "fallbacks" | "secondary">;
}

/**
 * THE TABLE. Keys are the payload's own: a figure's key for its `drill`, and
 * the `drills` block's key for everything else. Both clients mirror it.
 *
 *   header          "Today at a glance" and its "Today's report" button
 *   bills           "N bill(s) settled" — a count, so a direct jump
 *   day, zone       the day and zone chips — "how today is cut"; the zone chip
 *                   leads to Settings, which only an admin can open
 *   month           the "month from" chip — the month to date sheet
 *   by_method       the COLLECTED BY PAYMENT METHOD label — a direct jump
 *   by_method_row   one mode's row; its secondary is Accounting's bill list
 *                   filtered to that mode (Unallocated -> Split)
 *   split           "N bill(s) paid across more than one method"
 *   unallocated     the amber warning line
 *   nc              the NC line beside the block
 *   nothing_settled the empty-day sentence — the floor, where the open bills are
 */
export const GLANCE_ROUTES: Readonly<Record<string, GlanceRoute>> = {
  header: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  bills: { module: "Reports", report: "order_summary", window: "day", bills: true, fallbacks: ["Accounting", "Analytics"] },
  day: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  zone: { module: "Settings", window: "none", fallbacks: [] },
  month: { module: "Reports", report: "sales_summary", window: "month", fallbacks: ["Accounting", "History", "Analytics"] },
  today_net: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  today_gross: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  online_net: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  online_gross: { module: "Reports", report: "sales_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  cash_collection: {
    module: "Reports", report: "settlement_summary", window: "day", method: "Cash", bills: true,
    fallbacks: ["Accounting", "Analytics"],
    // The drawer. A DIFFERENT window (the cash session) with a different rule,
    // which both clients label as such — never as the same figure.
    secondary: { module: "Cash register", window: "none" },
  },
  month_to_date: { module: "Reports", report: "sales_summary", window: "month", fallbacks: ["Accounting", "History", "Analytics"] },
  by_method: { module: "Reports", report: "settlement_summary", window: "day", fallbacks: ["Accounting", "Analytics"] },
  by_method_row: {
    module: "Reports", report: "settlement_summary", window: "day", method: "row", bills: true,
    fallbacks: ["Accounting", "Analytics"],
    secondary: { module: "Accounting", window: "day", method: "row", bills: true },
  },
  split: { module: "Accounting", report: "settlement_summary", window: "day", method: "Split", bills: true, fallbacks: ["Reports"] },
  unallocated: { module: "Accounting", report: "settlement_summary", window: "day", method: "Split", bills: true, fallbacks: ["Reports"] },
  nc: { module: "Reports", report: "nc_summary", window: "day", fallbacks: [] },
  nothing_settled: { module: "Tables", window: "none", fallbacks: ["Orders"] },
};

/** The six figures, which carry their drill on themselves. */
export const GLANCE_FIGURE_KEYS = [
  "today_net", "today_gross", "online_net", "online_gross", "cash_collection", "month_to_date",
] as const;

/** Everything else, which rides in the `drills` block. by_method_row is per mode. */
export const GLANCE_BLOCK_KEYS = [
  "header", "bills", "day", "zone", "month", "by_method", "split", "unallocated", "nc", "nothing_settled",
] as const;

/**
 * The Accounting filter a mode's row lands on. Unallocated is not a stored
 * payment_method — it is the residual of a 'Split' bill whose parts do not add
 * up — so its bills are the Split bills.
 */
export function glanceRowMethod(method: string): string {
  return method.trim() === "Unallocated" ? "Split" : method.trim();
}

/**
 * The params a module takes, for a window. The ONE rule both clients copy, so a
 * fallback lands on the same day as the primary would have.
 *
 *   Reports     report + the window + slot=all
 *   Accounting  the window (+ method)
 *   History     the window
 *   anything else takes nothing: Analytics, Cash register, Tables, Orders and
 *   Settings parse no window, and an unread key is a filter that is not there.
 */
export function glanceParamsFor(
  module: string,
  route: Pick<GlanceRoute, "report" | "window" | "method">,
  day: { today: string; month_from: string },
  rowMethod?: string,
): GlanceParams {
  const from = route.window === "month" ? day.month_from : day.today;
  const to = day.today;
  const windowed = route.window !== "none";
  const method = route.method === "row" ? (rowMethod ? glanceRowMethod(rowMethod) : undefined) : route.method;
  switch (module) {
    case "Reports":
      return windowed
        ? { report: route.report ?? "sales_summary", from, to, slot: "all" }
        : { report: route.report ?? "sales_summary" };
    case "Accounting":
      return { ...(windowed ? { from, to } : {}), ...(method ? { method } : {}) };
    case "History":
      return windowed ? { from, to } : {};
    default:
      return {};
  }
}

/** The web path for a module and its params. Query order is fixed. */
export function glanceHref(module: string, params: GlanceParams, bills = false): string {
  const base = GLANCE_APP_MODULES[module] ?? "/dashboard";
  const q = new URLSearchParams();
  for (const k of GLANCE_WEB_PARAMS) {
    const v = params[k];
    if (typeof v === "string" && v !== "") {q.set(k, v);}
  }
  const qs = q.toString();
  const anchor = bills && module === "Accounting" ? "#settled-bills" : "";
  return `${base}${qs ? `?${qs}` : ""}${anchor}`;
}

function targetOf(
  module: string,
  route: Pick<GlanceRoute, "report" | "window" | "method" | "bills">,
  day: { today: string; month_from: string },
  rowMethod?: string,
): GlanceTarget {
  const params = glanceParamsFor(module, route, day, rowMethod);
  // Only a bill list is scrolled to, and only Accounting has one a jump reaches.
  const bills = route.bills === true && module === "Accounting";
  return {
    module,
    params,
    href: glanceHref(module, params, bills),
    ...(bills ? { bills: true as const } : {}),
  };
}

/** The drill for one key of the table, cut on the server's day. */
export function glanceDrill(
  key: string,
  day: { today: string; month_from: string },
  rowMethod?: string,
): GlanceDrill {
  const route = GLANCE_ROUTES[key];
  if (!route) {throw new Error(`no glance route for "${key}"`);}
  return {
    ...targetOf(route.module, route, day, rowMethod),
    fallbacks: route.fallbacks.map((m) => targetOf(m, route, day, rowMethod)),
    ...(route.secondary ? { secondary: targetOf(route.secondary.module, route.secondary, day, rowMethod) } : {}),
  };
}

/** The `drills` block: every non-figure key, plus one row drill per mode shown. */
export interface GlanceDrills {
  header: GlanceDrill;
  bills: GlanceDrill;
  day: GlanceDrill;
  zone: GlanceDrill;
  month: GlanceDrill;
  by_method: GlanceDrill;
  split: GlanceDrill;
  unallocated: GlanceDrill;
  nc: GlanceDrill;
  nothing_settled: GlanceDrill;
  /** Keyed by the row's stored method id, exactly as today_by_method carries it. */
  by_method_rows: Record<string, GlanceDrill>;
}

export function glanceDrills(day: { today: string; month_from: string }, methods: readonly string[]): GlanceDrills {
  const block = Object.fromEntries(GLANCE_BLOCK_KEYS.map((k) => [k, glanceDrill(k, day)])) as Omit<GlanceDrills, "by_method_rows">;
  const rows: Record<string, GlanceDrill> = {};
  for (const m of methods) {rows[m] = glanceDrill("by_method_row", day, m);}
  return { ...block, by_method_rows: rows };
}
