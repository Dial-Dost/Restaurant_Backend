/**
 * WHAT DID THE PAPER SAY? — the fingerprint of a printed bill (migration 055,
 * client items 1 and 2).
 *
 * ============================================================================
 * WHAT WAS ASKED
 * ============================================================================
 * "If a bill is printed on a table (not settled), there should still be an
 * option to add more items onto the existing bill." Gaia Global Vegetarian
 * settles at night: on 2026-09-14 eleven of seventeen bills were closed between
 * 22:26 and 23:03 by one admin, and a bill printed at 13:32 on 09-16 was settled
 * at 17:33. A printed table is a pending bill for hours, and the same guests
 * order a dessert.
 *
 * ============================================================================
 * WHY THE LEDGER HAS TO REMEMBER THE PAPER
 * ============================================================================
 * C3 lets a waiter print a seating's bill once. The rule counted prints and
 * nothing else, so it could not tell a pointless second copy (the thing C3
 * exists to stop — Jim was refused twice on 09-14, each time in the same minute
 * as his first print) from the one reprint that has to happen: the paper in the
 * guest's hand no longer covers what was added to the bill. Letting a waiter
 * add to a printed bill without letting them fix the paper is the
 * paper-disagrees-with-the-drawer bug, handed to the one person who cannot
 * repair it.
 *
 * So every bill print now files WHAT IT PRINTED beside the job
 * ("PrintJobs".bill_digest, lines_digest, bill_grand_total, table_name), and the
 * current bill is fingerprinted the same way. A waiter may print again when,
 * and only when, the two differ. Identical content, or a print from before 055
 * whose content nobody recorded, is still a senior's reprint — unknown fails
 * closed, exactly as C3 always did.
 *
 * ============================================================================
 * WHAT IS IN THE FINGERPRINT, AND WHAT IS NOT
 * ============================================================================
 * IN: every line the guest is charged for (name, variation, unit price, comped
 * or not, quantity — merged, so the same dish ordered in two rounds reads the
 * same as one line of two), and every rung of the ladder (subtotal, discount,
 * service charge and its percent, each tax line, round-off, grand total), and
 * the guest's name, customer GSTIN and address (a corporate guest's claim
 * hangs on them; client item 7 prints the address under the GSTIN, so an
 * address added after the print leaves the guest holding an invoice without
 * it, and a name corrected after it leaves the old name on the invoice).
 *
 * OUT: the time, the cashier, the bill number, the logo and the QR. A second
 * print differs in all of those and says nothing new about what is owed.
 * Course holds and item notes are out too: they do not move a rupee.
 *
 * TWO FINGERPRINTS, TWO READERS.
 *   * `billPaperDigest` — the whole paper. The print gate and GET
 *     /bill-for-table compare it (routes/bills.ts currentPaperDigest), so a
 *     discount, a waiver or a comp added after the print reads stale there too.
 *   * `billLinesDigest` — the lines alone. GET /get-tables compares it, because
 *     the floor read cannot price forty tables' ladders on every poll and a new
 *     dish — the case this feature is for — always changes the lines.
 *
 * This module is pure: routes/bills.ts, database_supabase.ts and the tests all
 * use it, and bill_paper_digest.test.ts pins it.
 */

import { createHash } from "node:crypto";

/** One line as a bill carries it (GetBillForTable's merged items) or as an order stores it. */
export interface PaperLine {
	name?: unknown;
	price?: unknown;
	quantity?: unknown;
	nc?: unknown;
	variation?: unknown;
}

/** The rungs of a bill's ladder, as computeBillCharges answers them. */
export interface PaperCharges {
	subtotal?: unknown;
	discount?: unknown;
	service_charge?: unknown;
	service_charge_percent?: unknown;
	taxes?: readonly { name?: unknown; percentage?: unknown; amount?: unknown }[] | null;
	round_off?: unknown;
	grand_total?: unknown;
}

