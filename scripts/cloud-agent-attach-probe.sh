#!/usr/bin/env bash
set -euo pipefail

COUNT=5
WORKSPACE_SOURCE="all"
REPORT=false
WORKSPACE_ID="${CLOUD_WORKSPACE_ID:-50587328-441d-4acb-b8f3-dbe1b3c5de99}"
CLOUD_BASE="${CLOUD_BASE:-https://agentrelay.com/cloud}"
AUTH_FILE="${CLOUD_AUTH_FILE:-$HOME/.agent-relay/cloud-auth.json}"
REPORT_FILE="/tmp/cloud-agent-probe-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
POLL_INTERVAL_SEC=2
POLL_TIMEOUT_SEC=300
STOP_TIMEOUT_SEC=120
SANDBOX_WORKSPACE_PATH="/workspace"

usage() {
  cat <<'USAGE'
Usage: scripts/cloud-agent-attach-probe.sh [--count N] [--workspace-source relayfile|git|git-overlay|all] [--report]

Environment:
  CLOUD_WORKSPACE_ID   Workspace UUID to probe. Defaults to the autopilot workspace.
  CLOUD_AGENT_ID       Cloud agent id. If omitted, the first listed cloud agent is used.
  CLOUD_BASE           Cloud API base. Defaults to https://agentrelay.com/cloud.
  CLOUD_AUTH_FILE      Auth JSON path. Defaults to ~/.agent-relay/cloud-auth.json.
USAGE
}

die() {
  echo "cloud-agent-attach-probe: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count)
      [[ $# -ge 2 ]] || die "--count requires a value"
      COUNT="$2"
      shift 2
      ;;
    --workspace-source)
      [[ $# -ge 2 ]] || die "--workspace-source requires a value"
      WORKSPACE_SOURCE="$2"
      shift 2
      ;;
    --report)
      REPORT=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$COUNT" =~ ^[0-9]+$ ]] && [[ "$COUNT" -gt 0 ]] || die "--count must be a positive integer"
case "$WORKSPACE_SOURCE" in
  relayfile|git|git-overlay|all) ;;
  *) die "--workspace-source must be relayfile, git, git-overlay, or all" ;;
esac

require_tool curl
require_tool jq

json_string() {
  jq -rn --arg value "$1" '$value'
}

expires_epoch() {
  jq -r '
    (.accessTokenExpiresAt // .expiresAt // "") as $raw
    | if $raw == "" then 0
      else ($raw | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch 0)
      end
  ' "$AUTH_FILE"
}

refresh_auth_if_needed() {
  [[ -f "$AUTH_FILE" ]] || die "auth file not found: $AUTH_FILE"

  local now expires refresh_token response_file response_status access_token next_refresh next_expires next_api tmp_file
  now="$(date -u +%s)"
  expires="$(expires_epoch)"
  if [[ "$expires" =~ ^[0-9]+$ ]] && (( expires >= now + 30 )); then
    return 0
  fi

  refresh_token="$(jq -r '.refreshToken // empty' "$AUTH_FILE")"
  [[ -n "$refresh_token" ]] || die "auth file is missing refreshToken"

  response_file="$(mktemp)"
  response_status="$(
    curl -sS -o "$response_file" -w '%{http_code}' \
      -X POST "$CLOUD_BASE/api/v1/auth/token/refresh" \
      -H 'Content-Type: application/json' \
      --data "$(jq -cn --arg refreshToken "$refresh_token" '{refreshToken: $refreshToken}')" || true
  )"

  if [[ "$response_status" != 2* ]]; then
    local message
    message="$(jq -r '.error // .message // empty' "$response_file" 2>/dev/null || true)"
    rm -f "$response_file"
    die "token refresh failed (${response_status}${message:+: $message})"
  fi

  access_token="$(jq -r '.accessToken // empty' "$response_file")"
  next_refresh="$(jq -r '.refreshToken // empty' "$response_file")"
  next_expires="$(jq -r '.accessTokenExpiresAt // empty' "$response_file")"
  next_api="$(jq -r --arg fallback "$CLOUD_BASE" '.apiUrl // $fallback' "$response_file")"
  rm -f "$response_file"

  [[ -n "$access_token" ]] || die "token refresh response missing accessToken"
  [[ -n "$next_refresh" ]] || die "token refresh response missing refreshToken"
  [[ -n "$next_expires" ]] || die "token refresh response missing accessTokenExpiresAt"

  tmp_file="$(mktemp "${AUTH_FILE}.tmp.XXXXXX")"
  jq \
    --arg accessToken "$access_token" \
    --arg refreshToken "$next_refresh" \
    --arg accessTokenExpiresAt "$next_expires" \
    --arg apiUrl "$next_api" \
    '.accessToken = $accessToken
      | .refreshToken = $refreshToken
      | .accessTokenExpiresAt = $accessTokenExpiresAt
      | .apiUrl = $apiUrl' \
    "$AUTH_FILE" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$AUTH_FILE"
}

access_token() {
  refresh_auth_if_needed
  jq -r '.accessToken // empty' "$AUTH_FILE"
}

curl_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local token response_file status
  token="$(access_token)"
  [[ -n "$token" ]] || die "auth file is missing accessToken"

  response_file="$(mktemp)"
  if [[ -n "$body" ]]; then
    status="$(
      curl -sS -o "$response_file" -w '%{http_code}' \
        -X "$method" "$url" \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        --data "$body" || true
    )"
  else
    status="$(
      curl -sS -o "$response_file" -w '%{http_code}' \
        -X "$method" "$url" \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' || true
    )"
  fi

  printf '%s\n%s\n' "$status" "$response_file"
}

