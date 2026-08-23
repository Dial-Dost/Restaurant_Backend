# Deploy order: migrations that must land before the code

Most migrations in this repo are additive and order-insensitive relative to the
code — a route that reads a new column simply does not exist yet in the old
build. A few are different: the code ships a *user-visible promise* whose
enforcement lives entirely in SQL. If the SQL is missing, the button works, says
it worked, and does nothing. Those belong here.

## `028_restaurant_archived_status.sql` — tenant archiving

**Apply before the build containing `POST /platform/restaurants/:id/archive`
serves traffic.**

### What breaks without it

Archiving writes `"Restaurant".account_status = 'archived'`. Nothing enforces
that value directly. Every enforcement point asks the SQL function
`platform.restaurant_status(uuid)`:

| Enforcement point | File |
|---|---|
| staff login refused | `routes/auth.ts:141` |
| guest QR / aggregator writes refused | `routes/_shared.ts` (`restaurantAcceptsGuestWrites`) |
| scheduled reports skipped | `report_schedules.ts:215` |

Migration 011's version of that function matches the literal `'suspended'` and
**falls through to `'active'` for anything else**. So on a database without 028,
an archived restaurant reads as ACTIVE: its staff keep signing in, its QR keeps
taking orders, its reports keep being delivered — while the operator console
shows it greyed out as Archived. The operator believes a tenant is gone while it
is still trading.

### What the code does about it

Two guards, so this cannot be discovered by a customer:

1. **The archive route refuses.** `archivedStatusSupported()` (`platform/db.ts`)
   reads `pg_proc.prosrc` for `platform.restaurant_status` and looks for the
   `account_status = 'archived'` arm. Missing → `503` naming the migration, and
   nothing is written. The check is memoised only on success, so applying the
   migration takes effect without a restart.
2. **Boot logs a banner.** `bootstrap()` in `index.ts` logs
   `Tenant archiving available (migration 028 applied)` or an error explaining
   exactly what is inert. It is a warning, not a hard failure — every other
   feature works fine without 028, and refusing to boot would take a fleet down
   to protect one button.

### Why this is a manual step

`Dockerfile.node`'s `CMD` is `node build/index.js`, **not** `npm run start:prod`
(the only script that chains `npm run migrate`). The container deploy path
therefore never applies migrations. Use one of:

```bash
# release / pre-deploy step, once per deploy, as the OWNER role
npm run migrate

# check first, without applying
npm run migrate:dry
```

`MIGRATION_DATABASE_URL` must point at an owner/superuser role — `app_runtime`
and `platform_runtime` intentionally lack DDL privileges.

### Rollback

028 is a single `CREATE OR REPLACE FUNCTION` with no `ALTER TABLE`, no data
write and no new column. Rolling back is re-running `011_billing_grace.sql`,
which replaces the same signature. Any restaurant already flagged `'archived'`
then reverts to reading as `'active'` — so roll the *code* back with it, or the
silent-trading failure above returns.

---

## How CI enforces this

Since the CI/CD pipeline landed, "apply migrations manually" is no longer a
convention you have to remember — it is a gate that stops the deploy.

`.github/workflows/deploy.yml` and the VPS wrapper `/usr/local/sbin/rd-deploy`
between them will **never** apply a migration. They detect pending ones and
refuse. (The wrapper is **not** in this repository and deliberately is not
shipped from it — it is root-owned on the box and installing it from a git
checkout would overwrite a vetted security boundary. The grammar this pipeline
is written against is recorded in `deploy/vps/WRAPPER_CONTRACT.md`.)

* **Gate A**, in CI, after the images are built: does this push add or change
  anything under `migrations/`? If so the deploy is refused and the job summary
  names the files and prints the exact `docker run ... npm run migrate` command,
  using the digest of the image just built. Gate A needs two commits to diff, so
  it evaluates on **push runs only** and skips on `workflow_dispatch` — which is
  also how you re-run a deploy after applying a migration by hand. Until the
  push trigger is enabled (`deploy.yml` ships dispatch-only in its first commit,
  see the `on:` block there), Gate A always skips and Gate B is the only gate.
* **Gate B**, on the VPS inside `rd-deploy`, before any container is swapped:
  `npm run migrate:dry` executed **inside the new image**, against
  `/opt/restaurant-dash/.env.migrate` (root-only, never in GitHub). Pending
  migrations abort the deploy with exit 65, having changed nothing. This one is
  authoritative — it catches a migration added in an earlier push that nobody
  applied, which Gate A cannot see.

Two details that matter and are easy to get wrong:

* **Run the migration from the NEW image.** `migrations/` is baked into
  `Dockerfile.node`, so `npm run migrate` inside the currently-deployed
  container compares the *old* file set and reports success without doing
  anything. Gate B runs the dry run in the new image for exactly this reason.
* **`--dry-run` is not strictly read-only.** `scripts/migrate.ts` issues
  `create table if not exists schema_migrations` before it lists anything, so a
  SELECT-only role fails the gate. `MIGRATION_DATABASE_URL` must be the
  owner/migration role — as this document already says, `app_runtime` and
  `platform_runtime` intentionally lack DDL privileges.

Full runbook, including how to apply a migration and re-run the deploy:
`deploy/vps/README.md`.
