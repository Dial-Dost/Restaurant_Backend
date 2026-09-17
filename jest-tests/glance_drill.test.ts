// Client item 10 — "Today at a glance": where each element leads.
//
// glance_drill.ts is pure, so the table is tested as data here. What these
// pin, in order of how badly a regression would hurt:
//
//   * a destination the app cannot open is a SILENT no-op in the Flutter shell
//     (it does indexOf(label) and returns on -1), so every module named must be
//     a label the shell registers — copied verbatim below and re-read from the
//     app checkout when it sits beside this one;
//   * a web href carrying a parameter the dashboard does not parse looks like a
//     working filter and is not, so every href is held to GLANCE_WEB_PARAMS —
//     and that list is re-checked against the pages' own parsing;
//   * every windowed jump is the server's day (or month), ALL DAY — a report
//     that remembered "Lunch" would otherwise show a slice — and that includes
//     a fallback: Analytics opened on its remembered 30 days is not "today";
//   * a figure only leads to a screen that shows it: the online figures have no
//     fallback, because only the Sales Summary cuts trade by order type.

import { describe, expect, test } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  GLANCE_APP_MODULES,
  GLANCE_BLOCK_KEYS,
  GLANCE_FIGURE_KEYS,
  GLANCE_REPORTS,
  GLANCE_ROUTES,
  GLANCE_WEB_PARAMS,
  glanceDrill,
  glanceDrills,
  glanceHref,
  glanceParamsFor,
  glanceRowMethod,
  type GlanceTarget,
} from "../glance_drill";

const DAY = { today: "2026-09-17", month_from: "2026-09-01" };

/**
 * The Flutter shell's module labels, VERBATIM from
 * restaurant_owner_app/lib/screens/home_shell.dart. Copied rather than derived
 * so that a rename there turns the staleness test below red.
 */
const FLUTTER_MODULE_LABELS = [
  "Overview", "Concerns", "Orders", "Kitchen", "Tables", "Floor plan", "Waitlist", "Bookings", "Menu",
  "Inventory", "Purchase Orders", "Attendance", "Employees", "Roles", "Valet", "Feedback", "Customers",
  "Analytics", "Simulation", "History", "Reports", "Accounting", "Cash register", "Billing", "Outlets",
  "Printer", "Audit Log", "Settings",
];

/** The MIS report keys, VERBATIM from the app's _misReports and the web's MIS_REPORTS. */
const MIS_REPORT_KEYS = [
  "item_wise", "discount", "void_kot", "bill_edit", "sales_summary", "order_summary", "executive_summary",
  "cover_size_summary", "settlement_summary", "nc_summary", "service_charge_deny", "group_summary",
  "variation_summary", "tip_summary", "counter_summary",
];

const sibling = (repo: string, rel: string): string | null => {
  for (const base of [path.join(process.cwd(), ".."), path.join(__dirname, "..", "..")]) {
    const f = path.join(base, repo, rel);
    if (fs.existsSync(f)) {return fs.readFileSync(f, "utf8");}
  }
  return null;
};

function allTargets(): { key: string; t: GlanceTarget }[] {
  const out: { key: string; t: GlanceTarget }[] = [];
  const keys = Object.keys(GLANCE_ROUTES);
  for (const key of keys) {
    const d = glanceDrill(key, DAY, "Cash");
    out.push({ key, t: d });
    for (const f of d.fallbacks) {out.push({ key: `${key} -> ${f.module}`, t: f });}
    if (d.secondary) {out.push({ key: `${key} (secondary)`, t: d.secondary });}
  }
  return out;
}

describe("every element of the box has a destination", () => {
  test("the six figures and the ten block keys are all in the table, and nothing else", () => {
    expect(new Set(Object.keys(GLANCE_ROUTES))).toEqual(
      new Set<string>([...GLANCE_FIGURE_KEYS, ...GLANCE_BLOCK_KEYS, "by_method_row"]),
    );
  });

  test("the drills block carries every block key and one row drill per mode", () => {
    const block = glanceDrills(DAY, ["Cash", "Upi", "Unallocated"]);
    for (const k of GLANCE_BLOCK_KEYS) {expect(block[k].module).toBeTruthy();}
    expect(Object.keys(block.by_method_rows)).toEqual(["Cash", "Upi", "Unallocated"]);
    expect(glanceDrills(DAY, []).by_method_rows).toEqual({});
  });

  test("an unknown key is a loud error, not a destination made up on the spot", () => {
    expect(() => glanceDrill("covers", DAY)).toThrow(/no glance route/);
  });
});

