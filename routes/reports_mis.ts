/**
 * MIS / CONTROL REPORTS — the HTTP surface for the fifteen documents an owner or
 * an auditor reads (Insights → Reports).
 *
 * READ-ONLY, ALL OF IT, with ONE exception: PUT /reports/mis/time-slots saves
 * the restaurant's time-slot presets (migration 049) — configuration, never
 * money. No report writes a row, and nothing touches the idempotency outbox.
 *
 * MOUNTED UNDER /reports/ ON PURPOSE, exactly as the scheduled-report routes
 * reasoned: FEATURE_BY_PREFIX already maps that prefix to the "accounting" plan
 * feature, so a tenant whose plan has it off gets a 403 here with no new gating
 * code, and the permission is the SAME ACCOUNTING_PERM that guards every other
 * /reports/* route. Minting a new gate id would have stripped the whole section
 * from every custom role that can already read the accounting reports.
 *
 * THE EXISTING /reports/* ROUTES ARE UNTOUCHED. sales, sales.csv, gst, gst.csv,
 * pnl, balance-sheet, discounts, deliveries, schedules and tally.xml keep their
 * paths, their payloads and their numbers; everything here lives under the
 * /reports/mis/ prefix and absorbs none of them. The literal `.csv` paths are
 * registered before nothing that could shadow them — there is no `:param` at the
 * /reports/mis/ level at all — and the route manifest gate proves it stays that
 * way.
 *
 * THE LAST SIX READ THE CAPTURE TABLES of migrations 034-039 (NC Summary,
 * Service Charge Deny, Group Summary, Variation Summary, Tip Summary, Counter
 * Summary). They are registered exactly like the first nine — same gate, same
 * shell, same `.csv` twin, same misHandler — because a report that needed its
 * own permission, its own query shape or its own exporter would be a second way
 * to read this system's money. A tenant that has not yet run one of those
 * migrations gets an EMPTY report with its own dates on it rather than a 500:
 * the readers degrade through captureRead, and an owner reads a failed request
 * as lost data.
 *
 * THE SHARED SHELL, on the wire:
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive tenant-calendar days (or ?days=N)
 *   X-Outlet-Id / ?outletId          one outlet, or the "all" sentinel for the
 *                                    admin/manager ALL-OUTLETS aggregate read
 *   ?search=                         Bill No. / KOT (order id) / table / mode
 *   ?limit= &offset=                 the row-level reports
 *   ?bucket=day|hour|hour_of_day|session   the Sales Summary's time-wise cut
 *   ?slot=<preset id> | ?time_from=HH:mm&time_to=HH:mm
 *                                    the part of each day (report_window.ts);
 *                                    custom wins, all day when absent
 *   ?day_close=HH:mm                 TRADING days that close at that minute
 *                                    instead of calendar days (client item 9 —
 *                                    what a daily report email reads); refused,
 *                                    named, alongside a slot
 * Every payload carries `meta` (the window the SERVER used, with any clamp
 * NAMED), `columns` (which drives the client's column picker AND its totals row)
 * and `totals`. Add `.csv` to any of the nine for the same table as a sheet.
 */
import type { Express, Request, Response } from "express";
import {
	Audit_log_category,
	GetBillEditReport,
	GetClosedBill,
	GetCounterSummaryReport,
	GetCoverSizeSummaryReport,
	GetDiscountReport,
	GetExecutiveSummaryReport,
	GetGroupSummaryReport,
	GetItemWiseReport,
	GetMisOrderDetail,
	GetNcSummaryReport,
	GetOrderSummaryReport,
	GetReportTimeSlots,
	GetSalesSummaryReport,
	GetServiceChargeDenyReport,
	GetSettlementSummaryReport,
	GetTipSummaryReport,
	GetVariationSummaryReport,
	GetVoidKotReport,
	SetReportTimeSlots,
	type MisColumn,
	type MisReportQuery,
	type MisReportMeta,
} from "../database_supabase.js";
import { logger } from "../observability.js";
import { renderMisCsv } from "../report_render.js";
import { TIME_BUCKET_MODES, TimeSlotConfigError, parseDayClose, timeSlotFileSuffix, timeSlotPresetWire, tradingDayFileSuffix, type TimeSlotPreset } from "../report_window.js";
import { ACCOUNTING_PERM, PERM_SETTINGS, callerHasPermission, extractRestaurantId, log_audit, validateAction } from "./_shared.js";


