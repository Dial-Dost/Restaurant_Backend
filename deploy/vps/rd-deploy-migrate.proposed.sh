#!/bin/bash
# =============================================================================
# rd-migrate — PROPOSED. NOT INSTALLED. Reviewable source for a new wrapper verb.
#
# Installed path (once a human approves it): /usr/local/sbin/rd-migrate,
# root:root 0755. It is reached ONLY through one new arm in the already-vetted
# /usr/local/sbin/rd-deploy:
#
#       migrate)
#         [ $# -eq 1 ] || exit 64          # takes no service, no arguments
#         exec /usr/local/sbin/rd-migrate
#         ;;
#
# THAT ARM IS THE ENTIRE EDIT TO THE VETTED WRAPPER. This file is deliberately a
# separate program rather than a block spliced into rd-deploy, for two reasons:
# the change to the security boundary stays a three-line diff a reviewer can hold
# in their head, and this file — unlike rd-deploy — lives in git, so it can be
# diffed, re-reviewed and blamed. See WRAPPER_CONTRACT.md, "The `migrate` verb".
#
# WHY THIS EXISTS
# -----------------------------------------------------------------------------
# deploy/vps/README.md gated migrations out of the pipeline with one sentence:
#
#     "The production database has no PITR, so an auto-applied migration is an
#      unrecoverable event a health check cannot see."
#
# That is a statement about the RESTORE PATH, not about migrations. This program
# is an attempt to create the missing restore path and nothing more. It takes a
# verified dump before it applies anything and refuses to apply if the dump did
# not work. If you delete or weaken that half, put the gate back — the gate was
# never the point, the absence of a way back was.
#
# READ THIS BEFORE APPROVING — one deliberate deviation from the brief
# -----------------------------------------------------------------------------
# The brief said "on failure, restore from the dump". THE DEFAULT HERE IS NOT
# THAT. By default a failed migration exits 67 and restores NOTHING. Reasons, in
# the order they matter:
#
#   1. scripts/migrate.ts applies each file in its OWN transaction and rolls that
#      transaction back on error. So a failed run is already in a KNOWN state:
#      the files before the failure are applied, the failing file is not, and the
#      files after it were never attempted. Nothing is half-written.
#   2. The dump is taken while the restaurant is trading. Restoring it rewinds
#      every order, payment, KOT and clock-in taken between the dump and the
#      restore. At 9pm on a Friday that is real money that was really collected,
#      deleted to undo a DDL statement that already rolled itself back. The
#      automatic restore turns a recoverable event into an unrecoverable one —
#      which is the exact sentence the original gate was written to prevent.
#   3. `pg_restore --clean` against a MANAGED Postgres also touches objects this
#      project does not own (extensions, Supabase's own schemas). Deciding what
#      to do about those belongs to a human looking at the error.
#
# The restore routine is still here, complete and reviewed, because the worst
# time to write one is during the incident. It runs only when a root-owned flag
# file exists on the box (see AUTORESTORE_FLAG). Turning it on is a deliberate,
# documented act, not a default.
#
# WHAT THIS DOES NOT PROTECT AGAINST — stated plainly, do not oversell it
# -----------------------------------------------------------------------------
#   * IN-FLIGHT WRITES. pg_dump takes a consistent snapshot of the moment it
#     starts, not a lock on the business. Every write committed after that point
#     is outside the dump. The dump is a rollback point for a SCHEMA change, not
#     a backup, and it is not offsite.
#   * A MIGRATION THAT SUCCEEDS AND IS WRONG. If the SQL runs cleanly and
#     silently corrupts meaning — a bad UPDATE, a DEFAULT applied to the wrong
#     column, a dropped constraint — every check in this file passes and the
#     deploy goes green. Nothing here reads semantics.
#   * ROLES, GRANTS AND ANYTHING CLUSTER-WIDE. `pg_dump` is one database. Role
#     definitions and cluster settings are `pg_dumpall --globals-only`, which
#     this does not run and which a managed provider may not permit at all. A
#     migration that alters roles is outside this rollback point.
#   * THE DISK NEXT YEAR. The free-space check below compares against TODAY'S
#     dump. The database grows; the check does not learn. It refuses rather than
#     filling the disk, but "refuses" during a release is still an outage of the
#     pipeline, and nobody is watching that number.
#   * A DUMP THAT IS READABLE BUT USELESS. `pg_restore --list` proves the archive
#     header and table of contents parse and that a known table is present. It
#     does NOT read the data blocks. A dump has never been restore-tested against
#     this database. DO THAT ONCE, DELIBERATELY, INTO A SCRATCH DATABASE, BEFORE
#     TRUSTING ANY OF THIS. Until that has happened this file is an untested
#     seatbelt, and the honest thing is to say so here rather than in an incident.
#   * CONCURRENT SCHEMA CHANGES BY A HUMAN. The flock below serialises this
#     program against itself. It does not stop someone in psql.
#
# ARGUMENTS: THERE ARE NONE. Every path, image and limit below is a constant.
# The caller supplies nothing, so there is nothing to inject. Any argument at
# all is exit 64.
# =============================================================================
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

