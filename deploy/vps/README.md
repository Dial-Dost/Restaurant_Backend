# CI/CD to the production VPS — runbook

Covers **both** repositories. `Restaurant_Dashboard_UI/deploy/README.md` points
here, because the server-side wrapper this documents serves both.

Nothing in this directory has ever run against production. Treat the first
deploy as a change to a live system serving real restaurants, and do it outside
service hours.

---

## READ THIS FIRST: the stale production secrets are still unrotated

`.github/workflows/ci.yml` records, in its own header, that the deleted
`backend-ci.yml` pointed `RESTAURANT_ID: csrorganics` — a live, paying tenant —
at the production Supabase credentials held as **repository secrets**. That
workflow is gone. **The secrets are not.** Deleting a workflow deletes the use,
not the secret. As of this writing they have **not** been rotated.

Two facts, unsoftened:

1. **Those production database credentials are one pull request away for
   everyone with write access, and have been for weeks.** A workflow triggered by
   `pull_request` from a same-repo branch receives repository secrets. Anyone who
   can push a branch can add a workflow that prints them. That is default GitHub
   behaviour, not a hypothetical.

2. **This pipeline raises the stakes considerably.** Until now the worst case was
   a leak of database credentials. Once a deploy pipeline exists, the same
   one-PR exfiltration also yields the ability to ship code to production. You
   would be putting a key to the house in a drawer you already know is unlocked.

**Sequencing is not negotiable: rotate and delete the stale Supabase repository
secrets BEFORE either deploy workflow merges, not after.**

```sh
gh secret list --repo Dial-Dost/Restaurant_Backend        # see what is still there
gh secret delete <NAME> --repo Dial-Dost/Restaurant_Backend
```

Rotating means issuing new credentials in Supabase and retiring the old ones.
Deleting the GitHub secret alone leaves a live credential that has been exposed
to every workflow run in the repository's history.

The new deploy key is deliberately **not** a repository secret. It lives in a
GitHub **Environment** named `production`, which a workflow running on a feature
branch or a pull request cannot read. That property is the single
highest-value control in this design, and it is why both deploy workflows carry
`environment: production` on their deploy job.

---

## How new code actually reaches the box

This is the part that had to be rewritten from the draft, so read it before
anything else.

`/usr/local/sbin/rd-deploy` is the **only** program the CI identity can cause to
run. Its whole vocabulary is `status`, `logs [service]`, `check-migrations`,
`deploy [service]`, `rollback [service]` — see
[`WRAPPER_CONTRACT.md`](./WRAPPER_CONTRACT.md). It accepts **no image reference,
no digest, no file path and no flag**. `deploy` is `docker compose up -d`.

Given that, plus: the box has **no git access** (deploy keys are disabled
org-wide), and `docker-compose.yml` exists **only** on the box and is not in git —
there is exactly one honest answer:

> **The registry is the transport, and a mutable tag is the deployment pointer.**
> CI pushes an immutable digest to GHCR, moves `ghcr.io/…:prod` to it, and then
> asks the wrapper to converge. The wrapper deploys "whatever `:prod` is", and CI
> decides what `:prod` is.

