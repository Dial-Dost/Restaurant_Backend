#!/bin/bash
# =============================================================================
# install.sh — finish the one-time server-side setup for the CI/CD deploy path.
#
# RUN AS ROOT ON THE VPS. Idempotent.
#
#   scp -r deploy/vps root@<host>:/tmp/rd-vps
#   ssh root@<host> 'bash /tmp/rd-vps/install.sh /tmp/rd-vps/ci-deploy.pub'
#
# WHAT IT WRITES (only these two things):
#   * /usr/local/sbin/rd-entry              — the SSH forced command
#   * /home/deploy/.ssh/authorized_keys     — the pinned, restricted key line
#
# WHAT IT ONLY VERIFIES, AND WILL NOT WRITE:
#   * /usr/local/sbin/rd-deploy             — ALREADY INSTALLED AND VETTED.
#       This script used to install it from the repo. It no longer does, and the
#       repo no longer carries a copy. Overwriting a working, root-owned security
#       boundary from a git checkout is not something an installer should do
#       quietly. See WRAPPER_CONTRACT.md.
#   * /etc/sudoers.d/restaurant-deploy      — same reasoning.
#   * docker-compose.yml, any .env file, public/downloads — never touched.
#
# It also does NOT create .env.migrate and does NOT install the repo deploy keys.
# Both hold credentials; both are deliberate human steps. See README.md.
#
# (There is no registry login to perform. The transport is GIT: the box holds
# read-only clones and builds them locally. An earlier revision of this file
# verified GHCR images, pull_policy and a /root/.docker credential — every one of
# those checks now FAILS on a correctly-configured box, which is worse than no
# check, so they were replaced with the git-transport equivalents below.)
# =============================================================================
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

APP_DIR=/opt/restaurant-dash
DEPLOY_USER=deploy
WRAPPER=/usr/local/sbin/rd-deploy
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBKEY_FILE="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "install.sh must run as root." >&2; exit 1; }
[ -d "$APP_DIR" ] || { echo "$APP_DIR does not exist — wrong box?" >&2; exit 1; }

fail=0
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  [OK] %s\n' "$*"; }
bad()  { printf '  [!!] %s\n' "$*"; fail=1; }

# ---------------------------------------------------------------------------
step "verify the deploy identity"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  bad "user '$DEPLOY_USER' does not exist. The server side was supposed to be installed already — stop and find out what happened."
else
  ok "user '$DEPLOY_USER' exists"
  if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
    bad "$DEPLOY_USER is in the DOCKER GROUP. That IS root ('docker run -v /:/host --privileged' is a host shell) and it defeats the entire sudoers design. Remove it: gpasswd -d $DEPLOY_USER docker"
  else
    ok "$DEPLOY_USER is NOT in the docker group"
  fi
fi

# ---------------------------------------------------------------------------
step "verify the wrapper (NOT installed from this repo — see WRAPPER_CONTRACT.md)"
if [ ! -x "$WRAPPER" ]; then
  bad "$WRAPPER is missing or not executable. This installer will not create it; it is the security boundary and lives only on the box."
