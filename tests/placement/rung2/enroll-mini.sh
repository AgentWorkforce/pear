#!/usr/bin/env bash
# Rung-2 additive fleet-node enrollment — issue #411 placement requester.
#
# Runs ON a mini (over `ssh -o BatchMode=yes`). It enrolls a UNIQUE, isolated
# `pear-fleet-<host>` broker into the operator workspace so a requester on the
# operator's Mac can place a real agent onto this mini and chat with it.
#
# HARD RULES (why this script exists):
#   * ADDITIVE ONLY. It enumerates every existing broker on the mini FIRST and
#     never touches them (unique instance name + non-default port + dedicated
#     state dir guarantee no collision with the mini's real brokers/agents).
#   * IDEMPOTENT. Re-running `enroll` when our instance is already up is a no-op
#     that just re-reports status.
#   * REVERSIBLE. `teardown` stops ONLY our instance (state-dir scoped). It never
#     uses `node down --all` (that would kill the mini's real brokers).
#
# Inputs (env):
#   RELAY_WORKSPACE_KEY  operator workspace key (required for `enroll`/`verify`).
#                        Passed via env — NOT argv — so it never lands in `ps`.
#   AR_BIN               override agent-relay binary (else auto-detected; finn's
#                        mise shims are dead so we fall back to /opt/homebrew).
#   PEAR_FLEET_PORT      broker base port (default 39150; API binds base+1).
#                        MUST be non-default — the script refuses 3889.
#   PEAR_FLEET_HOME      state parent dir (default $HOME/.pear-fleet).
#
# Usage (on mini):  enroll-mini.sh <before|enroll|verify|after|teardown>
set -uo pipefail

CMD="${1:-enroll}"
# Instance host label. PEAR_FLEET_HOST wins (deterministic, matches the SSH
# alias); else derive from hostname. `hostname -s` is unreliable here (finn
# reports "mac", sf reports "sf-mac-mini"), so callers SHOULD set PEAR_FLEET_HOST.
HOST_SHORT="${PEAR_FLEET_HOST:-$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')}"
[ -n "$HOST_SHORT" ] || HOST_SHORT="mini"
INSTANCE="pear-fleet-${HOST_SHORT}"
PORT="${PEAR_FLEET_PORT:-39150}"
STATE_PARENT="${PEAR_FLEET_HOME:-$HOME/.pear-fleet}"
INSTANCE_DIR="${STATE_PARENT}/${INSTANCE}"
# PROJECT_ROOT is what node up will resolve as its project root (and what its
# orphan-killer reaps by). We pin it to this unique per-instance dir — never a
# shared root like $HOME — via AGENT_RELAY_PROJECT + a marker (see enroll).
PROJECT_ROOT="${INSTANCE_DIR}"
STATE_DIR="${INSTANCE_DIR}/relay"
WORK_DIR="${PROJECT_ROOT}"
LOG_FILE="${INSTANCE_DIR}/node.log"

if [ "$PORT" = "3889" ]; then
  echo "REFUSING: port 3889 is the default/live broker port; pick a non-default PEAR_FLEET_PORT." >&2
  exit 2
fi
if [ "$INSTANCE" = "pear" ]; then
  echo "REFUSING: instance name 'pear' is the live broker." >&2
  exit 2
fi

# --- resolve a working agent-relay binary --------------------------------------
# sf-mini: mise shims resolve (10.6.2). finn-mini: mise has NO global version set,
# so the shims error ("No version is set for shim") and we must use the homebrew
# install (10.6.0). Probe with `--version` and take the first that answers.
detect_bin() {
  local c
  if [ -n "${AR_BIN:-}" ] && "$AR_BIN" --version >/dev/null 2>&1; then echo "$AR_BIN"; return 0; fi
  for c in "$HOME/.local/share/mise/shims/agent-relay" /opt/homebrew/bin/agent-relay "$HOME/.agentworkforce/relay/bin/agent-relay" "$(command -v agent-relay 2>/dev/null || true)"; do
    [ -n "$c" ] || continue
    if "$c" --version >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  return 1
}
AR="$(detect_bin || true)"
if [ -z "$AR" ]; then
  echo "FATAL: no working agent-relay binary on $HOST_SHORT (mise shims dead + no homebrew?)." >&2
  exit 3
