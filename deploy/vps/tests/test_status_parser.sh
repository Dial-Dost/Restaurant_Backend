#!/bin/bash
# =============================================================================
# test_status_parser.sh — pin the ONE undeclared dependency in the deploy path:
# the exact text `sudo /usr/local/sbin/rd-deploy status` and `rd-deploy rollback`
# print.
#
#     bash deploy/vps/tests/test_status_parser.sh
#
# .github/workflows/ci.yml runs this on every push and every PR, so the guard
# cannot rot quietly.
#
# deploy.yml decides whether production is healthy, whether the container was
# actually recreated, and whether a rollback had anything to roll back to, by
# string-matching that output. The wrapper is not in this repository, so nothing
# else in the tree would notice if its `--format` or its warning wording changed
# — the first symptom would be a deploy that hangs to its health timeout, a
# deploy declared unproven when it had shipped, or a successful rollback
# reported as "the code was NOT reverted".
#
# The functions under test are EXTRACTED FROM .github/workflows/deploy.yml at
# run time, never retyped here. A copy would drift; an extract cannot.
#
# WHAT THE THREE RECREATION-RELATED FUNCTIONS ARE FOR
# -----------------------------------------------------------------------------
# `assert_recreated` compares TWO snapshots — `rd-deploy status` from before the
# first `update`, and from after the last one — and looks for the uptime RESET.
# It is deliberately NOT an absolute age test: the box compiles its own deploys
# on 2 vCPUs, so the interval between the snapshots is routinely longer than any
# fixed "must be younger than N minutes" window (deploy.yml allows 60 minutes).
# `uptime_secs` is the whole of docker's HumanDuration vocabulary, and anything
# it cannot read makes the assertion FAIL, never pass.
#
# IT RETURNS FOUR ANSWERS, AND THIS FILE PINS ALL FOUR
# -----------------------------------------------------------------------------
#   0  recreated                 the uptime reset
#   1  MEASURED not recreated    both readings parsed; no reset. The only answer
#                                that lets deploy.yml say "not replaced"
#   2  REPLACED AND BROKEN       the after line is Restarting / Exited / Created:
#                                a RECOGNISED not-running state. deploy.yml must
#                                route this to logs + rollback + re-verify
#   3  CANNOT BE TOLD            absent, or a format nothing recognises. Fails
#                                closed; deploy.yml must say "could not measure"
#
# The 2-vs-3 split is the point of the newest assertions below. When they were
# the same answer, a container CRASH-LOOPING on the freshly built image scored
# "not recreated", hit deploy.yml's exit-72 gate ahead of the rollback section,
# and produced a run with ZERO rollback calls, no logs collected, and a summary
# stating that no new image had reached production — while production was
# crash-looping on the commit just shipped. Collapsing 2 into 1 or 3 must fail
# this file. Prove it: change `return 2` to `return 3` in `assert_recreated` and
# re-run — the CRASH-LOOP block below must go red.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WF="$REPO/.github/workflows/deploy.yml"
FIX="$HERE/fixtures"

[ -r "$WF" ] || { echo "cannot read $WF" >&2; exit 2; }

# Pull the parser region out of the workflow's `run:` block and strip its
# 10-space YAML indent.
PARSERS="$(mktemp)"; trap 'rm -f "$PARSERS"' EXIT
awk '
  { orig = $0 }
  orig ~ /^          svc_line \(\) \{/ { on = 1 }
  !on { next }
  { line = orig; sub(/^          /, "", line); print line }
  orig ~ /^          assert_recreated \(\) \{/ { ar = 1 }
  ar && orig ~ /^          \}$/ { exit }
' "$WF" > "$PARSERS"
for fn in svc_line rev_of svc_verdict uptime_secs noprev_warned restored_previous assert_recreated; do
  grep -q "^$fn () {" "$PARSERS" || { echo "could not extract $fn() from $WF — has the step been renamed or re-indented?" >&2; exit 2; }
done
# shellcheck disable=SC1090
. "$PARSERS"

pass=0; fail=0
vname () { case "$1" in 0) echo healthy;; 1) echo starting;; 2) echo broken;; 3) echo absent;; *) echo "?$1";; esac; }

