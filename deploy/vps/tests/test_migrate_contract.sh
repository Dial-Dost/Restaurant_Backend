#!/usr/bin/env bash
# Guards the `migrate` verb: the proposed wrapper, the forced command's grammar,
# and the workflow's routing of rd-migrate's exit codes.
#
# WHY THIS EXISTS
# ---------------
# `migrate` is the first verb in this design that WRITES TO THE PRODUCTION
# DATABASE, and three of its moving parts are undeclared dependencies of each
# other that nothing else checks:
#
#   1. rd-migrate keys on two SENTENCES scripts/migrate.ts prints, because that
#      script exits 0 whether or not migrations are pending. Reword either
#      sentence and the wrapper stops being able to tell "clean" from "pending".
#      It is written to REFUSE on unrecognised output rather than guess, so the
#      failure is safe — but it is silent until a release, and this catches it
#      on every push instead.
#   2. deploy.yml routes rd-migrate's exit codes. Getting 64 wrong is the same
#      class of bug that once reported a missing forced command (127) as a
#      PENDING MIGRATION: 64 means "the box has not had the verb installed yet",
#      and the generic handler would call that a bug in the workflow file and
#      send someone to read YAML instead of running one install command.
#   3. rd-entry must accept `migrate` and must still refuse `migrate <service>`.
#      There is ONE database behind all three services; a service argument would
#      be a lie the grammar accepted.
#
# Like test_status_parser.sh, everything here is EXTRACTED from the real files at
# run time and never retyped — a retyped copy drifts and then guards nothing. It
# touches no server, no docker, no network and no database.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$VPS_DIR/../.." && pwd)"

PROPOSED="$VPS_DIR/rd-deploy-migrate.proposed.sh"
ENTRY="$VPS_DIR/rd-entry"
MIGRATE_TS="$REPO_ROOT/scripts/migrate.ts"
WF="$REPO_ROOT/.github/workflows/deploy.yml"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$*"; }
need() { [ -r "$1" ] || { printf 'not readable: %s\n' "$1" >&2; exit 2; }; }

need "$PROPOSED"; need "$ENTRY"; need "$MIGRATE_TS"; need "$WF"

# ===========================================================================
printf '\n== rd-migrate takes NO arguments and runs only as root ==\n'
printf '   -- every path, image and limit is a constant; an argument is an\n'
printf '      injection surface, so there are none --\n'
# ===========================================================================
for args in "backend" "python" "--force" "a b" "; sh"; do
  bash "$PROPOSED" $args >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 64 ] && ok "argument '$args' -> 64" || bad "argument '$args' -> $rc, expected 64"
done
# Runs as an unprivileged user here, so this exercises the root check. On the box
# it is reached through sudo and passes.
bash "$PROPOSED" >/dev/null 2>&1
rc=$?
if [ "$(id -u)" -ne 0 ]; then
  [ "$rc" -eq 64 ] && ok "non-root -> 64" || bad "non-root -> $rc, expected 64"
else
  printf '  skip running as root: the no-argument path would touch the box\n'
fi

# ===========================================================================
printf '\n== the two sentences rd-migrate keys on are the ones migrate.ts prints ==\n'
printf '   -- scripts/migrate.ts EXITS 0 whether or not anything is pending, so\n'
printf '      these strings are the only way to tell the two apart --\n'
# ===========================================================================
# Pull the constants out of the proposed script rather than retyping them.
eval "$(grep -E "^(PENDING_MARKER|CLEAN_MARKER|SENTINEL_TABLE|KEEP)=" "$PROPOSED")"

if grep -qF "$PENDING_MARKER" "$MIGRATE_TS"; then
  ok "PENDING_MARKER '$PENDING_MARKER' appears in scripts/migrate.ts"
else
  bad "PENDING_MARKER '$PENDING_MARKER' is NOT in scripts/migrate.ts."
  printf '       rd-migrate would stop recognising a PENDING dry run. It refuses rather\n'
  printf '       than guessing, so a release would stop dead. Reconcile the two files.\n'
