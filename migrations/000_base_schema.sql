-- 000_base_schema.sql — fresh-DB bootstrap of the public schema.
-- AUTO-GENERATED from the live schema via catalog introspection (server-authored DDL).
-- Pure STRUCTURE only: enums, sequences, tables, constraints, indexes.
-- Row-Level Security is intentionally NOT here — migrations 003/007/008 own it
-- (idempotent; they run after this). Feature tables the app creates lazily at
-- runtime (ensure*Table) are also covered here so a fresh DB matches prod.
-- On the existing prod DB this migration is marked already-applied (schema predates the runner).

create extension if not exists pgcrypto;       -- gen_random_uuid()
create extension if not exists "uuid-ossp";    -- uuid_generate_* (if referenced)

-- Enum types
do $$ begin if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='Action_groups' and n.nspname='public') then create type "Action_groups" as enum ('Test', 'Tables', 'Roles', 'Inventory', 'Customer', 'Valet', 'Bills', 'Bookings', 'Audit Logs', 'Menu', 'Orders', 'Restaurant Specific', 'Feedback Questions'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='Audit_log_cat' and n.nspname='public') then create type "Audit_log_cat" as enum ('General', 'Bill', 'Orders', 'Valet', 'Inventory', 'Tables', 'Roles', 'Customer', 'Bookings', 'Menu'); end if; end $$;
do $$ begin if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='feedback_question_cat' and n.nspname='public') then create type "feedback_question_cat" as enum ('ambience', 'food', 'valet', 'follow_up', 'restroom', 'waiter_serving', 'initial_greeting'); end if; end $$;

-- Tables
create table if not exists "Actions" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "action_name" text not null,
  "action_desc" text,
  "group" "Action_groups" default 'Test'::"Action_groups" not null,
  constraint "Actions_pkey" PRIMARY KEY (id)
);

create table if not exists "Attendance" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "emp_id" uuid not null,
  "clock_in" timestamp with time zone default now() not null,
  "clock_out" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  constraint "Attendance_pkey" PRIMARY KEY (id)
);

create table if not exists "Audit_logs" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "employee_id" uuid not null,
  "action_id" uuid not null,
  "reason" text,
  "category" "Audit_log_cat" default 'General'::"Audit_log_cat" not null,
  "additional_details" json,
  constraint "Audit_logs_pkey" PRIMARY KEY (id)
);

create table if not exists "Bills" (
  "id" uuid default gen_random_uuid() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "created_at" timestamp with time zone default now() not null,
  "table_id" uuid not null,
  "emp_id" uuid not null,
  "status" numeric default '1'::numeric not null,
  "reason" text,
  "order_id" uuid not null,
  "total_amt" numeric not null,
  "tax_breakdown" json not null,
  "payment_method" text,
  "waiter_confirmed_at" timestamp with time zone,
  "waiter_confirmed_by_username" text,
  "admin_approved_at" timestamp with time zone,
  "admin_approved_by_username" text,
  "closed_at" timestamp with time zone,
  "closed_by_username" text,
  "payment_proof_screenshot_url" text,
  "bill_no" bigint default '1'::bigint not null,
  "discount_type" text,
  "discount_value" numeric,
  "refunded_at" timestamp with time zone,
  "refunded_by_username" text,
  "refund_amount" numeric,
  "refund_reason" text,
  "refund_ref" text,
  "coupon_code" text,
  constraint "Bills_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Bookings" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "cust_id" uuid not null,
  "num_adults" numeric default '1'::numeric not null,
  "num_kids" numeric,
  "table_id" uuid not null,
  "slot" text not null,
  constraint "Bookings_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "CashSessions" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "opened_at" timestamp with time zone default now() not null,
  "opened_by" text,
  "opening_float" numeric default 0 not null,
  "closed_at" timestamp with time zone,
  "closed_by" text,
  "cash_sales" numeric,
  "cash_refunds" numeric,
  "cash_payouts" numeric,
  "expected_cash" numeric,
  "counted_cash" numeric,
  "variance" numeric,
  "notes" text,
  "status" text default 'open'::text not null,
  constraint "CashSessions_pkey" PRIMARY KEY (id)
);