v () { # fixture service expected
  svc_verdict "$2" "$FIX/$1"; local got=$?
  if [ "$got" = "$3" ]; then printf '  ok   svc_verdict       %-34s %-10s %s\n' "$1" "$2" "$(vname "$got")"; pass=$((pass+1))
  else printf '  FAIL svc_verdict       %-34s %-10s got %s, want %s\n' "$1" "$2" "$(vname "$got")" "$(vname "$3")"; fail=$((fail+1)); fi
}
t () { # fixture repo-key expected-sha ("" = must find nothing)
  local got; got="$(rev_of "$2" "$FIX/$1")"
  if [ "$got" = "$3" ]; then printf '  ok   rev_of            %-34s %-24s %s\n' "$1" "$2" "${got:-<empty>}"; pass=$((pass+1))
  else printf '  FAIL rev_of            %-34s %-24s got "%s", want "%s"\n' "$1" "$2" "$got" "$3"; fail=$((fail+1)); fi
}
u () { # fixture service expected-seconds ("" = must be unreadable, rc 1)
  local line got rc
  line="$(svc_line "$2" "$FIX/$1")"
  got="$(uptime_secs "$line")"; rc=$?
  [ "$rc" -ne 0 ] && got=""
  if [ "$got" = "$3" ]; then printf '  ok   uptime_secs       %-34s %-10s %s\n' "$1" "$2" "${got:-<unreadable, rc 1>}"; pass=$((pass+1))
  else printf '  FAIL uptime_secs       %-34s %-10s got "%s", want "%s"   (line: %s)\n' "$1" "$2" "$got" "$3" "$line"; fail=$((fail+1)); fi
}
arname () { case "$1" in 0) echo recreated;; 1) echo not-recreated;; 2) echo replaced-BROKEN;; 3) echo cannot-tell;; *) echo "?$1";; esac; }
r () { # before-fixture after-fixture service expected_rc
  local out got
  out="$(assert_recreated "$3" "$FIX/$1" "$FIX/$2" 2>&1)"; got=$?
  if [ "$got" = "$4" ]; then printf '  ok   assert_recreated  %-28s -> %-30s %-10s rc=%s %s\n' "$1" "$2" "$3" "$got" "$(arname "$got")"; pass=$((pass+1))
  else printf '  FAIL assert_recreated  %-28s -> %-30s %-10s got rc=%s (%s), want %s (%s)\n%s\n' "$1" "$2" "$3" "$got" "$(arname "$got")" "$4" "$(arname "$4")" "$out"; fail=$((fail+1)); fi
}
rsay () { # before-fixture after-fixture service expected_rc must-print
  local out got
  out="$(assert_recreated "$3" "$FIX/$1" "$FIX/$2" 2>&1)"; got=$?
  if [ "$got" = "$4" ] && printf '%s' "$out" | grep -q "$5"; then
    printf '  ok   assert_recreated  %-28s -> %-30s %-10s rc=%s %-16s says "%s"\n' "$1" "$2" "$3" "$got" "$(arname "$got")" "$5"; pass=$((pass+1))
  else
    printf '  FAIL assert_recreated  %-28s -> %-30s %-10s got rc=%s (%s) want %s (%s), and it must print "%s". Output:\n%s\n' "$1" "$2" "$3" "$got" "$(arname "$got")" "$4" "$(arname "$4")" "$5" "$out"; fail=$((fail+1))
  fi
}
nw () { # fixture expected_rc   (0 = the wrapper said there was NO :previous)
  noprev_warned "$FIX/$1"; local got=$?
  if [ "$got" = "$2" ]; then printf '  ok   noprev_warned     %-34s rc=%s %s\n' "$1" "$got" "$([ "$got" = 0 ] && echo '(no rollback target)' || echo '(a real rollback)')"; pass=$((pass+1))
  else printf '  FAIL noprev_warned     %-34s got rc=%s, want %s\n' "$1" "$got" "$2"; fail=$((fail+1)); fi
}
rp () { # fixture service expected_rc   (0 = the wrapper confirmed the retag)
  restored_previous "$FIX/$1" "$2"; local got=$?
  if [ "$got" = "$3" ]; then printf '  ok   restored_previous %-34s %-10s rc=%s\n' "$1" "$2" "$got"; pass=$((pass+1))
  else printf '  FAIL restored_previous %-34s %-10s got rc=%s, want %s\n' "$1" "$2" "$got" "$3"; fail=$((fail+1)); fi
}

echo "== the shape the live wrapper actually prints: tab-separated, NO header =="
v ps_status_real.txt            backend   0
v ps_status_real.txt            dashboard 0
v ps_status_real.txt            python    0
v ps_status_real.txt            valkey    0
v ps_status_real_fresh.txt      backend   0
v ps_status_real_starting.txt   backend   1
v ps_status_real_unhealthy.txt  backend   2
v ps_status_real_restarting.txt backend   2
v ps_status_real_absent.txt     backend   3
v ps_status_real_absent.txt     dashboard 0
echo "   -- captured from the box on 2026-08-23: 'Up About an hour' is REAL --"
v ps_status_real_abouthour.txt  backend   0
v ps_status_real_abouthour.txt  dashboard 0
v ps_status_real_abouthour.txt  python    0
v ps_status_real_nouptime.txt   dashboard 0
echo "   -- Created is BROKEN, not 'still starting'. up -d starts what it     --"
echo "      creates, so a container still in Created could not be started.    --"
v ps_status_real_nouptime.txt         backend   2
v ps_status_real_created_after.txt    backend   2
v ps_status_real_created_after.txt    python    2
v ps_status_real_exited_after.txt     backend   2
v ps_status_real_crashloop_after.txt  backend   2
echo "   -- but an UNKNOWN wording is not promoted to broken; it stays 1 and  --"
echo "      assert_recreated turns that into 'cannot be told', not a rollback --"
v ps_status_real_unknownfmt_after.txt backend   1