fi
if grep -qF "$CLEAN_MARKER" "$MIGRATE_TS"; then
  ok "CLEAN_MARKER '$CLEAN_MARKER' appears in scripts/migrate.ts"
else
  bad "CLEAN_MARKER '$CLEAN_MARKER' is NOT in scripts/migrate.ts."
  printf '       rd-migrate would stop recognising a CLEAN database, and its post-apply\n'
  printf '       verification (exit 77) could never pass. Reconcile the two files.\n'
fi
# The two must never both match the same line, or "clean" and "pending" collapse.
if grep -F "$PENDING_MARKER" "$MIGRATE_TS" | grep -qF "$CLEAN_MARKER"; then
  bad "one line of migrate.ts contains BOTH markers — they no longer discriminate"
else
  ok "the two markers never appear on the same line"
fi

# ===========================================================================
printf '\n== the pending-list parser matches migrate.ts output ==\n'
printf '   -- the names go in the job summary and the log; a parser that returns\n'
printf '      nothing makes an applied migration unattributable afterwards --\n'
# ===========================================================================
# migrate.ts prints:  console.log(`  - ${f}`)
if grep -qF '`  - ${f}`' "$MIGRATE_TS"; then
  ok "migrate.ts still prints pending names as '  - <file>'"
else
  bad "migrate.ts no longer prints '  - \${f}'. rd-migrate's PENDING_LIST parser (sed -n 's/^  - //p') will come back empty."
fi
cat >"$TMP/dry.txt" <<'EOF'
3 pending migration(s):
  - 037_tips_and_split_payments.sql
  - 038_billing_counters.sql
  - 039_menu_groups_and_variations.sql