fi
AR_DIR="$(cd "$(dirname "$AR")" && pwd)"
# Put the resolved toolchain dir first so the broker's harness detection and the
# spawned CLI (codex/claude) resolve the SAME working binaries — critical on finn
# where the mise shims are broken and /opt/homebrew must win.
export PATH="${AR_DIR}:/opt/homebrew/bin:${HOME}/.local/bin:${PATH}"
AR_VERSION="$("$AR" --version 2>/dev/null | head -1)"

banner() { echo; echo "==== $* ===="; }

# --- MANDATORY FAILSAFE #2: project-root reaper guard --------------------------
# `agent-relay node up` runs killOrphanedBrokerProcesses(projectRoot) at startup,
# which terminates EVERY broker whose CWD is projectRoot. `findProjectRoot()`
# walks up looking for markers incl `.agentworkforce/relay`, so a markerless dir
# under $HOME resolves projectRoot=$HOME and reaps every $HOME-rooted broker
# (real incident on a busy mini — see relay#1328). This computes the SAME
# projectRoot node up will use and REFUSES to proceed if it is dangerous.
compute_effective_root() {
  # Mirrors @agent-relay/config findProjectRoot(): AGENT_RELAY_PROJECT wins,
  # else walk up from cwd for markers, else fall back to cwd.
  if [ -n "${AGENT_RELAY_PROJECT:-}" ]; then
    ( cd "$AGENT_RELAY_PROJECT" 2>/dev/null && pwd ) || printf '%s' "$AGENT_RELAY_PROJECT"
    return
  fi
  local cur; cur="$(pwd)"
  while [ "$cur" != "/" ]; do
    for m in .git package.json Cargo.toml go.mod pyproject.toml .agentworkforce/relay; do
      [ -e "$cur/$m" ] && { printf '%s' "$cur"; return; }
    done
    cur="$(dirname "$cur")"
  done
  pwd
}

preflight_reaper_guard() {
  local root; root="$1"
  banner "PREFLIGHT reaper guard — effective projectRoot=$root"
  # (a) never a shared / broad root.
  case "$root" in
    ""|"/"|"$HOME") echo "REFUSE: projectRoot resolves to a broad/shared root ($root)." >&2; return 1 ;;
  esac
  # (b) never an ANCESTOR of $HOME (would reap everything under it).
  case "$HOME/" in
    "$root"/*) echo "REFUSE: projectRoot ($root) is an ancestor of \$HOME." >&2; return 1 ;;
  esac
  # (c) MUST be strictly inside our dedicated sandbox ($STATE_PARENT). This alone
  #     makes it impossible to reap any broker that runs elsewhere.
  case "$root/" in
    "$STATE_PARENT"/*) : ;;
    *) echo "REFUSE: projectRoot ($root) is not strictly inside the sandbox $STATE_PARENT." >&2; return 1 ;;
  esac
  # (d) no EXISTING broker may have its CWD == our projectRoot (defense in depth).
  local pid cwd
  for pid in $(pgrep -f "agent-relay-broker" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [ -n "$cwd" ] || continue
    if [ "$(cd "$cwd" 2>/dev/null && pwd)" = "$root" ]; then
      echo "REFUSE: existing broker pid $pid has CWD == our projectRoot ($root)." >&2; return 1
    fi
  done
  echo "OK: projectRoot is isolated ($root) — orphan-killer cannot match a foreign broker."
  return 0
}

# --- enumerate existing brokers (never touched) --------------------------------
capture_state() {
  banner "HOST" ; echo "host=$HOST_SHORT  uname=$(uname -srm)"
  echo "agent-relay=$AR  version=$AR_VERSION"
  echo "our-instance=$INSTANCE  port=$PORT  state-dir=$STATE_DIR"
  banner "EXISTING broker instances (MUST be left untouched)"
  # Use `comm` (executable path only, NO args) so we never capture the
  # rk_live_/at_live_ tokens that appear in agents' argv. Existing broker
  # instances + their ports come from the arg-bearing `init` lines, but we
  # extract ONLY --instance-name/--api-port (which carry no secrets).
  local total broker_procs
  total="$(ps ax -o comm 2>/dev/null | grep -icE "agent-relay|agent-relay-broker")"
  echo "existing agent-relay/broker process count: ${total}"
  echo "existing broker instances (name @ api-port):"
  ps ax -o command 2>/dev/null \
    | grep -E "agent-relay-broker (init|pty)" \
    | grep -v grep \
    | sed -nE 's/.*--instance-name ([^ ]+).*--api-port ([0-9]+).*/  \1 @ \2/p' \
    | sort -u || true
  echo "(our target instance=$INSTANCE @ $PORT must NOT appear above before enroll)"
  banner "OUR instance broker status"
  "$AR" node status --state-dir "$STATE_DIR" 2>&1 | head -12 || true
}