/**
 * The window/outlet/search/paging query, read off the request and passed down
 * RAW.
 *
 * It deliberately does not parse or clamp the dates: only the data layer knows
 * the tenant's zone, and "2026-08-01" is a different pair of instants in
 * Asia/Kolkata than it is on this server. windowQuery() in _shared.ts makes the
 * same argument for the accounting routes; this is that helper plus the four
 * fields the MIS shell adds.
 */
function misQuery(req: Request): MisReportQuery {
	return {
		from: req.query.from,
		to: req.query.to,
		days: req.query.days,
		search: req.query.search,
		limit: req.query.limit,
		offset: req.query.offset,
		bucket: req.query.bucket,
		// The time slot, raw like the dates: only the data layer has the presets
		// and the zone that give "lunch" and "12:00" a meaning.
		slot: req.query.slot,
		time_from: req.query.time_from,
		time_to: req.query.time_to,
		// The trading day's close, raw like the rest: misContext resolves it.
		day_close: req.query.day_close,
	};
}

/**
 * Filename an export downloads as: report, outlet scope, window — and the time
 * slot, ONLY when one was applied, so an all-day sheet keeps the name it always
 * had. The suffix rule is timeSlotFileSuffix's, which the clients mirror.
 */
function misFilename(meta: MisReportMeta): string {
	const scope = meta.outlet_scope === "all" ? "all-outlets" : (meta.outlet_name ?? "outlet").replace(/[^A-Za-z0-9._-]+/g, "-");
	// A trading-day sheet says so in its name, so it never overwrites the
	// calendar one (the suffix an emailed CSV carries, report_bundle.ts).
	const close = meta.window.day_close ? tradingDayFileSuffix(parseDayClose(meta.window.day_close)) : "";
	return `${meta.report}_${scope}_${meta.window.from}_to_${meta.window.to}${timeSlotFileSuffix(meta.time_slot)}${close}.csv`;
}

/** The catalogue's report keys, in tab order. Every one of them honours the time slot. */
const MIS_REPORT_KEYS = [
	"item_wise", "discount", "void_kot", "bill_edit", "sales_summary", "order_summary",
	"executive_summary", "cover_size_summary", "settlement_summary", "nc_summary",
	"service_charge_deny", "group_summary", "variation_summary", "tip_summary", "counter_summary",
] as const;

/** GET and PUT /reports/mis/time-slots answer the same shape. */
function timeSlotsBody(slots: readonly TimeSlotPreset[], isDefault: boolean, canEdit: boolean) {
	return { slots: slots.map(timeSlotPresetWire), can_edit: canEdit, is_default: isDefault };
}

function sendMisCsv(res: Response, meta: MisReportMeta, columns: readonly MisColumn[], rows: readonly object[], totals: object | null): void {
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.setHeader("Content-Disposition", `attachment; filename="${misFilename(meta)}"`);
	res.send(renderMisCsv(columns, rows, totals));
}

/**
 * One handler shape for all fifteen, twice over (JSON and CSV).
 *
 * `rowsOf` says which array of the payload is the TABLE — the series for the
 * Sales Summary, the outlet breakdown for the Executive Summary, `rows` for the
 * other thirteen — so the sheet always matches the grid on screen.
 *
 * An EMPTY WINDOW IS A 200 WITH AN EMPTY REPORT, never a 500 and never a 404: a
 * restaurant that was closed all week must see zeros with its own date range on
 * them, because a failed request reads to an owner as lost data. Only a genuine
 * fault (an unreachable database, an unknown tenant) reaches the 500 below, and
 * it logs the real error server-side while returning a generic message.
 */
function misHandler<T extends { meta: MisReportMeta; columns: MisColumn[]; totals?: object }>(
	label: string,
	load: (restaurantId: string, q: MisReportQuery) => Promise<T>,
	rowsOf: (payload: T) => readonly object[],
	asCsv: boolean,
) {
	return async (req: Request, res: Response): Promise<void> => {
		const restaurantId = extractRestaurantId(req);
		if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
		try {
			const payload = await load(restaurantId, misQuery(req));
			if (asCsv) {
				sendMisCsv(res, payload.meta, payload.columns, rowsOf(payload), payload.totals ?? null);
				return;
			}
			res.json(payload);
		} catch (e) {
			logger.error({ err: e }, `mis_${label}_failed`);
			res.status(500).json({ error: `Unable to build the ${label.replace(/_/g, " ")} report` });
		}
	};
}