/** What a bill print files beside its job (migration 055). */
export interface BillPaperRecord {
	bill_digest: string | null;
	lines_digest: string | null;
	bill_grand_total: number | null;
	/** The table name the paper printed — "12" even after the party moves to 20. */
	table_name: string | null;
}

const num = (v: unknown): number => {
	const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
	return Number.isFinite(n) ? n : 0;
};

/** Two decimals, as text, so 425 and 425.00 and "425" are one amount. */
const money = (v: unknown): string => (Math.round(num(v) * 100) / 100).toFixed(2);

/**
 * The quantity a line counts for: a whole number, at least 1 — the rule
 * GetBillForTable applies to every stored line before it merges.
 */
const qty = (v: unknown): number => Math.max(1, Math.round(num(v) || 1));

const text = (v: unknown): string => String(v ?? "").trim();

const isNc = (v: unknown): boolean => v === true || v === "true" || v === 1;

/**
 * The lines, merged and sorted into ONE shape whichever side produced them.
 *
 * A bill's items arrive already merged (GetBillForTable keys them on name,
 * price, comp and variation, case-insensitively); the floor read hands in every
 * stored line of every order. Merging again here is a no-op for the first and
 * the same merge for the second, so both sides fingerprint the same paper.
 */
export function canonicalPaperLines(lines: readonly PaperLine[] | null | undefined): [string, string, string, number, number][] {
	const merged = new Map<string, [string, string, string, number, number]>();
	for (const l of lines ?? []) {
		const name = text(l?.name ?? "Item").toLowerCase() || "item";
		const variation = text(l?.variation).toLowerCase();
		const price = money(l?.price);
		const nc = isNc(l?.nc) ? 1 : 0;
		const key = JSON.stringify([name, variation, price, nc]);
		const hit = merged.get(key);
		if (hit) {
			hit[4] += qty(l?.quantity);
		} else {
			merged.set(key, [name, variation, price, nc, qty(l?.quantity)]);
		}
	}
	return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fingerprint of the lines alone — what the floor tile compares. */
export function billLinesDigest(lines: readonly PaperLine[] | null | undefined): string {
	return sha256({ v: 1, lines: canonicalPaperLines(lines) });
}

/** The fingerprint of the whole paper — what the print gate and the bill sheet compare. */
export function billPaperDigest(input: {
	items: readonly PaperLine[] | null | undefined;
	charges: PaperCharges;
	customerGstin?: string | null;
	/** The customer_address the paper prints (client item 7). */
	customerAddress?: string | null;
	/** The guest name the paper prints on its "Name:" line. */
	customerName?: string | null;
}): string {
	const c = input.charges ?? {};
	const address = paperAddress(input.customerAddress);
	const name = paperName(input.customerName);
	const taxes = (c.taxes ?? [])
		.map((t) => [text(t?.name).toLowerCase(), money(t?.percentage), money(t?.amount)] as const)
		.sort((a, b) => (a.join("|") < b.join("|") ? -1 : 1));
	return sha256({
		v: 1,
		lines: canonicalPaperLines(input.items),
		subtotal: money(c.subtotal),
		discount: money(c.discount),
		service_charge: money(c.service_charge),
		// A percent with no charge beside it prints nothing, so it is not paper.
		service_charge_percent: num(c.service_charge) > 0 ? money(c.service_charge_percent) : "0.00",
		taxes,
		round_off: money(c.round_off),
		grand_total: money(c.grand_total),
		customer_gstin: text(input.customerGstin).toUpperCase(),
		// Only when there is one, so every bill without an address keeps the
		// fingerprint it had before the address slot existed.
		...(address ? { customer_address: address } : {}),
		// THE NAME, the third field of the same identity, edited in the same
		// dialog. Without it a name corrected after the print left the paper
		// "current": a waiter was refused the reprint and settle raised no warning
		// while the guest's invoice carried the old name. Only when the paper
		// prints one, so a walk-in or unnamed bill keeps the fingerprint it had.
		...(name ? { customer_name: name } : {}),
	});
}

/** The address as lines: each trimmed, blank ones dropped, CRLF read as LF. */
function paperAddress(value: unknown): string {
	return text(value).split(/\r\n?|\n/).map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

/**
 * The name as the paper prints it (escpos.ts's "Name:" line): trimmed, runs of
 * whitespace read as one, and blank for the placeholders the ordering flows
 * store for "nobody gave a name" ("Guest", "QR Guest"), which print nothing.
 */
function paperName(value: unknown): string {
	const name = text(value).replace(/\s+/g, " ");
	return /^(qr )?guest$/i.test(name) ? "" : name;
}

/**
 * IS THE PAPER IN THE GUEST'S HAND STILL RIGHT?
 *
 *   * null  — nothing printed, or the print's content was never recorded (a
 *             print from before migration 055, or a ledger write that failed).
 *             Nobody can say, so nobody acts on it: the waiter's reprint stays
 *             a senior's, and no tile claims the paper is out of date.
 *   * true  — the bill has changed since it was printed.
 *   * false — the paper still says what the bill says.
 */
export function paperStale(current: string | null | undefined, printed: string | null | undefined): boolean | null {
	const now = text(current);
	const then = text(printed);
	if (!now || !then) { return null; }
	return now !== then;
}

/**
 * The name the paper printed, when it is not the name the table has now — "12"
 * on a party moved to 20. Null otherwise, so a tile says "Printed as 12" only
 * when that is news.
 */
export function printedAsName(printedTable: string | null | undefined, currentTable: string | null | undefined): string | null {
	const printed = text(printedTable);
	if (!printed) { return null; }
	return printed.toLowerCase() === text(currentTable).toLowerCase() ? null : printed;
}

// ---------------------------------------------------------------------------
// The words. escpos.ts, the web renderer and the app's preview print these.
// ---------------------------------------------------------------------------

/**
 * The banner on a print that REPLACES an earlier one because the bill changed.
 * "** REPRINT **" says "a copy"; a copy of a bill that has grown is a
 * different document, and a guest holding two papers has to be able to tell
 * which one to pay. A senior's identical copy keeps the REPRINT banner.
 */
export const UPDATED_BILL_MARKER = "** UPDATED BILL **";

/**
 * The clock the replaced print is named by, in the restaurant's zone: "13:32",
 * or "16/09 13:32" when it was printed on another day (CSR keeps a printed room
 * open for a day and a half).
 */
export function billPrintedClock(printedAt: string | Date | null | undefined, tz: string, now: Date = new Date()): string {
	const at = printedAt instanceof Date ? printedAt : new Date(String(printedAt ?? ""));
	if (Number.isNaN(at.getTime())) { return ""; }
	const zone = text(tz) || "Asia/Kolkata";
	const parts = (d: Date, z: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const p of new Intl.DateTimeFormat("en-GB", {
			timeZone: z, day: "2-digit", month: "2-digit", year: "numeric",
			hour: "2-digit", minute: "2-digit", hourCycle: "h23",
		}).formatToParts(d)) { out[p.type] = p.value; }
		return out;
	};
	let a: Record<string, string>;
	let b: Record<string, string>;
	try {
		a = parts(at, zone);
		b = parts(now, zone);
	} catch {
		a = parts(at, "Asia/Kolkata");
		b = parts(now, "Asia/Kolkata");
	}
	const clock = `${a.hour ?? ""}:${a.minute ?? ""}`;
	const sameDay = a.day === b.day && a.month === b.month && a.year === b.year;
	return sameDay ? clock : `${a.day ?? ""}/${a.month ?? ""} ${clock}`;
}

/** The line under the banner: "Replaces the bill printed 13:32". */
export function replacesBillLine(clock: string): string {
	const c = text(clock);
	return c ? `Replaces the bill printed ${c}` : "Replaces an earlier printed bill";
}