is_our_broker_up() {
  "$AR" node status --state-dir "$STATE_DIR" 2>/dev/null | grep -qiE "Status:\s*RUNNING"
}

verify_registration() {
  banner "OUR node status (node-side fleet attachment)"
  "$AR" node status --state-dir "$STATE_DIR" 2>&1 | head -14
  banner "WORKSPACE fleet view — our node + its advertised capabilities"
  if [ -n "${RELAY_WORKSPACE_KEY:-}" ]; then
    # Pass the key via env (fleet nodes defaults --workspace-key to
    # RELAY_WORKSPACE_KEY) so it never lands in argv / `ps`.
    "$AR" fleet nodes --name "$INSTANCE" 2>&1 | head -60
  else
    echo "(RELAY_WORKSPACE_KEY not set — skipping workspace-side fleet listing)"
  fi
}

case "$CMD" in
  before|after)
    capture_state
    ;;

  verify)
    verify_registration
    ;;

  enroll)
    [ -n "${RELAY_WORKSPACE_KEY:-}" ] || { echo "FATAL: RELAY_WORKSPACE_KEY required for enroll." >&2; exit 4; }
    echo "### BEFORE-STATE (additive-enroll guard) ###"
    capture_state

    if is_our_broker_up; then
      echo; echo ">>> $INSTANCE already enrolled + running (idempotent no-op). Re-verifying."
      verify_registration
      exit 0
    fi

    mkdir -p "$STATE_DIR" "$PROJECT_ROOT"
    # FIX: pin the project root to our isolated per-instance dir. findProjectRoot()
    # honors AGENT_RELAY_PROJECT first; the marker makes the walk-up stop here too
    # (belt-and-suspenders if the env is ever stripped).
    export AGENT_RELAY_PROJECT="$PROJECT_ROOT"
    mkdir -p "$PROJECT_ROOT/.agentworkforce/relay"

    # FAILSAFE: verify the effective project root is isolated BEFORE node up.
    # compute_effective_root mirrors findProjectRoot() (honors AGENT_RELAY_PROJECT,
    # which we just exported), so this is exactly what node up will resolve.
    EFFECTIVE_ROOT="$(cd "$PROJECT_ROOT" && compute_effective_root)"
    [ -n "$EFFECTIVE_ROOT" ] || EFFECTIVE_ROOT="$PROJECT_ROOT"
    if ! preflight_reaper_guard "$EFFECTIVE_ROOT"; then
      echo "ABORTING enroll — reaper guard refused. No broker started, nothing touched." >&2
      exit 5
    fi

    banner "STARTING $INSTANCE  (port=$PORT, state-dir=$STATE_DIR, projectRoot=$PROJECT_ROOT, background)"
    # Workspace key via env (not argv) so it never appears in `ps`.
    ( cd "$PROJECT_ROOT" && \
      AGENT_RELAY_PROJECT="$PROJECT_ROOT" \
      RELAY_WORKSPACE_KEY="$RELAY_WORKSPACE_KEY" \
      AGENT_RELAY_BROKER_PORT="$PORT" \
      "$AR" node up \
        --broker-name "$INSTANCE" \
        --state-dir "$STATE_DIR" \
        --background \
        --log-file "$LOG_FILE" \
        --log-level info 2>&1 ) | head -40

    banner "WAITING for broker readiness"
    "$AR" node status --state-dir "$STATE_DIR" --wait-for 45 2>&1 | head -14 || true
    # Give the fleet node-token mint + registration a moment.
    sleep 6
    verify_registration

    echo; echo "### AFTER-STATE (confirm existing brokers untouched) ###"
    capture_state
    echo
    echo "### TEARDOWN (documented; NOT executed — node is left enrolled) ###"
    echo "  ssh $HOST_SHORT 'PEAR_FLEET_PORT=$PORT $(basename "$0") teardown'"
    echo "  # or directly:  $AR node down --state-dir $STATE_DIR"
    echo "  # (state-dir scoped; NEVER 'node down --all' — that kills the mini's real brokers)"
    ;;

  preflight)
    # Dry-run the reaper guard (no broker started). With no extra arg it checks
    # our pinned PROJECT_ROOT (should PASS). `preflight simulate-unpinned` clears
    # AGENT_RELAY_PROJECT and resolves from the current dir to demonstrate the
    # guard REFUSING a dangerous $HOME resolution.
    if [ "${2:-}" = "simulate-unpinned" ]; then
      unset AGENT_RELAY_PROJECT
      EFFECTIVE_ROOT="$(compute_effective_root)"
      echo "(simulate-unpinned: resolved from $(pwd))"
    else
      export AGENT_RELAY_PROJECT="$PROJECT_ROOT"
      mkdir -p "$PROJECT_ROOT/.agentworkforce/relay"
      EFFECTIVE_ROOT="$(cd "$PROJECT_ROOT" && compute_effective_root)"
    fi
    if preflight_reaper_guard "$EFFECTIVE_ROOT"; then
      echo "PREFLIGHT RESULT: PASS"
    else
      echo "PREFLIGHT RESULT: REFUSED (guard working)"
      exit 5
    fi
    ;;

  snapshot)
    # snapshot <agent-name> — read OUR broker's plain PTY snapshot for a placed
    # agent (proves this mini owns the placed PTY — acceptance #2b, node side).
    NAME="${2:-}"; [ -n "$NAME" ] || { echo "usage: $0 snapshot <agent-name>" >&2; exit 64; }
    CONN="$STATE_DIR/connection.json"
    [ -f "$CONN" ] || { echo "no connection file at $CONN (broker not up?)" >&2; exit 5; }
    URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONN" | head -1)"
    KEY="$(sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONN" | head -1)"
    curl -s -m 6 -H "authorization: Bearer $KEY" "${URL}/api/spawned/${NAME}/snapshot?format=plain"
    echo "__HTTP_DONE__"
    ;;

  release-agent)
    # release-agent <agent-name> — gracefully stop a placed agent on OUR broker
    # instance ONLY (resolves the target broker from our own connection.json;
    # never the mini's real default broker).
    NAME="${2:-}"; [ -n "$NAME" ] || { echo "usage: $0 release-agent <agent-name>" >&2; exit 64; }
    CONN="$STATE_DIR/connection.json"
    [ -f "$CONN" ] || { echo "no connection file at $CONN" >&2; exit 5; }
    URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONN" | head -1)"
    KEY="$(sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONN" | head -1)"
    banner "RELEASE placed agent '$NAME' from $INSTANCE (our broker only)"
    # `node agent release` ignores RELAY_BROKER_URL and demands the default
    # connection file, so call the broker's release endpoint directly (same
    # transport the CLI uses): DELETE /api/spawned/<name> on OUR broker only.
    curl -s -m 8 -X DELETE -H "authorization: Bearer $KEY" "${URL}/api/spawned/$(printf '%s' "$NAME" | sed 's/ /%20/g')" 2>&1 | head -5
    echo "__RELEASE_DONE__"
    ;;

  teardown)
    banner "TEARDOWN $INSTANCE (state-dir scoped only)"
    "$AR" node down --state-dir "$STATE_DIR" 2>&1 | head -20
    ;;

  *)
    echo "usage: $0 <before|enroll|verify|after|preflight|snapshot <name>|release-agent <name>|teardown>" >&2
    exit 64
    ;;
esac