create table if not exists "Customers" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "cust_Fname" text not null,
  "cust_Lname" text not null,
  "cust_ph" numeric,
  "cust_email" text,
  "country_of_origin" text not null,
  constraint "Customers_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Employees" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "emp_Fname" text not null,
  "emp_email" text,
  "emp_ph" numeric,
  "emp_add" text,
  "emp_roles" json not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "emp_Lname" text not null,
  constraint "Employees_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Expenses" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "created_at" timestamp with time zone default now() not null,
  "spent_on" date default CURRENT_DATE not null,
  "category" text default 'General'::text not null,
  "vendor" text,
  "amount" numeric default 0 not null,
  "note" text,
  "created_by" text,
  constraint "Expenses_pkey" PRIMARY KEY (id)
);

create table if not exists "Feedback_entries" (
  "id" uuid default gen_random_uuid() not null,
  "submitted_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "emp_id" uuid not null,
  "cust_name" text,
  "comments" text,
  "overall_rating" integer not null,
  "cattegory_ratings" json not null,
  "visit_date" timestamp with time zone not null,
  "source" text not null,
  "recovery_status" text,
  "recovery_resolved_at" timestamp with time zone,
  "recovery_resolved_by" text,
  "recovery_note" text,
  constraint "Feedback_entries_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Inventory" (
  "barcode" text not null,
  "created_at" timestamp with time zone default now() not null,
  "name" text not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "description" text,
  "Quantity" numeric default '0'::numeric not null,
  constraint "Inventory_pkey" PRIMARY KEY (barcode, res_id, outlet_id)
);

create table if not exists "Login" (
  "emp_id" uuid not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "emp_username" text not null,
  "emp_pass" text not null,
  constraint "Login_pkey" PRIMARY KEY (res_id, outlet_id, emp_username)
);

create table if not exists "Menu" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "name" text not null,
  "description" text,
  "main_cat_id" uuid not null,
  "sub_cat_id" uuid not null,
  "avg_time" text not null,
  constraint "Menu_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Menue_main_cat" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "name" text not null,
  "avg_time" text not null,
  constraint "Menue_main_cat_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Menue_sub_cat" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "name" text not null,
  "avg_time" text not null,
  "main_cat_id" uuid not null,
  constraint "Menue_sub_cat_pkey" PRIMARY KEY (id, res_id, outlet_id, main_cat_id)
);

create table if not exists "Notifications" (
  "id" uuid default gen_random_uuid() not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "type" text default 'info'::text,
  "title" text not null,
  "body" text,
  "meta" jsonb default '{}'::jsonb,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  constraint "Notifications_pkey" PRIMARY KEY (id)
);

create table if not exists "Orders" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "food" json not null,
  "table_id" uuid not null,
  "status" numeric default '1'::numeric not null,
  "cust_id" uuid,
  "timing" jsonb,
  constraint "Orders_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Outlets" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "oultet_username" character varying not null,
  "outlet_name" text not null,
  "outlet_add" text not null,
  "outlet_main_ph" numeric,
  "outlet_working_hours" text,
  "res_id" uuid not null,
  "default_tax" json default '{   "SGST": 2.5,   "CGST": 2.5, "Service Charge": 1 }'::json not null,
  "is_active" boolean default true not null,
  "bill_seq" integer default 0 not null,
  constraint "Outlets_pkey" PRIMARY KEY (id)
);

create table if not exists "Parking_Bays" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "bay_name" text not null,
  "current_capacity" bigint default '0'::bigint not null,
  "total_capacity" bigint default '0'::bigint not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  constraint "Parking_Bays_pkey" PRIMARY KEY (id)
);

create table if not exists "PasswordResetRequests" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "emp_id" uuid not null,
  "username" text not null,
  "status" text default 'pending'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "resolved_at" timestamp with time zone,
  constraint "PasswordResetRequests_pkey" PRIMARY KEY (id)
);