CURL_STATUS=""
CURL_RESPONSE_FILE=""
call_curl_json() {
  local output
  output="$(curl_json "$@")"
  CURL_STATUS="${output%%$'\n'*}"
  CURL_RESPONSE_FILE="${output#*$'\n'}"
}

read_error_message() {
  local file="$1"
  local fallback="$2"
  jq -r --arg fallback "$fallback" '
    .errorMessage // .error // .message // .details // $fallback
  ' "$file" 2>/dev/null || printf '%s\n' "$fallback"
}

is_not_found_response() {
  local status="$1"
  local file="$2"
  local message
  if [[ "$status" == "404" ]]; then
    return 0
  fi

  message="$(read_error_message "$file" "")"
  [[ "$message" =~ [Nn]ot[[:space:]_-]?[Ff]ound ]] || [[ "$message" =~ no[[:space:]_-]?sandbox ]]
}

discover_cloud_agent_id() {
  if [[ -n "${CLOUD_AGENT_ID:-}" ]]; then
    printf '%s\n' "$CLOUD_AGENT_ID"
    return 0
  fi

  local status response_file id
  call_curl_json GET "$CLOUD_BASE/api/v1/cloud-agents"
  status="$CURL_STATUS"
  response_file="$CURL_RESPONSE_FILE"
  if [[ "$status" != 2* ]]; then
    rm -f "$response_file"
    call_curl_json GET "$CLOUD_BASE/api/v1/agents"
    status="$CURL_STATUS"
    response_file="$CURL_RESPONSE_FILE"
  fi
  [[ "$status" == 2* ]] || {
    local message
    message="$(read_error_message "$response_file" "failed to list cloud agents")"
    rm -f "$response_file"
    die "could not discover cloud agent id (${status}: ${message}); set CLOUD_AGENT_ID"
  }

  id="$(jq -r '
    (.agents // .) as $agents
    | ($agents | if type == "array" then . else [] end)
    | map(select((.status // "ready") != "stopped"))
    | .[0]
    | (.id // .agentId // empty)
  ' "$response_file")"
  rm -f "$response_file"
  [[ -n "$id" ]] || die "no cloud agent id found; set CLOUD_AGENT_ID"
  printf '%s\n' "$id"
}

normalize_remote_url() {
  local remote="$1"
  if [[ "$remote" =~ ^git@github.com:(.+)$ ]]; then
    printf 'https://github.com/%s\n' "${BASH_REMATCH[1]}"
  else
    printf '%s\n' "$remote"
  fi
}

git_workspace_source_json() {
  local kind="$1"
  require_tool git

  local remote_url branch upstream_ref ref commit
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  [[ -n "$remote_url" ]] || die "git workspace source requires an origin remote"
  remote_url="$(normalize_remote_url "$remote_url")"

  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ "$upstream_ref" == */* ]]; then
    ref="${upstream_ref#*/}"
  else
    ref="$branch"
  fi
  commit="$(git rev-parse HEAD)"

  jq -cn \
    --arg kind "$kind" \
    --arg remoteUrl "$remote_url" \
    --arg ref "$ref" \
    --arg commit "$commit" \
    --arg targetDir "$SANDBOX_WORKSPACE_PATH" \
    '{kind: $kind, remoteUrl: $remoteUrl, ref: $ref, commit: $commit, shallow: true, targetDir: $targetDir}'
}

request_body_for_mode() {
  local mode="$1"
  case "$mode" in
    relayfile)
      jq -cn --arg path "$SANDBOX_WORKSPACE_PATH" '{relayfileMountPaths: [$path]}'
      ;;
    git)
      jq -cn --argjson source "$(git_workspace_source_json git)" \
        '{relayfileMountPaths: [], workspaceSource: $source}'
      ;;
    git-overlay)
      jq -cn --arg path "$SANDBOX_WORKSPACE_PATH" --argjson source "$(git_workspace_source_json git-overlay)" \
        '{relayfileMountPaths: [$path], workspaceSource: $source}'
      ;;
  esac
}

mode_for_attempt() {
  local attempt="$1"
  if [[ "$WORKSPACE_SOURCE" != "all" ]]; then
    printf '%s\n' "$WORKSPACE_SOURCE"
    return 0
  fi

  case $(( (attempt - 1) % 3 )) in
    0) printf 'relayfile\n' ;;
    1) printf 'git\n' ;;
    2) printf 'git-overlay\n' ;;
  esac
}

