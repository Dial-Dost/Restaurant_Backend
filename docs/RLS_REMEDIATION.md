# RLS remediation — moving the runtime off the RLS-bypassing role

**Status: NOT DONE. Nothing in this document has been applied.** It is the
plan for closing the "Row-Level Security is inert" finding. Do NOT run any of
it against production from a shell — it needs a maintenance window and a
staging rehearsal, and a wrong step locks the app out of its own data.

## What is actually wrong

Migrations 003 / 007 / 008 enable `ROW LEVEL SECURITY` + `FORCE ROW LEVEL
SECURITY` on every tenant table and attach a `tenant_isolation` policy of the
form `res_id::text = current_setting('app.res_id', true)`. That part is in
place — 42 of the 43 public tables have `rowsecurity = true` (the exception is
`schema_migrations`, which has no `res_id` and does not need it).

The policies never take effect because **every runtime connection logs in as
`postgres`, and `postgres` has `rolbypassrls = true`**:

```
rolname           rolsuper  rolbypassrls  rolcanlogin
postgres          false     true          true    <-- all three app URLs use this
app_runtime       false     false         true    <-- exists, unused, no known password
platform_runtime  false     false         true    <-- exists, unused, no known password
```

`SUPABASE_DIRECT_URL`, `SUPABASE_IPV4_URL` and `PLATFORM_DATABASE_URL` all
carry the `postgres.<project-ref>` user. So tenant isolation today rests
entirely on the application-level `where res_id = $1` in every query — correct
today, but one forgotten predicate away from a cross-tenant leak.

There is already a boot-time assertion for this: `assertRlsPosture()` in
`database_supabase.ts` (~line 1242) logs
`[rls-check] runtime DB role "postgres" BYPASSES row-level security …` on every
start, and refuses to boot when `ENFORCE_RLS_AT_BOOT=true`. Turning that env
var on in production is the last step of this plan, not the first.

## Target posture

| Connection | Env var | Today | Target |
|---|---|---|---|
| Tenant pool (primary) | `SUPABASE_DIRECT_URL` | `postgres` | `app_runtime` |
| Tenant pool (IPv4 fallback) | `SUPABASE_IPV4_URL` | `postgres` | `app_runtime` |
| Control plane | `PLATFORM_DATABASE_URL` | `postgres` | `platform_runtime` |
| Migrations (`npm run migrate`) | `MIGRATION_DATABASE_URL` | unset (falls back to `SUPABASE_DIRECT_URL`) | **must stay the owner role** — set it explicitly to the current `postgres` URL BEFORE repointing anything else |

`scripts/migrate.ts` already prefers `MIGRATION_DATABASE_URL` and warns against
pointing it at the runtime role. Set it first, or the next migration run will
fail with `insufficient_privilege` once the other URLs move.

Supabase pooler note: the username in a pooler URL is `<db-user>.<project-ref>`
(today `postgres.mjgttyzvyvzkoukmonyx`), so the repointed URLs use
`app_runtime.<project-ref>` / `platform_runtime.<project-ref>`. Verify the
pooler accepts the non-`postgres` user on this project before the window — if
it does not, connect these two pools to the direct (non-pooler) 5432 host
instead.

## Step 1 — set real passwords (owner connection, one statement each)

```sql
alter role app_runtime      login password '<strong-secret-1>';
alter role platform_runtime login password '<strong-secret-2>';
```

Store both in the same secret store the current DB password lives in. Neither
role should ever appear in a committed file.

## Step 2 — close the privilege gaps these roles still have

Migration 002 granted `app_runtime` DML on everything in `public`, plus default
privileges for future tables, and that is still intact (no public table is
missing `SELECT` for `app_runtime` right now). Two gaps remain:

1. **`app_runtime` cannot reach the `platform` schema.** It holds `EXECUTE` on
   `platform.restaurant_plan(uuid)` and `platform.restaurant_status(uuid)`
   (migrations 004/005/011) but `has_schema_privilege('app_runtime','platform','USAGE')`
   is **false**, so both calls would fail the moment the app is repointed:

   ```sql
   grant usage on schema platform to app_runtime;
   ```

   Without this, `GetRestaurantPlan` / the account-status check swallow the
   error and fail **open** (every tenant silently drops to an empty plan — all
   feature flags unset, all limits unenforced). It is a silent degradation, not
   a crash, which is exactly why it must be granted before the cutover.

2. **DDL.** `app_runtime` is `NOSUPERUSER … NOBYPASSRLS` with no DDL rights,
   and the app still creates a handful of tables/columns lazily
   (`ensureLazyTable`, `ensure*Columns`). Those paths already treat
   `42501 insufficient_privilege` as "already provisioned"
   (`database_supabase.ts` ~1209-1218), so they degrade cleanly — **but only if
   the schema is actually there**. Run `npm run migrate` with the owner URL
   first, and confirm on staging that no lazy table is missing.

## Step 3 — rehearse on staging, in this order

1. Restore a staging copy of production.
2. Apply steps 1 and 2 there.
3. Repoint the three runtime URLs; leave `MIGRATION_DATABASE_URL` on the owner.
4. Boot with `ENFORCE_RLS_AT_BOOT=true` and confirm the log now reads
   `[rls-check] OK — runtime role "app_runtime" does not bypass RLS.`
5. Run `npm run test:isolation` (`test/tenant_isolation_test.ts`) plus a manual
   pass over: employee login (plan resolution), the POS order → bill → settle
   path, the KDS board, analytics, the public QR/guest pages, and the whole
   `/platform/*` console.
6. Confirm the isolation probe: inside a connection as `app_runtime` with
   `select set_config('app.res_id','00000000-0000-0000-0000-000000000000',false)`,
   `select count(*) from "Menu"` must return **0** (as `postgres` today it
   returns 57).

## Step 4 — production cutover

Maintenance window, because every pooled connection has to be re-established:

1. Set `MIGRATION_DATABASE_URL` to the existing owner URL.
2. Apply steps 1 and 2 against production.
3. Swap `SUPABASE_DIRECT_URL`, `SUPABASE_IPV4_URL`, `PLATFORM_DATABASE_URL`.
4. Restart the backend (do **not** set `ENFORCE_RLS_AT_BOOT=true` yet).
5. Watch the log for `[rls-check] OK`, then smoke-test login, an order, a
   settle and the platform console.
6. Only once that is green, set `ENFORCE_RLS_AT_BOOT=true` so a future
   regression back onto an RLS-bypassing role cannot boot silently.

**Rollback:** put the three URLs back to the `postgres` credentials and
restart. The role/grant changes in steps 1-2 are additive and safe to leave in
place; nothing about them affects the owner connection.

## Do not do

- Do not `alter role postgres nobypassrls` — Supabase's own tooling connects as
  that role.
- Do not repoint one URL and leave the others: `SUPABASE_IPV4_URL` is the
  automatic fallback pool, so a half-migration means isolation is enforced only
  until the primary pool blips.
- Do not run this from an agent/automation session against the live database.
