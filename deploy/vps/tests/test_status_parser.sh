#!/bin/bash
# =============================================================================
# test_status_parser.sh — pin the ONE undeclared dependency in the deploy path:
# the exact text `sudo /usr/local/sbin/rd-deploy status` prints.
#
#     bash deploy/vps/tests/test_status_parser.sh
#
# deploy.yml decides whether production is healthy, and whether the container
# was actually recreated, by string-matching that output. The wrapper is not in
# this repository, so nothing else in the tree would notice if its --format
# changed — the first symptom would be a deploy that hangs to its health
# timeout, or rolls back a build that was fine.
#
# The functions under test are EXTRACTED FROM .github/workflows/deploy.yml at
# run time, never retyped here. A copy would drift; an extract cannot.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WF="$REPO/.github/workflows/deploy.yml"
FIX="$HERE/fixtures"

[ -r "$WF" ] || { echo "cannot read $WF" >&2; exit 2; }

# Pull svc_line + svc_verdict + assert_recreated out of the workflow's `run:`
# block and strip its 10-space YAML indent.
PARSERS="$(mktemp)"; trap 'rm -f "$PARSERS"' EXIT
awk '
  { orig = $0 }
  orig ~ /^          svc_line \(\) \{/ { on = 1 }
  !on { next }
  { line = orig; sub(/^          /, "", line); print line }
  orig ~ /^          assert_recreated \(\) \{/ { ar = 1 }
  ar && orig ~ /^          \}$/ { exit }
' "$WF" > "$PARSERS"
for fn in svc_line svc_verdict assert_recreated; do
  grep -q "^$fn () {" "$PARSERS" || { echo "could not extract $fn() from $WF — has the step been renamed or re-indented?" >&2; exit 2; }
done
# shellcheck disable=SC1090
. "$PARSERS"

pass=0; fail=0
vname () { case "$1" in 0) echo healthy;; 1) echo starting;; 2) echo broken;; 3) echo absent;; *) echo "?$1";; esac; }
v () { # fixture service expected
  svc_verdict "$2" "$FIX/$1"; local got=$?
  if [ "$got" = "$3" ]; then printf '  ok   svc_verdict      %-32s %-10s %s\n' "$1" "$2" "$(vname "$got")"; pass=$((pass+1))
  else printf '  FAIL svc_verdict      %-32s %-10s got %s, want %s\n' "$1" "$2" "$(vname "$got")" "$(vname "$3")"; fail=$((fail+1)); fi
}
r () { # fixture service expected_rc
  local out; out="$(assert_recreated "$2" "$FIX/$1" 2>&1)"; local got=$?
  if [ "$got" = "$3" ]; then printf '  ok   assert_recreated %-32s %-10s rc=%s\n' "$1" "$2" "$got"; pass=$((pass+1))
  else printf '  FAIL assert_recreated %-32s %-10s got rc=%s, want %s\n%s\n' "$1" "$2" "$got" "$3" "$out"; fail=$((fail+1)); fi
}

echo "== the shape the live wrapper actually prints: tab-separated, NO header =="
v ps_status_real.txt           backend   0
v ps_status_real.txt           dashboard 0
v ps_status_real.txt           python    0
v ps_status_real.txt           valkey    0
v ps_status_real_fresh.txt     backend   0
v ps_status_real_starting.txt  backend   1
v ps_status_real_unhealthy.txt backend   2
v ps_status_real_restarting.txt backend  2
v ps_status_real_absent.txt    backend   3
v ps_status_real_absent.txt    dashboard 0
echo "   -- 'Up 15 hours' means compose reused the on-disk image: MUST be caught --"
r ps_status_real.txt           backend   1
r ps_status_real.txt           python    1
r ps_status_real_fresh.txt     backend   0
r ps_status_real_fresh.txt     python    0
r ps_status_real_fresh.txt     dashboard 1
r ps_status_real_starting.txt  backend   0

echo
echo "== the padded 'docker compose ps' table, in case the wrapper changes back =="
v ps_wide_healthy.txt  backend   0
v ps_wide_healthy.txt  dashboard 0
v ps_wide_healthy.txt  python    0
v ps_wide_lessthan.txt backend   1
r ps_wide_healthy.txt  backend   0
r ps_wide_healthy.txt  dashboard 1
r ps_wide_lessthan.txt backend   0
r ps_wide_noop.txt     backend   1

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS  $pass assertions"
else
  echo "FAIL  $fail of $((pass+fail)) assertions."
  echo "If 'rd-deploy status' has changed format on the box, fix deploy.yml's parser"
  echo "and re-capture fixtures/ps_status_real.txt — do NOT loosen these tests."
fi
exit "$fail"
