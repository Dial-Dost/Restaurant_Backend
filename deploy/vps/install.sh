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
# It also does NOT log in to GHCR for you and does NOT create .env.migrate.
# Both hold credentials; both are deliberate human steps. See README.md.
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

  # Probe the grammar the two deploy.yml workflows are written against. These
  # calls change nothing: an unknown verb and an unknown service both just exit.
  set +e
  "$WRAPPER" __contract_probe__ >/dev/null 2>&1; rc_verb=$?
  "$WRAPPER" deploy __contract_probe__ >/dev/null 2>&1; rc_svc=$?
  set -e
  [ "$rc_verb" -eq 64 ] && ok "unknown verb -> 64" || bad "unknown verb -> $rc_verb, expected 64. The wrapper's grammar has changed; deploy.yml will misreport failures. Reconcile it with WRAPPER_CONTRACT.md before deploying."
  [ "$rc_svc"  -eq 64 ] && ok "unknown service -> 64" || bad "unknown service -> $rc_svc, expected 64. Same problem as above."
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
  if grep -qE '^[[:space:]]*build:' "$COMPOSE"; then
    bad "$COMPOSE still has a build: section. The box must PULL, not build: a 'next build' on 2 vCPU next to live POS traffic is the thing this pipeline exists to avoid."
  else
    ok "no build: section"
  fi
  # THE load-bearing check. Without pull_policy: always, 'compose up -d' reuses
  # the image already on disk and every deploy is a silent no-op that CI reports
  # as green.
  # Every one of the three application services must follow :prod. Checking
  # them individually is the point: the earlier version of this loop grepped a
  # fixed (backend|python|dashboard) alternation and `break`ed on the first
  # match, so ONE repointed service made it print that all three were, and a
  # service still pinned to :main or to a digest would never ship again while
  # CI stayed green.
  missing_tag=""
  for svc in backend python dashboard; do
    if ! grep -qE "^[[:space:]]*image:[[:space:]]*[\"']?ghcr\.io/dial-dost/restaurant_${svc}:prod[\"']?[[:space:]]*(#.*)?$" "$COMPOSE"; then
      missing_tag="$missing_tag $svc"
    fi
  done
  if [ -z "$missing_tag" ]; then
    ok "all three services follow ghcr.io/dial-dost/restaurant_{backend,python,dashboard}:prod"
  else
    bad "these services do NOT follow the :prod tag:$missing_tag. Each needs 'image: ghcr.io/dial-dost/restaurant_<svc>:prod'; a service left on another tag or a digest will never receive a deploy while CI still reports success. See README.md, 'Switch compose to follow the :prod tag'."
  fi

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
  n_pull="$(grep -cE '^[[:space:]]*pull_policy:[[:space:]]*always' "$COMPOSE" || true)"
  if [ "${n_pull:-0}" -ge 3 ]; then
    ok "pull_policy: always present $n_pull times (backend, python, dashboard)"
  else
    bad "pull_policy: always appears $n_pull time(s); expected at least 3. WITHOUT IT EVERY DEPLOY IS A SILENT NO-OP: 'docker compose up -d' will reuse the image already on disk and CI will still go green."
  fi
fi

if [ -d "$APP_DIR/public/downloads" ] && [ -n "$(ls -A "$APP_DIR/public/downloads" 2>/dev/null)" ]; then
  ok "public/downloads present and non-empty (read-only bind-mount source)"
else
  bad "public/downloads is missing or empty — the dashboard would 404 on the installer downloads."
fi

if [ -r /root/.docker/config.json ] && grep -q 'ghcr.io' /root/.docker/config.json 2>/dev/null; then
  ok "root has a ghcr.io credential"
else
  bad "root is not logged in to ghcr.io, so 'compose up -d' cannot pull. docker login ghcr.io with a READ-ONLY token (read:packages) scoped to the three packages."
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