export function registerMisReportRoutes(app: Express): void {

// The catalogue. One place the Reports workspace reads to build its tab strip
// and its column pickers, so adding a report does not need a client release.
// It lists ONLY the reports that exist: an empty tab for a report whose data
// this system does not capture would be a promise the numbers cannot keep. The
// last six earned their place when migrations 034-039 started recording what
// they describe.
app.get("/reports/mis", validateAction(ACCOUNTING_PERM), (_req: Request, res: Response) => {
	res.json({
		reports: [
			{ key: "item_wise", title: "Item Wise", path: "/reports/mis/item-wise", rows: "rows", paged: true },
			{ key: "discount", title: "Discount", path: "/reports/mis/discount", rows: "rows", paged: true },
			{ key: "void_kot", title: "Void KOT", path: "/reports/mis/void-kot", rows: "rows", paged: true },
			{ key: "bill_edit", title: "Bill Edit", path: "/reports/mis/bill-edit", rows: "rows", paged: true },
			{ key: "sales_summary", title: "Sales Summary", path: "/reports/mis/sales-summary", rows: "series", paged: false },
			{ key: "order_summary", title: "Order Summary", path: "/reports/mis/order-summary", rows: "rows", paged: true },
			{ key: "executive_summary", title: "Executive Summary", path: "/reports/mis/executive-summary", rows: "by_outlet", paged: false },
			{ key: "cover_size_summary", title: "Cover Size Summary", path: "/reports/mis/cover-size-summary", rows: "rows", paged: false },
			{ key: "settlement_summary", title: "Settlement Summary", path: "/reports/mis/settlement-summary", rows: "rows", paged: false },
			{ key: "nc_summary", title: "NC Summary", path: "/reports/mis/nc-summary", rows: "rows", paged: true },
			{ key: "service_charge_deny", title: "Service Charge Deny", path: "/reports/mis/service-charge-deny", rows: "rows", paged: true },
			{ key: "group_summary", title: "Group Summary", path: "/reports/mis/group-summary", rows: "rows", paged: false },
			{ key: "variation_summary", title: "Variation Summary", path: "/reports/mis/variation-summary", rows: "rows", paged: false },
			{ key: "tip_summary", title: "Tip Summary", path: "/reports/mis/tip-summary", rows: "rows", paged: true },
			{ key: "counter_summary", title: "Counter Summary", path: "/reports/mis/counter-summary", rows: "rows", paged: false },
		],
		// The shell every one of them speaks, so a client can build the toolbar
		// generically instead of nine times.
		shell: {
			window: ["from", "to", "days"],
			outlet: { header: "X-Outlet-Id", query: "outletId", all_sentinel: "all" },
			search: "search",
			paging: ["limit", "offset"],
			time_wise: { param: "bucket", values: [...TIME_BUCKET_MODES], applies_to: ["sales_summary"] },
			// The part of each day. EVERY report takes it, each on its own clock
			// (see `basis`); the presets live at presets_path.
			time_slot: { params: ["slot", "time_from", "time_to"], presets_path: "/reports/mis/time-slots", applies_to: [...MIS_REPORT_KEYS] },
			// A TRADING DAY: the window's days close at this minute instead of at
			// midnight. Every report takes it; never together with a slot.
			trading_day: { param: "day_close", applies_to: [...MIS_REPORT_KEYS], excludes: ["slot", "time_from", "time_to"] },
			csv_suffix: ".csv",
			// Which clock each report buckets on, so a client can label the toolbar
			// honestly instead of implying that every tab answers the same question
			// about the same days. The payload's own `notes` say it in words.
			basis: {
				settlement: [
					"sales_summary", "order_summary", "executive_summary",
					"cover_size_summary", "settlement_summary", "counter_summary", "discount",
				],
				order_placement: ["item_wise", "group_summary", "variation_summary", "void_kot"],
				act_time: ["nc_summary", "service_charge_deny", "tip_summary", "bill_edit"],
			},
			drill_down: { bill: "/reports/mis/bill/:id", kot: "/reports/mis/kot/:id" },
		},
	});
});

// --- The fifteen ------------------------------------------------------------
// Each is registered JSON-first then .csv. Both literals, so registration order
// between them cannot shadow either one, and every one of them sits ABOVE the
// two `:id` drill-downs at the bottom of this file.

app.get("/reports/mis/item-wise", validateAction(ACCOUNTING_PERM), misHandler("item_wise", GetItemWiseReport, (p) => p.rows, false));
app.get("/reports/mis/item-wise.csv", validateAction(ACCOUNTING_PERM), misHandler("item_wise", GetItemWiseReport, (p) => p.rows, true));

app.get("/reports/mis/discount", validateAction(ACCOUNTING_PERM), misHandler("discount", GetDiscountReport, (p) => p.rows, false));
app.get("/reports/mis/discount.csv", validateAction(ACCOUNTING_PERM), misHandler("discount", GetDiscountReport, (p) => p.rows, true));

app.get("/reports/mis/void-kot", validateAction(ACCOUNTING_PERM), misHandler("void_kot", GetVoidKotReport, (p) => p.rows, false));
app.get("/reports/mis/void-kot.csv", validateAction(ACCOUNTING_PERM), misHandler("void_kot", GetVoidKotReport, (p) => p.rows, true));

app.get("/reports/mis/bill-edit", validateAction(ACCOUNTING_PERM), misHandler("bill_edit", GetBillEditReport, (p) => p.rows, false));
app.get("/reports/mis/bill-edit.csv", validateAction(ACCOUNTING_PERM), misHandler("bill_edit", GetBillEditReport, (p) => p.rows, true));

// The Sales Summary's table IS its time-wise series (?bucket=day|hour), so that
// is what the sheet carries; the window totals ride the TOTALS row.
app.get("/reports/mis/sales-summary", validateAction(ACCOUNTING_PERM), misHandler("sales_summary", GetSalesSummaryReport, (p) => p.series, false));
app.get("/reports/mis/sales-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("sales_summary", GetSalesSummaryReport, (p) => p.series, true));

app.get("/reports/mis/order-summary", validateAction(ACCOUNTING_PERM), misHandler("order_summary", GetOrderSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/order-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("order_summary", GetOrderSummaryReport, (p) => p.rows, true));

// Leadership rollup: the table is the per-outlet breakdown, and the TOTALS row
// is the group. In single-outlet scope it is one row, which is the honest shape.
app.get("/reports/mis/executive-summary", validateAction(ACCOUNTING_PERM), misHandler("executive_summary", GetExecutiveSummaryReport, (p) => p.by_outlet, false));
app.get("/reports/mis/executive-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("executive_summary", GetExecutiveSummaryReport, (p) => p.by_outlet, true));

app.get("/reports/mis/cover-size-summary", validateAction(ACCOUNTING_PERM), misHandler("cover_size_summary", GetCoverSizeSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/cover-size-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("cover_size_summary", GetCoverSizeSummaryReport, (p) => p.rows, true));

app.get("/reports/mis/settlement-summary", validateAction(ACCOUNTING_PERM), misHandler("settlement_summary", GetSettlementSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/settlement-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("settlement_summary", GetSettlementSummaryReport, (p) => p.rows, true));

// The six that read migrations 034-039. Same gate, same shell, same exporter.

app.get("/reports/mis/nc-summary", validateAction(ACCOUNTING_PERM), misHandler("nc_summary", GetNcSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/nc-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("nc_summary", GetNcSummaryReport, (p) => p.rows, true));

app.get("/reports/mis/service-charge-deny", validateAction(ACCOUNTING_PERM), misHandler("service_charge_deny", GetServiceChargeDenyReport, (p) => p.rows, false));
app.get("/reports/mis/service-charge-deny.csv", validateAction(ACCOUNTING_PERM), misHandler("service_charge_deny", GetServiceChargeDenyReport, (p) => p.rows, true));

app.get("/reports/mis/group-summary", validateAction(ACCOUNTING_PERM), misHandler("group_summary", GetGroupSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/group-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("group_summary", GetGroupSummaryReport, (p) => p.rows, true));

app.get("/reports/mis/variation-summary", validateAction(ACCOUNTING_PERM), misHandler("variation_summary", GetVariationSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/variation-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("variation_summary", GetVariationSummaryReport, (p) => p.rows, true));

app.get("/reports/mis/tip-summary", validateAction(ACCOUNTING_PERM), misHandler("tip_summary", GetTipSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/tip-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("tip_summary", GetTipSummaryReport, (p) => p.rows, true));

app.get("/reports/mis/counter-summary", validateAction(ACCOUNTING_PERM), misHandler("counter_summary", GetCounterSummaryReport, (p) => p.rows, false));
app.get("/reports/mis/counter-summary.csv", validateAction(ACCOUNTING_PERM), misHandler("counter_summary", GetCounterSummaryReport, (p) => p.rows, true));

// --- Time slots -------------------------------------------------------------
//
// The presets behind ?slot=. READING them is a view concern — they reveal no
// data, and anyone who can open a report can already pick custom times — so the
// read is on ACCOUNTING_PERM, with `can_edit` telling the toolbar whether to
// offer "Manage". CHANGING them changes what "Lunch" means for everyone in the
// restaurant, so the write is PERM_SETTINGS, which the owner always holds.
// Both are literals under /reports/mis/ with no `:param` sibling, and sit above
// the drill-downs like the fifteen.

app.get("/reports/mis/time-slots", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	try {
		const { slots, is_default } = await GetReportTimeSlots(restaurantId);
		res.json(timeSlotsBody(slots, is_default, callerHasPermission(req, PERM_SETTINGS)));
	} catch (e) {
		logger.error({ err: e }, "mis_time_slots_read_failed");
		res.status(500).json({ error: "Unable to load the report time slots" });
	}
});

// REPLACES the whole list; an empty list is "back to the defaults". A refusal is
// the owner's to fix, so it is a 400 with one plain sentence and nothing written.
// Audited with the list it replaced (read in the same transaction as the write).
app.put("/reports/mis/time-slots", validateAction(PERM_SETTINGS), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const body = (req.body ?? {}) as { slots?: unknown };
	try {
		const { before, after } = await SetReportTimeSlots(restaurantId, body.slots);
		try {
			await log_audit(req, "60d14e9c-45cc-4dc2-b017-56058cc3ae33",
				after.is_default
					? "Reset report time slots to the defaults"
					: `Updated report time slots: ${after.slots.map((s) => `${s.label} ${s.start}-${s.end}`).join(", ")}`,
				Audit_log_category.General,
				{ report_time_slots: { before: before.is_default ? null : before.slots, after: after.is_default ? null : after.slots } });
		} catch (err) { logger.warn({ err }, "log_audit report time slots failed"); }
		res.json(timeSlotsBody(after.slots, after.is_default, callerHasPermission(req, PERM_SETTINGS)));
	} catch (err) {
		if (err instanceof TimeSlotConfigError) {
			res.status(400).json({ error: "Invalid time slots", details: err.message });
			return;
		}
		logger.error({ err }, "mis_time_slots_save_failed");
		res.status(500).json({ error: "Unable to save the report time slots" });
	}
});

// --- Drill-down -------------------------------------------------------------

// The FULL BILL behind a row. Deliberately the same reader the History screen
// and the bill-detail screen use, so a drill-down can never show a different
// bill from the one the rest of the product shows.
app.get("/reports/mis/bill/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing bill id" }); return; }
	try {
		const bill = await GetClosedBill(restaurantId, id);
		// 404 rather than 403 for a bill of ANOTHER tenant: the read is already
		// scoped by res_id, so it simply finds nothing, and saying "not found" is
		// also the answer that leaks the least.
		if (!bill) { res.status(404).json({ error: "No such bill" }); return; }
		res.json(bill);
	} catch (e) {
		logger.error({ err: e }, "mis_bill_drilldown_failed");
		res.status(500).json({ error: "Unable to open this bill" });
	}
});

// The FULL KOT (order) behind a row — for Void KOT, and for a Bill Edit row that
// names an order rather than a bill. Carries the order's own audit trail, which
// is what a void or an edit is actually being read for.
app.get("/reports/mis/kot/:id", validateAction(ACCOUNTING_PERM), async (req: Request, res: Response) => {
	const restaurantId = extractRestaurantId(req);
	if (!restaurantId) { res.status(400).json({ error: "Missing restaurantId" }); return; }
	const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
	if (!id) { res.status(400).json({ error: "Missing order id" }); return; }
	try {
		const order = await GetMisOrderDetail(restaurantId, id);
		if (!order) { res.status(404).json({ error: "No such order" }); return; }
		res.json(order);
	} catch (e) {
		logger.error({ err: e }, "mis_kot_drilldown_failed");
		res.status(500).json({ error: "Unable to open this ticket" });
	}
});
}