echo
echo "== uptime_secs: docker's HumanDuration vocabulary, IN FULL =="
echo "   -- an unreadable duration must return 1, never a number and never 0 --"
u ps_status_real.txt            backend   54000       # Up 15 hours
u ps_status_real.txt            python    104400      # Up 29 hours
u ps_status_real_fresh.txt      backend   8           # Up 8 seconds
u ps_status_real_starting.txt   backend   3           # Up 3 seconds (health: starting)
u ps_status_real_abouthour.txt  backend   115200      # Up 32 hours
u ps_status_real_abouthour.txt  dashboard 3600        # Up About an hour   <- WAS UNPARSEABLE
u ps_status_real_abouthour.txt  python    165600      # Up 46 hours
u ps_status_real_longhaul.txt   backend   63072000    # Up 2 years         <- WAS UNPARSEABLE
u ps_status_real_longhaul.txt   dashboard 3024000     # Up 5 weeks
u ps_status_real_longhaul.txt   python    7776000     # Up 3 months
u ps_status_real_longhaul.txt   valkey    518400      # Up 6 days
u ps_wide_lessthan.txt          backend   0           # Up Less than a second
u ps_status_real_nouptime.txt   backend   ""          # "Created"  -> rc 1
u ps_status_real_nouptime.txt   python    ""          # "Up" alone -> rc 1
u ps_status_real_restarting.txt backend   ""          # "Restarting (1) 2 seconds ago" -> rc 1
u ps_status_real_exited_after.txt     backend ""    # "Exited (1) 3 seconds ago"     -> rc 1
u ps_status_real_created_after.txt    backend ""    # "Created"                      -> rc 1
u ps_status_real_unknownfmt_after.txt backend ""    # "Paused since Tuesday"         -> rc 1

echo
echo "== assert_recreated: the RESET between two snapshots, not an absolute age =="
echo "   -- 15h -> 8s is a reset. 15h -> 15h is not. --"
r ps_status_real.txt ps_status_real_fresh.txt      backend   0
r ps_status_real.txt ps_status_real_fresh.txt      python    0
r ps_status_real.txt ps_status_real.txt            backend   1
r ps_status_real.txt ps_status_real.txt            python    1
echo "   -- THE PYTHON CACHE HIT: backend replaced, python untouched. Per-service --"
echo "      truth; deploy.yml turns 'backend yes, python no' into a ::notice::.   --"
r ps_status_real_abouthour.txt ps_status_real_abouthour_after.txt backend   0
r ps_status_real_abouthour.txt ps_status_real_abouthour_after.txt dashboard 0
r ps_status_real_abouthour.txt ps_status_real_abouthour_after.txt python    1
echo "   -- a slow build cannot break it: an 'after' well past any 5-minute window --"
echo "      is still a reset as long as it is younger than the 'before'.          --"
r ps_status_real_longhaul.txt ps_status_real_abouthour.txt backend   0
r ps_status_real_longhaul.txt ps_status_real_abouthour.txt python    0
echo
echo "   ======================================================================"
echo "   CRASH-LOOP ON THE NEW IMAGE. rc MUST be 2 — never 1, never 3."
echo "   rc 2 is what routes deploy.yml into logs + rollback + re-verify. While"
echo "   this returned 1, a crash-looping deploy exited 72 having called"
echo "   rollback ZERO times, collected no logs, and reported that no new image"
echo "   had reached production. Restarting / Exited / Created are RECOGNISED"
echo "   states, not unreadable ones."
echo "   ======================================================================"
rsay ps_status_real.txt ps_status_real_crashloop_after.txt        backend 2 'RECOGNISED not-running state'
rsay ps_status_real.txt ps_status_real_crashloop_python_after.txt python  2 'RECOGNISED not-running state'
rsay ps_status_real.txt ps_status_real_exited_after.txt           backend 2 'RECOGNISED not-running state'
rsay ps_status_real.txt ps_status_real_created_after.txt          backend 2 'RECOGNISED not-running state'
rsay ps_status_real.txt ps_status_real_created_after.txt          python  2 'RECOGNISED not-running state'
rsay ps_status_real.txt ps_status_real_nouptime.txt               backend 2 'RECOGNISED not-running state'
echo "   -- and it must QUOTE the state, so the summary can print what it saw --"
rsay ps_status_real.txt ps_status_real_crashloop_after.txt backend 2 'Restarting (1) 2 seconds ago'
rsay ps_status_real.txt ps_status_real_exited_after.txt    backend 2 'Exited (1) 3 seconds ago'
echo "   -- the healthy service in the SAME snapshot is unaffected, so the    --"
echo "      per-service verdict still tells backend and python apart          --"
r ps_status_real.txt ps_status_real_crashloop_after.txt        python    0
r ps_status_real.txt ps_status_real_crashloop_python_after.txt backend   0
echo
echo "   -- FAIL CLOSED, but only for input that is genuinely UNKNOWN: rc 3.  --"
echo "      'I do not understand this line' must not be reported as 'nothing  --"
echo "      changed', and 'it is not running' must not be reported as either. --"
rsay ps_status_real.txt ps_status_real_nouptime.txt          python  3 'could not read an uptime'
rsay ps_status_real.txt ps_status_real_unknownfmt_after.txt  backend 3 'could not read an uptime'
rsay ps_status_real.txt ps_status_real_absent.txt            python  3 'does not appear'
echo "   -- a service that was NOT up before and is up now was started by us      --"
r ps_status_real_absent.txt          ps_status_real_fresh.txt backend 0
r ps_status_real_restarting.txt      ps_status_real_fresh.txt backend 0
r ps_status_real_exited_after.txt    ps_status_real_fresh.txt backend 0
r ps_status_real_created_after.txt   ps_status_real_fresh.txt backend 0
echo "   -- a crash-loop that is STILL a crash-loop is 2, not 0: 'it was not  --"
echo "      up before' must never launder a container that is not up now.     --"
r ps_status_real_restarting.txt ps_status_real_crashloop_after.txt backend 2
echo "   -- and the error names the service and both readings --"
rsay ps_status_real.txt ps_status_real.txt backend 1 'was NOT recreated'

