#!/usr/bin/env bash
# Pins the ROUTING DECISION in both deploy.yml files: given a classification of
# the updated services, does the run roll back or not?
#
# WHY THIS EXISTS, SEPARATELY FROM test_status_parser.sh
# ------------------------------------------------------
# The parser guard proves `assert_recreated` returns the right verdict for a
# given pair of `rd-deploy status` captures. It says nothing about what the
# workflow DOES with that verdict. Those are two different failures, and the
# second one shipped:
#
#   A new image that crash-loops on boot (`Restarting`/`Exited`/`Created`) was
#   scored "not recreated", hit the no-rollback gate, and exited 72 having
#   collected no logs and rolled nothing back — while printing that no new image
#   had reached production. Production was crash-looping on the commit just
#   deployed. The gate then read `REV_OK -eq 0 || RECREATED_OK -eq 0`.
#
# It was demonstrated that reverting ONLY that gate line reintroduces the bug
# with test_status_parser.sh still reporting PASS. So the parser guard cannot
# defend it, and nothing else did. This file does.
#
# HOW: the gate is a pure boolean over four variables, so it is extracted from
# the workflow at run time (never retyped — a copy drifts, an extract cannot)
# and evaluated against every combination that matters. It touches no server, no
# docker, and no network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

# Both workflows carry the same gate; a fix applied to one and not the other is
# exactly the drift this checks for.
WFS=(
  "$REPO_ROOT/.github/workflows/deploy.yml"
  "$REPO_ROOT/../Restaurant_Dashboard_UI/.github/workflows/deploy.yml"
)

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

for WF in "${WFS[@]}"; do
  name="$(basename "$(dirname "$(dirname "$(dirname "$WF")")")")"
  if [ ! -r "$WF" ]; then
    printf '\n%s: not readable, skipping (%s)\n' "$name" "$WF"
    continue
  fi
  printf '\n== %s ==\n' "$name"

  # ---- extract REPLACED_OK's definition and the gate ----------------------
  # Anchor on the assignment, not on the array test: `${#RECREATED[@]} -gt 0`
  # appears in several places and the first match is not this one.
  repl_line="$(grep -E 'REPLACED_OK=1' "$WF" | head -n1 || true)"
  gate_line="$(grep -E '^ +if \[ "\$HEALTHY" -eq 1 \] \|\| \[ "\$REPLACED_OK" -eq 0 \]; then' "$WF" | head -n1 || true)"

  if [ -z "$gate_line" ]; then
    bad "$name: the no-rollback gate is not \`HEALTHY -eq 1 || REPLACED_OK -eq 0\`."
    printf '       A crash-looping new image must reach the rollback path. If the gate has\n'
    printf '       been rewritten, update this test deliberately — do not delete it.\n'
    printf '       Current candidates:\n'
    grep -nE '^ +if \[ "\$HEALTHY".*then' "$WF" | sed 's/^/         /' | head -4
    continue
  fi
  ok "$name gate is HEALTHY -eq 1 || REPLACED_OK -eq 0"

  if ! printf '%s' "$repl_line" | grep -q 'BROKEN\[@\]'; then
    bad "$name: REPLACED_OK no longer counts BROKEN — a crash-looper stops counting as replaced and the gate swallows it again."
  else
    ok "$name REPLACED_OK counts BROKEN"
  fi
  if ! printf '%s' "$repl_line" | grep -q 'BROKEN_LATE\[@\]'; then
    bad "$name: REPLACED_OK no longer counts BROKEN_LATE — a crash-looper seen only by the health poll is swallowed."
  else
    ok "$name REPLACED_OK counts BROKEN_LATE"
  fi

  # BROKEN_LATE must be decided by assert_recreated, NOT svc_verdict. svc_verdict
  # says "broken" for any (unhealthy) line whatever its uptime, so using it there
  # force-recreates a container that was ALREADY sick before the run — a rollback
  # on a run that shipped nothing.
  if grep -qE '^ +svc_verdict "\$s" status\.txt; vrc=\$\?' "$WF"; then
    bad "$name: BROKEN_LATE is decided by svc_verdict, so an already-sick container with an UNRESET uptime would be rolled back by a run that shipped nothing. Use: assert_recreated \"\$s\" pre.txt status.txt"
  else
    ok "$name BROKEN_LATE requires an uptime reset (assert_recreated, not svc_verdict)"
  fi

  # ---- evaluate the gate over every combination that matters -------------
  # rolls_back == the run reaches section 5 (logs + rollback).
  gate() { # <HEALTHY> <REPLACED_OK>
    HEALTHY="$1" REPLACED_OK="$2" bash -c \
      'if [ "$HEALTHY" -eq 1 ] || [ "$REPLACED_OK" -eq 0 ]; then exit 1; else exit 0; fi'
  }
  #        HEALTHY REPLACED_OK  expect-rollback  description
  while read -r h r want desc; do
    [ -z "${h:-}" ] && continue
    if gate "$h" "$r"; then got=1; else got=0; fi
    if [ "$got" = "$want" ]; then
      ok "$name $desc -> $([ "$want" = 1 ] && echo 'ROLLS BACK' || echo 'no rollback')"
    else
      bad "$name $desc -> expected rollback=$want got=$got  (HEALTHY=$h REPLACED_OK=$r)"
    fi
  done <<'CASES'
0 1 1 crash-loop: unhealthy and something was replaced
1 1 0 healthy after a real deploy
0 0 0 unhealthy but nothing was replaced (old container sick; rolling back moves production backwards)
1 0 0 healthy and nothing replaced (genuine no-op)
CASES
done

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf 'PASS  %d assertions\n' "$pass"
  exit 0
fi
printf 'FAIL  %d of %d assertions\n' "$fail" "$((pass+fail))"
printf '\nThe routing decision changed. The case that matters most: a new image that\n'
printf 'crash-loops on boot MUST reach the rollback path. If it does not, a bad deploy\n'
printf 'is left running while the job summary reports that nothing shipped.\n'
exit 1
