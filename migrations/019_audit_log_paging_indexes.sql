-- Audit-log paging + closed-bill browsing indexes.
--
-- "Audit_logs" shipped with nothing but its primary key, so GET /audit-logs read
-- the whole tenant's history and sorted it in memory for every page. Infinite
-- scroll turns that into one full scan per batch. The first index matches the
-- list's ORDER BY exactly ((created_at desc, id desc) — the id tiebreak is what
-- makes paging deterministic), so a page becomes an index scan with no sort.
--
-- The runtime mirrors these in ensureAuditLogIndexes() so a deployment that has
-- not run migrations still gets them; both forms are `if not exists`.

create index if not exists audit_logs_tenant_paging_idx
  on "Audit_logs" (res_id, outlet_id, created_at desc, id desc);

-- `category` is the one equality filter in the UI's chip row.
create index if not exists audit_logs_tenant_category_idx
  on "Audit_logs" (res_id, outlet_id, category, created_at desc);

-- The per-row "already undone?" lateral joins on additional_details->>'undo_of'.
create index if not exists audit_logs_undo_of_idx
  on "Audit_logs" ((additional_details ->> 'undo_of'))
  where additional_details ->> 'undo_of' is not null;

-- Closed-bill list ordering: coalesce(closed_at, admin_approved_at, created_at)
-- desc, id desc. idx_bills_res_outlet_closed already covers closed_at alone; this
-- one covers the settled-first ordering the Accounting/History list uses.
create index if not exists bills_res_outlet_settled_idx
  on "Bills" (res_id, outlet_id, (coalesce(closed_at, admin_approved_at, created_at)) desc, id desc);
