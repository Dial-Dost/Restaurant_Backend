// Owner-facing "what does this number mean?" copy for the analytics screens.
//
// Pure static text — NO database, network or native dependencies (same rationale
// as billing_math.ts). It lives server-side so the web dashboard and the Flutter
// owner app show the SAME sentence for the same metric, and the wording can be
// corrected in one place without shipping two clients.
//
// Style rules for anything added here: no jargon, no percentile/statistics
// vocabulary unless it is immediately explained, `what` is one sentence, `how`
// says plainly what is divided by what, and `tip` is only present when there is
// a genuinely useful action.

export interface MetricExplainer {
  // Short display name for the metric (headline of the explainer popover).
  title: string;
  // One sentence: what the number measures.
  what: string;
  // How it is computed, in owner language.
  how: string;
  // Optional: what to do about it.
  tip?: string;
}

export const METRIC_EXPLAINERS: Record<string, MetricExplainer> = {
  revenue: {
    title: "Revenue",
    what: "The money your orders added up to over the period you are looking at.",
    how: "Every item on every non-cancelled order, price times quantity, added together. Before tax.",
    tip: "Compare it against the same span last month rather than against yesterday — single days swing a lot.",
  },
  apc: {
    title: "Average per cover (APC)",
    what: "What one guest spends on average.",
    how: "Bill total divided by covers, counted once per table, before tax.",
    tip: "The fastest way to lift it is a suggested add-on (a side, a drink) rather than a price rise.",
  },
  covers: {
    title: "Covers",
    what: "The number of guests you actually served.",
    how: "The guest count entered for each table, counted once per table no matter how many orders that table places.",
    tip: "If covers look low next to your bill count, staff are probably skipping the guest count when they open a table.",
  },
  bills: {
    title: "Bills",
    what: "How many tables you closed and took payment for.",
    how: "One bill per table visit, counted when it is settled. Split bills still count as the one table.",
  },
  avg_prep_ms: {
    title: "Average prep time",
    what: "How long the kitchen typically takes on an order, from the moment it is announced to the moment it is served.",
    how: "Average of the kitchen timer across finished orders, with paused time removed. Tickets that ran over three hours are treated as abandoned and left out.",
    tip: "Averages hide the bad nights — read this together with the 90th-percentile time.",
  },
  p90_prep_ms: {
    title: "90th-percentile prep time",
    what: "The slow end of your kitchen: nine out of ten orders came out faster than this.",
    how: "All finished prep times sorted from fast to slow; this is the time at the 90% mark.",
    tip: "This is closer to what an unlucky guest experiences than the average is. Cut the gap between the two and complaints drop.",
  },
  bark_to_served: {
    title: "Announce to served",
    what: "The wall-clock wait from the kitchen being told about an order to that order leaving the kitchen.",
    how: "Time from the order being announced (barked) to it being marked served — no pauses removed, so it includes any time the ticket sat waiting.",
    tip: "If this is well above average prep time, tickets are queuing rather than cooking slowly.",
  },
  table_occupancy: {
    title: "Table occupancy",
    what: "How much of your seating was actually in use.",
    how: "Tables that were occupied or reserved divided by all tables in the outlet, at the moment you are looking.",
    tip: "High occupancy with a low APC means you are full but under-selling; low occupancy is a marketing or reservations problem.",
  },
  avg_rating: {
    title: "Average rating",
    what: "The average score guests gave you on the feedback form.",
    how: "All feedback scores in the period added up and divided by the number of responses.",
    tip: "Read it next to the response count — a 5.0 from three guests says very little.",
  },
  discount_total: {
    title: "Discounts given",
    what: "Money you chose not to collect: coupons, staff discounts and manual reductions.",
    how: "Every discount and coupon amount applied to settled bills in the period, added together.",
    tip: "Discounts concentrated on one staff member or one hour of the day are worth a closer look.",
  },
  void_count: {
    title: "Voids",
    what: "How many items or orders were cancelled after being sent to the kitchen.",
    how: "A count of cancelled items and cancelled orders in the period.",
    tip: "A rising void count usually means order-taking mistakes or items that keep running out.",
  },
  top_dish: {
    title: "Top dish",
    what: "The dish bringing in the most money over the period.",
    how: "Sales are grouped by dish name (modifiers stripped) and ranked by revenue, then by quantity.",
    tip: "Your top dish is your safest candidate for a small price rise, and the one to never run out of.",
  },
  slow_mover: {
    title: "Slow movers",
    what: "Dishes still on your menu that hardly anyone ordered.",
    how: "Available menu items ranked by how little they sold in the period — including the ones that sold nothing.",
    tip: "Each one is a choice: reprice it, feature it, or take it off the menu to speed up ordering.",
  },
  section_avg_prep: {
    title: "Section prep time",
    what: "How long each kitchen station takes on the items routed to it.",
    how: "Average prep time of every timed item, grouped by the station its dish is assigned to on the menu.",
    tip: "Dishes with no station land in Unassigned — assign them on the menu to make this reliable.",
  },
  nps: {
    title: "NPS",
    what: "Whether guests would recommend you, on a scale from -100 to +100.",
    how: "The share of guests who scored 9-10 minus the share who scored 0-6.",
    tip: "The score moves slowly; the written comments behind it tell you why much faster.",
  },
};