else
  perm="$(stat -c '%U:%G %a' "$WRAPPER")"
  if [ "$perm" = "root:root 755" ]; then
    ok "$WRAPPER is root:root 755"
  else
    bad "$WRAPPER is $perm — expected root:root 755"
  fi
  dirperm="$(stat -c '%U:%G %a' /usr/local/sbin)"
  case "$dirperm" in
    "root:root 755"|"root:root 0755") ok "/usr/local/sbin is $dirperm" ;;
    *) bad "/usr/local/sbin is $dirperm. If '$DEPLOY_USER' can write that directory, the sudoers line IS root." ;;
  esac

  # Probe the grammar the two deploy.yml workflows are written against. Every
  # call here is REJECTED by design, so none of them changes anything: each is a
  # sentence the wrapper must refuse.
  set +e
  "$WRAPPER" __contract_probe__ >/dev/null 2>&1; rc_verb=$?
  "$WRAPPER" deploy __contract_probe__ >/dev/null 2>&1; rc_svc=$?
  # `update` is the verb CI actually sends, and its two narrowings carry real
  # weight: a bare `update` would rebuild and bounce the WHOLE stack in one call,
  # and `update valkey` is meaningless (upstream image, no repo to build from).
  # Both must be refusals, not surprises performed with root authority.
  "$WRAPPER" update >/dev/null 2>&1; rc_bare=$?
  "$WRAPPER" update valkey >/dev/null 2>&1; rc_valkey=$?
  set -e
  [ "$rc_verb" -eq 64 ] && ok "unknown verb -> 64" || bad "unknown verb -> $rc_verb, expected 64. The wrapper's grammar has changed; deploy.yml will misreport failures. Reconcile it with WRAPPER_CONTRACT.md before deploying."
  [ "$rc_svc"  -eq 64 ] && ok "unknown service -> 64" || bad "unknown service -> $rc_svc, expected 64. Same problem as above."
  [ "$rc_bare" -eq 64 ] && ok "bare 'update' -> 64 (cannot bounce the whole stack in one call)" || bad "bare 'update' -> $rc_bare, expected 64. A leaked CI key could rebuild and restart every service at once."
  [ "$rc_valkey" -eq 64 ] && ok "'update valkey' -> 64 (no repo to build from)" || bad "'update valkey' -> $rc_valkey, expected 64. valkey is the shared cache — the one service whose restart is felt by every till at once."

  # `revision` is how the pipeline PROVES a deploy landed. If it is missing, the
  # workflow's revision assertion can never pass and every deploy reports as
  # unproven. Read-only.
  set +e
  rev_out="$("$WRAPPER" revision 2>/dev/null)"; rc_rev=$?
  set -e
  if [ "$rc_rev" -ne 0 ]; then
    bad "'revision' exited $rc_rev. deploy.yml uses it to prove the deployed commit; without it every run fails its own proof. Reconcile the wrapper with WRAPPER_CONTRACT.md."
  elif ! printf '%s' "$rev_out" | grep -qE '^Restaurant_Backend[[:space:]]+[0-9a-f]{40}$'; then
    bad "'revision' did not print a 40-char sha for Restaurant_Backend. deploy.yml parses this output; a format change silently breaks the deploy proof."
  else
    ok "'revision' reports 40-char shas (the pipeline's proof that a deploy landed)"
  fi
fi

# ---------------------------------------------------------------------------
step "the 'migrate' verb (OPTIONAL — absent is a supported state, not a failure)"
# NOTHING HERE RUNS `rd-deploy migrate`. That verb applies schema changes to the
# live database; an installer must never invoke it as a side effect of being run.
# The only probe below is `migrate backend`, which the grammar refuses before it
# reaches anything, and the only other evidence is a file existing.
#
# rd-entry — which this script DOES install, from the repo — accepts `migrate`
# whether or not the wrapper implements it. That is deliberate and safe: on a box
# without the verb, `migrate` reaches rd-deploy and comes back 64, which
# deploy.yml reports as "the box is behind this repo" together with the one-click
# way to restore the manual route. It cannot cause an unintended migration.
RD_MIGRATE=/usr/local/sbin/rd-migrate
if [ ! -e "$RD_MIGRATE" ]; then
  printf '  [--] %s is not installed.\n' "$RD_MIGRATE"
  printf '       This is FINE and is the current state of the box. The deploy pipeline\n'
  printf '       must then run in MANUAL migration mode: set the repository variable\n'
  printf '       MIGRATION_APPLY_MODE=manual in BOTH repos, or every migration-carrying\n'
  printf '       deploy will stop with exit 64 having changed nothing.\n'
  printf '       To install it, review deploy/vps/rd-deploy-migrate.proposed.sh and follow\n'
  printf '       README.md, "Installing the migrate verb". It is a deliberate human step:\n'
  printf '       this installer will NOT create it, for the same reason it will not create\n'
  printf '       rd-deploy — it is a security boundary that writes to production data.\n'
