# CI/CD to the production VPS — runbook

Covers **both** repositories. `Restaurant_Dashboard_UI/deploy/README.md` points
here, because the server-side wrapper this documents serves both.

The pipeline has never run against production from CI. Both workflows are
`workflow_dispatch`-only until one deploy has been watched end to end by hand,
outside service hours. Treat the first run as a change to a live system serving
real restaurants.

---

## READ THIS FIRST: the stale production secrets

`.github/workflows/ci.yml` records, in its own header, that the deleted
`backend-ci.yml` pointed `RESTAURANT_ID: csrorganics` — a live, paying tenant —
at the production Supabase credentials held as **repository secrets**. That
workflow is gone. **Deleting a workflow deletes the use, not the secret.**

Two facts, unsoftened:

1. **Those production database credentials are one pull request away for
   everyone with write access.** A workflow triggered by `pull_request` from a
   same-repo branch receives repository secrets. Anyone who can push a branch can
   add a workflow that prints them. That is default GitHub behaviour, not a
   hypothetical.

2. **This pipeline raises the stakes.** Until now the worst case was a leak of
   database credentials. With a deploy pipeline, the same one-PR exfiltration
   also yields the ability to ship code to production.

**Rotate and delete the stale Supabase repository secrets BEFORE either deploy
workflow's push trigger is enabled.**

```sh
gh secret list --repo Dial-Dost/Restaurant_Backend        # see what is still there
gh secret delete <NAME> --repo Dial-Dost/Restaurant_Backend
```

Rotating means issuing new credentials in Supabase and retiring the old ones.
Deleting the GitHub secret alone leaves a live credential that has been exposed
to every workflow run in the repository's history.

The deploy key is deliberately **not** a repository secret. It lives in a GitHub
**Environment** named `production`, which a workflow running on a feature branch
or a pull request cannot read, and whose deployment branches are restricted to
`main`. That property is the single highest-value control in this design, and it
is why both deploy jobs carry `environment: production`.

---

## How new code reaches the box

**The transport is git. There is no registry in this pipeline.**

An earlier design built images in CI, pushed them to GHCR by digest, and moved a
`:prod` tag that the box's compose file followed. It is gone: GHCR needed a
long-lived read credential in *root's* docker config on the VPS, and it could not
be created without a human at a keyboard. Everything that design implied —
`pull_policy: always`, `:prod`, digests, `docker login`, `packages: write` — has
been deleted from the workflows rather than left commented out.

What is on the box instead:

```
/opt/restaurant-dash/
├── docker-compose.yml            # NOT in git. Builds the two dirs below as
│                                 # LOCAL BUILD CONTEXTS (build: ./Restaurant_Backend …)
├── Restaurant_Backend/           # real git clone, on main, clean, READ-ONLY deploy key
├── Restaurant_Dashboard_UI/      # real git clone, on main, clean, READ-ONLY deploy key
└── .env, .env.migrate, public/downloads/ …
```

So a deploy is: **the box fetches the repo and rebuilds.** CI holds no image, no
digest and no registry credential. The only secret either workflow can see is an
SSH key pinned to a forced command.

`valkey` is an upstream image and has no repo. It is never deployed by CI, and
`rd-entry` refuses to name it at all.

### `update`, never `deploy`

`rd-deploy deploy` is `compose up -d` with **no rebuild**. Against a
local-context compose file it converges on the image already on disk — the same
image — so a pipeline built on `deploy` would report success having shipped
nothing. Both workflows send `update <service>`, which fetches and rebuilds.

`deploy` remains in the grammar for a human converging the stack after editing
compose by hand. **If you ever see `deploy` in a workflow file, that is the bug.**

### What this costs, stated plainly

**The production box now compiles its own deploys.** `tsc`, the python image and
`next build` all run on a 2-vCPU VPS next to live POS traffic, with real memory
pressure, and the build is now *inside* the deploy window instead of before it.
The dashboard is the worst of the three: its builder stage installs
`build-essential`/`g++`/`libvips-dev` and runs a full `next build`.

That is a genuine regression against the registry design, and it is the price of
not needing a registry credential. Consequences to plan around:

* **Deploy outside service hours.** Both deploy jobs are `timeout-minutes: 60`.
* A build failure now surfaces as a non-zero `update`, with the build output
  captured into the job summary.
* Rollback is still fast — it is a container swap, not a rebuild.

### Build args live on the box now

For the dashboard this is load-bearing and easy to miss. `next.config.ts`'s
`/backend-api` rewrite and every `NEXT_PUBLIC_*` value are baked into the
standalone build manifest **at build time**, and the build now happens on the
box. Those values therefore come from `docker-compose.yml` on the VPS, which is
not in git and which CI cannot read or set.

`vars.NEXT_PUBLIC_BACKEND_URL` and `vars.BACKEND_INTERNAL_URL` are consequently
**inert** — no workflow reads them any more. The old CI-side guard that refused a
`localhost` backend URL has been deleted rather than left in place, because it
can no longer see the value it was checking and a check that cannot fail is worse
than no check.

If a guest page breaks after a deploy, look at the `build:` args in
`/opt/restaurant-dash/docker-compose.yml` first. What the dashboard workflow
still asserts is repository *content*: `Dockerfile` must keep
`ARG BACKEND_INTERNAL_URL`, and `.dockerignore` must keep excluding
`public/downloads`.

---

## How a run proves it actually shipped

This is the heart of the design. **A pipeline that reports success without
shipping is the specific failure it exists to prevent**, and with a
local-context build there are two independent ways for that to happen. So there
are two independent proofs, and a green run needs both:

| Proof | Reads | Proves | Does **not** prove |
|---|---|---|---|
| **revision** | `rd-deploy revision` must equal `github.sha` afterwards | the code reached the box | that anything was rebuilt — `update` resets the tree *before* its migration gate, so an exit-65 run leaves the tree on the new commit with the old containers running |
| **recreation** | `rd-deploy status` snapshotted **before** the first `update` and again after; the uptime must have **reset** | a new image is running | which commit built it |

If either fails, the run exits **72** and **no rollback is attempted**. That is
deliberate: `rollback` swaps the running image for `:previous`, so if this run
never replaced the image, the thing running *is* `:previous` and rolling back
would move production to the build before that — backwards, over a deploy that
never happened. **Never roll back what was never rolled forward.**

### The exception, and it is the important one

"Recreation failed" is **not** one outcome. It is three, and exit 72 covers only
two of them:

| The post-update `status` line for an updated service | What that is | Where the run goes |
|---|---|---|
| an uptime that is **older** than the before-reading | *measured* not recreated | **72**, no rollback. This is the only case in which a summary may say the image was not replaced |
| `Restarting` / `Exited` / `Created` | **replaced and broken** — a recognised not-running state, carrying no duration because nothing is up | the **health-failure path**: collect that service's logs, `rollback`, poll again. Exit 70/71/74 |
| absent, or a wording the parser does not recognise | **could not be measured** | **72**, no rollback, under its own heading — the run says it could not tell, and never that nothing shipped |

