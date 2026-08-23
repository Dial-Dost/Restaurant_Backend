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

## Grammar

| Command | What it does on the box |
|---|---|
| `rd-deploy status` | `docker compose ps` |
| `rd-deploy logs [service]` | `docker compose logs --tail 100` |
| `rd-deploy check-migrations` | reports pending migrations; **applies nothing** |
| `rd-deploy deploy [service]` | exit **65** if a migration is pending, else `docker compose up -d [service]` |
| `rd-deploy rollback [service]` | `docker compose up -d --force-recreate [service]` |

* Any other first argument exits **64**.
* `service`, where accepted, must be one of `backend`, `dashboard`, `python`,
  `valkey`, or omitted (= the whole stack).
* `check-migrations` takes **no** argument.
* There are **no** digest arguments, **no** `--git-sha`, **no** `--force-window`,
  **no** file paths, and **no** image reference of any kind.
* The compose project lives at `/opt/restaurant-dash`. `docker-compose.yml` is
  there **only** — it is not in git and the wrapper cannot be asked to change it.

### `rd-entry` is deliberately narrower than this

`deploy/vps/rd-entry`, the SSH forced command in front of the wrapper, enforces
this grammar **minus** two things. It is never wider; the wrapper re-validates
everything it lets through.

| The wrapper accepts | `rd-entry` | Why |
|---|---|---|
| `deploy valkey`, `rollback valkey`, `logs valkey` | **rejected, 64** | valkey is the shared cache; a restart is felt by every till at once, and neither workflow has ever named it |
| bare `deploy`, bare `rollback` | **rejected, 64** | those are `compose up -d` across the whole stack. The backend workflow sends `deploy python` then `deploy backend`; the dashboard sends `deploy dashboard` |

Both narrowings only turn an accept into a `64`, so a `64` in a workflow log can
now mean *either* side refused. The workflows' 64 message says so. Bare `logs`
and bare `status` / `check-migrations` are unchanged.

## Exit codes the workflows render

| Code | Meaning | What the workflow does |
|---|---|---|
| `0` | success | continue to the health poll |
| `64` | bad arguments | restore `:prod`, fail as a **pipeline bug** |
| `65` | pending migration, nothing deployed | restore `:prod`, re-run `check-migrations` to name the file, fail with the exact `docker run … npm run migrate` line |
| `255` | *not* a wrapper code — this is ssh's transport failure | restore `:prod`, fail without claiming to know the stack's state |
| `127` | *not* a wrapper code either — this is the **login shell's** "command not found", i.e. the forced command is not installed and `rd-deploy` was never reached | restore `:prod`, fail naming the forced command. It is handled **before** the 64/65 branches at every call site: without its own case it renders as PENDING MIGRATION, which is a flat misdiagnosis |

`70` and `71` appear in the workflow output, but they are **invented by the
workflow**, not returned by the wrapper: `70` = "deployed, unhealthy, rolled
back", `71` = "rollback also failed". `69` likewise is the dashboard workflow's
own code for "the backend was already unhealthy, refused to deploy".

## What the wrapper does **not** give the pipeline

These absences drive the whole design of `deploy.yml`; do not paper over them.

1. **No way to pass an image.** Hence the registry-plus-tag transport — see
   `README.md`, *How new code reaches the box*.
2. **No version rollback.** `rollback` is `up -d --force-recreate`, which
   re-converges on whatever tag compose already names. It restarts a container;
   it does not go back a version. The workflow makes it a real rollback by
   re-pointing the `:prod` tag in GHCR *first*.
3. **No health check and no wait.** `compose up -d` returns as soon as the
   container starts. The workflow polls `rd-deploy status` (`compose ps`) and
   reads the `STATUS` column, which carries `(healthy)` / `(unhealthy)` because
   all four images declare a `HEALTHCHECK`.
4. **No build identity.** `compose ps` prints the image *tag*, and `/health`
   carries no revision. **The pipeline cannot prove which digest is live.** It
   proves the container was *recreated* (via the uptime in `compose ps`) and that
   it is healthy. To prove the digest, a human runs, on the box:
   `docker inspect -f '{{.Image}}' $(docker compose -f /opt/restaurant-dash/docker-compose.yml ps -q backend)`
5. **No lock.** Nothing serialises a backend deploy against a dashboard deploy.
   See `README.md`, *Cross-repo ordering*.
6. **No peak-service window.** An earlier draft assumed a `deploy.conf` with
   `PEAK_WINDOWS` and a `--force-window` flag. None of that exists. `deploy.conf`
   and `deploy.conf.example` have been deleted from this directory, and the
   `force_window` workflow input is gone.

## Verifying the box still matches this file

`install.sh` does this automatically; to check by hand, on the VPS:

```sh
sudo /usr/local/sbin/rd-deploy nonsense ; echo "expect 64, got $?"
sudo /usr/local/sbin/rd-deploy deploy nonsense ; echo "expect 64, got $?"
sudo /usr/local/sbin/rd-deploy status | head
stat -c '%U:%G %a' /usr/local/sbin/rd-deploy   # expect: root:root 755
sudo -u deploy docker ps                        # MUST be permission denied
id -nG deploy | tr ' ' '\n' | grep -qx docker && echo "!! deploy is in the docker group — that IS root"
```

If any of that has changed, **stop and fix `deploy.yml` to match the box** —
never the other way round. The box is authoritative.