# ---------------------------------------------------------------------------
# CONSTANTS — the entire configuration of this program.
# ---------------------------------------------------------------------------
APP_DIR=/opt/restaurant-dash
REPO_DIR="$APP_DIR/Restaurant_Backend"

# Root-only, holds MIGRATION_DATABASE_URL for the OWNER role. Never leaves the
# box; CI cannot read it and cannot ask for it.
ENV_FILE="$APP_DIR/.env.migrate"

# The image ALREADY DEPLOYED. Deliberately not a fresh build: building would tag
# restaurant-dash-backend:latest with the NEW code, and the `update` that follows
# would then tag that as :previous — destroying the rollback target you are
# migrating in order to be able to reach. The new migrations/ is supplied by the
# read-only bind mount instead. (deploy/vps/README.md, "Applying a migration".)
BACKEND_IMAGE=restaurant-dash-backend:latest

# pg_dump/pg_restore. MUST be >= the server's major version or pg_dump refuses.
# Verified present at install time and NEVER pulled here: a release step must not
# depend on a registry being up, and an image pulled mid-incident is an unvetted
# image. `docker image inspect` failing is a refusal, not a fetch.
PGTOOLS_IMAGE=postgres:17-alpine

DUMP_DIR=/var/backups/restaurant-dash/premigration
LOCK_FILE=/var/lock/rd-migrate.lock

# Opt-in, root-owned, on the box. Its EXISTENCE enables the automatic restore
# described in the header. Absent (the default) = a failed migration halts and
# waits for a human. See "one deliberate deviation" above before creating it.
AUTORESTORE_FLAG="$APP_DIR/.rd-migrate-autorestore"

# RETENTION. A dump is written ONLY when there is something to apply, i.e. about
# once per release that carries SQL — call it one or two a month at this
# project's cadence. Ten therefore spans several months of releases, which is
# well past the point where the correct recovery is "restore the schema" rather
# than "roll forward", while bounding the directory at ten copies of the
# database. Raise it only after checking `df`; the free-space guard below refuses
# a dump rather than filling the disk, and a full /var takes the box down.
KEEP=10

# A dump smaller than this is not a dump of THIS database. It is a floor against
# a truncated or empty file, NOT a size assertion.
#
# 1 MiB was the first guess and it was WRONG: the production database compresses
# to ~928 KB, so the very first real run refused a perfectly good dump with
# exit 66 and applied nothing. That failure was safe but it was noise, and the
# fix is not to trust the number more — it is to keep this crude check well
# clear of reality and let the REAL verification below do the work.
# `pg_restore --list` is what actually proves the archive is readable; this only
# catches the zero-byte and obviously-truncated cases before we get there.
MIN_DUMP_BYTES=$((256 * 1024))