write_result() {
  local attempt="$1"
  local mode="$2"
  local success="$3"
  local elapsed="$4"
  local status="$5"
  local error_message="$6"
  local sandbox_id="$7"
  local pre_warm_status="$8"

  jq -cn \
    --argjson attempt "$attempt" \
    --arg mode "$mode" \
    --argjson success "$success" \
    --argjson elapsedSec "$elapsed" \
    --arg status "$status" \
    --arg errorMessage "$error_message" \
    --arg sandboxId "$sandbox_id" \
    --arg preWarmStatus "$pre_warm_status" \
    '{
      attempt: $attempt,
      mode: $mode,
      preWarmStatus: $preWarmStatus,
      success: $success,
      elapsedSec: $elapsedSec,
      status: $status,
      errorMessage: $errorMessage,
      sandboxId: $sandboxId
    }' >> "$REPORT_FILE"
}

box_status() {
  local file="$1"
  jq -r '.status // empty' "$file"
}

box_sandbox_id() {
  local file="$1"
  jq -r '.sandboxId // .id // empty' "$file"
}

box_error() {
  local file="$1"
  jq -r '.errorMessage // .error // .message // empty' "$file"
}

wait_for_cold_box() {
  local get_url="$1"
  local delete_status delete_response_file status response_file sandbox_status started_at elapsed last_observed

  call_curl_json DELETE "$get_url"
  delete_status="$CURL_STATUS"
  delete_response_file="$CURL_RESPONSE_FILE"
  if [[ "$delete_status" == 2* ]]; then
    sandbox_status="$(box_status "$delete_response_file")"
    last_observed="${sandbox_status:-http-${delete_status}}"
    rm -f "$delete_response_file"
  elif is_not_found_response "$delete_status" "$delete_response_file"; then
    rm -f "$delete_response_file"
    printf 'absent\n'
    return 0
  else
    local message
    message="$(read_error_message "$delete_response_file" "DELETE /box failed")"
    rm -f "$delete_response_file"
    printf 'delete-failed:%s:%s\n' "$delete_status" "$message"
    return 1
  fi

  started_at="$(date -u +%s)"
  while true; do
    call_curl_json GET "$get_url"
    status="$CURL_STATUS"
    response_file="$CURL_RESPONSE_FILE"

    if is_not_found_response "$status" "$response_file"; then
      rm -f "$response_file"
      printf 'absent\n'
      return 0
    fi

    if [[ "$status" == 2* ]]; then
      sandbox_status="$(box_status "$response_file")"
      last_observed="${sandbox_status:-http-${status}}"
    else
      sandbox_status=""
      last_observed="http-${status}:$(read_error_message "$response_file" "GET /box failed")"
    fi
    rm -f "$response_file"

    if [[ "$status" == 2* && "$sandbox_status" == "stopped" ]]; then
      printf 'stopped\n'
      return 0
    fi

    elapsed="$(( $(date -u +%s) - started_at ))"
    if (( elapsed >= STOP_TIMEOUT_SEC )); then
      printf '%s\n' "${last_observed:-unknown}"
      return 1
    fi

    sleep "$POLL_INTERVAL_SEC"
  done
}

