// CSV rendering. report_render.ts imports nothing at runtime (its three payload
// imports are type-only), so this suite loads it directly — no pg mock, no
// fixture, no database_supabase.ts graph.
//
// The case that matters is TRUNCATION. The marker row is appended to a file the
// owner opens in a spreadsheet, so it has to be a well-formed record of THIS
// report's width: a fixed six-field `TRUNCATED,,,,,` is exactly the corrupt final
// record that the line-boundary cut above it exists to prevent, in every report
// that is not the six-field sales export.

import { describe, test, expect } from "@jest/globals";
import { renderReport, renderSalesCsv } from "../report_render";
import type { SalesReport, GstReport, ProfitAndLoss } from "../database_supabase";

const META = { periodFrom: "2026-08-01", periodTo: "2026-08-10" };

const salesReport = (days: number): SalesReport => ({
  from: "2026-08-01",
  to: "2026-08-10",
  total_sales: 100,
  total_tax: 5,
  total_service_charge: 7,
  total_refund: 2,
  total_refunded_tax: 0.1,
  net_sales: 98,
  bill_count: days,
  by_day: Array.from({ length: days }, (_, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    sales: 100, tax: 5, service_charge: 7, refund: 2, bills: 3,
  })),
  by_method: [],
});

const gstReport = (rates: number): GstReport => ({
  from: "2026-08-01",
  to: "2026-08-10",
  total_taxable: 1000,
  total_tax: 50,
  total_service_charge: 7,
  by_rate: Array.from({ length: rates }, (_, i) => ({
    name: `CGST bracket ${String(i)}`, percentage: 2.5, taxable: 1000, tax: 25,
  })),
});

const pnlReport = (categories: number): ProfitAndLoss => ({
  from: "2026-08-01",
  to: "2026-08-10",
  gross_sales: 1000,
  refunds: 10,
  tax_collected: 50,
  service_charge: 7,
  net_revenue: 940,
  total_expenses: 400,
  net_profit: 540,
  expenses_by_category: Array.from({ length: categories }, (_, i) => ({
    category: `Category number ${String(i)}`, amount: 10,
  })),
});

/** Field count honouring toCsv's quoting — the same rule the renderer applies. */
function fieldCount(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { fields += 1; }
  }
  return fields;
}

describe("renderSalesCsv", () => {
  test("keeps the Total row the interactive export already emitted, and adds Service Charge", () => {
    const csv = renderSalesCsv(salesReport(2));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Date,Bills,Sales,Tax,Service Charge,Refunds");
    expect(lines[1]).toBe("2026-08-01,3,100,5,7,2");
    expect(lines[lines.length - 1]).toBe("Total,2,100,5,7,2");
  });
});

describe("renderReport truncation", () => {
  const cases: { key: "sales" | "gst" | "pnl"; payload: SalesReport | GstReport | ProfitAndLoss; fields: number }[] = [
    { key: "sales", payload: salesReport(200), fields: 6 },
    { key: "gst", payload: gstReport(200), fields: 4 },
    { key: "pnl", payload: pnlReport(200), fields: 2 },
  ];

  for (const c of cases) {
    test(`the ${c.key} marker row is ${String(c.fields)} fields wide, like the rest of the file`, () => {
      const art = renderReport(c.key, "csv", c.payload, META, 1024);
      expect(art.truncated).toBe(true);

      const lines = art.body.split("\n").filter((l) => l !== "");
      const marker = lines[lines.length - 1];
      expect(marker).toMatch(/^TRUNCATED - full report was \d+ bytes/);
      // A ragged final record is the whole defect: every line, marker included,
      // has to carry this report's own column count.
      expect(fieldCount(marker)).toBe(c.fields);
      expect(new Set(lines.map(fieldCount))).toEqual(new Set([c.fields]));
    });
  }

  test("the pre-truncation size is recorded, and it is the size the marker names", () => {
    const art = renderReport("sales", "csv", salesReport(200), META, 1024);
    const full = renderReport("sales", "csv", salesReport(200), META, 10_000_000);

    expect(art.bytes).toBeLessThan(art.bytes_before_truncation);
    // artifact_bytes stores `bytes` — the POST-cut size — so this is the only
    // record of how much was dropped.
    expect(art.bytes_before_truncation).toBe(full.bytes);
    expect(art.body).toContain(`full report was ${String(full.bytes)} bytes`);
  });

  test("a report inside the cap is untouched and reports one size twice", () => {
    const art = renderReport("pnl", "csv", pnlReport(3), META, 524_288);
    expect(art.truncated).toBe(false);
    expect(art.body).not.toContain("TRUNCATED");
    expect(art.bytes_before_truncation).toBe(art.bytes);
    expect(art.filename).toBe("pnl_2026-08-01_to_2026-08-10.csv");
  });
});