The middle row is a fix, and it replaced a genuinely dangerous bug. Those three
states carry no duration, so a version of `assert_recreated` that only asked
"did the uptime reset?" scored a container **crash-looping on the image just
built** as *not recreated* — and the exit-72 gate sits above the rollback
section. A crash-looping production deploy therefore exited 72 having called
`rollback` **zero** times, collected **no** logs, and printed *"NOT ONE of
python backend was recreated … so no new image reached production. No rollback
was attempted, on purpose … the thing running now IS `:previous`"*. Every clause
of that was false. `Restarting`, `Exited` and `Created` are **recognised**
states, not unreadable ones, and the difference between "it is not running" and
"I could not read this line" is now the difference between rolling back and
standing still.

### What is still unproven

`revision` reads the **working tree**, not the image. A run can therefore prove
that the box is on this commit and that a new container is running, but not that
this container was built *from that tree* — a `docker compose build` that
silently reused a stale layer would satisfy both. Closing that gap means putting
the revision into the image (the label already exists) and exposing it on
`/health`; that remains the single highest-value follow-up.

### Why recreation is a comparison, not an age

The obvious version of proof 2 — "the container must report an uptime of five
minutes or less" — is wrong twice over on this box, and both were measured, not
guessed.

**It punishes a slow build.** The window is measured *after* `update backend`
returns, and `update` runs `tsc` and a docker build on 2 vCPUs beside live POS
traffic. That routinely takes longer than five minutes; the workflow's own
`timeout-minutes: 60` concedes as much. So the rule red-lighted deploys that had
worked.

**It cannot read what the box prints.** Docker's `HumanDuration` says
`Up About an hour` for a container between 60 and 90 minutes old, and the old
regex did not list it — nor `N years`. An unparseable duration took a branch that
printed a `::warning::` and **returned success**, which means the assertion could
silently switch itself off. That is not theoretical: `rd-deploy status` on the
box today returns

```
backend		Up 32 hours (healthy)
dashboard	Up About an hour (healthy)
python		Up 46 hours (healthy)
valkey		Up 46 hours (healthy)
```

So proof 2 is now a **comparison**: snapshot `status` before the first `update`,
read it again after, and look for the uptime **reset**. A container that was not
replaced can only get older; one that was replaced starts from zero. That is
immune to a build of any length and to any wording. Anything the parser cannot
read now **fails**, never passes — `deploy/vps/tests/test_status_parser.sh` pins
both properties, and `ci.yml` runs it.

### Not every service has to move

The rule is **at least one** updated service must show the reset. A service that
did not is named in a `::notice::` and printed in the success summary under
`unchanged`, and the summary never claims nothing shipped while the backend did.

**Do not re-derive that rule from "a cache-hit rebuild does not recreate."
Measured on this box, it does.** `buildx` 0.36.1 stamps a provenance attestation
into every build, so a rebuild with **no source change at all** still produces a
new image id:

```
image id before                    sha256:129c9f26d3403a54be6
image id after rebuild, no change  sha256:389d5ce34d2de9f0d45
```

and `up -d` then swaps the container. Confirmed live: `rd-deploy update python`
with nothing touched in the python image took that container's uptime from
46 hours to 12 seconds.

An earlier version of this section said the opposite, with a number attached —
that `Dockerfile.python:32-33` copies only `pyproject.toml`, `README.md` and
`Python_servers/`, so a TypeScript-only commit rebuilds python to an identical
image id and requiring every service to move would have red-lighted "roughly 92%
of real backend deploys". The Dockerfile part is true; **the conclusion drawn
from it is not true on this box**, and the 92% figure described a machine this is
not. It has been removed rather than softened.

The at-least-one rule stays, and not as a leftover. It does not depend on that
behaviour in either direction, it survives a `buildx` that stops stamping
provenance or a compose that starts skipping identical images, and it is what
keeps a build longer than any fixed "younger than N minutes" window from
red-lighting a deploy that worked.

### The genuinely benign way to fail proof 2 — and why it is rarer than it looks

A commit that changes nothing that lands in **any** image — docs, `.github/`,
`deploy/`, anything in `.dockerignore` — could in principle rebuild every service
to an identical image id, leaving compose nothing to recreate, and the run goes
red with exit 72. That would be the pipeline telling the truth: nothing shipped,
because nothing needed to.

Given the buildx behaviour above, **treat it as the less likely explanation, not
the default one.** On this box even an unchanged rebuild normally recreates, so
nothing moving is itself worth a look at the `update` output. The 72 summary
enumerates the causes in that order and rules "the box was already on this
commit" in or out from the before/after revisions it prints.

### A no-op re-dispatch is red, and says so in its own words

Nothing used to assert that the revision **moved**. Re-dispatching a commit the
box is already on printed `revision aaaa -> aaaa (= github.sha)` and reported
success on a run that changed nothing anywhere.