# Refuse to start a dump without this much free space. See the "disk next year"
# caveat in the header — this number does not learn.
MIN_FREE_KB=$((2 * 1024 * 1024))

# A fixed in-container filename so the `sh -c` strings below contain NO shell
# interpolation whatsoever. The host renames it afterwards.
TMP_DUMP=rd-premigration.tmp.dump

# A table that must appear in the dump's table of contents. Its absence means
# the dump succeeded against the WRONG database, which a size check cannot see.
SENTINEL_TABLE=Orders

# The two sentences scripts/migrate.ts prints. This program keys on them, so
# they are a contract: if that file's wording changes, THIS breaks and the
# unrecognised-output branch refuses rather than guessing.
PENDING_MARKER='pending migration(s):'
CLEAN_MARKER='already applied. Nothing to do.'

# ---- exit codes, in the style WRAPPER_CONTRACT.md already uses --------------
EX_USAGE=64             # arguments, or not root. Nothing was touched.
EX_REFUSED=66           # refused BEFORE the database was written to.
EX_FAILED_NOT_RESTORED=67   # migrate failed. NOT restored (the default).
EX_RESTORE_FAILED=68    # migrate failed AND the restore failed. Incident.
EX_LOCKED=75            # another rd-migrate holds the lock. Matches the flock
                        # convention README.md already proposes for rd-deploy.
EX_STILL_PENDING=77     # migrate reported success, the re-check disagrees.

LOG=""
log() {
  printf '%s\n' "$*"
  [ -n "$LOG" ] && printf '%s\n' "$*" >>"$LOG"
  return 0
}
die() { # <exit-code> <message...>
  local code="$1"; shift
  log ""
  log "rd-migrate: REFUSED ($code): $*"
  exit "$code"
}

# ---------------------------------------------------------------------------
# 0. No arguments, ever. Root only.
# ---------------------------------------------------------------------------
[ "$#" -eq 0 ] || { printf 'rd-migrate: takes no arguments\n' >&2; exit "$EX_USAGE"; }
[ "$(id -u)" -eq 0 ] || { printf 'rd-migrate: must run as root\n' >&2; exit "$EX_USAGE"; }

# ---------------------------------------------------------------------------
# 1. ONE AT A TIME. Two concurrent migration runs against one database is the
#    single worst thing in this file's blast radius: both read the same pending
#    list, both apply it, and the loser's transaction fails somewhere in the
#    middle. Non-blocking on purpose — a caller that has to wait should be told
#    to come back, not silently queued behind a run it cannot see.
# ---------------------------------------------------------------------------
exec 9>"$LOCK_FILE"
flock -n 9 || { printf 'rd-migrate: another run holds %s\n' "$LOCK_FILE" >&2; exit "$EX_LOCKED"; }

# ---------------------------------------------------------------------------
# 2. PRE-FLIGHT. Every one of these is a refusal (66) with the database
#    untouched. None of them can be satisfied by retrying.
# ---------------------------------------------------------------------------
[ -d "$REPO_DIR/migrations" ] || die "$EX_REFUSED" "$REPO_DIR/migrations does not exist. Has 'rd-deploy update backend' ever run on this box?"

[ -f "$ENV_FILE" ] || die "$EX_REFUSED" "$ENV_FILE is missing. It holds MIGRATION_DATABASE_URL for the owner role and is a deliberate human step (deploy/vps/README.md)."
env_perm="$(stat -c '%U:%G %a' "$ENV_FILE")"
case "$env_perm" in
  "root:root 600"|"root:root 400") ;;
  *) die "$EX_REFUSED" "$ENV_FILE is $env_perm — expected root:root 600. It holds an owner-role database URL; refusing to use a credential anyone else can read." ;;
esac

