-- 018: queue pre-order confirmation + Web Push subscriptions.
--
-- 1) Waitlist.pre_order_status / placed_order_id
--    Seating a queued party no longer auto-places its held pre-order; it has to
--    be CONFIRMED (or DECLINED, which leaves the items to seed the guest's cart).
--    'none' is correct for every historical row: those pre-orders were either
--    already placed at seat time, or never existed.
alter table "Waitlist" add column if not exists pre_order_status text not null default 'none';
alter table "Waitlist" add column if not exists placed_order_id uuid;

-- 2) PushSubscriptions — browser Web Push endpoints for queue notifications
--    ("we're calling you" / "your table is ready"), so the message reaches the
--    guest with the tab closed. Tenant-scoped like every other table.
create table if not exists "PushSubscriptions" (
  id uuid primary key,
  res_id uuid not null,
  outlet_id uuid,
  waitlist_id uuid,
  waitlist_token uuid,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failure_count integer not null default 0
);

-- One row per browser endpoint; re-subscribing updates the existing row.
create unique index if not exists push_subscriptions_endpoint_idx on "PushSubscriptions" (endpoint);
create index if not exists push_subscriptions_lookup_idx on "PushSubscriptions" (res_id, waitlist_id);
create index if not exists push_subscriptions_token_idx on "PushSubscriptions" (res_id, waitlist_token);

alter table "PushSubscriptions" enable row level security;
alter table "PushSubscriptions" force row level security;
drop policy if exists tenant_isolation on "PushSubscriptions";
create policy tenant_isolation on "PushSubscriptions"
  using (res_id::text = current_setting('app.res_id', true))
  with check (res_id::text = current_setting('app.res_id', true));
