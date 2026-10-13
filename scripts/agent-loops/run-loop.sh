#!/usr/bin/env bash
# Fresh-context headless runner for Project Admin's work-kind and deploy queues.
set -euo pipefail

REQUESTED_AGENT="${1:-}"
AGENT_TOKEN="$REQUESTED_AGENT"
QUEUE_NAME="${2:-}"
RUN_MODE="${3:---once}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_MACHINE_ID="$(node "$REPO_ROOT/scripts/project-env.js" value DEFAULT_MACHINE_ID)"
STATE_DIRECTORY="$(node "$REPO_ROOT/scripts/project-env.js" value STATE_DIRECTORY)"
MACHINE_ID="${PROJECT_ADMIN_MACHINE_ID:-$DEFAULT_MACHINE_ID}"
INTERVAL_SECONDS="${PROJECT_ADMIN_LOOP_INTERVAL_SECONDS:-1800}"
PROGRESS_INTERVAL_SECONDS="${PROJECT_ADMIN_LOOP_PROGRESS_SECONDS:-900}"
AGENTS_HELPER="$REPO_ROOT/scripts/lib/agents.js"
WORK_KINDS_HELPER="$REPO_ROOT/scripts/lib/work-kinds.js"
AUTH_ALERT_STAMP="${PROJECT_ADMIN_LOOP_AUTH_STAMP:-$HOME/$STATE_DIRECTORY/loop-auth-alert.stamp}"
AUTH_ALERT_DEBOUNCE_SECONDS="${PROJECT_ADMIN_LOOP_AUTH_DEBOUNCE_SECONDS:-1800}"
NOTIFIER="${PROJECT_ADMIN_LOOP_NOTIFIER:-osascript}"

# A headless CLI whose OAuth session expired cannot re-authenticate itself, so
# every queue silently reports "no work" until a human runs `claude setup-token`
# (or `codex login`). Detect the documented signatures in the captured output so
# the run is classified as failed and the project owner gets one notification.
AUTH_FAILURE_PATTERN='oauth session expired|failed to authenticate|could not be refreshed|invalid api key|authentication_error|please run.*login'
AUTH_FAILURE_REASON='Headless CLI authentication expired; loops stay idle until the session is renewed'

# The deploy queue runs firebase/gcloud/TestFlight commands that legitimately
# take 10-40+ minutes, and it drains several items per run. The default 600 s
# background-wait ceiling terminated the agent mid-deploy, orphaning the deploy
# and leaving the item unshipped (it then re-looped forever), so give deploy a
# 90-minute in-turn wait ceiling and a six-hour outer wall. Build queues keep
# the previous defaults; an explicit environment override always wins.
if [[ "${2:-}" == "deploy" ]]; then
  LOOP_TIMEOUT_SECONDS="${PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS:-21600}"
  CLAUDE_BACKGROUND_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-5400000}"
else
  LOOP_TIMEOUT_SECONDS="${PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS:-14400}"
  CLAUDE_BACKGROUND_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-0}"
fi

usage() {
  local tokens
  tokens="$(node "$AGENTS_HELPER" tokens --separator '|' 2>/dev/null || true)"
  local queues
  queues="$(node "$WORK_KINDS_HELPER" queues 2>/dev/null | paste -sd '|' - || true)"
  echo "Usage: $0 <${tokens:-agent}|configured> <${queues:-queue}> [--once|interval-seconds]" >&2
  exit 2
}