# Read the URL WITHOUT sourcing the file. Sourcing an env file executes it, and
# this one is a credential store, not a script. Last assignment wins, matching
# how docker's --env-file resolves duplicates.
CONN="$(sed -n 's/^[[:space:]]*MIGRATION_DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n1 | tr -d '\r')"
CONN="${CONN%\"}"; CONN="${CONN#\"}"
CONN="${CONN%\'}"; CONN="${CONN#\'}"
[ -n "$CONN" ] || die "$EX_REFUSED" "MIGRATION_DATABASE_URL is not set in $ENV_FILE. (The value is never printed by this program.)"
case "$CONN" in
  postgres://*|postgresql://*) ;;
  *) die "$EX_REFUSED" "MIGRATION_DATABASE_URL in $ENV_FILE is not a postgres:// or postgresql:// URL." ;;
esac

command -v docker >/dev/null 2>&1 || die "$EX_REFUSED" "docker is not on PATH."
docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1 \
  || die "$EX_REFUSED" "image $BACKEND_IMAGE is not present. Nothing has been deployed on this box yet, and this program will not build one — building would overwrite the :previous rollback target."
docker image inspect "$PGTOOLS_IMAGE" >/dev/null 2>&1 \
  || die "$EX_REFUSED" "image $PGTOOLS_IMAGE is not present, and this program does NOT pull. Pre-pull it as part of the one-time install: docker pull $PGTOOLS_IMAGE"

# deploy/vps/README.md flagged this as an UNPROVEN assumption of the manual
# recipe. Here it is a checked precondition instead of a hope.
workdir="$(docker image inspect -f '{{.Config.WorkingDir}}' "$BACKEND_IMAGE" 2>/dev/null || true)"
[ "$workdir" = "/app" ] || die "$EX_REFUSED" "$BACKEND_IMAGE has WorkingDir '$workdir', expected '/app'. The migrations bind mount below targets /app/migrations and would land somewhere else."

install -d -m 0700 -o root -g root "$DUMP_DIR"
# `|| true` so an unreadable df produces the message below rather than a bare
# `set -e` exit with no explanation. The case immediately after is the real check.
free_kb="$(df -Pk "$DUMP_DIR" | awk 'NR==2 {print $4}' || true)"
case "$free_kb" in
  ''|*[!0-9]*) die "$EX_REFUSED" "could not read free space on $DUMP_DIR." ;;
esac
[ "$free_kb" -ge "$MIN_FREE_KB" ] \
  || die "$EX_REFUSED" "only ${free_kb}KB free on $DUMP_DIR, need ${MIN_FREE_KB}KB. Prune old dumps by hand — a full /var takes this box down, which is worse than a late migration."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$DUMP_DIR/$STAMP.log"
: >"$LOG"; chmod 600 "$LOG"
log "rd-migrate $STAMP (UTC)"
log "  repo   $REPO_DIR"
log "  image  $BACKEND_IMAGE"
log "  dumps  $DUMP_DIR (keeping $KEEP)"
log ""

# ---------------------------------------------------------------------------
# The two container invocations. Both `sh -c` strings are FULLY LITERAL — no
# variable of any kind is interpolated into them, so there is no quoting bug to
# find and nothing a caller could influence even if it could reach one.
#
# The connection URL is passed by INHERITED ENVIRONMENT (`-e RD_PGCONN`, no
# `=value`), never as an argument. An argument would put an owner-role password
# in the host's process table, where every user on the box can read it.
# ---------------------------------------------------------------------------
migrate_run() { # <npm-script>   e.g. migrate / migrate:dry
  docker run --rm \
    --env-file "$ENV_FILE" \
    -v "$REPO_DIR/migrations":/app/migrations:ro \
    "$BACKEND_IMAGE" npm run "$1"
}