run_attempt() {
  local attempt="$1"
  local cloud_agent_id="$2"
  local mode start now elapsed body post_url get_url status response_file sandbox_status sandbox_id error_message pre_warm_status

  mode="$(mode_for_attempt "$attempt")"
  start="$(date -u +%s)"
  body="$(request_body_for_mode "$mode")"
  get_url="$CLOUD_BASE/api/v1/workspaces/$(printf '%s' "$WORKSPACE_ID" | jq -sRr @uri)/cloud-agents/$(printf '%s' "$cloud_agent_id" | jq -sRr @uri)/box"
  post_url="${get_url}?async=true"

  if ! pre_warm_status="$(wait_for_cold_box "$get_url")"; then
    elapsed="$(( $(date -u +%s) - start ))"
    write_result "$attempt" "$mode" false "$elapsed" "$pre_warm_status" "box did not stop before warm" "" "$pre_warm_status"
    return 1
  fi

  call_curl_json POST "$post_url" "$body"
  status="$CURL_STATUS"
  response_file="$CURL_RESPONSE_FILE"
  sandbox_status="$(box_status "$response_file")"
  sandbox_id="$(box_sandbox_id "$response_file")"
  if [[ "$status" != 2* ]]; then
    error_message="$(read_error_message "$response_file" "POST /box failed")"
    rm -f "$response_file"
    elapsed="$(( $(date -u +%s) - start ))"
    write_result "$attempt" "$mode" false "$elapsed" "$sandbox_status" "POST ${status}: ${error_message}" "$sandbox_id" "$pre_warm_status"
    return 1
  fi
  error_message="$(box_error "$response_file")"
  rm -f "$response_file"

  while true; do
    now="$(date -u +%s)"
    elapsed="$(( now - start ))"
    case "$sandbox_status" in
      ready)
        write_result "$attempt" "$mode" true "$elapsed" "$sandbox_status" "" "$sandbox_id" "$pre_warm_status"
        return 0
        ;;
      failed|stopping|stopped)
        write_result "$attempt" "$mode" false "$elapsed" "$sandbox_status" "${error_message:-box_warm_failed}" "$sandbox_id" "$pre_warm_status"
        return 1
        ;;
    esac

    if (( elapsed >= POLL_TIMEOUT_SEC )); then
      write_result "$attempt" "$mode" false "$elapsed" "${sandbox_status:-unknown}" "Cloud agent box warm timed out" "$sandbox_id" "$pre_warm_status"
      return 1
    fi

    sleep "$POLL_INTERVAL_SEC"
    call_curl_json GET "$get_url"
    status="$CURL_STATUS"
    response_file="$CURL_RESPONSE_FILE"
    sandbox_status="$(box_status "$response_file")"
    sandbox_id="$(box_sandbox_id "$response_file")"
    error_message="$(box_error "$response_file")"
    if [[ "$status" != 2* ]]; then
      error_message="$(read_error_message "$response_file" "GET /box failed")"
      rm -f "$response_file"
      elapsed="$(( $(date -u +%s) - start ))"
      write_result "$attempt" "$mode" false "$elapsed" "$sandbox_status" "GET ${status}: ${error_message}" "$sandbox_id" "$pre_warm_status"
      return 1
    fi
    rm -f "$response_file"
  done
}