--dry-run: no changes made.
EOF
# Extracted, not retyped.
PARSER="$(grep -F 'PENDING_LIST="$(sed' "$PROPOSED" | sed 's/.*\$(\(.*\) "\$dry_before")".*/\1/')"
got="$(eval "$PARSER" "$TMP/dry.txt")"
want=$'037_tips_and_split_payments.sql\n038_billing_counters.sql\n039_menu_groups_and_variations.sql'
[ "$got" = "$want" ] && ok "parser lists all three pending files" || bad "parser returned '$got'"

# ===========================================================================
printf '\n== retention keeps exactly KEEP dumps, and takes the sidecars with them ==\n'
printf "   -- KEEP=$KEEP. A dump is a full copy of the production database; the\n"
printf '      failure this prevents is a full /var, which takes the box down --\n'
# ===========================================================================
DUMP_DIR="$TMP/dumps"; mkdir -p "$DUMP_DIR"
# Names are ISO-8601 UTC stamps, so lexical order IS chronological order — which
# is exactly the property retention relies on. Zero-pad so that is true for the
# test data too. Deliberately NO `touch`: if retention ever goes back to sorting
# by mtime, these files are all the same age and the "newest survived" assertion
# below starts failing at random, which is how you find out.
NEWEST=""
for i in $(seq 1 $((KEEP + 3))); do
  base="$(printf '%s/202601%02dT000000Z' "$DUMP_DIR" "$i")"
  : >"$base.dump"; : >"$base.log"; : >"$base.toc.txt"; : >"$base.dry-before.txt"
  NEWEST="$base.dump"
done
log() { :; }
# Extract the retention block from the proposed script rather than retyping it.
awk '/^prunable="\$\(ls -1 "\$DUMP_DIR"/,/^done$/' "$PROPOSED" >"$TMP/retention.sh"
[ -s "$TMP/retention.sh" ] && ok "retention block extracted from the proposed script" \
                           || bad "could not extract the retention block — the anchors moved"
# shellcheck disable=SC1090
. "$TMP/retention.sh"
left="$(find "$DUMP_DIR" -name '*.dump' | wc -l | tr -d ' ')"
[ "$left" -eq "$KEEP" ] && ok "$((KEEP + 3)) dumps -> $left kept" || bad "expected $KEEP dumps left, found $left"
orphans="$(find "$DUMP_DIR" -name '*.log' -o -name '*.toc.txt' -o -name '*.dry-before.txt' | wc -l | tr -d ' ')"
[ "$orphans" -eq $((KEEP * 3)) ] && ok "sidecars deleted with their dump (no orphans)" \
                                 || bad "expected $((KEEP * 3)) sidecars, found $orphans"
# The NEWEST must survive and the OLDEST must go. Deleting the wrong end is the
# only retention bug that costs anything, and it is invisible until an incident.
[ -f "$NEWEST" ] && ok "the newest dump survived" \
                 || bad "the newest dump was DELETED. Retention is keeping the OLDEST — the one dump that can still roll back today's migration is the one it throws away."
[ -f "$DUMP_DIR/20260101T000000Z.dump" ] && bad "the oldest dump survived — retention deleted the wrong end" \
                                         || ok "the oldest dump was pruned"

# ===========================================================================
printf '\n== rd-entry: migrate is accepted, and takes no service ==\n'
# ===========================================================================
entry() { SSH_ORIGINAL_COMMAND="$1" bash "$ENTRY" >/dev/null 2>&1; echo $?; }
# `migrate` alone reaches the final `exec sudo ... rd-deploy`, which does not
# exist off the box — so anything OTHER than 64 means rd-entry accepted it.
rc="$(entry 'migrate')"
[ "$rc" -ne 64 ] && ok "'migrate' is accepted by rd-entry (reached the wrapper, rc=$rc)" \
                 || bad "'migrate' was REJECTED by rd-entry. The workflow's auto path can never run."
for c in 'migrate backend' 'migrate dashboard' 'migrate python' 'migrate valkey' 'migrate all'; do
  rc="$(entry "$c")"
  [ "$rc" -eq 64 ] && ok "'$c' -> 64 (one database, not one per service)" \
                   || bad "'$c' -> $rc, expected 64"
done

# ===========================================================================
printf '\n== deploy.yml routes rd-migrate exit codes to the right diagnosis ==\n'
printf '   -- extracted from the workflow at run time, never retyped --\n'
# ===========================================================================
awk '/^          migrate_now \(\) \{/,/^          \}$/' "$WF" >"$TMP/migrate_now.sh"
if [ ! -s "$TMP/migrate_now.sh" ]; then
  bad "could not extract migrate_now() from deploy.yml — it was renamed or reindented"
else
  ok "migrate_now() extracted from deploy.yml"

  # Every collaborator it touches, stubbed. `rd` returns the code under test.
  cat >"$TMP/harness.sh" <<'HARNESS'
GITHUB_STEP_SUMMARY="$TMP/summary.md"
MIGRATED=0
DEPLOY_USER=deploy
DEPLOY_HOST=vps.example
rd () { printf 'stub rd %s\n' "$*"; return "$STUB_RC"; }
summary () { printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; }
block () { summary ''; summary '```'; cat "$1" >> "$GITHUB_STEP_SUMMARY"; summary '```'; summary ''; }
fail () { local code="$1"; shift; printf '::error::%s\n' "$*"; exit "$code"; }
not_installed () { summary "forced command missing: $1"; }
HARNESS

  route () { # <stub-rc> -> prints "<exit-code>|<error text>"
    (
      set +e
      TMP="$TMP"; STUB_RC="$1"
      # migrate_now redirects into a RELATIVE `migrate.txt`, exactly as it does on
      # a runner in $GITHUB_WORKSPACE. Run from the temp dir so this test never
      # drops a file into the repository it is checking.
      cd "$TMP" || exit 99
      . "$TMP/harness.sh"
      : > "$GITHUB_STEP_SUMMARY"
      . "$TMP/migrate_now.sh"
      migrate_now "test" && printf 'RETURNED|MIGRATED=%s\n' "$MIGRATED"
    ) 2>&1
  }

  out="$(route 0)"
  case "$out" in
    *"RETURNED|MIGRATED=1"*) ok "rc 0   -> returns, MIGRATED=1 (the deploy continues)" ;;
    *) bad "rc 0 did not return cleanly: $out" ;;
  esac

  # THE ONE THAT WILL ACTUALLY HAPPEN. 64 must say "the box is behind this repo"
  # and name the escape hatch — never "bug in this workflow file".
  out="$(route 64)"
  if printf '%s' "$out" | grep -q 'does not have the migrate verb installed'; then
    ok "rc 64  -> 'the box does not have the migrate verb', not 'pipeline bug'"
  else
    bad "rc 64 did not diagnose a missing verb. Got: $out"
  fi
  printf '%s' "$out" | grep -q 'MIGRATION_APPLY_MODE=manual' \
    && ok "rc 64  -> names the one-click escape hatch (MIGRATION_APPLY_MODE=manual)" \
    || bad "rc 64 does not tell the operator how to get today's behaviour back"

  # Every failing code must be non-zero, must say nothing was deployed, and must
  # never be silently swallowed.
  for rc in 64 66 67 68 75 77 127 255 9; do
    out="$(route "$rc")"
    if printf '%s' "$out" | grep -q 'RETURNED|'; then
      bad "rc $rc RETURNED instead of ending the step — the deploy would continue over a failed migration"
    else
      ok "rc $rc  -> ends the step (never falls through to update)"
    fi
  done

  # The dump is the whole justification for this verb. A failure that does not
  # tell the operator where the dump is has thrown away the only thing that
  # made applying safe.
  for rc in 67 68 77; do
    out="$(route "$rc")"
    printf '%s' "$out" | grep -q 'premigration' \
      && ok "rc $rc  -> names the pre-migration dump directory" \
      || bad "rc $rc does not tell the operator where the dump is"
  done

  # 66 is the SAFE refusal and must say so, or someone will treat it as an outage.
  out="$(route 66)"
  printf '%s' "$out" | grep -qi 'database is unchanged' \
    && ok "rc 66  -> states the database is unchanged" \
    || bad "rc 66 does not state that the database was not touched"