# ---------------------------------------------------------------------------
# 3. WHAT IS PENDING? Read-only apart from `create table if not exists
#    schema_migrations`, which scripts/migrate.ts issues before it lists
#    anything (docs/DEPLOY_ORDER.md says the same). Nothing else is written.
#
#    Note the bind mount: migrations/ is BAKED INTO the image, so without it the
#    deployed image would compare the OLD file set and cheerfully report clean.
# ---------------------------------------------------------------------------
log "== dry run (before)"
dry_before="$DUMP_DIR/$STAMP.dry-before.txt"
if ! migrate_run migrate:dry >"$dry_before" 2>&1; then
  cat "$dry_before" | tee -a "$LOG"
  die "$EX_REFUSED" "the dry run itself failed. Nothing was applied. Likely causes, in order: an unreachable database; a MIGRATION_DATABASE_URL that is not the owner role (--dry-run issues 'create table if not exists schema_migrations', so a SELECT-only role fails right here); or $REPO_DIR/migrations not being readable by uid 1000, which is the unprivileged 'node' user the image runs as."
fi
cat "$dry_before" | tee -a "$LOG"

if grep -qF "$CLEAN_MARKER" "$dry_before"; then
  log ""
  log "Nothing pending. No dump taken and no change made."
  exit 0
fi
if ! grep -qF "$PENDING_MARKER" "$dry_before"; then
  die "$EX_REFUSED" "the dry run produced output this program does not recognise — neither '$PENDING_MARKER' nor '$CLEAN_MARKER'. Refusing to guess. Someone has changed scripts/migrate.ts's wording; reconcile it with this file."
fi
PENDING_LIST="$(sed -n 's/^  - //p' "$dry_before")"
log ""
log "Pending:"
log "$PENDING_LIST"

# ---------------------------------------------------------------------------
# 4. THE RESTORE PATH, BEFORE ANYTHING IS APPLIED.
#
#    This is the whole reason the gate existed and the whole reason this program
#    is allowed to exist. If any part of it fails, NOTHING is applied.
# ---------------------------------------------------------------------------
log ""
log "== dump"
rm -f "$DUMP_DIR/$TMP_DUMP"
dump_rc=0
RD_PGCONN="$CONN" docker run --rm \
  -e RD_PGCONN \
  -v "$DUMP_DIR":/out \
  --entrypoint sh \
  "$PGTOOLS_IMAGE" \
  -c 'exec pg_dump --dbname="$RD_PGCONN" --format=custom --compress=6 --no-owner --no-privileges --file=/out/rd-premigration.tmp.dump' \
  >>"$LOG" 2>&1 || dump_rc=$?

if [ "$dump_rc" -ne 0 ]; then
  rm -f "$DUMP_DIR/$TMP_DUMP"
  tail -n 40 "$LOG"
  die "$EX_REFUSED" "pg_dump exited $dump_rc. NOTHING WAS APPLIED. If it says 'server version ... pg_dump version ... aborting', the server has been upgraded past $PGTOOLS_IMAGE — bump PGTOOLS_IMAGE, pull it, and re-run. Output is in $LOG."
fi

# Verification, in the order a bad dump actually fails: missing, empty, then
# structurally unreadable, then a dump of something else entirely.
[ -f "$DUMP_DIR/$TMP_DUMP" ] || die "$EX_REFUSED" "pg_dump returned 0 but wrote no file. NOTHING WAS APPLIED."
dump_bytes="$(stat -c '%s' "$DUMP_DIR/$TMP_DUMP")"
[ "$dump_bytes" -ge "$MIN_DUMP_BYTES" ] \
  || { rm -f "$DUMP_DIR/$TMP_DUMP"; die "$EX_REFUSED" "the dump is only ${dump_bytes} bytes (floor ${MIN_DUMP_BYTES}). That is not this database. NOTHING WAS APPLIED."; }

toc="$DUMP_DIR/$STAMP.toc.txt"
toc_rc=0
docker run --rm \
  -v "$DUMP_DIR":/out:ro \
  --entrypoint sh \
  "$PGTOOLS_IMAGE" \
  -c 'exec pg_restore --list /out/rd-premigration.tmp.dump' \
  >"$toc" 2>>"$LOG" || toc_rc=$?
