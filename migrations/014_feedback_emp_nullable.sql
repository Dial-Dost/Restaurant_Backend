-- Migration 014: allow feedback with no attributed waiter.
--
-- WHY: the feedback link + GetTableFeedbackContext are designed to still send a
-- guest to the feedback form when no waiter can be resolved for the table (e.g. a
-- table that only ever had QR self-orders — no staff order-taker, no seat
-- assignment). But "Feedback_entries.emp_id" was NOT NULL, so such a submission
-- would fail. Relaxing it lets unattributed feedback save (emp_id = NULL); the
-- composite FK (res_id, outlet_id, emp_id) is MATCH SIMPLE, so a NULL emp_id simply
-- isn't FK-checked. Per-waiter analytics keep working (NULL rows are just unattributed).
--
-- Safe/additive (relaxes a constraint). Idempotent.

ALTER TABLE "Feedback_entries" ALTER COLUMN emp_id DROP NOT NULL;
