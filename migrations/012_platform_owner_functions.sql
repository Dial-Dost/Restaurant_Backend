-- Migration 012: SECURITY DEFINER helpers for the platform control plane's one
-- legitimate cross-tenant operation — reading/resetting a locked-out tenant
-- owner's login.
--
-- WHY: the least-privilege `platform_runtime` role (migration 004) has NO grants on
-- the tenant "Login"/"Employees" tables, and migration 003 puts fail-closed RLS on
-- them. So the platform reset-owner endpoint, which reads "Login" join "Employees"
-- and updates "Login", would return zero rows / permission-denied the moment the
-- platform connection is repointed off the owner role onto platform_runtime
-- (the intended production posture).
--
-- These functions run as their OWNER (the table owner, which bypasses RLS), so the
-- control plane can perform exactly this one operation without weakening tenant
-- isolation or holding broad table grants. Mirrors the SECURITY DEFINER pattern in
-- migrations 005/011. Idempotent (create or replace). Safe to apply anytime.

-- Earliest-created admin (the "owner") for a restaurant.
create or replace function platform.get_restaurant_owner(p_res_id uuid)
returns table(emp_id uuid, emp_username text, fname text, lname text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select l.emp_id, l.emp_username, e."emp_Fname", e."emp_Lname"
    from "Login" l
    join "Employees" e on e.id = l.emp_id and e.res_id = l.res_id
   where l.res_id = p_res_id
     and (e.emp_roles->>'primary' = 'admin' or e.emp_roles::text ilike '%"admin"%')
   order by l.created_at asc
   limit 1
$$;

-- Reset that owner's password hash. Returns the affected owner (no rows if none).
create or replace function platform.reset_owner_password(p_res_id uuid, p_hash text)
returns table(emp_id uuid, emp_username text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_emp_id uuid;
  v_username text;
begin
  select o.emp_id, o.emp_username into v_emp_id, v_username
    from platform.get_restaurant_owner(p_res_id) o;
  if v_emp_id is null then
    return;
  end if;
  update "Login" set emp_pass = p_hash
   where "Login".emp_id = v_emp_id and "Login".res_id = p_res_id;
  emp_id := v_emp_id;
  emp_username := v_username;
  return next;
end
$$;

-- Least privilege: not callable by the world; only the control-plane role.
revoke all on function platform.get_restaurant_owner(uuid) from public;
revoke all on function platform.reset_owner_password(uuid, text) from public;
grant execute on function platform.get_restaurant_owner(uuid) to platform_runtime;
grant execute on function platform.reset_owner_password(uuid, text) to platform_runtime;