else
  perm="$(stat -c '%U:%G %a' "$RD_MIGRATE")"
  [ "$perm" = "root:root 755" ] && ok "$RD_MIGRATE is root:root 755" \
                                || bad "$RD_MIGRATE is $perm — expected root:root 755"

  # It must refuse a service argument: there is ONE database behind all three
  # services, so `migrate backend` is a sentence that could only mislead.
  set +e
  "$WRAPPER" migrate backend >/dev/null 2>&1; rc_msvc=$?
  set -e
  [ "$rc_msvc" -eq 64 ] && ok "'migrate backend' -> 64 (takes no service)" \
                        || bad "'migrate backend' -> $rc_msvc, expected 64. One database serves all three services; a service argument must not be accepted."

  # Its two preconditions. rd-migrate refuses (66) without either, having changed
  # nothing — but finding that out during a release is worse than finding it now.
  PGTOOLS="$(sed -n 's/^PGTOOLS_IMAGE=//p' "$SRC_DIR/rd-deploy-migrate.proposed.sh" | head -n1)"
  if [ -n "$PGTOOLS" ]; then
    if docker image inspect "$PGTOOLS" >/dev/null 2>&1; then
      ok "$PGTOOLS is present locally (rd-migrate never pulls — a release step must not need a registry)"
    else
      bad "$PGTOOLS is NOT present. rd-migrate takes its pg_dump with it and deliberately does not pull, so it will refuse with 66 and no migration will ever be applied. Fix: docker pull $PGTOOLS"
    fi
  fi
  DUMPS=/var/backups/restaurant-dash/premigration
  if [ -d "$DUMPS" ]; then
    dperm="$(stat -c '%U:%G %a' "$DUMPS")"
    [ "$dperm" = "root:root 700" ] && ok "$DUMPS is root:root 700" \
      || bad "$DUMPS is $dperm — expected root:root 700. Those files are full copies of the production database, customer data included."
    free_kb="$(df -Pk "$DUMPS" | awk 'NR==2 {print $4}')"
    printf '  [--] %s has %s KB free (rd-migrate refuses below 2097152)\n' "$DUMPS" "$free_kb"
  else
    printf '  [--] %s does not exist yet; rd-migrate creates it 0700 on first use.\n' "$DUMPS"
  fi

  # The opt-in automatic restore. Its DEFAULT is off, and off is the recommended
  # setting — see the header of rd-deploy-migrate.proposed.sh. Say so loudly if
  # someone has turned it on, because nothing else on the box will.
  if [ -f /opt/restaurant-dash/.rd-migrate-autorestore ]; then
    printf '  [!!] /opt/restaurant-dash/.rd-migrate-autorestore EXISTS.\n'
    printf '       A failed migration will now attempt a FULL pg_restore of the production\n'
    printf '       database, discarding every order, payment and clock-in committed since the\n'
    printf '       dump was taken minutes earlier. This is NOT the default and NOT the\n'
    printf '       recommended setting. Remove the file unless you can say why it is there.\n'
  else
    ok "automatic restore is OFF (the default; a failed migration halts for a human)"
  fi
fi

# ---------------------------------------------------------------------------
step "verify the sudoers grant (NOT installed from this repo)"
SUDOERS=/etc/sudoers.d/restaurant-deploy
if [ ! -f "$SUDOERS" ]; then
  bad "$SUDOERS is missing. Install restaurant-deploy.sudoers from this directory BY HAND, then run visudo -c."
else
  ok "$SUDOERS exists"
  if grep -qE '^\s*deploy\s+ALL=\(root\)\s+NOPASSWD:\s*/usr/local/sbin/rd-deploy\s*$' "$SUDOERS"; then
    ok "grants exactly /usr/local/sbin/rd-deploy with no argument wildcard"
  else
    bad "does not contain the expected wildcard-free line. Compare against restaurant-deploy.sudoers in this directory."
  fi
  if grep -vE '^\s*(#|$)' "$SUDOERS" | grep -q '\*'; then
    bad "contains a '*'. sudo wildcards match across spaces and are not a security boundary. Remove it."
  else
    ok "no '*' anywhere in the fragment"
  fi
  visudo -c >/dev/null && ok "visudo -c is clean" || bad "visudo -c FAILED"
fi

# ---------------------------------------------------------------------------
step "install the SSH forced command (/usr/local/sbin/rd-entry)"
# Authored on Windows. A CRLF checkout makes the shebang '#!/bin/bash\r', and the
# kernel then reports a "bad interpreter" error naming an invisible character.
if grep -qU $'\r' "$SRC_DIR/rd-entry" 2>/dev/null; then
  bad "$SRC_DIR/rd-entry has CRLF line endings and will not execute. Fix: sed -i 's/\r\$//' $SRC_DIR/rd-entry"
else
  install -o root -g root -m 0755 "$SRC_DIR/rd-entry" /usr/local/sbin/rd-entry
  bash -n /usr/local/sbin/rd-entry
  ok "installed and syntax-checked /usr/local/sbin/rd-entry"
fi

# ---------------------------------------------------------------------------
step "forced-command authorized_keys"
if [ -z "$PUBKEY_FILE" ]; then
  echo "  no public key argument given; skipping. Re-run with the CI key to finish:"
  echo "      bash $0 /path/to/ci-deploy.pub"
  echo "  (the key already at /home/$DEPLOY_USER/.ssh/id_ed25519.pub is the one CI uses)"
