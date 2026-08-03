-- Migration 024: employee leave requests.
--
-- Attendance already records what a person DID (clock in / clock out). Nothing
-- records what they were EXCUSED from, so getStaffAttendanceStats counted every
-- approved holiday as an absence — the one number an owner uses to decide who is
-- unreliable. This table is the missing half.
--
-- NO NEW PERMISSION IS MINTED. Listing, approving and rejecting a leave reuse
-- 'Review Attendance' (2e7b9c40-1f83-4d6a-b902-5a8c3e1f6047), which is already
-- the gate on GET /attendance and POST /attendance/:id/approve. Whoever reviews
-- a clock-in is exactly who should review a day off; a new Action would have to
-- be granted to every existing role before leave review worked at all.
--
-- DATES ARE THE RESTAURANT'S CALENDAR DAYS, stored as bare `date`. They are
-- computed in TypeScript from the tenant's IANA zone (dayKeyOf / dayRangeOf) and
-- passed down as 'YYYY-MM-DD'. Deliberately NOT timestamptz and deliberately
-- never defaulted from `current_date`: this server runs in UTC, so through the
-- tenant's own late shift (00:00-05:30 IST is still yesterday in UTC) a
-- Postgres-side date is the wrong day. That exact bug was fixed across six call
-- sites recently; there is no reason to re-introduce it here.

-- `leave_type` and `status` are plain text with CHECK constraints rather than
-- Postgres enums. That IS the house convention for workflow state — "Attendance"
-- .status, "DiscountRequests".status and "PurchaseOrders".status are all text —
-- and the only real enums in the schema ("Action_groups", "Audit_log_cat") are
-- catalogues, not row state. A CHECK gives the same guarantee without making a
-- future value a lock-taking ALTER TYPE.
CREATE TABLE IF NOT EXISTS "EmployeeLeaves" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  res_id uuid NOT NULL REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  emp_id uuid NOT NULL,
  -- "Employees" is keyed on the TRIPLE (id, res_id, outlet_id), not on id alone,
  -- so this is the only FK shape Postgres will accept — and it is the stronger
  -- one: it makes "a leave is filed at the employee's own outlet" a structural
  -- fact rather than a convention the next writer has to remember. The API
  -- resolves emp_id within (res_id, outlet_id) before inserting, so a caller can
  -- never trip this; it exists to stop a future writer from filing outlet B's
  -- day off against outlet A's roster. Moving an employee between outlets
  -- carries their leave with them (ON UPDATE CASCADE).
  CONSTRAINT employee_leaves_emp_fkey FOREIGN KEY (emp_id, res_id, outlet_id)
    REFERENCES "Employees"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE,
  leave_type text NOT NULL DEFAULT 'casual'
    CHECK (leave_type IN ('sick', 'casual', 'unpaid', 'holiday')),
  -- Inclusive range of restaurant calendar days. A single-day leave has
  -- start_day = end_day.
  start_day date NOT NULL,
  end_day date NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected')),
  reason text,
  -- Employee ids, as text. Deliberately NOT FKs: the decision trail must survive
  -- the deciding employee's row being deleted, and the decider is frequently a
  -- manager at a different outlet than the leave, which the composite FK above
  -- could not express anyway.
  --
  -- NOTE these are ids, not usernames — "DiscountRequests".requested_by next
  -- door stores a USERNAME, so the two columns look alike and are not. The API
  -- resolves both to display names on read.
  requested_by text,
  decided_by text,
  decided_at timestamptz,
  CONSTRAINT employee_leaves_range_ordered CHECK (end_day >= start_day)
);

-- The two reads this table has: "leaves for this employee overlapping a range"
-- (the attendance correction and the employee filter) and "leaves for this
-- outlet overlapping a range" (the list and the absent-without-leave concern).
CREATE INDEX IF NOT EXISTS employee_leaves_emp_day_idx
  ON "EmployeeLeaves" (res_id, outlet_id, emp_id, start_day, end_day);
CREATE INDEX IF NOT EXISTS employee_leaves_status_day_idx
  ON "EmployeeLeaves" (res_id, outlet_id, status, start_day, end_day);

-- Fail-closed from the moment it exists, in migration 003's exact policy form.
ALTER TABLE "EmployeeLeaves" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeLeaves" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeLeaves";
CREATE POLICY tenant_isolation ON "EmployeeLeaves"
  USING (res_id::text = current_setting('app.res_id', true))
  WITH CHECK (res_id::text = current_setting('app.res_id', true));

-- 002's ALTER DEFAULT PRIVILEGES only covers tables created by the role that set
-- it. Spell it out so a migration run under a different owner still leaves the
-- runtime able to read its own rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "EmployeeLeaves" TO app_runtime;
  END IF;
END $$;
