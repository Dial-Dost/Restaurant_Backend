# `rd-deploy` — the contract this pipeline is written against

`/usr/local/sbin/rd-deploy` **already exists on the production VPS** and is
root-owned, mode 755. It is not in this repository and must not be. This file
records the grammar the two `deploy.yml` workflows were written against, so that
a change to either side is a visible change to a tracked file.

> **This repo deliberately does not ship a copy of `rd-deploy`.**
> An earlier draft did. Shipping it was the single most dangerous thing in this
> directory: `install.sh` would have `install`ed it over the working wrapper, and
> the drafted version had a *completely different* grammar (it took image
> digests, `--git-sha`, `--force-window`, and implemented its own health-check
> and rollback). Re-running the installer would have silently replaced a vetted
> security boundary with an unvetted one. `install.sh` now **verifies** the
> wrapper and refuses to write it.

---

## The transport is git

The registry is gone. `/opt/restaurant-dash/Restaurant_Backend` and
`/opt/restaurant-dash/Restaurant_Dashboard_UI` are real git clones of the two
GitHub repos — on `main`, working trees clean, fetched with per-repo **read-only**
deploy keys — and `/opt/restaurant-dash/docker-compose.yml` builds those
directories as **local build contexts**. `valkey` is an upstream image and has no
repo.

That single fact drives everything below. In particular it is why CI must send
`update` and never `deploy`.

---

## Grammar

| Command | What it does on the box |
|---|---|
| `rd-deploy status` | `<service><TAB><status>` lines, **no header row**, e.g. `backend⇥Up 31 hours (healthy)` |
| `rd-deploy revision` | `<repo-dir><TAB><40-char sha>`, **one line per repo** |
| `rd-deploy logs [service]` | `compose logs --tail 100` |
| `rd-deploy check-migrations` | prints the migrate dry-run verdict; **applies nothing** |
| `rd-deploy update <service>` | `git fetch` + `reset --hard FETCH_HEAD`, prints `revision <12ch> -> <12ch>`, **then** the migration gate, **then** tags the outgoing image `:previous`, **then** `compose build` + `up -d` |
| `rd-deploy deploy [service]` | migration gate, then `up -d`. **No rebuild.** |
| `rd-deploy rollback [service]` | retags `<img>:previous` back to `:latest`, then force-recreates |

* Any other first argument exits **64**. An unknown service exits **64**.
* `update` **refuses a bare form** and refuses `valkey` (no repo to build from);
  both exit **64**.
* A pending migration exits **65**. The wrapper **never applies one**.
* Image names are `restaurant-dash-backend`, `restaurant-dash-dashboard`,
  `restaurant-dash-python`.
* The compose project lives at `/opt/restaurant-dash`. `docker-compose.yml` is
  there **only** — it is not in git and the wrapper cannot be asked to change it.

### `update` vs `deploy`, and why CI only ever sends `update`

`deploy` is `up -d` with no rebuild. Against a **local-context** compose file it
converges on the image already on disk — the same image — so a pipeline built on
`deploy` would go green having shipped nothing at all. Every deploy this
repository's CI performs uses `update`.

`deploy` stays in the grammar for a human converging the stack after editing
compose by hand. If you ever see `deploy` in a workflow file, that is the bug.

### The ordering inside `update` that both workflows have to know about

`update` resets the working tree **before** it runs the migration gate. So a run
that ends in exit 65 leaves the box in a split state:

| | |
|---|---|
| working tree | **moved** to the new commit |
| running containers | **unchanged** — still the previous build |
| `:previous` image tags | untouched (written only after the gate passes) |
| database | untouched |

Both workflows say exactly this in their exit-65 output, because "nothing was
deployed" is true of the containers and false of the box. It also has an upside
the registry design did not have: re-running `check-migrations` after a 65 names
the migrations **this commit** carries, because they are now on disk.

### `rd-entry` is deliberately narrower than this