else
  [ -r "$PUBKEY_FILE" ] || { echo "cannot read $PUBKEY_FILE" >&2; exit 1; }
  KEY="$(tr -d '\r\n' <"$PUBKEY_FILE")"
  case "$KEY" in
    ssh-ed25519\ *|ecdsa-sha2-*\ *|ssh-rsa\ *) ;;
    *) echo "!! $PUBKEY_FILE does not look like an OpenSSH public key." >&2; exit 1 ;;
  esac
  SSH_DIR="/home/$DEPLOY_USER/.ssh"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$SSH_DIR"
  # `restrict` implies no-port-forwarding, no-agent-forwarding, no-X11-forwarding,
  # no-pty and no-user-rc, and gains any future restriction OpenSSH adds. The
  # forced command means $SSH_ORIGINAL_COMMAND is validated by rd-entry and the
  # client's own command line is never executed.
  LINE='restrict,command="/usr/local/sbin/rd-entry" '"$KEY"
  printf '%s\n' "$LINE" >"$SSH_DIR/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR/authorized_keys"
  chmod 0600 "$SSH_DIR/authorized_keys"
  ok "wrote $SSH_DIR/authorized_keys (restrict + forced command)"
fi

# ---------------------------------------------------------------------------
step "preconditions for the first pipeline run"

if [ -r "$APP_DIR/.env.migrate" ]; then
  perm="$(stat -c '%U:%G %a' "$APP_DIR/.env.migrate")"
  if [ "$perm" = "root:root 600" ]; then
    ok ".env.migrate present, root:root 0600"
  else
    bad ".env.migrate is $perm — must be root:root 0600"
  fi
else
  bad ".env.migrate missing. Create it with ONLY MIGRATION_DATABASE_URL=... (the owner/migration role, NOT app_runtime), then chmod 0600. It is what makes 'rd-deploy check-migrations' able to answer."
fi

COMPOSE="$APP_DIR/docker-compose.yml"
if [ ! -r "$COMPOSE" ]; then
  bad "$COMPOSE not readable — wrong box?"
