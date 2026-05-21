#!/usr/bin/env bash
# Run every spec's REMAINING WORK through ricky, in dependency order.
#
# All five specs have been slimmed to only what is still missing (the scaffolding
# is already implemented). They are run in DEPENDENCY order, which is NOT the
# numeric order:
#
#   05  integrations-connect  — account-wide RelayWorkspaceManager (foundation)
#   04  cloud-agent-box       — box endpoints; key on the account workspace
#   01  cloud-agents          — restore-on-launch + relayfile conflict-policy flag
#   02  integrations          — scope pickers + per-project visibility
#   03  proactive-agents      — mount the UI + cloud proactive-personas backend
#
# Each spec is implemented in its own git worktree and ends with a PR per touched
# repo — see the "Workflow (mandatory)" section in each spec and the wave README.
# This script only invokes ricky per spec; ricky creates the worktree and opens
# the PR as the spec instructs.
#
# Usage:
#   ./specs/run-remaining-work.sh              # run all specs in dependency order
#   ./specs/run-remaining-work.sh 04           # run only this spec (by NN prefix)
#   DRY_RUN=1 ./specs/run-remaining-work.sh    # just print the ricky commands

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONLY="${1:-}"
DRY_RUN="${DRY_RUN:-0}"

# Dependency order, not numeric order.
ORDER=(
  "05-integrations-connect.md"
  "04-cloud-agent-box.md"
  "01-cloud-agents.md"
  "02-integrations.md"
  "03-proactive-agents.md"
)

if ! command -v ricky >/dev/null 2>&1; then
  echo "error: 'ricky' is not on PATH. Install it (npm i -g @agentworkforce/ricky) or run from a shell that has it." >&2
  exit 127
fi

total=${#ORDER[@]}
idx=0

echo "==> Running $total specs (remaining work) in dependency order: 05 → 04 → 01 → 02 → 03"
for name in "${ORDER[@]}"; do
  idx=$((idx + 1))
  spec="$SCRIPT_DIR/$name"

  if [[ -n "$ONLY" && "$name" != "$ONLY"* ]]; then
    echo "  - skip [$idx/$total] $name (only running $ONLY)"
    continue
  fi

  if [[ ! -f "$spec" ]]; then
    echo "==> MISSING $name in $SCRIPT_DIR — skipping" >&2
    continue
  fi

  cmd=(ricky --mode local --spec-file "$spec" --run)

  echo
  echo "==> [$idx/$total] $name"
  echo "    ${cmd[*]}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    (dry run — not executed)"
    continue
  fi

  if ! "${cmd[@]}"; then
    rc=$?
    echo
    echo "==> FAILED on $name (exit $rc)"
    echo "    Fix the underlying issue, then resume with:"
    echo "      $0 ${name%%-*}"
    exit "$rc"
  fi
done

echo
echo "==> Done. Verify each spec's PR is open (one per touched repo)."