echo
echo "== the padded 'docker compose ps' table, in case the wrapper changes back =="
v ps_wide_healthy.txt  backend   0
v ps_wide_healthy.txt  dashboard 0
v ps_wide_healthy.txt  python    0
v ps_wide_lessthan.txt backend   1
r ps_wide_noop.txt    ps_wide_healthy.txt backend   0
r ps_wide_healthy.txt ps_wide_healthy.txt dashboard 1
r ps_wide_noop.txt    ps_wide_lessthan.txt backend  0

echo
echo "== 'rd-deploy rollback': which of its TWO outcomes actually happened =="
echo "   -- compose prints WARN[0000] on every invocation and the SUCCESS line   --"
echo "      contains the word 'previous'. Neither may trigger the no-target path. --"
nw rollback_restored.txt 1
nw rollback_noprev.txt   0
rp rollback_restored.txt dashboard 0
rp rollback_noprev.txt   dashboard 1
echo "   -- and it must not confuse one service's rollback for another's --"
rp rollback_restored.txt backend   1

echo
echo "== 'rd-deploy revision': the OTHER undeclared dependency =="
echo "   -- deploy.yml refuses to deploy at all if it cannot read a 40-char SHA --"
t revision_synthetic.txt Restaurant_Backend      4f2a1c9e8b7d6a5f4e3c2b1a0f9e8d7c6b5a4938
t revision_synthetic.txt Restaurant_Dashboard_UI 9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a392817263
t revision_padded.txt    Restaurant_Backend      4f2a1c9e8b7d6a5f4e3c2b1a0f9e8d7c6b5a4938
t revision_padded.txt    Restaurant_Dashboard_UI 9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a392817263
echo "   -- an absent or partial key MUST return empty, never another repo's SHA --"
t revision_synthetic.txt Restaurant_Python       ""
t revision_synthetic.txt Restaurant              ""
t revision_synthetic.txt Restaurant_Backend_UI   ""

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS  $pass assertions"
else
  echo "FAIL  $fail of $((pass+fail)) assertions."
  echo "If 'rd-deploy status', 'rd-deploy revision' or 'rd-deploy rollback' has changed"
  echo "format on the box, fix deploy.yml's parser and re-capture the fixtures — do NOT"
  echo "loosen these tests. Three rules, in the order they were learned the hard way:"
  echo "  * assert_recreated must never return 0 on input it could not read;"
  echo "  * a RECOGNISED broken state (Restarting/Exited/Created) must return 2, so"
  echo "    deploy.yml collects logs and rolls back instead of reporting that nothing"
  echo "    shipped;"
  echo "  * only a genuinely unknown format returns 3."
fi
exit "$fail"