fi

# ===========================================================================
printf '\n== the update-loop apply cannot fire twice ==\n'
printf '   -- it sits inside `for svc in python backend`, and an unguarded retry\n'
printf '      would apply migrations in a loop against a live database --\n'
# ===========================================================================
guard="$(grep -n 'MIGRATED_UPD" -eq 0' "$WF" | head -n1)"
if [ -n "$guard" ]; then
  ok "the update-loop retry is guarded by MIGRATED_UPD"
  gl="${guard%%:*}"
  # The flag must be SET BEFORE the call, not after: `migrate_now` can return,
  # and the loop then continues to the next service.
  setl="$(grep -n '^ *MIGRATED_UPD=1$' "$WF" | head -n1)"; setl="${setl%%:*}"
  calll="$(grep -n 'migrate_now "rd-deploy update' "$WF" | head -n1)"; calll="${calll%%:*}"
  if [ -n "$setl" ] && [ -n "$calll" ] && [ "$setl" -lt "$calll" ]; then
    ok "MIGRATED_UPD=1 is set BEFORE migrate_now is called (line $setl < $calll)"
  else
    bad "MIGRATED_UPD is not set before the migrate_now call — the loop could apply twice"
  fi
else
  bad "the update-loop retry is not guarded by MIGRATED_UPD. If it is guarded by the shared MIGRATED, a push carrying a NEW migration on top of a backlog one is refused for no reason; if it is unguarded, the loop can apply migrations repeatedly."
fi

# ===========================================================================
printf '\n== both jobs validate MIGRATION_MODE and neither falls back silently ==\n'
# ===========================================================================
n="$(grep -c 'MIGRATION_MODE resolved to' "$WF")"
[ "$n" -eq 2 ] && ok "both migration_gate and deploy reject an unrecognised MIGRATION_MODE" \
               || bad "found $n MIGRATION_MODE validations in deploy.yml, expected 2 (Gate A is skipped on dispatch and on a force-push, so the deploy job must check too)"
grep -qF "vars.MIGRATION_APPLY_MODE || 'auto'" "$WF" \
  && ok "MIGRATION_APPLY_MODE uses || (an unset variable is an EMPTY STRING, and ?? would not catch it)" \
  || bad "the MIGRATION_MODE expression no longer falls back with ||"

printf '\n%s  %d assertions\n' "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$((pass + fail))"
[ "$fail" -eq 0 ] || printf '%d FAILED\n' "$fail"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