create table if not exists "PurchaseOrders" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "vendor_id" uuid,
  "vendor_name" text,
  "status" text default 'draft'::text not null,
  "items" jsonb default '[]'::jsonb not null,
  "total_cost" numeric default 0 not null,
  "notes" text,
  "expected_date" date,
  "created_at" timestamp with time zone default now() not null,
  "created_by" text,
  "ordered_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  constraint "PurchaseOrders_pkey" PRIMARY KEY (id)
);

create table if not exists "Restaurant" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_username" character varying not null,
  "res_name" text not null,
  "main_office_add" text,
  "logo" text,
  "theme_color" text,
  "auto_push_orders" boolean default true,
  "currency" text,
  "payment_config" jsonb,
  "razorpay_key_id" text,
  "razorpay_key_secret" text,
  "service_charge" numeric default 0,
  "feedback_config" jsonb,
  "bill_logo_svg" text,
  "bill_paper_width" text,
  "account_status" text default 'active'::text not null,
  constraint "Restaurant_pkey" PRIMARY KEY (id)
);

create table if not exists "Roles" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "role_name" text not null,
  "actions_performable" json not null,
  "res_id" uuid not null,
  constraint "roles_pkey" PRIMARY KEY (id, res_id)
);

create table if not exists "Table_assignments" (
  "id" uuid not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "table_id" uuid not null,
  "employee_id" uuid not null,
  constraint "Table_assignments_pkey" PRIMARY KEY (id)
);

create table if not exists "Tables" (
  "id" uuid default gen_random_uuid() not null,
  "created_at" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "table_name" character varying not null,
  "capacity" numeric default '2'::numeric not null,
  "is_occupied" boolean default false,
  "num_covers" integer default 1,
  "linked_order_id" text,
  "is_deleted" boolean default false,
  "is_virtual" boolean default false,
  constraint "Tables_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Valet_vehicle_meta" (
  "booking_id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "number_plate" text not null,
  "customer_name" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint "Valet_vehicle_meta_pkey" PRIMARY KEY (booking_id)
);

create table if not exists "Valet_vehicle_state" (
  "id" uuid default gen_random_uuid() not null,
  "entry_time" timestamp with time zone default now() not null,
  "res_id" uuid not null,
  "outlet_id" uuid not null,
  "state" numeric default '1'::numeric not null,
  "exit_time" timestamp with time zone,
  "bay_id" uuid default gen_random_uuid() not null,
  constraint "Valet_vehicle_state_pkey" PRIMARY KEY (id, res_id, outlet_id)
);

create table if not exists "Vendors" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "name" text not null,
  "phone" text,
  "email" text,
  "notes" text,
  "created_at" timestamp with time zone default now() not null,
  constraint "Vendors_pkey" PRIMARY KEY (id)
);

create table if not exists "Waitlist" (
  "id" uuid not null,
  "res_id" uuid not null,
  "outlet_id" uuid,
  "token" uuid not null,
  "name" text not null,
  "phone" text,
  "party_size" integer default 1 not null,
  "status" text default 'waiting'::text not null,
  "pre_order" jsonb default '[]'::jsonb not null,
  "table_id" uuid,
  "created_at" timestamp with time zone default now() not null,
  "called_at" timestamp with time zone,
  "seated_at" timestamp with time zone,
  constraint "Waitlist_pkey" PRIMARY KEY (id)
);

create table if not exists "feedback_questions" (
  "id" uuid default gen_random_uuid() not null,
  "category" feedback_question_cat not null,
  "question" text not null,
  "tokens" bigint not null,
  "created_at" timestamp with time zone default now() not null,
  constraint "feedback_questions_pkey" PRIMARY KEY (id)
);