else
  # TRANSPORT IS GIT, NOT A REGISTRY. This block used to assert the opposite —
  # no build: section, three ghcr.io/...:prod images, pull_policy: always, a root
  # ghcr.io credential — because the pipeline was originally designed around
  # GHCR. That design needed a registry token on the box, and GitHub has no API
  # to mint one, so it could not be completed without a human. The box now holds
  # real read-only clones and builds locally. Every one of those old checks would
  # FAIL on a correctly-configured box, which is worse than no check at all.
  if ! grep -qE '^[[:space:]]*build:' "$COMPOSE"; then
    bad "$COMPOSE has no build: section. Transport is git: the box builds from local clones. Without build:, 'compose up -d' has no way to turn new source into a new image."
  else
    ok "compose builds from local context (git transport)"
  fi

  # Each application service must build from the repo that actually contains it.
  # Checked individually and by name: a loop that greps a fixed alternation and
  # breaks on the first match reports all three healthy when only one is right —
  # that exact bug was found here once already.
  missing_ctx=""
  for pair in "backend:Restaurant_Backend" "python:Restaurant_Backend" "dashboard:Restaurant_Dashboard_UI"; do
    svc="${pair%%:*}"; want="${pair##*:}"
    # The service's own block, up to the next top-level service key.
    if ! awk -v s="$svc" '
          $0 ~ "^[[:space:]]{2}"s":[[:space:]]*$" {inblk=1; next}
          inblk && /^[[:space:]]{2}[a-z_-]+:[[:space:]]*$/ {inblk=0}
          inblk {print}' "$COMPOSE" | grep -qE "context:[[:space:]]*\./${want}[[:space:]]*$"; then
      missing_ctx="$missing_ctx $svc"
    fi
  done
  if [ -z "$missing_ctx" ]; then
    ok "backend+python build from ./Restaurant_Backend, dashboard from ./Restaurant_Dashboard_UI"
  else
    bad "wrong or missing build context for:$missing_ctx. A service building from the wrong clone would deploy another repo's code."
  fi

  # The clones themselves. `update` does `git fetch && reset --hard`, so if these
  # are plain copies rather than checkouts the deploy fetches nothing and ships
  # whatever is already on disk — green, and stale forever.
  for pair in "Restaurant_Backend:gh-backend" "Restaurant_Dashboard_UI:gh-dashboard"; do
    d="${pair%%:*}"; alias_host="${pair##*:}"
    if [ ! -d "$APP_DIR/$d/.git" ]; then
      bad "$APP_DIR/$d is not a git checkout. 'update' cannot pull into it; clone it with git clone $alias_host:Dial-Dost/$d.git"
      continue
    fi
    if ! git -C "$APP_DIR/$d" ls-remote --exit-code origin >/dev/null 2>&1; then
      bad "$APP_DIR/$d cannot reach its remote — the read-only deploy key is missing, revoked, or ~/.ssh/config lacks the '$alias_host' alias. Every deploy would fail at the fetch."
      continue
    fi
    ok "$d is a git checkout and its deploy key authenticates"

    # On main. `update` resets to FETCH_HEAD of origin/main, so a checkout parked
    # on another branch or on a detached HEAD is a box that quietly disagrees
    # with what the pipeline thinks it deployed.
    br="$(git -C "$APP_DIR/$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    if [ "$br" = "main" ]; then
      ok "$d is on main"
    else
      bad "$d is on '$br', not main. 'update' fetches origin/main; leaving it here makes the deployed revision disagree with the branch the pipeline reports."
    fi

    # Clean tree. `update` does `reset --hard`, so anything local here is
    # DESTROYED on the next deploy without warning. That is correct for a deploy
    # target — but if someone has been hand-editing this box, they should learn
    # it now rather than by losing the edit mid-incident.
    if [ -z "$(git -C "$APP_DIR/$d" status --porcelain 2>/dev/null)" ]; then
      ok "$d working tree is clean"
    else
      bad "$d has local modifications. 'update' runs 'git reset --hard' and will DESTROY them on the next deploy. Commit them upstream or discard them deliberately: git -C $APP_DIR/$d status"
    fi
  done

  # ---- command:/entrypoint: override guard --------------------------------
  # An override on an APPLICATION service replaces the image's CMD, and that is
  # precisely how a deploy would start applying migrations behind your back:
  # Dockerfile.node's CMD is ["node","build/index.js"], while `npm run
  # start:prod` is the ONE script that chains `npm run migrate`. A compose file
  # carrying that turns every `docker compose up -d` into an unsupervised schema
  # change against a database with no PITR.
  #
  # DELIBERATELY SCOPED TO backend|dashboard|python. valkey legitimately carries
  #     command: ["valkey-server", "--save", "60", "1", "--appendonly", "no"]
  # and a guard that fires on that would fail on every single run and be deleted
  # as noise inside a week. This walks the `services:` mapping by indentation
  # instead of pattern-matching a fixed layout, so it does not care about key
  # order, indent width, or where valkey sits in the file.
  overrides="$(
    awk '
      { line = $0; sub(/\r$/, "", line) }
      line ~ /^[[:space:]]*(#|$)/ { next }
      {
        match(line, /^[ \t]*/); ind = RLENGTH
        key = line; sub(/^[ \t]+/, "", key)
      }
      ind == 0 {
        in_services = (key ~ /^services[[:space:]]*:/)
        if (in_services) seen = 1
        svc = ""; svc_ind = -1
        next
      }
      !in_services { next }
      svc_ind == -1 || ind == svc_ind {
        if (key ~ /^[A-Za-z0-9_.-]+[[:space:]]*:/) {
          svc_ind = ind
          svc = key; sub(/[[:space:]]*:.*$/, "", svc)
        }
        next
      }
      ind > svc_ind && svc ~ /^(backend|dashboard|python)$/ &&
        key ~ /^(command|entrypoint)[[:space:]]*:/ {
          printf "%s: %s\n", svc, key
      }
      END { if (!seen) print "__NO_SERVICES__" }
    ' "$COMPOSE"
  )"
  if [ "$overrides" = "__NO_SERVICES__" ]; then
    bad "could not find a top-level 'services:' block in $COMPOSE, so the command:/entrypoint: override check could not run. Check by hand that backend, dashboard and python have neither key."
  elif [ -n "$overrides" ]; then
    bad "an application service overrides the image's CMD. That is how a deploy silently becomes a migration run. Remove these keys — the backend image must start as ['node','build/index.js']:"
    printf '%s\n' "$overrides" | sed 's/^/         /'
  else
    ok "no command:/entrypoint: override on backend, dashboard or python (valkey's own command: is expected and ignored)"
  fi

  # Backstop for the same failure expressed somewhere the walk above does not
  # reach. Comments are stripped first so that a note *warning* about
  # start:prod does not permanently fail this installer.
  if grep -vE '^[[:space:]]*#' "$COMPOSE" | sed 's/[[:space:]]#.*$//' | grep -q 'start:prod'; then
    bad "$COMPOSE mentions 'start:prod' outside a comment. 'npm run start:prod' is the only script that chains 'npm run migrate'; nothing in the deploy path may run it. Migrations are applied by hand — see docs/DEPLOY_ORDER.md."
  else
    ok "no 'start:prod' anywhere in the compose file"
  fi
  # (The pull_policy: always check that stood here is gone with GHCR. Its job —
  # "prove a deploy cannot silently reuse the on-disk image" — is now done by
  # `update` rebuilding, and by the workflow asserting the container's uptime
  # actually reset. Keeping a registry check here would fail on a correct box.)
