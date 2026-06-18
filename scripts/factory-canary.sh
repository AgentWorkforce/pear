#!/usr/bin/env bash
#
# factory-canary.sh — scheduled sync-fidelity regression detector.
#
# Runs `factory canary <issue>` against the LIVE relayfile mount and asserts a
# known "Ready for Agent" issue is still classified dispatch-ready by the real
# triage path. If it ever flips to "skipped" (e.g. the Linear sync regresses to
# sparse records with no state.id — see AgentWorkforce/cloud#2284), this exits
# non-zero and alerts, so the regression is caught before it silently blocks
# every factory dispatch.
#
# Designed to run unattended from cron/launchd on the operator machine, where
# the relayfile mount + relay broker + factory.config.json already live.
#
# IMPORTANT — run from the pear repo root (this script's parent dir). The canary
# runs the real dry-run triage path, which reuses the running Pear relay broker
# via <root>/.agentworkforce/relay/connection.json. Run it from anywhere else
# and it will try to spawn its own broker (slow / may hang).
#
# Requires a factory build that has the `canary` command (AgentWorkforce/factory
# #10 or later). Until that publishes, point FACTORY_BIN at a local build.
#
# Config (env vars):
#   FACTORY_CANARY_ISSUE       Linear issue key to check (default: AR-305)
#   FACTORY_CONFIG             path to factory.config.json (default: ./factory.config.json)
#   FACTORY_BIN                path to factory.mjs (default: resolved from node_modules)
#   FACTORY_CANARY_TIMEOUT     seconds before the canary is considered hung (default: 180)
#   FACTORY_CANARY_SLACK_WEBHOOK  optional Slack incoming-webhook URL for failure alerts
#
# Exit codes: 0 = dispatch-ready (healthy); 1 = NOT ready / error / hung (regression).

set -uo pipefail

# Resolve the pear repo root (this script lives in <root>/scripts).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ISSUE="${FACTORY_CANARY_ISSUE:-AR-305}"
CONFIG="${FACTORY_CONFIG:-factory.config.json}"
BIN="${FACTORY_BIN:-$ROOT/node_modules/@agent-relay/factory/bin/factory.mjs}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f "$BIN" ]]; then
  echo "[$TS] factory-canary: factory bin not found at $BIN" >&2
  exit 1
fi

# Run the canary. It runs the real dry-run triage path (no agents spawned) and
# prints a JSON verdict {ok,issue,status,reason}; exit code mirrors ok. A hung
# run (e.g. broker/mount wedge) is bounded by FACTORY_CANARY_TIMEOUT.
TIMEOUT="${FACTORY_CANARY_TIMEOUT:-180}"
RUN=(node "$BIN" factory canary "$ISSUE" --config "$CONFIG" --backend internal)
if command -v timeout >/dev/null 2>&1; then
  OUT="$(timeout "$TIMEOUT" "${RUN[@]}" 2>/dev/null)"
else
  OUT="$("${RUN[@]}" 2>/dev/null)"
fi
CODE=$?
if [[ $CODE -eq 124 ]]; then
  echo "[$TS] factory-canary: TIMED OUT after ${TIMEOUT}s (broker/mount may be wedged)" >&2
fi

# The verdict JSON is the last line of stdout (preamble logs go to stderr).
VERDICT="$(printf '%s\n' "$OUT" | tail -1)"
echo "[$TS] factory-canary $ISSUE -> $VERDICT (exit $CODE)"

if [[ $CODE -eq 0 ]]; then
  exit 0
fi

# Failure: alert.
REASON="$(printf '%s' "$VERDICT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(`${v.status||"error"}: ${v.reason||"unknown"}`)}catch{console.log("unparseable verdict")}})' 2>/dev/null)"
MSG=":rotating_light: factory canary FAILED for ${ISSUE} — ${REASON}. Sync fidelity may have regressed (issue no longer dispatch-ready). See AgentWorkforce/cloud#2284 / factory#10."
echo "[$TS] $MSG" >&2

if [[ -n "${FACTORY_CANARY_SLACK_WEBHOOK:-}" ]]; then
  curl -sS -m 15 -X POST -H 'Content-type: application/json' \
    --data "$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$MSG")" \
    "$FACTORY_CANARY_SLACK_WEBHOOK" >/dev/null 2>&1 \
    && echo "[$TS] factory-canary: posted Slack alert" >&2 \
    || echo "[$TS] factory-canary: Slack alert post failed" >&2
fi

exit 1
