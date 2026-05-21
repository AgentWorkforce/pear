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
#   ./specs/run-remaining-work.sh                # run every spec in dependency order
#   ./specs/run-remaining-work.sh --from 01      # RESUME: start at this NN and run the rest
#   ./specs/run-remaining-work.sh --only 04      # run only this spec
#   ./specs/run-remaining-work.sh 04             # back-compat: same as --only 04
#   DRY_RUN=1 ./specs/run-remaining-work.sh ...  # print the ricky commands without executing
#
# Examples:
#   # Paused mid-01? Resume from 01 onward (skips 05 + 04 which already ran):
#   ./specs/run-remaining-work.sh --from 01
#
#   # Just re-run the one spec that failed:
#   ./specs/run-remaining-work.sh --only 02
#
# Stops on the first failure and prints the exact command to resume from there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FROM=""
ONLY=""
DRY_RUN="${DRY_RUN:-0}"

# Dependency order, not numeric order.
ORDER=(
  "05-integrations-connect.md"
  "04-cloud-agent-box.md"
  "01-cloud-agents.md"
  "02-integrations.md"
  "03-proactive-agents.md"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM="${2:-}"
      [[ -z "$FROM" ]] && { echo "error: --from needs an NN prefix (e.g. 01)" >&2; exit 2; }
      shift 2
      ;;
    --from=*)
      FROM="${1#*=}"
      shift
      ;;
    --only)
      ONLY="${2:-}"
      [[ -z "$ONLY" ]] && { echo "error: --only needs an NN prefix (e.g. 04)" >&2; exit 2; }
      shift 2
      ;;
    --only=*)
      ONLY="${1#*=}"
      shift
      ;;
    -h|--help)
      sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*)
      echo "error: unknown flag $1" >&2; exit 2
      ;;
    *)
      # Back-compat: a bare positional NN means --only NN.
      ONLY="$1"
      shift
      ;;
  esac
done

if [[ -n "$FROM" && -n "$ONLY" ]]; then
  echo "error: pass --from OR --only, not both" >&2
  exit 2
fi

if ! command -v ricky >/dev/null 2>&1; then
  echo "error: 'ricky' is not on PATH. Install it (npm i -g @agentworkforce/ricky) or run from a shell that has it." >&2
  exit 127
fi

total=${#ORDER[@]}
idx=0
seen_from=0

[[ -n "$FROM" ]] && echo "==> Resuming from $FROM onward (dependency order: 05 → 04 → 01 → 02 → 03)"
[[ -n "$ONLY" ]] && echo "==> Running only $ONLY"
[[ -z "$FROM$ONLY" ]] && echo "==> Running $total specs in dependency order: 05 → 04 → 01 → 02 → 03"

for name in "${ORDER[@]}"; do
  idx=$((idx + 1))
  spec="$SCRIPT_DIR/$name"

  if [[ -n "$ONLY" ]]; then
    if [[ "$name" != "$ONLY"* ]]; then
      echo "  - skip [$idx/$total] $name (only running $ONLY)"
      continue
    fi
  elif [[ -n "$FROM" ]]; then
    if [[ "$seen_from" -eq 0 ]]; then
      if [[ "$name" != "$FROM"* ]]; then
        echo "  - skip [$idx/$total] $name (resuming from $FROM)"
        continue
      fi
      seen_from=1
    fi
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
    echo "    Fix the underlying issue, then resume from this spec with:"
    echo "      $0 --from ${name%%-*}"
    exit "$rc"
  fi
done

if [[ -n "$FROM" && "$seen_from" -eq 0 ]]; then
  echo "==> warning: --from $FROM matched no spec in the order; nothing ran." >&2
  exit 2
fi

echo
echo "==> Done. Verify each spec's PR is open (one per touched repo)."