`deploy/vps/rd-entry`, the SSH forced command in front of the wrapper, enforces
this grammar **minus** two things. It is never wider; the wrapper re-validates
everything it lets through.

| The wrapper accepts | `rd-entry` | Why |
|---|---|---|
| `deploy valkey`, `rollback valkey`, `logs valkey` | **rejected, 64** | valkey is the shared cache; a restart is felt by every till at once, and no workflow has ever named it |
| bare `deploy`, bare `rollback`, bare `update` | **rejected, 64** | those are the whole stack. The backend workflow sends `update python` then `update backend`; the dashboard sends `update dashboard` |

`status`, `revision` and `check-migrations` take no service and are unchanged.
Bare `logs` is still accepted (it changes nothing).

Both narrowings only turn an accept into a `64`, so a `64` in a workflow log can
mean *either* side refused. The workflows' 64 message says so.

**Proven, not assumed:** with the real private key, an interactive session,
`cat /opt/restaurant-dash/.env` and a bare `deploy` were all refused, while
`status` and `revision` worked; 25 hostile inputs all came back 64. Exit 127
therefore should no longer occur — but every call site in both workflows still
handles it, because a 127 today would mean the forced command has been *removed*,
which is a security event rather than an unfinished install.

## Exit codes

Codes the **wrapper** (or ssh, or the login shell) returns:

| Code | Meaning | What the workflow does |
|---|---|---|
| `0` | success | continue to the proof and the health poll |
| `64` | bad arguments, from `rd-entry` or `rd-deploy` | fail as a **pipeline bug**, naming the sentence it sent and the accepted grammar. Nothing on the box changed |
| `65` | pending migration, nothing built | fail, re-run `check-migrations` to name the files, print the exact apply command, and **state that the working tree has already moved** |
| `255` | *not* a wrapper code — ssh's transport failure | fail without claiming to know the state. If it happened during `update`, the build keeps running on the box: check `revision` and `status` before re-running |
| `127` | *not* a wrapper code either — the **login shell's** "command not found", i.e. the forced command did not run and `rd-deploy` was never reached | fail naming the forced command. Handled **before** the 64/65 branches at every call site: without its own case it renders as PENDING MIGRATION, which is a flat misdiagnosis |

Codes **invented by the workflows** (the wrapper never returns these):

| Code | Meaning |
|---|---|
| `69` | dashboard only: the backend was already unhealthy, so the deploy was refused before anything moved |
| `70` | deployed, unhealthy, **image rolled back**. The git tree on the box is still at the bad commit. Reached both by a service that went unhealthy and by one whose post-update `status` line was `Restarting`/`Exited`/`Created` — a recognised not-running state is a health failure, not a failure to measure |
| `71` | either the `rollback` **call** failed, or it returned 0 and the service still did not come back. The summary and the `::error::` say which — a rollback that ran cleanly while production stays down points outside these images |
| `72` | **the deploy could not be proven, and production was not observed broken.** Three summaries share it: **CANNOT BE PROVEN** (revision is not `github.sha`, or every updated service was *measured* as not recreated), **NOTHING CHANGED** (box already on `github.sha`, revision did not move, every service measured as not recreated), **COULD NOT BE MEASURED** (post-update `status` failed, a service was absent, or its line was in a format the parser does not recognise). Plus the pre-flight refusals: baseline `status` or `revision` unreadable. No rollback is attempted — either nothing was observed to have replaced the image, or the containers are healthy. **A service that comes back `Restarting`/`Exited`/`Created` is NOT this code**: that is replaced-and-broken, and it goes to the rollback path (70/71/74) |
| `73` | containers recreated and healthy on the box, but the public URL never answered. No rollback is attempted — an image swap cannot fix ingress |
| `74` | there was **no `:previous` image** (first `update` of that service), so the container was force-recreated on the same image and the code was **not** reverted. Reported whether or not it then came back healthy: healthy here means the failing commit passed on the retry, not that anything was reverted |