if [ "$toc_rc" -ne 0 ]; then
  rm -f "$DUMP_DIR/$TMP_DUMP"
  die "$EX_REFUSED" "the dump is not readable — pg_restore --list exited $toc_rc. NOTHING WAS APPLIED."
fi
if ! grep -qw "$SENTINEL_TABLE" "$toc"; then
  rm -f "$DUMP_DIR/$TMP_DUMP"
  die "$EX_REFUSED" "the dump parses but has no '$SENTINEL_TABLE' in its table of contents, so it is a dump of the WRONG DATABASE. NOTHING WAS APPLIED."
fi

DUMP="$DUMP_DIR/$STAMP.dump"
mv -f "$DUMP_DIR/$TMP_DUMP" "$DUMP"
chmod 600 "$DUMP" "$toc"
log "dump OK: $DUMP (${dump_bytes} bytes, $(wc -l <"$toc") TOC entries)"
log "restore command, should you need it by hand:"
log "  RD_PGCONN=\"\$(sed -n 's/^MIGRATION_DATABASE_URL=//p' $ENV_FILE)\" \\"
log "  docker run --rm -e RD_PGCONN -v $DUMP_DIR:/in:ro --entrypoint sh $PGTOOLS_IMAGE \\"
log "    -c 'exec pg_restore --dbname=\"\$RD_PGCONN\" --clean --if-exists --no-owner --no-privileges --single-transaction /in/$STAMP.dump'"

# RETENTION. Names are generated by this program (an ISO-8601 UTC stamp), so they
# contain no whitespace and globbing is safe — and, more usefully, LEXICAL ORDER
# IS CHRONOLOGICAL ORDER. Sorting by name rather than by mtime is deliberate: an
# mtime is changed by a copy, a restore-test, a backup agent or a stray `touch`,
# and the failure mode of getting that wrong is deleting the NEWEST dump, i.e.
# the only one that matters. The name cannot drift.
#
# Newest KEEP survive; each dump's sidecars go with it.
#
# The list is built into a variable first, with `|| true`: `set -o pipefail` plus
# `set -e` would otherwise turn "the glob matched nothing" into a silent abort of
# the whole program AFTER the migration had already been applied — the retention
# tail is the last place that should be able to fail a run.
# shellcheck disable=SC2012
prunable="$(ls -1 "$DUMP_DIR"/*.dump 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) || true)"
printf '%s\n' "$prunable" | while read -r old; do
  [ -n "$old" ] || continue
  base="${old%.dump}"
  log "retention: removing $(basename "$old") and its sidecars"
  rm -f "$old" "$base.log" "$base.toc.txt" "$base.dry-before.txt" "$base.dry-after.txt"
done

# ---------------------------------------------------------------------------
# 5. APPLY.
# ---------------------------------------------------------------------------
log ""
log "== apply"
apply_out="$DUMP_DIR/$STAMP.apply.txt"
apply_rc=0
migrate_run migrate >"$apply_out" 2>&1 || apply_rc=$?
cat "$apply_out" | tee -a "$LOG"

# ---------------------------------------------------------------------------
#    THE RESTORE ROUTINE. Off by default — see the header.
#
#    --single-transaction is what makes an automated attempt tolerable at all:
#    it implies --exit-on-error, so the restore either fully succeeds or changes
#    NOTHING. There is no half-restored outcome. What it does not fix is the
#    thing the header says: it rewinds live trading data, and it holds one long
#    transaction against a pooled connection while it does so.
# ---------------------------------------------------------------------------
attempt_restore() { # -> 0 restored, 1 refused (flag absent), 2 attempted and failed
  if [ ! -f "$AUTORESTORE_FLAG" ]; then
    return 1
  fi
  log ""
  log "!! $AUTORESTORE_FLAG exists — ATTEMPTING AN AUTOMATIC RESTORE FROM $DUMP"
  log "!! Every write committed since $STAMP will be lost."
  local rc=0
  RD_PGCONN="$CONN" docker run --rm \
    -e RD_PGCONN \
    -v "$DUMP":/in/restore.dump:ro \
    --entrypoint sh \
    "$PGTOOLS_IMAGE" \
    -c 'exec pg_restore --dbname="$RD_PGCONN" --clean --if-exists --no-owner --no-privileges --single-transaction /in/restore.dump' \
    >>"$LOG" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] && return 0
  log "!! pg_restore exited $rc"
  return 2
}