# Queues are the configured work kinds (project-admin.config.json `workKinds`)
# plus `deploy`, which spans every kind that deploys.
node "$WORK_KINDS_HELPER" queues 2>/dev/null | grep -qxF -- "$QUEUE_NAME" || usage
[[ "$LOOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS must be a positive integer" >&2; exit 2; }
[[ "$PROGRESS_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "PROJECT_ADMIN_LOOP_PROGRESS_SECONDS must be a positive integer" >&2; exit 2; }
if [[ "$REQUESTED_AGENT" == "configured" ]]; then
  [[ "$QUEUE_NAME" == "deploy" ]] || usage
  AGENT_TOKEN="$(node "$SCRIPT_DIR/log-run.js" configured-agent --queue deploy)"
fi
# The configured roster (project-admin.config.json `agents`) decides which
# tokens exist and which runner adapter each one uses. The helper prints
# shell-quoted PA_* assignments, canonicalizing aliases such as codex -> terra.
AGENT_FIELDS="$(node "$AGENTS_HELPER" resolve "$AGENT_TOKEN")" || usage
eval "$AGENT_FIELDS"
AGENT_TOKEN="$PA_AGENT_TOKEN"
RUNNER_ADAPTER="$SCRIPT_DIR/runners/$PA_RUNNER.sh"
# machine-roster.json is enforcing, not descriptive: a hand-copied or stale
# launchd plist must never poll a queue this host is no longer entitled to run.
if ! node "$SCRIPT_DIR/roster-check.js" "$MACHINE_ID" "$QUEUE_NAME" "$AGENT_TOKEN"; then
  echo "machine-roster.json does not entitle $MACHINE_ID to run $AGENT_TOKEN x $QUEUE_NAME" >&2
  exit 2
fi
if [[ "$RUN_MODE" != "--once" ]]; then
  [[ "$RUN_MODE" =~ ^[0-9]+$ ]] || usage
  INTERVAL_SECONDS="$RUN_MODE"
fi
# Only adapters that wire headless-guard.py into their CLI are guarded. Say so
# up front, once per launch, so an unguarded runner is never silent about it.
if [[ "$PA_GUARDED" != "1" ]]; then
  echo "run-loop: WARNING $AGENT_TOKEN uses the $PA_RUNNER runner, which does not enforce headless-guard.py; destructive shell commands are not blocked${PA_SANDBOX:+ (sandbox: $PA_SANDBOX)}" >&2
fi
# Usage capture is an optional per-agent hook (runner default, or the agent's
# `usage` config). PROJECT_ADMIN_<PROVIDER>_USAGE_CAPTURE overrides its script.
USAGE_CAPTURE=""
if [[ -n "$PA_USAGE_PROVIDER" ]]; then
  usage_override="PROJECT_ADMIN_$(tr 'a-z-' 'A-Z_' <<<"$PA_USAGE_PROVIDER")_USAGE_CAPTURE"
  USAGE_CAPTURE="${!usage_override:-$PA_USAGE_SCRIPT}"
fi

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$TIMEOUT_BIN" ]] || { echo "timeout is required (brew install coreutils)" >&2; exit 1; }

count_queue() {
  if [[ "$QUEUE_NAME" == "deploy" ]]; then
    # Without --kind, deploy-count covers every kind whose items deploy.
    node "$REPO_ROOT/scripts/work-agent.js" deploy-count --as "$AGENT_TOKEN"
  else
    node "$REPO_ROOT/scripts/work-agent.js" --kind "$QUEUE_NAME" count --as "$AGENT_TOKEN"
  fi
}

capture_usage() {
  [[ -n "$USAGE_CAPTURE" ]] || return 0
  PA_USAGE_PROVIDER="$PA_USAGE_PROVIDER" "$USAGE_CAPTURE" >/dev/null 2>&1 || true
}

# One macOS notification per debounce window, shared by every concurrent loop,
# so seven wedged queues cannot fire seven alerts for the same expired session.
notify_auth_failure() {
  local now_seconds last_seconds=0
  echo "run-loop: AUTH FAILURE ($AGENT_TOKEN x $QUEUE_NAME) - the headless CLI needs re-auth" >&2
  now_seconds="$(date +%s)"
  [[ -f "$AUTH_ALERT_STAMP" ]] && last_seconds="$(cat "$AUTH_ALERT_STAMP" 2>/dev/null || echo 0)"
  [[ "$last_seconds" =~ ^[0-9]+$ ]] || last_seconds=0
  (( now_seconds - last_seconds > AUTH_ALERT_DEBOUNCE_SECONDS )) || return 0
  mkdir -p "$(dirname "$AUTH_ALERT_STAMP")" 2>/dev/null || true
  echo "$now_seconds" > "$AUTH_ALERT_STAMP" 2>/dev/null || true
  command -v "$NOTIFIER" >/dev/null 2>&1 || return 0
  "$NOTIFIER" -e 'display notification "Headless agent loops cannot authenticate. Run: claude setup-token (or codex login). Loops are idle until fixed." with title "Project Admin loops: auth expired" sound name "Basso"' >/dev/null 2>&1 || true
}

run_once() {
  cd "$REPO_ROOT"
  # A run killed by a signal (launchctl bootout during provision-machine.sh
  # install, a machine restart, a hard kill) never reaches finish/release-claim
  # below, so its row stays "running" with a frozen heartbeat and its item stays
  # claimed until the four-hour lease lapses. Sweep this machine's abandoned
  # runs before counting work so their items are claimable on this very fire.
  node "$SCRIPT_DIR/log-run.js" reap --machine "$MACHINE_ID" >/dev/null 2>&1 || true
  local count_json work_count item_effort run_effort run_model prompt_template prompt_file loop_run_id log_dir log_file exit_code summary classified release_reason confirmation_requested confirmation_handoff handoff_status
  count_json="$(count_queue)"
  work_count="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))' <<<"$count_json")"
  item_effort="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).topThinkingEffort||"medium"))' <<<"$count_json")"
  if [[ "$work_count" == "0" ]]; then
    node "$SCRIPT_DIR/log-run.js" machine-heartbeat --machine "$MACHINE_ID" >/dev/null
    capture_usage
    echo "No $QUEUE_NAME work claimable by $AGENT_TOKEN."
    return 0
  fi

  prompt_template="$SCRIPT_DIR/${QUEUE_NAME}-loop-prompt.md"
  [[ -f "$prompt_template" ]] || { echo "Missing $prompt_template" >&2; return 1; }
  [[ -x "$RUNNER_ADAPTER" ]] || { echo "Missing runner adapter $RUNNER_ADAPTER" >&2; return 1; }
  # Fail before a run row exists when the CLI is not installed, as before.
  PA_COMMAND_JSON="$PA_COMMAND_JSON" "$RUNNER_ADAPTER" check >/dev/null || return 1
  # The runner's documented env overrides (CODEX_MODEL, CLAUDE_EFFORT, ...) win
  # over the configured model and the item's effort; resolving them here keeps
  # the recorded effort equal to the one the CLI actually gets.
  run_model="$PA_MODEL"
  run_effort="$item_effort"
  if [[ -n "$PA_MODEL_ENV" ]]; then run_model="${!PA_MODEL_ENV:-$PA_MODEL}"; fi
  if [[ -n "$PA_EFFORT_ENV" ]]; then run_effort="${!PA_EFFORT_ENV:-$item_effort}"; fi

  # `$$` is this run-loop.sh process even inside the command substitution, and
  # it is the pid the reaper checks to tell a killed run from a sleeping Mac.
  loop_run_id="$(node "$SCRIPT_DIR/log-run.js" start --agent "$AGENT_TOKEN" --queue "$QUEUE_NAME" --machine "$MACHINE_ID" --pid $$ --effort "$run_effort")"
  export PROJECT_ADMIN_AGENT_RUN_ID="$loop_run_id"
  export PROJECT_ADMIN_MACHINE_ID="$MACHINE_ID"
  log_dir="$REPO_ROOT/.agent-logs"
  mkdir -p "$log_dir"
  log_file="$log_dir/${QUEUE_NAME}-${AGENT_TOKEN}-${loop_run_id}.log"
  prompt_file="$log_dir/${QUEUE_NAME}-${AGENT_TOKEN}-${loop_run_id}.prompt.md"
  sed "s/{{AGENT}}/$AGENT_TOKEN/g" "$prompt_template" > "$prompt_file"

  # The adapter contract (runners/README.md): PA_* environment in, the CLI's
  # stdout/stderr out, its exit code back. The outer timeout stays here so every
  # runner gets the same wall and kill escalation.
  local -a command_line=("$TIMEOUT_BIN" --signal=TERM --kill-after=30s "$LOOP_TIMEOUT_SECONDS" env
    "PA_AGENT=$AGENT_TOKEN" "PA_QUEUE=$QUEUE_NAME" "PA_RUNNER=$PA_RUNNER"
    "PA_MODEL=$run_model" "PA_EFFORT=$run_effort" "PA_PROMPT_FILE=$prompt_file"
    "PA_REPO_ROOT=$REPO_ROOT" "PA_SANDBOX=$PA_SANDBOX" "PA_HEADLESS_GUARD=$SCRIPT_DIR/headless-guard.py"
    "PA_BG_WAIT_CEILING_MS=$CLAUDE_BACKGROUND_WAIT_CEILING_MS" "PA_TIMEOUT_SECONDS=$LOOP_TIMEOUT_SECONDS"
    "PA_COMMAND_JSON=$PA_COMMAND_JSON" "PA_PROMPT_VIA=$PA_PROMPT_VIA"
    "$RUNNER_ADAPTER")

  set +e
  # Never leave launchd's inherited stdin open: an adapter whose CLI reads the
  # prompt from stdin redirects it from PA_PROMPT_FILE, so every CLI sees EOF.
  "${command_line[@]}" </dev/null > >(tee "$log_file") 2>&1 &
  local worker_pid=$! heartbeat_seconds=0 progress_seconds=0 progress_summary
  while kill -0 "$worker_pid" 2>/dev/null; do
    sleep 5
    heartbeat_seconds=$((heartbeat_seconds + 5))
    progress_seconds=$((progress_seconds + 5))
    if (( progress_seconds >= PROGRESS_INTERVAL_SECONDS )); then
      progress_summary="$(tail -c 4000 "$log_file" 2>/dev/null || true)"
      [[ -n "${progress_summary//[[:space:]]/}" ]] || progress_summary="Worker active; no output has been captured yet."
      node "$SCRIPT_DIR/log-run.js" progress --run "$loop_run_id" --machine "$MACHINE_ID" --summary "$progress_summary" >/dev/null 2>&1 || true
      progress_seconds=0
      heartbeat_seconds=0
    elif (( heartbeat_seconds >= 60 )); then
      node "$SCRIPT_DIR/log-run.js" heartbeat --run "$loop_run_id" --machine "$MACHINE_ID" >/dev/null 2>&1 || true
      heartbeat_seconds=0
    fi
  done
  wait "$worker_pid"
  exit_code=$?
  set -e
  rm -f "$prompt_file"
  summary="$(tail -c 6000 "$log_file" 2>/dev/null || true)"
  if [[ -z "${summary//[[:space:]]/}" ]]; then
    summary="${AGENT_TOKEN} ${QUEUE_NAME} iteration exited ${exit_code} without captured output"
  fi
  classified="$(node "$SCRIPT_DIR/classify-run-result.js" "$exit_code" "$log_file")"
  IFS=$'\t' read -r exit_code release_reason confirmation_requested <<<"$classified"
  if [[ "$exit_code" != "0" ]] && grep -qiE "$AUTH_FAILURE_PATTERN" "$log_file" 2>/dev/null; then
    exit_code=78
    release_reason="$AUTH_FAILURE_REASON"
    summary="$AUTH_FAILURE_REASON"$'\n'"$summary"
    notify_auth_failure
  fi
  if [[ "$exit_code" == "0" && -n "$confirmation_requested" ]]; then
    confirmation_handoff="$(node "$SCRIPT_DIR/log-run.js" confirmation-handoff --run "$loop_run_id" --reason "$release_reason" --output "$summary" 2>/dev/null || echo 'not_applicable')"
    if [[ "$confirmation_handoff" == "asked" ]]; then
      exit_code=70
    fi
  fi
  if [[ "$exit_code" == "0" ]]; then
    handoff_status="$(node "$SCRIPT_DIR/log-run.js" handoff-status --run "$loop_run_id" 2>/dev/null || echo 'Unable to verify the lifecycle handoff')"
    if [[ "$handoff_status" != "ok" ]]; then
      exit_code=70
      release_reason="$handoff_status"
    fi
  fi
  if [[ "$exit_code" != "0" ]]; then
    node "$SCRIPT_DIR/log-run.js" release-claim --run "$loop_run_id" --reason "$release_reason" >/dev/null || true
  fi
  node "$SCRIPT_DIR/log-run.js" finish --run "$loop_run_id" --machine "$MACHINE_ID" --code "$exit_code" --summary "$summary" >/dev/null || true
  capture_usage
  return "$exit_code"
}

if [[ "$RUN_MODE" == "--once" ]]; then
  run_once
else
  while true; do
    run_once || true
    sleep "$INTERVAL_SECONDS"
  done
fi