Now the workflows track `REV_MOVED` separately from `REV_OK`, and the case where
the revision was already correct, did not move, and nothing was recreated gets
its own heading — **NOTHING CHANGED** — instead of `CANNOT BE PROVEN`. It is
still exit 72, deliberately: the one promise this pipeline makes is that a green
run means code shipped. But the summary says plainly that the box was already on
this commit, that **every updated service's uptime was read on both sides of the
update and had not reset**, that production is unchanged and healthy (or is not,
and why that is not this run's doing), and that nothing was rolled back.

That heading is now gated on the measurement actually having been taken. It used
to be reachable when the post-update `status` call merely **timed out** — every
service then landed in "could not measure", the tree was already at `github.sha`
from the `update` that *had* succeeded, and the run printed *"every rebuild was a
pure cache hit … No container's uptime reset"* about a container it had never
looked at. Runs that could not measure now get their own heading, **COULD NOT BE
MEASURED**, which says what failed, what is still known (the `update` calls
returned 0; the health poll did or did not see the service healthy), and gives
the three commands that settle it on the box. Same exit code, different sentence:
*measured no* and *could not measure* must never read the same.

The distinction that matters: a re-run **after applying a migration by hand** also
finds the revision already correct — the refused run reset the tree before exiting
65 — but it *does* rebuild and recreate. That is a real deploy and reports success,
with `revision ... UNCHANGED` spelled out in the summary.

---

## What the pipeline does, step by step

**`Restaurant_Backend`:**

1. **ci** — `ci.yml` via `workflow_call`, unchanged and secret-free: money
   invariants, typecheck, unit tests, the route-manifest gate
   (`npm run test:routes`), migration chain, tenant isolation, real-Postgres
   integration tests, container smoke test. Node 22. A red CI makes the deploy
   job **unreachable**.
2. **migration_gate (Gate A)** — a `git diff` over `migrations/`. Zero
   credentials, no network call. It also validates `MIGRATION_MODE` here, where
   nothing is at stake. If this push adds SQL: in `manual` mode the run stops
   here and the box is never contacted; in `auto` mode it names the files in the
   summary and passes, and the apply happens on the box.
3. **deploy** (`environment: production`, and `if: github.ref ==
   'refs/heads/main'` so the branch restriction is visible in the file and not
   only in Settings) — `revision` (baseline) → `status` (**the baseline snapshot
   the recreation proof compares against; a failure to read it refuses the deploy
   outright, while the box is still untouched**) → `check-migrations`
   (→ `migrate` → `check-migrations`, in `auto` mode, if anything is pending from
   an earlier release) → `update python` → `update backend` (either of which, on
   a 65 in `auto` mode, triggers `migrate` and **one** retry) → `revision`
   (proof) → `status` (compared against the baseline) → health poll → public
   probe of
   `https://api.dialdost.com/health`. On failure: the logs of **whichever service
   is actually unhealthy**, then `rollback backend`, `rollback python`.

**`Restaurant_Dashboard_UI`:** the same shape, minus Gate A (this repo ships no
SQL), plus a **preflight** job asserting the Dockerfile and `.dockerignore`, plus
a precondition that the **backend is already healthy** before it will touch
anything. It probes `https://experiosolutions.dialdost.com/login`.

### Why the backend deploys `python` before `backend`

Both come out of the same clone and the same working tree, so the first `update`
is the one that fetches and resets; the second finds the tree already at
`FETCH_HEAD` and only rebuilds its own service. Order matters anyway:

* the **first** `update` is the one that can be refused (65, or 64 on a grammar
  bug). Spending that refusal on the sidecar means the API every till talks to
  has not been rebuilt or bounced when it happens;
* `backend` depends on `python`, not the reverse. The dependency goes up first,
  so the new backend never talks to an old sidecar;
* `backend` is the publicly observable service and the one the dashboard proxies
  to — last means the riskiest swap is the one the health poll is watching;
* if the python build fails, the backend has not been touched and restaurants
  keep taking orders.

Rollback runs in the **reverse** order — `backend` first — so the API is back on
a known-good build before the sidecar is touched.

Unlike the registry design, `python` is **not** skipped when nothing about it
changed: there is no digest to compare before the build exists, and inferring a
skip from a path diff would depend on the box's previous SHA being an ancestor of
this commit, which a force-push or squash breaks.

### The two migration gates, and why there are two

| | Gate A (CI) | The server gate |
|---|---|---|
| Where | GitHub runner | inside `rd-deploy update`, exit 65 |
| Credential | none | `.env.migrate`, root-only, never leaves the box |
| Detects | migrations added *by this push* | anything the *database* has not applied |
| Misses | a migration from an earlier push nobody applied | nothing |
| When it fires | before the box is contacted at all | **after the working tree has already been reset** |

Gate A exists to fail before an SSH connection is opened. The server gate is the
true one. **Neither ever applies a migration**, and neither ever will — Gate A
holds no database credential by design, and giving it one would move the most
dangerous credential in this system onto a GitHub runner.

A `workflow_dispatch` run skips Gate A deliberately — that is how you re-run a
deploy after applying a migration by hand.

The workflows also run `check-migrations` *before* `update`. That catches a
migration left unapplied by an **earlier** release, while the tree is still
untouched, which is a strictly better place to stop.

### What the gates DO with the answer: `MIGRATION_MODE`

Detecting is not the same as refusing, and since the `migrate` verb exists the
two are separate. Resolution order, most specific first:

1. the `workflow_dispatch` input `migrations`, unless it is the literal `default`
2. the repository variable `MIGRATION_APPLY_MODE`
3. `auto`

| | `manual` | `auto` (the default) |
|---|---|---|
| Gate A, migration in the push | refuses, prints the by-hand recipe | `::notice::`, names the files in the summary, passes |
| pre-flight `check-migrations` non-zero | refuses | `rd-deploy migrate`, then re-asks `check-migrations` |
| `update` returns 65 | refuses (this is today's behaviour) | `rd-deploy migrate`, then retries the update **once** |

A push cannot carry an input, so a push resolves to (2) then (3). **The
repository variable is the kill switch**: visible in Settings, effective on the
next run, no commit needed. The dispatch input overrides it for one run.

An unrecognised value is a **hard failure in both jobs**, never a silent
fallback. A typo in a repository variable must not quietly decide whether
production migrates itself. Both jobs check, because Gate A is skipped on a
dispatch and on a force-push, and the deploy job is the one holding the key.

**Why the default is `auto`.** A default of `manual` would leave the automated
path installed and never taken: every migration-carrying push would still stop,
this runbook would still say "ssh in as root", and the only thing that changed
would be that there is now a second way to do it that nobody uses. The safety of
this step never came from the gate — it came from there being no way back, and
the gate was the honest admission of that. `rd-deploy migrate` takes and verifies
a dump before it applies anything and refuses to apply if that fails, so a way
back now exists. Its limits are real and are listed in
`rd-deploy-migrate.proposed.sh`; read them before deciding this default is wrong,
and if you decide it is, set the variable rather than editing a workflow.

**Until the verb is installed, `auto` fails safe.** The box answers `migrate`
with 64, and the workflow reports *the box is behind this repo* — naming both the
one-time install and the `MIGRATION_APPLY_MODE=manual` escape hatch. Nothing is
applied and nothing is deployed.

---

## Secrets and variables

### `secrets.DEPLOY_SSH_KEY` — **environment** secret on `production`, both repos

The **private** half of the ed25519 keypair whose public half is in
`/home/deploy/.ssh/authorized_keys`.

**What it grants:** an SSH session to the `deploy` account that is immediately
replaced by the forced command `/usr/local/sbin/rd-entry`. Its entire vocabulary
is `status`, `revision`, `logs [svc]`, `check-migrations`, and
`update|deploy|rollback <svc>` with `svc` in `backend|dashboard|python`. It
cannot open a shell, cannot forward a port to Valkey or Postgres, cannot read an
env file, cannot run `docker` (the `deploy` user is not in the docker group), and
cannot run any program other than `rd-deploy`.

It must be an **environment** secret, not a repository secret, so a workflow on a
feature branch or a PR cannot read it.

There is **no `secrets.GITHUB_TOKEN` use and no `packages:` permission** in
either deploy workflow any more. Nothing in this pipeline talks to a registry.

### Repository variables — both repos

`vars.*`, not secrets. None is confidential; the risk in each is its *absence* or
a wrong value, not its disclosure.

| Name | Value | Notes |
|---|---|---|
| `DEPLOY_HOST` | `103.212.120.44` | not a secret |
| `DEPLOY_USER` | `deploy` | the restricted identity |
| `DEPLOY_PORT` | `22` | may be omitted; defaults to 22 |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan` | the workflow **refuses to run** without it. Never `StrictHostKeyChecking=no` — that would let anyone on the runner's network path present their own host key and collect the deploy key |
| `MIGRATION_APPLY_MODE` | `auto` \| `manual` \| unset | **set this to `manual` in the BACKEND repo until `/usr/local/sbin/rd-migrate` is installed** (done — set 2026-09-06). Unset means `auto`. Only the backend workflow reads it: the dashboard runs `check-migrations` and refuses on a pending migration, but never calls `migrate`, so setting it there does nothing. Any other value is a hard failure in both jobs — a typo must not decide whether production migrates itself. See *What the gates DO with the answer* |

### Optional per-repo overrides

Both have a live default baked into the workflow's `env:` block, so neither has
to be set; a `vars.` value wins if you need to change the URL without a commit.

| Repo | Name | Default in the workflow |
|---|---|---|
| `Restaurant_Backend` | `PUBLIC_HEALTH_URL` | `https://api.dialdost.com/health` |
| `Restaurant_Dashboard_UI` | `PUBLIC_DASHBOARD_URL` | `https://experiosolutions.dialdost.com/login` |

A public probe that genuinely fails — timeouts, connection failures, 5xx, or
any mix of those with 403s — is exit **73**: the run goes red, but it does
**not** roll back, because the containers are healthy on the box and an image
swap cannot fix ingress.

One case is carved out. If **every** attempt in the window answers an instant
`403`, the probe is **BLINDED**, not failed: Cloudflare bot protection is
challenging curl from the GitHub runner. Measured 2026-08-18: both deploys
exited 73 on a pure-403 wall (20/20 attempts, ~120ms each, from the first
second) while the same URLs served 200 in ~0.5s to every other client, and a
live-swap reproduction with an external probe every 2s scored 150/150 at 200.
A tunnel that is actually down answers 52x/530 or times out — never a clean
instant 403. A pure-403 wall therefore does **not** exit 73: the run reports
"probe BLINDED" with a `::warning::`, prints the per-attempt HTTP codes, and
is judged on the on-box evidence (revision proof, recreation proof, health
poll). The **durable fix** is a **Cloudflare WAF skip rule** for the two probe
paths (`/health` on the API host, `/login` on the dashboard host) so the
runner is served the origin again — that needs Cloudflare dashboard access
and cannot be shipped from these repos.

`NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_FEEDBACK_FORM_URL` and
`BACKEND_INTERNAL_URL` are **no longer read by any workflow** — see *Build args
live on the box now*. Leave them or delete them; they do nothing here.

### Creating the key and the host pin

```sh
# On your workstation. No passphrase — a CI runner cannot type one.
ssh-keygen -t ed25519 -N '' -C 'ci-deploy' -f ci-deploy

# Private half -> the production ENVIRONMENT secret, in BOTH repos:
gh secret set DEPLOY_SSH_KEY --env production --repo Dial-Dost/Restaurant_Backend      < ci-deploy
gh secret set DEPLOY_SSH_KEY --env production --repo Dial-Dost/Restaurant_Dashboard_UI < ci-deploy

# Host key pin.
ssh-keyscan -p 22 103.212.120.44 > known_hosts.txt
gh variable set SSH_KNOWN_HOSTS --repo Dial-Dost/Restaurant_Backend      < known_hosts.txt
gh variable set SSH_KNOWN_HOSTS --repo Dial-Dost/Restaurant_Dashboard_UI < known_hosts.txt
```

Configure the `production` environment in **both** repos with *deployment
branches: selected branches → `main`*. Add required reviewers if you want a human
click before every production deploy.

### The exact `authorized_keys` line

Installed as the **only** line in `/home/deploy/.ssh/authorized_keys`
(`deploy:deploy`, mode `0600`):

```
restrict,command="/usr/local/sbin/rd-entry" ssh-ed25519 AAAA...<PUBKEY>... github-actions-deploy
```

`restrict` implies `no-port-forwarding`, `no-agent-forwarding`,
`no-X11-forwarding`, `no-pty` and `no-user-rc`, and automatically picks up any
future restriction OpenSSH adds. `command=` means the client's own command line
is never executed: it arrives in `$SSH_ORIGINAL_COMMAND`, and `rd-entry`
character-whitelists it, splits it into an argv array without ever invoking a
shell, checks it against the same grammar `rd-deploy` enforces, and `exec`s
`sudo -n /usr/local/sbin/rd-deploy`.

**This is installed and was proven with the real private key**: an interactive
session, `cat /opt/restaurant-dash/.env` and a bare `deploy` were all refused,
while `status` and `revision` worked; 25 hostile inputs all came back 64.

Both workflows still handle exit **127** at every call site anyway. A 127 today
would mean the forced command has been *removed* — a change to the security
boundary, not an unfinished install — and the workflows say exactly that.

---

## The state of the box

Everything in this list is **done**. It is recorded so that a future change is a
visible change, and so the failure output can name what should be true.

1. **The forced command** — `/usr/local/sbin/rd-entry`, root-owned 0755, wired
   into `authorized_keys` as above. Proven.
2. **The wrapper** — `/usr/local/sbin/rd-deploy`, root-owned 0755, reached
   through a wildcard-free sudoers grant. Its grammar, including `update` and
   `revision`, is in [`WRAPPER_CONTRACT.md`](./WRAPPER_CONTRACT.md).
3. **The two clones** — `/opt/restaurant-dash/Restaurant_Backend` and
   `.../Restaurant_Dashboard_UI`, on `main`, clean, fetched with per-repo
   **read-only** deploy keys.
4. **Compose builds from local context** — `docker-compose.yml` builds those two
   directories. It is not in git.
5. **The migration credential** — `/opt/restaurant-dash/.env.migrate`, root-only,
   holding `MIGRATION_DATABASE_URL` for the **owner/migration role**, not
   `app_runtime` (which intentionally lacks DDL privileges). `check-migrations`
   reads it; nothing in CI ever sees it.

The one thing in this section that is **not** done:

6. **`/usr/local/sbin/rd-migrate` is NOT installed**, so `rd-deploy migrate` is
   not a verb the box knows and comes back 64. Both repos must therefore be set
   to `MIGRATION_APPLY_MODE=manual`. See *Installing the `migrate` verb*. The
   repo side of that change — `rd-entry`'s acceptance of the verb, the
   workflow's `auto` path, the guard test — is already in place and is inert
   until the box catches up.

To re-verify, on the VPS:

```sh
sudo /usr/local/sbin/rd-deploy status
sudo /usr/local/sbin/rd-deploy revision
sudo -u deploy sudo -n /usr/local/sbin/rd-deploy status      # the sudoers grant
git -C /opt/restaurant-dash/Restaurant_Backend status --short --branch
git -C /opt/restaurant-dash/Restaurant_Dashboard_UI status --short --branch
```

And from a workstation, proving the key can do that and nothing else — **every
one of these must fail**:

```sh
ssh -i ci-deploy deploy@103.212.120.44 revision                     # works
ssh -i ci-deploy deploy@103.212.120.44                              # no shell
ssh -i ci-deploy deploy@103.212.120.44 'cat /opt/restaurant-dash/.env'
ssh -i ci-deploy deploy@103.212.120.44 'docker ps'                  # unknown verb
ssh -i ci-deploy deploy@103.212.120.44 update                       # bare update
ssh -i ci-deploy deploy@103.212.120.44 'update valkey'
ssh -i ci-deploy deploy@103.212.120.44 'deploy; sh'                 # charset reject
ssh -i ci-deploy -L 6379:127.0.0.1:6379 deploy@103.212.120.44 status # no forwarding
sudo -u deploy docker ps                                             # not in docker group
```

`install.sh` in this directory checks all of the above and is current for the
git transport. It verifies, and does not assume:

* both clones exist, are **on `main`**, have **clean working trees**, and their
  read-only deploy keys authenticate (`git ls-remote`);
* `docker-compose.yml` builds `./Restaurant_Backend` (backend, python) and
  `./Restaurant_Dashboard_UI` (dashboard) as local contexts;
* the wrapper refuses an unknown verb, an unknown service, a **bare `update`**
  and **`update valkey`** — each with 64 — and that `revision` prints 40-char
  shas, since the pipeline's deploy proof parses that output;
* `rd-entry` is installed as a forced command and refuses **both** an arbitrary
  command and an **interactive session** (empty `SSH_ORIGINAL_COMMAND` — the one
  that would hand over a shell);
* `.env.migrate` is present and root-only; `public/downloads` is non-empty;
  no `command:`/`entrypoint:` override on an application service and no
  `start:prod` anywhere; sudoers is wildcard-free and `visudo -c` is clean;
  `deploy` is not in the docker group; `cloudflared` is up.

It **writes only** `/usr/local/sbin/rd-entry` and the `authorized_keys` line. It
will not create `rd-deploy` or the sudoers file — those are the security
boundary and live only on the box (see `WRAPPER_CONTRACT.md`). Running it is
idempotent.

> Earlier revisions of that file verified the **registry** transport —
> `image: ghcr.io/…:prod`, `pull_policy: always`, a `/root/.docker` credential.
> Every one of those checks fails on a correctly-configured box now, which is
> worse than no check at all, so they were replaced rather than deleted. If you
> are reading an old copy, that is why.

---

## Applying a migration

**Which of the two sections below applies to you depends on one thing: whether
`/usr/local/sbin/rd-migrate` exists on the box.**

```sh
ls -l /usr/local/sbin/rd-migrate    # absent -> by hand, below. present -> the pipeline does it.
```

It does **not** exist today. Until it does, the by-hand procedure below is the
only route and **both repos must be set to `MIGRATION_APPLY_MODE=manual`** —
otherwise every migration-carrying deploy stops with exit 64 ("the box does not
have the migrate verb"), having changed nothing.

### While the verb is NOT installed — by hand

The production database has no PITR, so an auto-applied migration would be an
unrecoverable event a health check cannot see. **That is a statement about the
restore path, not about migrations**, and it is what
[*Installing the `migrate` verb*](#installing-the-migrate-verb) below is for.

The awkward part of the git transport is that the SQL has to reach the box before
it can be applied, and the only thing allowed to fetch is `update` — which
refuses to build while a migration is pending. Use that refusal:

```sh
# On the VPS, as root.

# 1. Fetches and resets the tree to main, THEN refuses with 65 without building.
#    That refusal is the point: the new migrations/ are now on disk and no
#    container has been touched.
sudo /usr/local/sbin/rd-deploy update backend ; echo "expect 65, got $?"

# 2. Name what is pending.
sudo /usr/local/sbin/rd-deploy check-migrations

# 3. Apply it with the CURRENTLY DEPLOYED image, overlaying the new migration
#    files read-only. Nothing here rebuilds anything, so the :previous rollback
#    target is left alone.
docker run --rm --env-file /opt/restaurant-dash/.env.migrate \
    -v /opt/restaurant-dash/Restaurant_Backend/migrations:/app/migrations:ro \
    restaurant-dash-backend:latest npm run migrate

# 4. Confirm.
sudo /usr/local/sbin/rd-deploy check-migrations   # must come back clean
```

**Two assumptions in step 3, both cheap to check first**, and neither has been
exercised against this box yet:

```sh
docker image inspect -f '{{.Config.WorkingDir}}' restaurant-dash-backend:latest   # expect /app
```

and that `npm run migrate` reads `migrations/` relative to that working
directory. Verify both **the first time**, deliberately, before trusting this
recipe.

The obvious alternative — `docker compose build backend` and then run `migrate`
from the fresh image — is **worse**, and not only because it burns a build:
building tags `restaurant-dash-backend:latest` with the *new* code, so the
subsequent `update` would tag that as `:previous` and your rollback target would
become the very build you are trying to be able to escape from.

Then re-run the deploy workflow from the **Actions tab**. A `workflow_dispatch`
run skips Gate A; the server gate still runs, and now passes.

### Once the verb IS installed — the pipeline does it

Nothing. Push. The deploy job reaches `update`, is refused with 65, calls
`rd-deploy migrate`, and retries the update once. The job summary names the
migrations that were applied and the dump that was taken first.

To take the by-hand route for one release anyway — a migration nobody trusts,
or one you want to watch — dispatch from the Actions tab with
**migrations = manual**. To turn it off for everyone, set the repository
variable `MIGRATION_APPLY_MODE=manual`. Neither needs a commit.

---

## Installing the `migrate` verb

**One-time, as root on the VPS. This is the step that closes the last manual gap
in the release pipeline, and it is deliberately a human decision** — it grants a
root-owned program the ability to write schema changes to a live database
holding real restaurant money.

### Before you start: read the thing you are installing

[`rd-deploy-migrate.proposed.sh`](./rd-deploy-migrate.proposed.sh) is written to
be read in one sitting. Read the header. In particular read *WHAT THIS DOES NOT
PROTECT AGAINST* and the paragraph about why it does **not** restore on failure
by default — if you disagree with that call, this is the moment to say so, not
after it is installed. [`WRAPPER_CONTRACT.md`](./WRAPPER_CONTRACT.md), *The
`migrate` verb*, is the summary.

**Do the restore test first.** No dump from this box has ever been restored. A
seatbelt nobody has pulled is not a seatbelt:

```sh
# On the VPS, as root, into a SCRATCH database — never the live one.
# Take a dump exactly the way rd-migrate will, restore it somewhere else, and
# confirm the row counts you expect. If this does not work, nothing below matters.
```

### The install

```sh
# 1. Get the reviewed script onto the box. It is in the repo clone already —
#    that clone is what the pipeline deploys from, so it is the same bytes CI saw.
cd /opt/restaurant-dash/Restaurant_Backend
git log -1 --format='%H %s' -- deploy/vps/rd-deploy-migrate.proposed.sh   # know what you are installing

install -o root -g root -m 0755 \
    deploy/vps/rd-deploy-migrate.proposed.sh \
    /usr/local/sbin/rd-migrate

# 2. Pre-pull the client image. rd-migrate NEVER pulls: a release step must not
#    depend on a registry being up, and an image fetched mid-incident is an
#    unvetted image. It refuses with 66 if this is missing.
#    The tag must be >= the server's major version or pg_dump aborts.
docker pull "$(sed -n 's/^PGTOOLS_IMAGE=//p' deploy/vps/rd-deploy-migrate.proposed.sh | head -n1)"

# 3. Add the ONE arm to the wrapper. This is the only edit to a vetted security
#    boundary in this whole change — keep it to these three lines. Back it up
#    first; there is no copy of rd-deploy anywhere else.
cp -a /usr/local/sbin/rd-deploy /root/rd-deploy.bak.$(date -u +%Y%m%dT%H%M%SZ)
vi /usr/local/sbin/rd-deploy
```

The arm, next to the other no-service verbs (`status`, `revision`,
`check-migrations`):

```sh
migrate)
  [ $# -eq 1 ] || exit 64          # takes no service, no arguments
  exec /usr/local/sbin/rd-migrate
  ;;
```

Then re-install the forced command so `rd-entry` accepts the new verb, and let
the installer check the whole thing:

```sh
scp -r deploy/vps root@<host>:/tmp/rd-vps
ssh root@<host> 'bash /tmp/rd-vps/install.sh /tmp/rd-vps/ci-deploy.pub'
```

`install.sh` treats an absent `rd-migrate` as a **supported state, not a
failure**, and reports what it finds either way: the file's mode, that
`migrate backend` is refused with 64, that the pg client image is present, that
the dump directory is `root:root 700`, how much disk is free, and — loudly —
whether the opt-in automatic restore has been switched on.

### Verifying it is live

```sh
# SAFE probes. Neither of these applies anything.
sudo /usr/local/sbin/rd-deploy migrate backend ; echo "expect 64, got $?"
stat -c '%U:%G %a' /usr/local/sbin/rd-migrate  ; # expect root:root 755

# From a workstation, with the CI key — proves the pipeline can reach it.
ssh -i ci-deploy deploy@<host> 'migrate backend'   # expect 64 from rd-entry
```

**Do not "test" it with a bare `sudo rd-deploy migrate`.** With nothing pending
it is a harmless no-op that exits 0 without taking a dump — but with something
pending it applies it, which is not a test. The real first exercise is a release
that carries one migration you have read, deployed outside service hours, with
the job summary open.

Then turn the pipeline on: set `MIGRATION_APPLY_MODE=auto` in the backend repo,
or delete the variable (`auto` is the default when it is unset). The dashboard
repo has no such variable to change.

### Rolling it back

Removing the verb is two commands and takes effect immediately. Nothing that has
already been applied is undone by this — it stops future automatic applies.

```sh
# 1. Stop the pipeline sending it. Do this FIRST: a deploy in flight will
#    otherwise reach a verb that is about to disappear.
#    In BOTH repos: Settings > Secrets and variables > Actions > Variables
#      MIGRATION_APPLY_MODE = manual

# 2. Remove the arm from the wrapper (restore the backup taken above), and:
rm -f /usr/local/sbin/rd-migrate
```

The pipeline degrades exactly to today's behaviour: Gate A refuses a
migration-carrying push in manual mode, the server gate refuses with 65, and the
by-hand recipe above is printed in the job summary.

**Keep `/var/backups/restaurant-dash/premigration`.** Those dumps are the only
rollback points for the migrations that were applied while the verb was live, and
deleting them is the one part of this rollback that is not reversible.

---

## Triggering a manual deploy

* **From GitHub:** Actions → *Deploy (production)* → **Run workflow** on `main`.
  This is also how you re-deploy after applying a migration.
* **On the box, without GitHub:**

  ```sh
  sudo /usr/local/sbin/rd-deploy check-migrations
  sudo /usr/local/sbin/rd-deploy update python
  sudo /usr/local/sbin/rd-deploy update backend
  sudo /usr/local/sbin/rd-deploy revision      # confirm it is the commit you meant
  sudo /usr/local/sbin/rd-deploy status
  ```

  Use `update dashboard` for the dashboard. **Do not use `deploy`** unless you
  specifically want "converge without rebuilding" — for example after editing
  `docker-compose.yml` by hand. `deploy` will not ship new code.

---

## Rolling back

```sh
sudo /usr/local/sbin/rd-deploy rollback backend    # then python, if it was updated
sudo /usr/local/sbin/rd-deploy status
sudo /usr/local/sbin/rd-deploy logs backend
```

`rollback` retags `<image>:previous` back to `:latest` and force-recreates, so
unlike the old wrapper it **does** revert the running code. Two limits, and the
workflows print both in their failure output:

1. **It does not touch the git working tree.** After a rollback,
   `rd-deploy revision` still reads the bad commit, and **the next `update` of
   that service — a workflow re-run, or someone shipping an unrelated fix —
   rebuilds it and puts it straight back into production.** The image rollback is
   a stopgap. The durable fix is:

   ```sh
   git revert <bad-sha> && git push      # then dispatch the workflow
   ```

2. **There is no `:previous` on a service's first `update`.** The wrapper warns
   on stderr that the code is *not* reverted and force-recreates the same image
   anyway. That is a restart, not a rollback. The workflows detect that warning
   and exit **74** rather than claiming a revert happened — but the detection
   reads the wrapper's *wording*, so if that wording ever changes it goes quiet.
   Read the captured output in the job summary, not just the headline.

There is **no combined rollback across the two repos.** Rolling the backend back
does not roll the dashboard back.

If the site is still down after a rollback, stop automating. Check the ingress
(`journalctl -u cloudflared`) — no image rollback fixes the tunnel — and
`docker compose -f /opt/restaurant-dash/docker-compose.yml ps`.

### Exit codes you will see in Actions

| Code | Source | Meaning | What to do |
|---|---|---|---|
| `0` | — | deployed, proven, healthy, publicly reachable | nothing |
| `1` | workflow | ssh transport failure (ssh's own 255, remapped) | if it happened during `update`, **the build kept running on the box**: check `revision` and `status` before re-running |
| `64` | wrapper / `rd-entry` | bad arguments | a **pipeline bug** — the workflow sent a sentence the grammar does not accept. Nothing on the box changed; re-running will not help. **One exception:** if the sentence was `migrate`, it is not a bug — the verb is not installed on the box yet. Install it, or set `MIGRATION_APPLY_MODE=manual`. The job summary says which case it is |
| `65` | wrapper | pending migration, nothing built | apply it (above). **The working tree has already moved** if the 65 came from `update`. In `auto` mode you only see this if `migrate` was already used once this run, or the retry was refused again |
| `66` | `rd-migrate` | the migration was refused **before the database was touched** — most often the `pg_dump` failed or did not verify, which is the feature working | **the database is unchanged.** Fix what the summary names (a Postgres server upgraded past the pinned client image, or a full `/var`) and re-run |
| `67` | `rd-migrate` | the migration failed and was **not** restored — the default | the failing file rolled itself back; files earlier in the run **are** applied. Production is still on the OLD code against that schema — check that first. Dump and restore command are on the box. Do not re-run |
| `68` | `rd-migrate` | the migration failed **and the restore also failed** | schema **indeterminate**. Stop. Do not re-run, do not deploy, do not delete the dump. Page a human |
| `75` | `rd-migrate` | another migration run holds the lock | wait for it, confirm with `check-migrations`, re-run |
| `77` | `rd-migrate` | apply reported success, the re-check still says pending | the runner and the database disagree. Read the rd-migrate log on the box before shipping code against this schema |
| `69` | dashboard workflow | the backend was already unhealthy | fix or roll back the backend first; nothing was deployed |
| `70` | workflow | unhealthy, **image rolled back**. Reached by a service that went unhealthy *and* by one whose post-update `status` line was `Restarting`/`Exited`/`Created` — a recognised not-running state is a health failure, not a failure to measure | production is on the previous build. **Revert the commit on `main`** — do not re-run |
| `71` | workflow | either the `rollback` **call** failed, or it succeeded and the service **still** did not come back. The summary and the error message say which | page a human; do not re-run. If the call succeeded and production is still down, the fault is probably not in these images |
| `72` | workflow | **the deploy could not be proven, and production was not observed broken.** Three distinct summaries share this code: **CANNOT BE PROVEN** (wrong revision, or every updated service *measured* as not recreated), **NOTHING CHANGED** (the no-op re-dispatch — box already on `github.sha`, revision did not move, every service measured as not recreated), and **COULD NOT BE MEASURED** (the post-update `status` call failed, a service was absent, or its line was in an unrecognised format). Also the pre-flight refusals: baseline `status` or `revision` unreadable. **It does *not* cover a service that came back `Restarting`/`Exited`/`Created`** — that is a replaced-and-broken deploy and goes to the rollback path (70/71/74) | read the summary and check which of the three it is. No rollback was attempted: either nothing was observed to have replaced the image, or the containers are healthy |
| `73` | workflow | shipped and healthy on the box, but the public URL genuinely never answered: timeouts, connection failures or 5xx — including any **mix** of those with 403s. A **pure-403 wall is not this exit**: every attempt answering an instant 403 means Cloudflare bot protection is challenging the runner, and the run is reported as probe **BLINDED** (a `::warning::`, per-attempt codes in the summary, judged on the on-box evidence) instead of red | check ingress/tunnel, then DNS, then TLS — the per-attempt HTTP codes are in the job summary. Not a rollback situation. If 403s keep appearing in the codes, add the Cloudflare WAF skip rule for the probe paths (needs dashboard access) |
| `74` | workflow | **no `:previous` existed**, so the container was force-recreated on the same image and the code was NOT reverted — whether or not it came back healthy | revert the commit on `main` and dispatch again. Healthy here means "the failing commit passed on the retry", not "reverted" |
| `127` | login shell | the forced command did not run | **treat as a security event**: the `authorized_keys` restriction or `rd-entry` has been removed |

---

## Cross-repo ordering

**The two repos deploy independently and nothing serialises them.**

* GitHub `concurrency:` groups are **per-repository**. `production-deploy-backend`
  and `production-deploy-dashboard` cannot see each other.
* The wrapper takes no lock.

What is in place, and what it does and does not cover:

* The dashboard workflow **refuses to deploy unless the `backend` service is
  already healthy** (exit 69). That catches a backend that is down, restarting or
  mid-swap.
* It does **not** catch a backend that is healthy right now and swaps a second
  later.

**Consequences of an interleave**, in order of likelihood:

1. The dashboard ships code calling a backend endpoint that has not deployed yet
   (or vice versa) → 404s or broken guest pages until the other deploy lands.
2. Two concurrent `docker compose` invocations on the same project can collide on
   shared resources and one may error out. **This matters more than it used to:**
   both now run a *build*, so they also compete for CPU and memory on a 2-vCPU
   box, and an out-of-memory kill during a build is a realistic outcome.
3. There is no combined rollback.

**Mitigation, procedural rather than technical: ship API contract changes
expand/contract.** Add the field in the backend and release, then consume it in
the dashboard and release. Do not push both repos at once.

If you want this enforced rather than agreed, the minimal change is a `flock` at
the top of `/usr/local/sbin/rd-deploy` (`exec 9>/var/lock/rd-deploy; flock -w 900
9 || exit 75`). **The pipeline does not assume it exists** and keeps working
exactly as it does today if you never add it — but the second deploy would wait
rather than race, and you would want `75` in the table above.

---

## What is deliberately not automated

* **Installing the `migrate` verb.** The verb itself automates applying
  migrations (see *Installing the `migrate` verb*), but putting it on the box is
  a human decision made once, with the script read: it is root-owned, it writes
  schema changes to a live database, and `install.sh` verifies it and refuses to
  create it — the same rule that already covers `rd-deploy` and the sudoers file.
  **Until it is installed, applying migrations is manual and both repos must be
  set to `MIGRATION_APPLY_MODE=manual`.**
* **Restoring after a failed migration.** `rd-migrate` takes the dump and refuses
  to migrate without one; it does **not** restore from it by default. A failed
  migration rolled its own transaction back, while restoring discards every order
  taken since the dump — see *On failure it does NOT restore, by default* in
  `WRAPPER_CONTRACT.md`. A human decides.
* **Refreshing `public/downloads`.** Shipping a 94 MB APK to every restaurant is a
  release decision, not a side effect of a code push. It stays a deliberate `scp`
  and a read-only bind mount.
* **Editing `docker-compose.yml`, any `.env`, or anything else on the box.** The
  wrapper cannot, and the CI identity cannot ask it to. This includes every
  dashboard build arg.
* **Pruning images.** Do not run `docker system prune -af` from a cron: it deletes
  the `:previous` tags, which are now the *entire* rollback mechanism. You find
  out at the worst possible moment. Prune by hand, keeping `:latest` and
  `:previous` for all three services.
* **Deploying during service.** There is no peak-window mechanism in the wrapper,
  and the builds now run on the production box. Time your deploys.
* **Enabling the `push:` trigger.** Both workflows are `workflow_dispatch`-only
  until one deploy has been watched end to end by hand.

---

## Tests that guard this

```sh
bash deploy/vps/tests/test_status_parser.sh
bash deploy/vps/tests/test_deploy_routing.sh
bash deploy/vps/tests/test_migrate_contract.sh
```

**`ci.yml` runs all three on every push and every pull request**, as the first
steps of the `backend` job — before the toolchain is installed, because they need
nothing but bash. A guard nobody runs is not a guard.

The wrapper is not in this repository, so the exact text of `rd-deploy status`,
`rd-deploy revision` and `rd-deploy rollback` is an **undeclared dependency** of
both workflows. That script extracts `svc_line`, `rev_of`, `svc_verdict`,
`uptime_secs`, `noprev_warned`, `restored_previous` and `assert_recreated`
straight out of `.github/workflows/deploy.yml` at run time — never a retyped copy,
which would drift — and runs them against captured fixtures in `tests/fixtures/`.

What it pins, beyond "the format has not changed":

* **the whole of docker's `HumanDuration` vocabulary**, `Up About an hour` and
  `N years` included, against a fixture captured byte-for-byte from the live box;
* **that unreadable input FAILS.** `assert_recreated` must never return 0 on a
  line it could not parse. It used to, and that silently disabled the recreation
  proof;
* **that recreation is the RESET, not an age.** A fixture pair whose "after" is
  an hour old still counts as recreated when the "before" was two years old,
  which is what makes the proof survive a slow build;
* **that a rollback which WORKED is not mistaken for one with no target.**
  `rollback_restored.txt` carries both a compose `WARN[0000]` banner and the word
  "previous" — the two things the old detector keyed on — and must not trip it.

Every one of those was found by reading, not by a failing test. **Do not loosen
this script**; re-capture the fixtures instead.

`test_migrate_contract.sh` covers the third undeclared dependency — the one that
writes to the production database. `rd-migrate` cannot read an exit code to tell
"pending" from "clean", because `scripts/migrate.ts` returns 0 either way, so it
keys on two **sentences** that file prints. The test extracts those constants
from the proposed wrapper and asserts they still appear in `migrate.ts`; it also
pins the pending-file parser, dump retention (against the one retention bug that
costs anything — deleting the newest dump instead of the oldest), `rd-entry`'s
acceptance of `migrate` with no service argument, and `deploy.yml`'s routing of
every `rd-migrate` exit code. The routing assertion that matters most is **64**:
it must be diagnosed as *the box is behind this repo*, never as a workflow bug —
the same misdiagnosis class that once rendered a missing forced command (127) as
PENDING MIGRATION.

---

## Known gaps, honestly

1. **The stale Supabase repository secrets.** Top of this file. Rotate before
   enabling either push trigger.
2. ~~**`install.sh` is stale**~~ — **fixed.** It now verifies the git transport:
   both clones on `main` with clean trees and authenticating deploy keys, the
   compose build contexts, the wrapper's refusal of a bare `update` and
   `update valkey`, `revision`'s output format, and `rd-entry` refusing both an
   arbitrary command and an interactive session. It still writes only `rd-entry`
   and the `authorized_keys` line, and still refuses to create `rd-deploy` or
   the sudoers file.

   What remains unproven is narrower: its checks are read-only assertions about
   configuration, not a test that a deploy *works*. Only a real dispatch shows
   that.
3. **The pipeline cannot prove the running image was built from the deployed
   tree** — only that the tree is at this commit and that a new container is
   running. Putting the revision in `/health` closes it and is the highest-value
   follow-up.
4. **The apply-a-migration command above has not been run on this box.** Its two
   assumptions (WORKDIR `/app`, `migrations/` read relative to it) are checkable
   in one command; do that the first time rather than in an incident.

   `rd-migrate` turns the first of those into a **checked precondition** — it
   refuses with 66 if the image's `WorkingDir` is not `/app` — but it inherits
   the second assumption unchanged, and it inherits the whole recipe unexercised.

   **And a bigger one it adds: no dump this design produces has ever been
   restored.** `pg_restore --list` proves the archive header and table of
   contents parse and that a known table is present; it does not read a single
   data block. Until someone has restored one into a scratch database and checked
   the row counts, the restore path this whole change is built on is an
   assumption. Do that before installing the verb, not after.
5. **The no-`:previous` detection still reads the wrapper's warning text**, and
   that is now the *only* remaining direction of error. It matches the sentence
   the wrapper actually prints (`no previous image for` / `code is NOT
   reverted`), case-sensitively, on ASCII-only fragments.

   The failure it used to have was the opposite one and far more likely: the
   detector matched any line containing `warn` **and** any line containing
   `previous`, and **both are true of a rollback that succeeded** — docker compose
   v2 prints `WARN[0000] ...` on essentially every invocation, and the wrapper's
   success line is `restored restaurant-dash-<svc>:previous`. Every working
   rollback was therefore reported as exit 74, "the code was NOT reverted", and
   because that branch sat *above* the post-rollback health check, the
   verification never ran at all. The branch now sits **below** it, so a rollback
   that demonstrably restored health can never be reported as no rollback.

   What remains: if someone rewords the wrapper, a genuine no-target restart could
   be reported as a rollback. That needs a human to edit `rd-deploy` first, the
   captured output is always in the summary, and
   `tests/fixtures/rollback_noprev.txt` fails the parser test the moment the
   sentence changes.
6. **No cross-repo serialisation**, and the two builds now compete for the same
   2 vCPUs. See above.
7. **`update` deploys whatever `main` points at when it runs**, not the commit
   that triggered the workflow. A push landing mid-deploy is caught after the
   fact by the revision proof (exit 72), not prevented.
8. **The public probe can be BLINDED by Cloudflare bot protection**, and the
   durable fix cannot be shipped from these repos. Measured 2026-08-18: both
   deploys exited 73 with every probe attempt answered by an instant 403 while
   the same URLs served 200 to every other client throughout — the edge was
   challenging curl from the GitHub runner, not reporting an outage. The
   workflows now classify a **pure-403 wall** as "probe BLINDED" (`PUBLIC_OK=2`,
   a `::warning::`, run judged on the on-box evidence) rather than exit 73; any
   mix of 403s with timeouts/connection failures/5xx still fails 73. Until a
   **Cloudflare WAF skip rule** is added for the probe paths (`/health` on the
   API host, `/login` on the dashboard host) — which needs Cloudflare dashboard
   access — no run can observe production from outside the box, so a real
   outage that Cloudflare masks with 403s at the edge would go unprobed.