That requires **a one-time change to `docker-compose.yml` on the server**
(see [Switch compose to follow the `:prod` tag](#4-switch-compose-to-follow-the-prod-tag)).
There is no way around it and no wrapper capability that substitutes for it.

Two consequences worth internalising:

* **`pull_policy: always` is load-bearing.** Compose's default pull policy is
  `missing`. Without `always`, `docker compose up -d` sees the `:prod` tag
  already present on disk, reuses it, changes nothing — and CI reports green.
  A silent no-op deploy is the worst failure mode this design has, so both
  workflows assert afterwards that the container was actually *recreated* (by
  reading the uptime out of `compose ps`) and fail loudly, naming this cause, if
  it was not.
* **Rollback is real only because CI owns the tag.** `rd-deploy rollback` is
  `docker compose up -d --force-recreate`; on its own it re-converges on the same
  tag and gives you the *same image back*. It restarts a container, it does not
  go back a version. The workflows make it a genuine rollback by re-pointing
  `:prod` to the previous digest **first**, then asking for the force-recreate.
  Every failure path restores the tag, so `:prod` always names what production is
  running.

### What the pipeline still cannot prove

`compose ps` prints the image **tag**, and `/health` carries no revision, so
**CI cannot prove which digest is live.** It proves the container was recreated
and is healthy. To prove the digest, on the box:

```sh
cd /opt/restaurant-dash
docker inspect -f '{{.Image}}' "$(docker compose ps -q backend)"
docker image ls --digests | grep restaurant_backend
```

---

## What the pipeline does, step by step

**`Restaurant_Backend` on push to `main`:**

1. **ci** — `ci.yml` via `workflow_call`, unchanged and secret-free: money
   invariants, typecheck, unit tests, the route-manifest gate
   (`npm run test:routes`), migration chain, tenant isolation, real-Postgres
   integration tests, container smoke test. Node 22.
2. **build_push** — builds `Dockerfile.node` and `Dockerfile.python`, pushes
   `:sha-<commit>` (immutable provenance) and `:main` (BuildKit cache only), and
   outputs both digests. **`:prod` is not touched here.**
3. **migration_gate (Gate A)** — a `git diff` over `migrations/`. Zero
   credentials, no network call. If this push adds SQL, the run stops here with
   the exact `docker run … npm run migrate` command, and `:prod` never moves.
4. **deploy** (`environment: production`) — moves `:prod` → asks
   `check-migrations` → `deploy python` (skipped when its digest is unchanged) →
   `deploy backend` → asserts recreation → polls `status` until `(healthy)` →
   optional public probe. On any failure it restores `:prod`, runs
   `rd-deploy rollback`, and fails red.

**`Restaurant_Dashboard_UI` on push to `main`:** the same shape, minus the
migration gate, plus a precondition that the **backend is already healthy**
before it will touch anything.

### The two migration gates, and why there are two

| | Gate A (CI) | The server gate |
|---|---|---|
| Where | GitHub runner | inside `rd-deploy deploy`, exit 65 |
| Credential | none | `.env.migrate`, root-only, never leaves the box |
| Detects | migrations added *by this push* | anything the *database* has not applied |
| Misses | a migration from an earlier push nobody applied | nothing |
| Cost | a `git diff` | one command on the box |

Gate A exists to fail *before* `:prod` moves and before an SSH connection is
opened. The server gate is the true one. **Neither ever applies a migration.**

A `workflow_dispatch` run skips Gate A deliberately — that is how you re-run a
deploy after applying a migration by hand. Re-running the *push* would just fail
at Gate A again.

---

## Secrets and variables

Every secret the workflows read, named exactly as it appears in the YAML.

### `secrets.DEPLOY_SSH_KEY` — **environment** secret on `production`, both repos

The **private** half of the ed25519 keypair whose public half is in
`/home/deploy/.ssh/authorized_keys`.

**What it grants:** an SSH session to the `deploy` account that is immediately
replaced by the forced command `/usr/local/sbin/rd-entry`. Its entire vocabulary
is `status`, `logs [svc]`, `check-migrations`, `deploy [svc]`, `rollback [svc]`.
It cannot open a shell, cannot forward a port to Valkey or Postgres, cannot read
an env file, cannot run `docker` (the `deploy` user is not in the docker group),
and cannot run any program other than `rd-deploy`.

It must be an **environment** secret, not a repository secret, so a workflow on a
feature branch or a PR cannot read it.

### `secrets.GITHUB_TOKEN` — automatic, you do not create it

Used to `docker login ghcr.io`. Grants push of the image and the ability to move
the `:prod` tag, via `permissions: packages: write` on the two jobs that need it.
It is ephemeral and scoped to the run.

### Repository variables — both repos

These are `vars.*`, not secrets. None is confidential; the risk in each is its
*absence* or a wrong value, not its disclosure.

| Name | Value | Notes |
|---|---|---|
| `DEPLOY_HOST` | the VPS address | not a secret |
| `DEPLOY_USER` | `deploy` | the restricted identity |
| `DEPLOY_PORT` | `22` | may be omitted; defaults to 22 |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan` below | the workflow **refuses to run** without it. Never `StrictHostKeyChecking=no` — that would let anyone on the runner's network path collect the deploy key |

### Repository variables — `Restaurant_Backend` only

| Name | Value |
|---|---|
| `PUBLIC_HEALTH_URL` | optional. The public `…/health` URL through cloudflared. Used only as a supplementary probe; a failure here **warns**, it never triggers a rollback, because an image rollback cannot fix a broken tunnel |

### Repository variables — `Restaurant_Dashboard_UI` only

All three are baked into the image at build time.

| Name | Value |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | the **public origin guests reach** — the cloudflared hostname. Do not guess it; read it from the running image or the cloudflared config. The build fails if it is empty or contains `localhost` |
| `BACKEND_INTERNAL_URL` | `http://backend:3001` (the compose service name; defaults to this if unset) |
| `NEXT_PUBLIC_FEEDBACK_FORM_URL` | leave unset unless the feedback form is hosted off-origin |
| `PUBLIC_DASHBOARD_URL` | optional public probe URL, e.g. the `/login` page |

### Creating the key and the host pin

```sh
# On your workstation. No passphrase — a CI runner cannot type one.
ssh-keygen -t ed25519 -N '' -C 'ci-deploy' -f ci-deploy

# Private half -> the production ENVIRONMENT secret, in BOTH repos:
gh secret set DEPLOY_SSH_KEY --env production --repo Dial-Dost/Restaurant_Backend      < ci-deploy
gh secret set DEPLOY_SSH_KEY --env production --repo Dial-Dost/Restaurant_Dashboard_UI < ci-deploy

# Host key pin.
ssh-keyscan -p 22 <host> > known_hosts.txt
gh variable set SSH_KNOWN_HOSTS --repo Dial-Dost/Restaurant_Backend      < known_hosts.txt
gh variable set SSH_KNOWN_HOSTS --repo Dial-Dost/Restaurant_Dashboard_UI < known_hosts.txt

gh variable set DEPLOY_HOST --repo Dial-Dost/Restaurant_Backend --body '<host>'
gh variable set DEPLOY_USER --repo Dial-Dost/Restaurant_Backend --body 'deploy'
# ...and the same for the dashboard repo.
```

Configure the `production` environment in **both** repos with *deployment
branches: selected branches → `main`*. Add required reviewers if you want a human
click before every production deploy.

### The exact `authorized_keys` line

Install this as the **only** line in `/home/deploy/.ssh/authorized_keys`
(`deploy:deploy`, mode `0600`), with `<PUBKEY>` replaced by the full contents of
`ci-deploy.pub`:

```
restrict,command="/usr/local/sbin/rd-entry" ssh-ed25519 AAAA...<PUBKEY>... ci-deploy
```

`restrict` implies `no-port-forwarding`, `no-agent-forwarding`,
`no-X11-forwarding`, `no-pty` and `no-user-rc`, and automatically picks up any
future restriction OpenSSH adds. `command=` means the client's own command line is
never executed: it arrives in `$SSH_ORIGINAL_COMMAND`, and `rd-entry`
character-whitelists it, splits it into an argv array without ever invoking a
shell, checks it against the same grammar `rd-deploy` enforces, and `exec`s
`sudo -n /usr/local/sbin/rd-deploy`.

`install.sh` writes this line for you if you pass it the public key file.

> **This is not yet configured on the box.** The `deploy` user currently has its
> own public key in its `authorized_keys` with no forced command. Until this line
> replaces it, that key is an ordinary shell account.

---

## One-time server setup still outstanding

Ordered. Steps 1–4 must all be done before the first pipeline run.

### 1. Install the forced command

```sh
scp -r deploy/vps ci-deploy.pub root@<host>:/tmp/rd-vps
ssh root@<host> 'bash /tmp/rd-vps/install.sh /tmp/rd-vps/ci-deploy.pub'
```

`install.sh` writes only `/usr/local/sbin/rd-entry` and the `authorized_keys`
line. It **verifies** `rd-deploy`, the sudoers fragment, compose, the bind mount,
the GHCR credential and cloudflared — and refuses to write any of them. It exits
non-zero listing anything unfinished.

### 2. GHCR read credentials for root (deliberately not a GitHub secret)

`rd-deploy` runs `docker compose` as root, so **root's** docker config is what
pulls. `secrets.GITHUB_TOKEN` is ephemeral and cannot help here.

```sh
# On the VPS, as root. Use a token with read:packages ONLY.
printf '%s' '<READ_ONLY_TOKEN>' | docker login ghcr.io -u <github-user> --password-stdin
```

The three packages must be visible to that token: either make
`restaurant_backend`, `restaurant_python` and `restaurant_dashboard` internal/
public in the org, or grant the token read access to each.

Without this, `compose up -d` cannot pull and every deploy fails at the pull.

### 3. The migration credential

`rd-deploy check-migrations` needs a database credential that never leaves the
box.

```sh
# /opt/restaurant-dash/.env.migrate    root:root 0600
MIGRATION_DATABASE_URL=postgresql://<owner-role>:<pw>@<host>:<port>/<db>
```

Owner/migration role, **not** `app_runtime` — `app_runtime` intentionally lacks
DDL privileges. Nothing in CI ever sees this file; CI sees an exit code and the
wrapper's own output.

### 4. Switch compose to follow the `:prod` tag

**This is the change that makes the whole pipeline work, and it is the only file
edit required on the server.** `/opt/restaurant-dash/docker-compose.yml`, for the
three application services (leave `valkey` alone):

```yaml
  backend:
    image: ghcr.io/dial-dost/restaurant_backend:prod
    pull_policy: always          # WITHOUT THIS EVERY DEPLOY IS A SILENT NO-OP
    # ...everything else unchanged: restart: always, the 127.0.0.1:3001 publish,
    #    env_file, depends_on. Remove any `build:` key.

  python:
    image: ghcr.io/dial-dost/restaurant_python:prod
    pull_policy: always

  dashboard:
    image: ghcr.io/dial-dost/restaurant_dashboard:prod
    pull_policy: always
    # DO NOT TOUCH the public/downloads bind mount. It stays read-only:
    #   - ./public/downloads:/app/public/downloads:ro
```

Do not change the port publishes (`127.0.0.1:3001`, `127.0.0.1:9002`), the
`restart: always` policies, or the `public/downloads` mount. `install.sh` checks
for the `:prod` references and counts at least three `pull_policy: always` lines.

### 5. Seed the `:prod` tags before the first run

Optional but strongly recommended: it is what gives the very first pipeline run a
rollback target.

```sh
# On your workstation, logged in to ghcr.io. Build/push the CURRENTLY RUNNING code
# once by hand from the commit that is live, then:
docker buildx imagetools create --tag ghcr.io/dial-dost/restaurant_backend:prod   ghcr.io/dial-dost/restaurant_backend:sha-<live-commit>
docker buildx imagetools create --tag ghcr.io/dial-dost/restaurant_python:prod    ghcr.io/dial-dost/restaurant_python:sha-<live-commit>
docker buildx imagetools create --tag ghcr.io/dial-dost/restaurant_dashboard:prod ghcr.io/dial-dost/restaurant_dashboard:sha-<live-commit>
```

Then `sudo rd-deploy deploy backend` once, by hand, and confirm the stack is
healthy on registry images before CI ever runs. See
[First-run safety](#first-run-safety) for what happens if you skip this.

### 6. Verify before you trust it

```sh
# On the box, as root — proves the wrapper works at all:
sudo /usr/local/sbin/rd-deploy status

# As the deploy user, through sudo — proves the sudoers grant works:
sudo -u deploy sudo -n /usr/local/sbin/rd-deploy status

# From your workstation, through SSH — proves the forced command works:
ssh -i ci-deploy deploy@<host> status
ssh -i ci-deploy deploy@<host> check-migrations

# And prove the key CANNOT do anything else. EVERY ONE of these must fail:
ssh -i ci-deploy deploy@<host>                                   # no shell
ssh -i ci-deploy deploy@<host> 'cat /opt/restaurant-dash/.env'   # no file read
ssh -i ci-deploy deploy@<host> 'docker ps'                       # unknown verb
ssh -i ci-deploy deploy@<host> 'deploy; sh'                      # charset reject
ssh -i ci-deploy -L 6379:127.0.0.1:6379 deploy@<host> status     # no forwarding
sudo -u deploy docker ps                                          # not in docker group
```

---

## First-run safety

On the very first pipeline run, `:prod` may not exist in GHCR yet. Both workflows
detect this (`FIRST_RUN`) and behave as follows:

* The tag is **created** pointing at the new build, so the deploy can proceed.
* There is **no rollback target**, because there is no previous digest anywhere —
  the wrapper keeps no history and `rd-deploy rollback` would only force-recreate
  the *same failing image*.
* So if the health check fails on a first run, the workflow **does not call
  `rollback`**. It leaves the stack as it is — up, on the new image — rather than
  churning it, prints the `compose ps` output and the last 100 log lines, and
  fails with the exact commands to point `:prod` at a known-good digest by hand.

**The stack is never left down by this path**, because the failure mode is "the
new container is running but unhealthy", and repeatedly recreating it would only
add outage. Seeding `:prod` first (step 5 above) removes the situation entirely.

The other first-run hazard is a compose file that still lacks
`pull_policy: always`: `up -d` would then quietly do nothing. That is what the
recreation assertion catches — it fails the build with that exact diagnosis
instead of reporting a green deploy that never happened.

---

## Applying a migration

The pipeline will **never** do this. The production database has no PITR, so an
auto-applied migration is an unrecoverable event a health check cannot see.

1. Push the migration. Gate A stops the run and prints the digest.
2. On the VPS, as root, from the image that carries the SQL (`migrations/` is
   baked into the image, so running it from the *deployed* image would apply the
   OLD file set):

   ```sh
   docker run --rm --env-file /opt/restaurant-dash/.env.migrate \
       ghcr.io/dial-dost/restaurant_backend@sha256:<digest-from-the-summary> \
       npm run migrate
   ```

3. Watch it finish.
4. Re-run the workflow from the **Actions tab** (Run workflow). A
   `workflow_dispatch` run skips Gate A; the server gate still runs.

---

## Triggering a manual deploy

* **From GitHub:** Actions → *Deploy (production)* → **Run workflow** on `main`.
  This rebuilds from the current `main`, so it is also how you re-deploy after
  applying a migration.
* **On the box, without GitHub** (the images must already be in GHCR and `:prod`
  must already point where you want):

  ```sh
  sudo /usr/local/sbin/rd-deploy check-migrations
  sudo /usr/local/sbin/rd-deploy deploy backend
  sudo /usr/local/sbin/rd-deploy status
  ```

  Use `deploy dashboard` / `deploy python` for the others. Avoid a bare
  `rd-deploy deploy` — that is `compose up -d` across the whole stack, valkey
  included.

---

## Rolling back by hand

`rd-deploy rollback` alone is **not** a version rollback — it is
`compose up -d --force-recreate` and will hand you the same image back. A real
rollback is two steps, and the first one is in the registry:

```sh
# 1. On your workstation, logged in to ghcr.io. Find the digest you want:
docker buildx imagetools inspect ghcr.io/dial-dost/restaurant_backend:prod
#    ...and point :prod back at a known-good build:
docker buildx imagetools create \
    --tag ghcr.io/dial-dost/restaurant_backend:prod \
    ghcr.io/dial-dost/restaurant_backend:sha-<good-commit>
docker buildx imagetools create \
    --tag ghcr.io/dial-dost/restaurant_python:prod \
    ghcr.io/dial-dost/restaurant_python:sha-<good-commit>

# 2. On the VPS, converge onto it:
sudo /usr/local/sbin/rd-deploy rollback backend
sudo /usr/local/sbin/rd-deploy status
sudo /usr/local/sbin/rd-deploy logs backend
```

The successful-deploy job summary prints the previous digests under
*"rollback target"* — that is the value to put back.

If the site is still down after a rollback, stop automating. Check
`journalctl -u cloudflared` (the tunnel is the only ingress; no image rollback
fixes it) and `docker compose -f /opt/restaurant-dash/docker-compose.yml ps`.

### Exit codes you will see in Actions

| Code | Source | Meaning | What to do |
|---|---|---|---|
| `0` | — | deployed and healthy | nothing |
| `64` | wrapper | bad arguments | a **pipeline bug** — the workflow sent a sentence `rd-deploy` does not accept |
| `65` | wrapper | pending migration, **nothing deployed**, `:prod` restored | apply it, re-run from the Actions tab |
| `69` | dashboard workflow | the backend was already unhealthy | fix or roll back the backend first; nothing was deployed |
| `70` | workflow | health checks failed, **rolled back** | service is fine on the previous image; fix forward, do not re-run |
| `71` | workflow | **rollback also failed** | page a human; do not re-run |
| `255` | ssh | transport failure, not a wrapper code | check the host, then `rd-deploy status` before re-running |

---

## Cross-repo ordering

**The two repos deploy independently and nothing serialises them.** Stated
plainly because the earlier draft claimed a `flock` inside `rd-deploy` that does
not exist.

* GitHub `concurrency:` groups are **per-repository**. `production-deploy-backend`
  and `production-deploy-dashboard` cannot see each other.
* The installed wrapper takes no lock.

What is actually in place, and what it does and does not cover:

* The dashboard workflow **refuses to deploy unless the `backend` service is
  already healthy** in `compose ps`. That catches a backend that is down,
  restarting, or mid-swap.
* It does **not** catch a backend that is healthy right now and swaps a second
  later. Two pushes landing within the same minute can interleave.

**Consequences of an interleave**, in order of likelihood:

1. The dashboard ships code that calls a backend endpoint that has not been
   deployed yet (or vice versa) → 404s or broken guest pages until the other
   deploy lands, typically a couple of minutes.
2. Two concurrent `docker compose up -d` invocations on the same project can
   collide on shared resources and one may error out. Each targets a different
   service, so this does not corrupt anything, but it can leave a deploy
   half-applied and reported red.
3. There is **no combined rollback.** Rolling the backend back does not roll the
   dashboard back.

**Mitigation, which is procedural rather than technical: ship API contract
changes expand/contract.** Add the field in the backend and release it, then
consume it in the dashboard and release. Two deploys, decided by a person who
understands the contract. Do not push both repos at once.

If you want this enforced rather than agreed, the minimal change is a `flock` at
the top of `/usr/local/sbin/rd-deploy` on the server (`exec 9>/var/lock/rd-deploy;
flock -w 900 9 || exit 75`). **The pipeline does not assume it exists** and will
keep working exactly as it does today if you never add it — but the second
deploy would then wait rather than race, and you would want to add `75` to the
exit-code table above.

---

## What is deliberately not automated

* **Applying migrations.** No PITR; see above.
* **Refreshing `public/downloads`.** Shipping a 94 MB APK to every restaurant is
  a release decision, not a side effect of a code push. It stays a deliberate
  `scp` and a read-only bind mount.
* **Editing `docker-compose.yml`, any `.env`, or anything else on the box.** The
  wrapper cannot, and the CI identity cannot ask it to.
* **Pruning images.** Do not run `docker system prune -af` from a cron. It
  deletes the rollback target and you find out at the worst possible moment.
  Prune by hand, keeping at least the digest behind `:prod` and the one before it.
* **Deploying during service.** The draft had a `PEAK_WINDOWS` /
  `--force-window` mechanism; the installed wrapper has neither, so it has been
  removed rather than faked. Time your pushes.

---

## Known gaps, honestly

1. **The stale Supabase repository secrets are still unrotated.** Top of this
   file. Rotate before merging either workflow.
2. **The forced command is not installed yet.** Until the `authorized_keys` line
   above is in place, the `deploy` key is an ordinary shell account.
3. **The pipeline cannot prove which digest is live** — only that the container
   was recreated and is healthy. Adding a revision field to `/health` (the image
   is already labelled `org.opencontainers.image.revision`) would close this and
   is the single highest-value follow-up.
4. **`check-migrations` runs on the server against whatever compose resolves.**
   The workflow moves `:prod` *before* calling it, so with `pull_policy: always`
   it should see the new migration set. Verify this once, deliberately, on the
   first release that carries SQL: confirm `check-migrations` names the new file
   rather than passing clean. If it passes clean on a push that Gate A flagged,
   the wrapper is checking the *running* container, and Gate A is the only real
   protection you have.
5. **No cross-repo serialisation.** See above.
6. **`:prod` is a mutable tag.** Anyone with `packages: write` on the org can
   move it. The immutable record of what shipped is `:sha-<commit>` plus the job
   summary of the run.