fi

# The bind-mount SOURCE, which lives inside the dashboard clone — not at
# $APP_DIR/public. The old path here never existed, so this check failed on
# every run and was pure noise. Release artifacts are ~110 MB and are served to
# every till that asks for an update; an empty directory 404s all of them, which
# has happened once already.
DL="$APP_DIR/Restaurant_Dashboard_UI/public/downloads"
if [ -d "$DL" ] && [ -n "$(ls -A "$DL" 2>/dev/null)" ]; then
  ok "public/downloads present and non-empty ($(ls -A "$DL" | wc -l) file(s), read-only bind-mount source)"
else
  bad "$DL is missing or empty — every till checking for an app update would get a 404."
fi

# The forced command is what makes a leaked DEPLOY_SSH_KEY survivable. Without
# it that key is an ordinary shell account on a box holding live restaurant data
# and the production .env, so this is checked as a hard failure, not a warning.
AK=/home/deploy/.ssh/authorized_keys
if [ ! -r "$AK" ]; then
  bad "$AK not readable — the CI key is not installed."
elif ! grep -q 'command="/usr/local/sbin/rd-entry"' "$AK"; then
  bad "$AK has no forced command. A leaked DEPLOY_SSH_KEY would be a SHELL on this box, able to read $APP_DIR/Restaurant_Backend/.env. Prefix the key with: restrict,command=\"/usr/local/sbin/rd-entry\""
elif [ ! -x /usr/local/sbin/rd-entry ]; then
  bad "authorized_keys points at /usr/local/sbin/rd-entry but it is missing or not executable — every CI connection would exit 127."
else
  # Prove it actually refuses, rather than trusting that the line is present.
  # Two distinct refusals, because they fail for different reasons and a boundary
  # that only stops one of them is not a boundary. An arbitrary command tests the
  # character whitelist; an EMPTY SSH_ORIGINAL_COMMAND is what an interactive
  # `ssh deploy@host` sends, and that is the one that hands over a shell.
  arb_ok=0; int_ok=0
  SSH_ORIGINAL_COMMAND='cat /etc/shadow' /usr/local/sbin/rd-entry >/dev/null 2>&1 || arb_ok=1
  env -u SSH_ORIGINAL_COMMAND /usr/local/sbin/rd-entry >/dev/null 2>&1 || int_ok=1
  if [ "$arb_ok" -ne 1 ]; then
    bad "/usr/local/sbin/rd-entry ACCEPTED an arbitrary command. The boundary is open."
  elif [ "$int_ok" -ne 1 ]; then
    bad "/usr/local/sbin/rd-entry ACCEPTED an interactive session (empty SSH_ORIGINAL_COMMAND). A leaked DEPLOY_SSH_KEY would be a SHELL on this box."
  else
    ok "forced command refuses both an arbitrary command and an interactive session"
  fi
fi

if systemctl is-active --quiet cloudflared 2>/dev/null; then
  ok "cloudflared is active (the only ingress)"
else
  bad "cloudflared is not active. It is the only ingress; nothing is reachable without it."
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$fail" -eq 0 ]; then
  cat <<'DONE'
Server side is ready. Prove the whole chain end to end, from your workstation:

    ssh -i ci-deploy deploy@<host> status              # should print compose ps
    ssh -i ci-deploy deploy@<host> check-migrations    # should report clean
    ssh -i ci-deploy deploy@<host>                     # MUST be refused (no shell)
    ssh -i ci-deploy deploy@<host> 'cat /opt/restaurant-dash/.env'   # MUST be refused
DONE
else
  echo "Finish the items marked [!!] above, then re-run this script."
  exit 1
fi