describe("modules: only labels the app shell registers", () => {
  test("every module a drill can name — primary, fallback, secondary — is a shell label", () => {
    for (const { key, t } of allTargets()) {
      expect({ key, ok: FLUTTER_MODULE_LABELS.includes(t.module) }).toEqual({ key, ok: true });
      expect({ key, ok: t.module in GLANCE_APP_MODULES }).toEqual({ key, ok: true });
    }
  });

  test("STALENESS: the copied label list is still the shell's", () => {
    const shell = sibling("restaurant_owner_app", "lib/screens/home_shell.dart");
    if (shell === null) {
      // A backend-only checkout: the copy above is the contract, stated.
      expect(FLUTTER_MODULE_LABELS.length).toBeGreaterThan(0);
      return;
    }
    const labels = [...shell.matchAll(/_Module\('([^']+)'/g)].map((m) => m[1]);
    expect(new Set(labels)).toEqual(new Set(FLUTTER_MODULE_LABELS));
  });

  test("every report a drill opens is one of the fifteen", () => {
    for (const r of GLANCE_REPORTS) {expect(MIS_REPORT_KEYS).toContain(r);}
    for (const { key, t } of allTargets()) {
      if (t.params.report !== undefined) {expect({ key, ok: MIS_REPORT_KEYS.includes(t.params.report) }).toEqual({ key, ok: true });}
    }
  });
});

describe("hrefs: only parameters the dashboard parses", () => {
  test("every href's query keys are in GLANCE_WEB_PARAMS, and its path is the module's page", () => {
    for (const { key, t } of allTargets()) {
      const url = new URL(t.href, "https://x.invalid");
      for (const k of url.searchParams.keys()) {
        expect({ key, k, ok: (GLANCE_WEB_PARAMS as readonly string[]).includes(k) }).toEqual({ key, k, ok: true });
      }
      expect(url.pathname).toBe(GLANCE_APP_MODULES[t.module]);
      // The params object and the href say the same thing.
      const fromHref = Object.fromEntries(url.searchParams.entries());
      expect(fromHref).toEqual(t.params);
    }
  });

  test("STALENESS: the pages a drill reaches really parse those parameters", () => {
    const reports = sibling("Restaurant_Dashboard_UI", "src/app/dashboard/reports/page.tsx");
    const accounting = sibling("Restaurant_Dashboard_UI", "src/app/dashboard/accounting/page.tsx");
    const history = sibling("Restaurant_Dashboard_UI", "src/app/dashboard/history/page.tsx");
    const analytics = sibling("Restaurant_Dashboard_UI", "src/app/dashboard/analytics/page.tsx");
    const slots = sibling("Restaurant_Dashboard_UI", "src/lib/report-time-slots.ts");
    // A dashboard checkout from before item 10 has no resolver and nothing to
    // pin; the one that ships it must parse every parameter this file emits.
    const resolver = sibling("Restaurant_Dashboard_UI", "src/lib/glance-destinations.ts");
    if (!reports || !accounting || !history || !analytics || !slots || !resolver) {return;}
    expect(reports).toMatch(/params\?\.get\("report"\)/);
    expect(reports).toMatch(/useDateRange\("reports", \{ params \}\)/);
    expect(slots).toMatch(/get\(['"]slot['"]\)/);
    expect(accounting).toMatch(/useDateRange\("accounting", \{ params: search \}\)/);
    expect(accounting).toMatch(/search\??\.get\("method"\)/);
    expect(accounting).toMatch(/id="settled-bills"/);
    expect(history).toMatch(/useDateRange\("history", \{[^}]*params: search/);
    expect(analytics).toMatch(/useDateRange\("analytics", \{ params: search \}\)/);
  });

  test("the query order is fixed, empty values are dropped and a method is encoded", () => {
    expect(glanceHref("Reports", { to: "2026-09-17", report: "sales_summary", slot: "all", from: "2026-09-17" }))
      .toBe("/dashboard/reports?report=sales_summary&from=2026-09-17&to=2026-09-17&slot=all");
    expect(glanceHref("Accounting", { from: "2026-09-17", to: "2026-09-17", method: "Pine Labs & Co" }, true))
      .toBe("/dashboard/accounting?from=2026-09-17&to=2026-09-17&method=Pine+Labs+%26+Co#settled-bills");
    expect(glanceHref("Tables", {})).toBe("/dashboard/tables");
    expect(glanceHref("Reports", { report: "nc_summary", method: "" })).toBe("/dashboard/reports?report=nc_summary");
  });

  test("the bill-list anchor is Accounting's alone", () => {
    expect(glanceHref("Reports", { report: "order_summary" }, true)).toBe("/dashboard/reports?report=order_summary");
    for (const { t } of allTargets()) {
      expect(t.href.includes("#settled-bills")).toBe(t.bills === true);
      if (t.bills) {expect(t.module).toBe("Accounting");}
    }
  });
});

describe("windows: the server's day, all day", () => {
  test("every Reports jump carries from, to and slot=all", () => {
    for (const { key, t } of allTargets()) {
      if (t.module !== "Reports") {continue;}
      expect({ key, slot: t.params.slot, to: t.params.to }).toEqual({ key, slot: "all", to: DAY.today });
      expect(t.params.from === DAY.today || t.params.from === DAY.month_from).toBe(true);
    }
  });

  test("the month jumps start on month_from; everything else on today", () => {
    for (const key of ["month", "month_to_date"]) {
      const d = glanceDrill(key, DAY);
      expect(d.params).toEqual({ report: "sales_summary", from: DAY.month_from, to: DAY.today, slot: "all" });
      expect(d.fallbacks.map((f) => [f.module, f.params])).toEqual([
        ["Accounting", { from: DAY.month_from, to: DAY.today }],
        ["History", { from: DAY.month_from, to: DAY.today }],
        ["Analytics", { from: DAY.month_from, to: DAY.today }],
      ]);
    }
    expect(glanceDrill("today_net", DAY).params.from).toBe(DAY.today);
  });

  test("modules that parse no window are sent none", () => {
    for (const { key, t } of allTargets()) {
      if (["Cash register", "Tables", "Orders", "Settings"].includes(t.module)) {
        expect({ key, params: t.params }).toEqual({ key, params: {} });
      }
    }
  });

  test("every jump from a windowed element carries that window, fallbacks included", () => {
    let analytics = 0;
    for (const [key, route] of Object.entries(GLANCE_ROUTES)) {
      if (route.window === "none") {continue;}
      const d = glanceDrill(key, DAY, "Cash");
      for (const t of [d, ...d.fallbacks]) {
        if (["Cash register", "Tables", "Orders", "Settings"].includes(t.module)) {continue;}
        const from = route.window === "month" ? DAY.month_from : DAY.today;
        expect({ key, module: t.module, from: t.params.from, to: t.params.to }).toEqual({ key, module: t.module, from, to: DAY.today });
        if (t.module === "Analytics") {
          analytics += 1;
          // The window and nothing else: Analytics has no report tab or bill filter.
          expect({ key, params: t.params }).toEqual({ key, params: { from, to: DAY.today } });
          expect(t.href).toBe(`/dashboard/analytics?from=${from}&to=${DAY.today}`);
        }
      }
    }
    // A table that stopped naming Analytics would make the loop above vacuous.
    expect(analytics).toBeGreaterThan(0);
    // A route with no window still sends Analytics none.
    expect(glanceParamsFor("Analytics", { window: "none" }, DAY)).toEqual({});
  });
});

describe("the destinations the investigation settled on", () => {
  const row = (key: string, method?: string) => {
    const d = glanceDrill(key, DAY, method);
    return {
      module: d.module,
      report: d.params.report,
      fallbacks: d.fallbacks.map((f) => f.module),
      secondary: d.secondary?.module,
    };
  };

  test("the money figures open the MIS pack, which computes them the same way", () => {
    for (const k of ["today_net", "today_gross"]) {
      expect(row(k)).toEqual({ module: "Reports", report: "sales_summary", fallbacks: ["Accounting", "Analytics"], secondary: undefined });
    }
    // Online trade is cut by order type on the Sales Summary and nowhere else:
    // Accounting and Analytics would open without the figure, so there is no
    // fallback — the sheet explains the rule on its own.
    for (const k of ["online_net", "online_gross"]) {
      expect(row(k)).toEqual({ module: "Reports", report: "sales_summary", fallbacks: [], secondary: undefined });
    }
    expect(row("month_to_date")).toEqual({ module: "Reports", report: "sales_summary", fallbacks: ["Accounting", "History", "Analytics"], secondary: undefined });
    expect(row("header")).toEqual(row("today_net"));
    expect(row("day")).toEqual(row("today_net"));
  });

  test("cash opens the Settlement Summary, with the drawer as a separate secondary", () => {
    const d = glanceDrill("cash_collection", DAY);
    expect(row("cash_collection")).toEqual({ module: "Reports", report: "settlement_summary", fallbacks: ["Accounting", "Analytics"], secondary: "Cash register" });
    // The Accounting fallback keeps the Cash filter a bare label would have lost.
    expect(d.fallbacks[0]).toEqual({
      module: "Accounting",
      params: { from: DAY.today, to: DAY.today, method: "Cash" },
      href: "/dashboard/accounting?from=2026-09-17&to=2026-09-17&method=Cash#settled-bills",
      bills: true,
    });
    // The Reports primary carries no method: the report takes none.
    expect(d.params.method).toBeUndefined();
    expect(d.secondary).toEqual({ module: "Cash register", params: {}, href: "/dashboard/cash" });
  });

  test("a mode's row: Settlement Summary first, its own bills in Accounting second", () => {
    const d = glanceDrill("by_method_row", DAY, "Upi");
    expect(row("by_method_row", "Upi")).toEqual({ module: "Reports", report: "settlement_summary", fallbacks: ["Accounting", "Analytics"], secondary: "Accounting" });
    expect(d.secondary?.href).toBe("/dashboard/accounting?from=2026-09-17&to=2026-09-17&method=Upi#settled-bills");
    // Unallocated is no stored method: its bills are the Split bills.
    expect(glanceDrill("by_method_row", DAY, "Unallocated").secondary?.params.method).toBe("Split");
    expect(glanceRowMethod(" Unallocated ")).toBe("Split");
    expect(glanceRowMethod("Cash")).toBe("Cash");
  });

  test("the split note and the warning list the Split bills; counts and NC open their reports", () => {
    for (const k of ["split", "unallocated"]) {
      expect(glanceDrill(k, DAY).href).toBe("/dashboard/accounting?from=2026-09-17&to=2026-09-17&method=Split#settled-bills");
      expect(glanceDrill(k, DAY).fallbacks.map((f) => f.href)).toEqual([
        "/dashboard/reports?report=settlement_summary&from=2026-09-17&to=2026-09-17&slot=all",
      ]);
    }
    expect(row("bills")).toEqual({ module: "Reports", report: "order_summary", fallbacks: ["Accounting", "Analytics"], secondary: undefined });
    expect(row("by_method")).toEqual({ module: "Reports", report: "settlement_summary", fallbacks: ["Accounting", "Analytics"], secondary: undefined });
    expect(row("nc")).toEqual({ module: "Reports", report: "nc_summary", fallbacks: [], secondary: undefined });
  });

  test("the zone chip is Settings (admin-only in both shells) and the empty day is the floor", () => {
    expect(glanceDrill("zone", DAY)).toEqual({ module: "Settings", params: {}, href: "/dashboard/settings", fallbacks: [] });
    const empty = glanceDrill("nothing_settled", DAY);
    expect([empty.module, ...empty.fallbacks.map((f) => f.module)]).toEqual(["Tables", "Orders"]);
  });

  test("glanceParamsFor ignores a row method no row was given", () => {
    expect(glanceParamsFor("Accounting", GLANCE_ROUTES.by_method_row, DAY)).toEqual({ from: DAY.today, to: DAY.today });
  });
});