-- Constraints (unique, check, foreign keys)
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Inventory_name_key' and c.relname='Inventory' and n.nspname='public') then alter table "Inventory" add constraint "Inventory_name_key" UNIQUE (name); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Restaurant_res_username_key' and c.relname='Restaurant' and n.nspname='public') then alter table "Restaurant" add constraint "Restaurant_res_username_key" UNIQUE (res_username); end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Audit_logs_action_id_fkey' and c.relname='Audit_logs' and n.nspname='public') then alter table "Audit_logs" add constraint "Audit_logs_action_id_fkey" FOREIGN KEY (action_id) REFERENCES "Actions"(id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Audit_logs_outlet_id_fkey' and c.relname='Audit_logs' and n.nspname='public') then alter table "Audit_logs" add constraint "Audit_logs_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Audit_logs_res_id_fkey' and c.relname='Audit_logs' and n.nspname='public') then alter table "Audit_logs" add constraint "Audit_logs_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Audit_logs_res_id_outlet_id_employee_id_fkey' and c.relname='Audit_logs' and n.nspname='public') then alter table "Audit_logs" add constraint "Audit_logs_res_id_outlet_id_employee_id_fkey" FOREIGN KEY (res_id, outlet_id, employee_id) REFERENCES "Employees"(res_id, outlet_id, id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bills_emp_id_res_id_outlet_id_fkey' and c.relname='Bills' and n.nspname='public') then alter table "Bills" add constraint "Bills_emp_id_res_id_outlet_id_fkey" FOREIGN KEY (emp_id, res_id, outlet_id) REFERENCES "Employees"(id, res_id, outlet_id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bills_order_id_res_id_outlet_id_fkey' and c.relname='Bills' and n.nspname='public') then alter table "Bills" add constraint "Bills_order_id_res_id_outlet_id_fkey" FOREIGN KEY (order_id, res_id, outlet_id) REFERENCES "Orders"(id, res_id, outlet_id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bills_outlet_id_fkey' and c.relname='Bills' and n.nspname='public') then alter table "Bills" add constraint "Bills_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bills_res_id_fkey' and c.relname='Bills' and n.nspname='public') then alter table "Bills" add constraint "Bills_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bills_table_id_res_id_outlet_id_fkey' and c.relname='Bills' and n.nspname='public') then alter table "Bills" add constraint "Bills_table_id_res_id_outlet_id_fkey" FOREIGN KEY (table_id, res_id, outlet_id) REFERENCES "Tables"(id, res_id, outlet_id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bookings_cust_id_res_id_outlet_id_fkey' and c.relname='Bookings' and n.nspname='public') then alter table "Bookings" add constraint "Bookings_cust_id_res_id_outlet_id_fkey" FOREIGN KEY (cust_id, res_id, outlet_id) REFERENCES "Customers"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bookings_outlet_id_fkey' and c.relname='Bookings' and n.nspname='public') then alter table "Bookings" add constraint "Bookings_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bookings_res_id_fkey' and c.relname='Bookings' and n.nspname='public') then alter table "Bookings" add constraint "Bookings_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Bookings_table_id_res_id_outlet_id_fkey' and c.relname='Bookings' and n.nspname='public') then alter table "Bookings" add constraint "Bookings_table_id_res_id_outlet_id_fkey" FOREIGN KEY (table_id, res_id, outlet_id) REFERENCES "Tables"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Customers_outlet_id_fkey' and c.relname='Customers' and n.nspname='public') then alter table "Customers" add constraint "Customers_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Customers_res_id_fkey' and c.relname='Customers' and n.nspname='public') then alter table "Customers" add constraint "Customers_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Employees_outlet_id_fkey' and c.relname='Employees' and n.nspname='public') then alter table "Employees" add constraint "Employees_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Employees_res_id_fkey' and c.relname='Employees' and n.nspname='public') then alter table "Employees" add constraint "Employees_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Feedback_entries_outlet_id_fkey' and c.relname='Feedback_entries' and n.nspname='public') then alter table "Feedback_entries" add constraint "Feedback_entries_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Feedback_entries_res_id_fkey' and c.relname='Feedback_entries' and n.nspname='public') then alter table "Feedback_entries" add constraint "Feedback_entries_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Feedback_entries_res_id_outlet_id_emp_id_fkey' and c.relname='Feedback_entries' and n.nspname='public') then alter table "Feedback_entries" add constraint "Feedback_entries_res_id_outlet_id_emp_id_fkey" FOREIGN KEY (res_id, outlet_id, emp_id) REFERENCES "Employees"(res_id, outlet_id, id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Inventory_outlet_id_fkey' and c.relname='Inventory' and n.nspname='public') then alter table "Inventory" add constraint "Inventory_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Inventory_res_id_fkey' and c.relname='Inventory' and n.nspname='public') then alter table "Inventory" add constraint "Inventory_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Login_emp_id_res_id_outlet_id_fkey' and c.relname='Login' and n.nspname='public') then alter table "Login" add constraint "Login_emp_id_res_id_outlet_id_fkey" FOREIGN KEY (emp_id, res_id, outlet_id) REFERENCES "Employees"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Login_outlet_id_fkey' and c.relname='Login' and n.nspname='public') then alter table "Login" add constraint "Login_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Login_res_id_fkey' and c.relname='Login' and n.nspname='public') then alter table "Login" add constraint "Login_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menu_main_cat_id_res_id_outlet_id_fkey' and c.relname='Menu' and n.nspname='public') then alter table "Menu" add constraint "Menu_main_cat_id_res_id_outlet_id_fkey" FOREIGN KEY (main_cat_id, res_id, outlet_id) REFERENCES "Menue_main_cat"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menu_outlet_id_fkey' and c.relname='Menu' and n.nspname='public') then alter table "Menu" add constraint "Menu_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menu_res_id_fkey' and c.relname='Menu' and n.nspname='public') then alter table "Menu" add constraint "Menu_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menu_sub_cat_id_res_id_outlet_id_main_cat_id_fkey' and c.relname='Menu' and n.nspname='public') then alter table "Menu" add constraint "Menu_sub_cat_id_res_id_outlet_id_main_cat_id_fkey" FOREIGN KEY (sub_cat_id, res_id, outlet_id, main_cat_id) REFERENCES "Menue_sub_cat"(id, res_id, outlet_id, main_cat_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menue_main_cat_outlet_id_fkey' and c.relname='Menue_main_cat' and n.nspname='public') then alter table "Menue_main_cat" add constraint "Menue_main_cat_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menue_main_cat_res_id_fkey' and c.relname='Menue_main_cat' and n.nspname='public') then alter table "Menue_main_cat" add constraint "Menue_main_cat_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menue_sub_cat_main_cat_id_res_id_outlet_id_fkey' and c.relname='Menue_sub_cat' and n.nspname='public') then alter table "Menue_sub_cat" add constraint "Menue_sub_cat_main_cat_id_res_id_outlet_id_fkey" FOREIGN KEY (main_cat_id, res_id, outlet_id) REFERENCES "Menue_main_cat"(id, res_id, outlet_id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menue_sub_cat_outlet_id_fkey' and c.relname='Menue_sub_cat' and n.nspname='public') then alter table "Menue_sub_cat" add constraint "Menue_sub_cat_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Menue_sub_cat_res_id_fkey' and c.relname='Menue_sub_cat' and n.nspname='public') then alter table "Menue_sub_cat" add constraint "Menue_sub_cat_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Orders_cust_id_res_id_outlet_id_fkey' and c.relname='Orders' and n.nspname='public') then alter table "Orders" add constraint "Orders_cust_id_res_id_outlet_id_fkey" FOREIGN KEY (cust_id, res_id, outlet_id) REFERENCES "Customers"(id, res_id, outlet_id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Orders_outlet_id_fkey' and c.relname='Orders' and n.nspname='public') then alter table "Orders" add constraint "Orders_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Orders_res_id_fkey' and c.relname='Orders' and n.nspname='public') then alter table "Orders" add constraint "Orders_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Orders_table_id_res_id_outlet_id_fkey' and c.relname='Orders' and n.nspname='public') then alter table "Orders" add constraint "Orders_table_id_res_id_outlet_id_fkey" FOREIGN KEY (table_id, res_id, outlet_id) REFERENCES "Tables"(id, res_id, outlet_id) ON UPDATE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Outlets_res_id_fkey' and c.relname='Outlets' and n.nspname='public') then alter table "Outlets" add constraint "Outlets_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Parking_Bays_outlet_id_fkey' and c.relname='Parking_Bays' and n.nspname='public') then alter table "Parking_Bays" add constraint "Parking_Bays_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Parking_Bays_res_id_fkey' and c.relname='Parking_Bays' and n.nspname='public') then alter table "Parking_Bays" add constraint "Parking_Bays_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='roles_res_id_fkey' and c.relname='Roles' and n.nspname='public') then alter table "Roles" add constraint "roles_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Tables_outlet_id_fkey' and c.relname='Tables' and n.nspname='public') then alter table "Tables" add constraint "Tables_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Tables_res_id_fkey' and c.relname='Tables' and n.nspname='public') then alter table "Tables" add constraint "Tables_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Valet_vehicle_state_bay_id_fkey' and c.relname='Valet_vehicle_state' and n.nspname='public') then alter table "Valet_vehicle_state" add constraint "Valet_vehicle_state_bay_id_fkey" FOREIGN KEY (bay_id) REFERENCES "Parking_Bays"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Valet_vehicle_state_outlet_id_fkey' and c.relname='Valet_vehicle_state' and n.nspname='public') then alter table "Valet_vehicle_state" add constraint "Valet_vehicle_state_outlet_id_fkey" FOREIGN KEY (outlet_id) REFERENCES "Outlets"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;
do $$ begin if not exists (select 1 from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.conname='Valet_vehicle_state_res_id_fkey' and c.relname='Valet_vehicle_state' and n.nspname='public') then alter table "Valet_vehicle_state" add constraint "Valet_vehicle_state_res_id_fkey" FOREIGN KEY (res_id) REFERENCES "Restaurant"(id) ON UPDATE CASCADE ON DELETE CASCADE; end if; end $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attendance_res_outlet_emp ON public."Attendance" USING btree (res_id, outlet_id, emp_id);
CREATE UNIQUE INDEX IF NOT EXISTS bills_one_open_per_table ON public."Bills" USING btree (table_id, outlet_id) WHERE (closed_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_bills_res_outlet_closed ON public."Bills" USING btree (res_id, outlet_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_bills_res_outlet_created ON public."Bills" USING btree (res_id, outlet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bills_res_outlet_table ON public."Bills" USING btree (res_id, outlet_id, table_id);
CREATE INDEX IF NOT EXISTS cash_sessions_lookup_idx ON public."CashSessions" USING btree (res_id, outlet_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_employees_res_outlet ON public."Employees" USING btree (res_id, outlet_id);
CREATE INDEX IF NOT EXISTS idx_expenses_res_outlet_spent ON public."Expenses" USING btree (res_id, outlet_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_inventory_res_outlet_barcode ON public."Inventory" USING btree (res_id, outlet_id, barcode);
CREATE INDEX IF NOT EXISTS notifications_res_idx ON public."Notifications" USING btree (res_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_res_outlet_created ON public."Orders" USING btree (res_id, outlet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_res_outlet_table ON public."Orders" USING btree (res_id, outlet_id, table_id);
CREATE INDEX IF NOT EXISTS purchase_orders_lookup_idx ON public."PurchaseOrders" USING btree (res_id, outlet_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_table_assignments_employee ON public."Table_assignments" USING btree (res_id, outlet_id, employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_assignments_unique ON public."Table_assignments" USING btree (res_id, outlet_id, table_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_valet_vehicle_meta_res_outlet_booking ON public."Valet_vehicle_meta" USING btree (res_id, outlet_id, booking_id);
CREATE INDEX IF NOT EXISTS valet_vehicle_meta_lookup_idx ON public."Valet_vehicle_meta" USING btree (res_id, outlet_id, booking_id);
CREATE INDEX IF NOT EXISTS waitlist_lookup_idx ON public."Waitlist" USING btree (res_id, outlet_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_token_idx ON public."Waitlist" USING btree (token);
CREATE INDEX IF NOT EXISTS idx_feedback_questions_category_created ON public.feedback_questions USING btree (category, created_at);