print_report() {
  jq -rs --arg file "$REPORT_FILE" '
    def pct($part; $total):
      if $total == 0 then "0" else (((($part * 10000) / $total) | floor) / 100 | tostring) end;
    def percentile($values; $p):
      if ($values | length) == 0 then null
      else ($values | sort) as $sorted
        | (($sorted | length) - 1) as $last
        | (($last * $p / 100) | ceil) as $idx
        | $sorted[$idx]
      end;
    . as $rows
    | ($rows | length) as $total
    | ($rows | map(select(.success)) | length) as $successes
    | ($rows | map(.elapsedSec)) as $elapsed
    | ([
        range(1; $rows | length) as $idx
        | select(($rows[$idx - 1].sandboxId != "") and ($rows[$idx].sandboxId != "") and ($rows[$idx - 1].sandboxId == $rows[$idx].sandboxId))
        | "  attempts \($rows[$idx - 1].attempt) and \($rows[$idx].attempt) share sandboxId \($rows[$idx].sandboxId)"
      ]) as $reuseWarnings
    | "Report file: \($file)",
      "Success rate: \($successes)/\($total) (\(pct($successes; $total))%)",
      "Elapsed seconds: p50=\(percentile($elapsed; 50) // "n/a") p95=\(percentile($elapsed; 95) // "n/a")",
      "",
      "Distinct errors:",
      (
        $rows
        | map(select(.errorMessage != ""))
        | group_by(.errorMessage)
        | map({message: .[0].errorMessage, count: length})
        | if length == 0 then ["  none"] else map("  \(.count)x \(.message)") end
        | .[]
      ),
      "",
      "Sandbox reuse warnings:",
      (if ($reuseWarnings | length) == 0 then "  none" else $reuseWarnings[] end),
      "",
      "Results:",
      "attempt\tmode\tpreWarmStatus\tsuccess\telapsedSec\tstatus\tsandboxId\terrorMessage",
      (
        $rows[]
        | "\(.attempt)\t\(.mode)\t\(.preWarmStatus)\t\(.success)\t\(.elapsedSec)\t\(.status)\t\(.sandboxId)\t\(.errorMessage)"
      )
  ' "$REPORT_FILE"
}

main() {
  : > "$REPORT_FILE"
  local cloud_agent_id failures=0 attempt
  cloud_agent_id="$(discover_cloud_agent_id)"
  echo "Cloud agent probe: workspace=$WORKSPACE_ID cloudAgent=$cloud_agent_id report=$REPORT_FILE" >&2

  for attempt in $(seq 1 "$COUNT"); do
    if ! run_attempt "$attempt" "$cloud_agent_id"; then
      failures=$(( failures + 1 ))
    fi
  done

  if [[ "$REPORT" == true ]]; then
    print_report
    exit 0
  fi

  if (( failures > 0 )); then
    echo "$failures/$COUNT attempts failed; see $REPORT_FILE" >&2
    exit 1
  fi
}

main "$@"