if [ "$apply_rc" -ne 0 ]; then
  log ""
  log "!! MIGRATION FAILED (npm run migrate exited $apply_rc)."
  log "!! scripts/migrate.ts runs each file in its own transaction and rolled the"
  log "!! failing one back, so the database is in a KNOWN state: everything before"
  log "!! the failure is applied, the failing file is not, nothing after it ran."
  log "!! Dump taken before any of it: $DUMP"
  restore_rc=0
  attempt_restore || restore_rc=$?
  case "$restore_rc" in
    0)
      log "!! RESTORED from $DUMP. The database is back at $STAMP and every write"
      log "!! committed after that moment is GONE. Do not deploy. Find out what the"
      log "!! migration did, then decide whether to replay anything."
      die "$EX_FAILED_NOT_RESTORED" "migration failed and the database WAS restored from $DUMP — writes since $STAMP are lost. Do not deploy; page a human."
      ;;
    1)
      log "!! NOT RESTORED. $AUTORESTORE_FLAG does not exist, which is the default"
      log "!! and the recommended setting. The failing file rolled itself back."
      log "!! Read $apply_out, fix the SQL, and decide by hand. The dump above is"
      log "!! the rollback point; the exact pg_restore command is earlier in this log."
      die "$EX_FAILED_NOT_RESTORED" "migration failed (exit $apply_rc). NOT restored, by design. The failing file rolled back; earlier files in this run ARE applied. Dump: $DUMP. Log: $LOG."
      ;;
    *)
      # THE CASE THAT ENDS UP IN AN INCIDENT, decided in advance:
      # do not retry, do not fall back, do not delete the dump, and do not let
      # anything downstream treat this as a survivable failure.
      log "!! ================================================================"
      log "!! THE RESTORE ALSO FAILED. STOP."
      log "!! --single-transaction means the restore was all-or-nothing, so the"
      log "!! most likely truth is that NOTHING was restored and the database is"
      log "!! still in the post-failure state above. That is a likelihood, NOT a"
      log "!! guarantee — treat the schema as INDETERMINATE until a human reads it."
      log "!! The dump is intact at $DUMP and this program will not touch it."
      log "!! DO NOT re-run rd-migrate. DO NOT deploy. Read $LOG, then restore by"
      log "!! hand with the command printed above so a person sees the errors."
      log "!! ================================================================"
      die "$EX_RESTORE_FAILED" "MIGRATION FAILED AND THE RESTORE FAILED. Schema state is indeterminate. Dump intact at $DUMP. Do not re-run and do not deploy — this needs a human at a psql prompt."
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 6. PROVE IT. The apply returning 0 is the runner's own opinion; ask again.
#    A `check-migrations` that still says pending after a successful apply means
#    the two are looking at different file sets or different databases, and a
#    deploy must not follow it.
# ---------------------------------------------------------------------------
log ""
log "== dry run (after)"
dry_after="$DUMP_DIR/$STAMP.dry-after.txt"
after_rc=0
migrate_run migrate:dry >"$dry_after" 2>&1 || after_rc=$?
cat "$dry_after" | tee -a "$LOG"
if [ "$after_rc" -ne 0 ] || ! grep -qF "$CLEAN_MARKER" "$dry_after"; then
  die "$EX_STILL_PENDING" "'npm run migrate' reported success but the re-check does not say clean (exit $after_rc). Something is inconsistent between the runner and the database — DO NOT DEPLOY. Dump: $DUMP. Log: $LOG."
fi

log ""
log "Applied:"
log "$PENDING_LIST"
log "Verified clean. Dump retained at $DUMP."
exit 0
