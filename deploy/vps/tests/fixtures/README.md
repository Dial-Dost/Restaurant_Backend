# `rd-deploy` output fixtures

`deploy.yml` reads production health, whether a container was actually
recreated, and whether a rollback had anything to roll back to, out of two
strings: whatever `sudo /usr/local/sbin/rd-deploy status` and
`... rd-deploy rollback <svc>` print. The wrapper is not in this repository, so
its output format is an **undeclared dependency** of both workflows. These files
pin it. `ci.yml` runs `tests/test_status_parser.sh` against them on every push.

## `status`

`ps_status_real.txt` is a byte-for-byte capture of the live VPS on 2026-08-22
(`cat -A`, `^I` = tab, `$` = end of line):

```
backend^IUp 15 hours (healthy)$
dashboard^IUp 15 hours (healthy)$
python^IUp 29 hours (healthy)$
valkey^IUp 29 hours (healthy)$
```

Note what it is **not**: no header row, and tab-separated rather than the
column-padded table `docker compose ps` prints on a terminal. The service name
is the first whitespace-delimited token, which is what `svc_line` keys on.

`ps_status_real_abouthour.txt` is the same box on **2026-08-23**, and it is the
reason the parser was rewritten:

```
backend^IUp 32 hours (healthy)$
dashboard^IUp About an hour (healthy)$
python^IUp 46 hours (healthy)$
valkey^IUp 46 hours (healthy)$
```

`Up About an hour` is docker's `HumanDuration` for a container between 60 and 90
minutes old. The old `assert_recreated` regex did not list it, and an
unparseable duration took a branch that printed a `::warning::` and **returned
success** — so half the "did this actually ship" proof switched itself off, on
the live box, silently. It now fails closed.

| file | what it pins |
|---|---|
| `ps_status_real.txt` | the ordinary shape: tab-separated, no header |
| `ps_status_real_fresh.txt` | seconds-old containers right after a swap |
| `ps_status_real_starting.txt` | `(health: starting)` is *not* healthy yet |
| `ps_status_real_unhealthy.txt` | `(unhealthy)` |
| `ps_status_real_restarting.txt` | `Restarting (1) 2 seconds ago` — no uptime at all |
| `ps_status_real_absent.txt` | a service missing from the output entirely |
| `ps_status_real_abouthour.txt` | **`Up About an hour`**, captured live |
| `ps_status_real_abouthour_after.txt` | the same stack after a deploy: backend and dashboard reset, **python did not** — the per-service verdict |
| `ps_status_real_longhaul.txt` | `N years`, `N weeks`, `N months`, `N days` — the rest of the vocabulary |
| `ps_status_real_nouptime.txt` | `Created` (a recognised broken state) next to a bare `Up` (an unrecognised one), in one file — the two must not get the same answer |
| `ps_status_real_crashloop_after.txt` | **backend `Restarting (1) 2 seconds ago`** while python is seconds old and healthy — the crash-loop-on-boot deploy |
| `ps_status_real_crashloop_python_after.txt` | the mirror image: python crash-looping, backend healthy |
| `ps_status_real_exited_after.txt` | **backend `Exited (1) 3 seconds ago`** — the new image died and stayed dead |
| `ps_status_real_created_after.txt` | **`Created`** for both built services — containers that `up -d` never managed to start |
| `ps_status_real_unknownfmt_after.txt` | `Paused since Tuesday` — a wording nothing recognises. The ONLY shape that may still fail closed |
| `ps_wide_*.txt` | the column-padded `docker compose ps` table, in case the wrapper ever changes back |

### The three AFTER-snapshot states that must NOT read as "nothing shipped"

`Restarting`, `Exited` and `Created` carry no duration, exactly like a line the
parser cannot read — and for a while `assert_recreated` treated them the same
way, as "not recreated". That routed a **crash-looping production deploy** into
the exit-72 gate, which sits above the rollback section: the run exited 72 having
called `rollback` zero times, collected no logs, and stated that no new image had
reached production.

They are now answer **2, replaced and broken**, and `deploy.yml` sends that to
logs + rollback + re-verify. `ps_status_real_unknownfmt_after.txt` is the control:
a genuinely unknown wording still returns **3** and still fails closed, because
there the honest statement really is "I could not tell". The mutation test for
this is one line — change `return 2` to `return 3` in `assert_recreated` — and
the CRASH-LOOP block of `test_status_parser.sh` must go red.

`assert_recreated` compares **two** of these — a snapshot from before the first
`update` and one from after — and looks for the uptime **reset**. It is
deliberately not an absolute-age test: the box compiles its own deploys on
2 vCPUs, so the interval between the snapshots routinely exceeds any fixed
window. `ps_status_real_longhaul.txt` → `ps_status_real_abouthour.txt` is the
case that proves it: an "after" reading of an hour is still a reset when the
"before" was two years.

## `rollback`

The wrapper has exactly two outcomes, and they must never be confused:

```
restored restaurant-dash-<svc>:previous
WARNING: no previous image for '<svc>' — recreating the CURRENT image, code is NOT reverted
```

| file | what it pins |
|---|---|
| `rollback_restored.txt` | a rollback that **worked** — and it carries a docker compose `WARN[0000]` banner and the word "previous", which is exactly why `grep -i warn` + `grep -i previous` reported it as *no rollback target* |
| `rollback_noprev.txt` | a genuine no-target restart, em dash and all |

## `revision`

`revision_synthetic.txt` (tab-separated) and `revision_padded.txt` (column
padded). `deploy.yml` refuses to deploy at all if it cannot read a 40-character
SHA for its own `REVISION_KEY`, so `rev_of` must return **empty** for an absent
or partially-matching key rather than another repository's SHA.

---

**Re-capture, never loosen.** If the wrapper's format changes, fix the parser in
`.github/workflows/deploy.yml` and re-capture these files from the box with
`cat -A`. Never let `assert_recreated` return 0 on input it could not read.
