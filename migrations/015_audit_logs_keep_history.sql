-- Audit entries are historical facts: they must survive the deletion of the
-- employee who performed them. The composite FK to "Employees" made any
-- employee with audit history undeletable (FK violation on DELETE), so drop it.
-- The audit list already LEFT JOINs Employees and falls back to "Unknown" when
-- the employee row is gone.
alter table "Audit_logs" drop constraint if exists "Audit_logs_res_id_outlet_id_employee_id_fkey";