## What the wrapper does **not** give the pipeline

These absences drive the design of `deploy.yml`; do not paper over them.

1. **No way to pass a commit.** `update` deploys whatever `main` points at when
   it runs. If someone pushes while a deploy is in flight, the box ends up on
   *their* commit — which is precisely why the workflow compares `revision` to
   `github.sha` afterwards and fails 72 when they differ.
2. **`rollback` reverts the image, never the source.** It retags `:previous` and
   force-recreates. The **git working tree stays at the new commit**, so the next
   `update` of that service rebuilds the bad code and ships it again. The only
   durable rollback is `git revert` on `main`. Both workflows say this in their
   failure output.
3. **`rollback` has no target on a service's first `update`.** There is no
   `:previous` image yet; the wrapper warns on stderr and force-recreates the
   same image. The workflows detect that and report a restart rather than a
   rollback (exit 74).

   The two sentences the wrapper prints are the contract here, and they are
   matched literally:

   ```
   restored restaurant-dash-<svc>:previous
   WARNING: no previous image for '<svc>' — recreating the CURRENT image, code is NOT reverted
   ```

   The detection is case-**sensitive** and keys on ASCII-only fragments of the
   second one. It must never key on the word `previous` alone, nor on `warn`
   case-insensitively: the *success* sentence contains "previous", and docker
   compose v2 prints `WARN[0000] ...` on essentially every invocation, so a
   detector built from those two reports every **successful** rollback as "the
   code was NOT reverted". `tests/fixtures/rollback_restored.txt` and
   `rollback_noprev.txt` pin both directions.

   It still reads *wording*, so rewording the wrapper makes the detection go
   quiet — read the captured output, and re-capture those two fixtures whenever
   `rd-deploy`'s `rollback` branch is edited.
4. **No health check and no wait.** `up -d` returns as soon as the container
   starts. The workflows poll `rd-deploy status` and read the status column,
   which carries `(healthy)`/`(unhealthy)` because all four images declare a
   `HEALTHCHECK`.
5. **No build isolation.** The build now runs **on the production box**, next to
   live traffic, on 2 vCPUs. A failed build surfaces as a non-zero `update`, and
   the workflows print the captured build output.
6. **No lock.** Nothing serialises a backend deploy against a dashboard deploy.
   See `README.md`, *Cross-repo ordering*.

## Verifying the box still matches this file

`install.sh` does this automatically; to check by hand, on the VPS:

```sh
sudo /usr/local/sbin/rd-deploy nonsense ; echo "expect 64, got $?"
sudo /usr/local/sbin/rd-deploy update   ; echo "expect 64 (bare update), got $?"
sudo /usr/local/sbin/rd-deploy update valkey ; echo "expect 64, got $?"
sudo /usr/local/sbin/rd-deploy status | head
sudo /usr/local/sbin/rd-deploy revision
stat -c '%U:%G %a' /usr/local/sbin/rd-deploy   # expect: root:root 755
sudo -u deploy docker ps                        # MUST be permission denied
id -nG deploy | tr ' ' '\n' | grep -qx docker && echo "!! deploy is in the docker group — that IS root"

# the clones the transport depends on: on main, clean, and read-only
git -C /opt/restaurant-dash/Restaurant_Backend status --short --branch
git -C /opt/restaurant-dash/Restaurant_Dashboard_UI status --short --branch
```

The output shapes of `status` and `revision` are pinned by
`deploy/vps/tests/test_status_parser.sh`, which extracts the parsers out of
`.github/workflows/deploy.yml` at run time and runs them against captured
fixtures. If the wrapper's formatting changes, that test fails — instead of a
production deploy hanging to its health timeout or being wrongly declared
unproven. Run it after any change to either side:

```sh
bash deploy/vps/tests/test_status_parser.sh
```

If any of that has changed, **stop and fix `deploy.yml` to match the box** —
never the other way round. The box is authoritative.
