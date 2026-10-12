#!/usr/bin/env bash
# Fresh-context headless runner for Project Admin's feature, bug, and deploy queues.
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
CODEX_USAGE_CAPTURE="${PROJECT_ADMIN_CODEX_USAGE_CAPTURE:-$SCRIPT_DIR/capture-codex-usage.sh}"
CLAUDE_USAGE_CAPTURE="${PROJECT_ADMIN_CLAUDE_USAGE_CAPTURE:-$SCRIPT_DIR/capture-claude-usage.sh}"
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
  echo "Usage: $0 <sol|terra|luna|opus|sonnet|fable|grok|configured> <feature|bug|deploy> [--once|interval-seconds]" >&2
  exit 2
}

[[ "$QUEUE_NAME" =~ ^(feature|bug|deploy)$ ]] || usage
[[ "$LOOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS must be a positive integer" >&2; exit 2; }
[[ "$PROGRESS_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "PROJECT_ADMIN_LOOP_PROGRESS_SECONDS must be a positive integer" >&2; exit 2; }
if [[ "$REQUESTED_AGENT" == "configured" ]]; then
  [[ "$QUEUE_NAME" == "deploy" ]] || usage
  AGENT_TOKEN="$(node "$SCRIPT_DIR/log-run.js" configured-agent --queue deploy)"
fi
[[ "$AGENT_TOKEN" =~ ^(sol|terra|luna|opus|sonnet|fable|grok)$ ]] || usage
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

TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$TIMEOUT_BIN" ]] || { echo "timeout is required (brew install coreutils)" >&2; exit 1; }

count_queue() {
  if [[ "$QUEUE_NAME" == "feature" ]]; then
    node "$REPO_ROOT/scripts/feature-agent.js" count --as "$AGENT_TOKEN"
  elif [[ "$QUEUE_NAME" == "bug" ]]; then
    node "$REPO_ROOT/scripts/bug-agent.js" count --as "$AGENT_TOKEN"
  else
    local feature_json bug_json feature_count bug_count
    feature_json="$(node "$REPO_ROOT/scripts/feature-agent.js" deploy-count --as "$AGENT_TOKEN")"
    bug_json="$(node "$REPO_ROOT/scripts/bug-agent.js" deploy-count --as "$AGENT_TOKEN")"
    feature_count="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))' <<<"$feature_json")"
    bug_count="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))' <<<"$bug_json")"
    echo "{\"count\":$((feature_count + bug_count)),\"topThinkingEffort\":\"high\"}"
  fi
}

capture_usage() {
  if [[ "$AGENT_TOKEN" =~ ^(sol|terra|luna)$ ]]; then
    "$CODEX_USAGE_CAPTURE" >/dev/null 2>&1 || true
  elif [[ "$AGENT_TOKEN" =~ ^(opus|sonnet|fable)$ ]]; then
    "$CLAUDE_USAGE_CAPTURE" >/dev/null 2>&1 || true
  fi
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

# Claude writes the model its alias resolved to into the session transcript
# once the first reply arrives; copy it onto the run record. Sets the
# caller's run_model so the lookup stops after the first hit.
record_claude_model() {
  local found
  found="$(node "$SCRIPT_DIR/resolve-model.js" claude-session "$2" 2>/dev/null || true)"
  [[ -n "$found" ]] || return 0
  run_model="$found"
  node "$SCRIPT_DIR/log-run.js" model --run "$1" --model "$found" >/dev/null 2>&1 || true
}

run_once() {
  cd "$REPO_ROOT"
  # A run killed by a signal (launchctl bootout during provision-machine.sh
  # install, a machine restart, a hard kill) never reaches finish/release-claim
  # below, so its row stays "running" with a frozen heartbeat and its item stays
  # claimed until the four-hour lease lapses. Sweep this machine's abandoned
  # runs before counting work so their items are claimable on this very fire.
  node "$SCRIPT_DIR/log-run.js" reap --machine "$MACHINE_ID" >/dev/null 2>&1 || true
  local count_json work_count item_effort run_effort run_model='' claude_session='' prompt_file prompt_text loop_run_id log_dir log_file exit_code summary classified release_reason confirmation_requested confirmation_handoff handoff_status prompt_via_stdin=0
  count_json="$(count_queue)"
  work_count="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))' <<<"$count_json")"
  item_effort="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).topThinkingEffort||"medium"))' <<<"$count_json")"
  if [[ "$work_count" == "0" ]]; then
    node "$SCRIPT_DIR/log-run.js" machine-heartbeat --machine "$MACHINE_ID" >/dev/null
    capture_usage
    echo "No $QUEUE_NAME work claimable by $AGENT_TOKEN."
    return 0
  fi

  prompt_file="$SCRIPT_DIR/${QUEUE_NAME}-loop-prompt.md"
  [[ -f "$prompt_file" ]] || { echo "Missing $prompt_file" >&2; return 1; }
  prompt_text="$(sed "s/{{AGENT}}/$AGENT_TOKEN/g" "$prompt_file")"
  local -a command_line
  if [[ "$AGENT_TOKEN" =~ ^(sol|terra|luna)$ ]]; then
    local codex_bin codex_model codex_effort
    codex_bin="$(command -v codex || true)"
    [[ -z "$codex_bin" && -x /Applications/Codex.app/Contents/Resources/codex ]] && codex_bin=/Applications/Codex.app/Contents/Resources/codex
    [[ -n "$codex_bin" ]] || { echo "Codex CLI not found" >&2; return 1; }
    case "$AGENT_TOKEN" in
      sol) codex_model=gpt-5.6-sol ;;
      terra) codex_model=gpt-5.6-terra ;;
      luna) codex_model=gpt-5.6-luna ;;
    esac
    codex_effort="${CODEX_EFFORT:-$item_effort}"
    if [[ -n "${CODEX_MODEL:-}" ]]; then
      codex_model="$CODEX_MODEL"
    else
      # Run the tier's newest model; the slug above is only the fallback when
      # the Codex catalog cannot be read.
      local resolved
      resolved="$(node "$SCRIPT_DIR/resolve-model.js" codex "$AGENT_TOKEN" "$codex_bin" "$codex_model" "$codex_effort" || true)"
      [[ -n "$resolved" ]] && IFS=$'\t' read -r codex_model codex_effort <<<"$resolved"
    fi
    run_effort="$codex_effort"
    run_model="$codex_model"
    # `-` reads the prompt from stdin (fed below) so the CLI sees an immediate
    # EOF instead of inheriting launchd's stdin and waiting on it forever.
    prompt_via_stdin=1
    command_line=("$TIMEOUT_BIN" --signal=TERM --kill-after=30s "$LOOP_TIMEOUT_SECONDS" "$codex_bin" exec --sandbox danger-full-access -m "$codex_model" -c "model_reasoning_effort=$codex_effort" -C "$REPO_ROOT" -)
  elif [[ "$AGENT_TOKEN" =~ ^(opus|sonnet|fable)$ ]]; then
    local claude_bin claude_model claude_effort guard settings
    claude_bin="$(command -v claude || true)"
    [[ -z "$claude_bin" && -x "$HOME/.local/bin/claude" ]] && claude_bin="$HOME/.local/bin/claude"
    [[ -n "$claude_bin" ]] || { echo "Claude CLI not found" >&2; return 1; }
    claude_model="${CLAUDE_MODEL:-$AGENT_TOKEN}"
    claude_effort="${CLAUDE_EFFORT:-$item_effort}"
    run_effort="$claude_effort"
    # The alias resolves to the newest model at launch and only the session
    # transcript names it, so fix the session ID to find that transcript.
    claude_session="$(node -e 'console.log(require("crypto").randomUUID())')"
    guard="$SCRIPT_DIR/headless-guard.py"
    settings="{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"python3 $guard\"}]}]}}"
    command_line=("$TIMEOUT_BIN" --signal=TERM --kill-after=30s "$LOOP_TIMEOUT_SECONDS" env "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=$CLAUDE_BACKGROUND_WAIT_CEILING_MS" "$claude_bin" -p --model "$claude_model" --effort "$claude_effort" --dangerously-skip-permissions --settings "$settings" --session-id "$claude_session" "$prompt_text")
  else
    local grok_bin grok_effort
    grok_bin="$(command -v grok || true)"
    [[ -n "$grok_bin" ]] || { echo "Grok CLI not found" >&2; return 1; }
    grok_effort="${GROK_EFFORT:-$item_effort}"
    run_effort="$grok_effort"
    run_model="$(node "$SCRIPT_DIR/resolve-model.js" grok "$grok_bin" || true)"
    command_line=("$TIMEOUT_BIN" --signal=TERM --kill-after=30s "$LOOP_TIMEOUT_SECONDS" "$grok_bin" -p --reasoning-effort "$grok_effort" "$prompt_text")
  fi

  # `$$` is this run-loop.sh process even inside the command substitution, and
  # it is the pid the reaper checks to tell a killed run from a sleeping Mac.
  loop_run_id="$(node "$SCRIPT_DIR/log-run.js" start --agent "$AGENT_TOKEN" --queue "$QUEUE_NAME" --machine "$MACHINE_ID" --pid $$ --effort "$run_effort" --model "$run_model")"
  export PROJECT_ADMIN_AGENT_RUN_ID="$loop_run_id"
  export PROJECT_ADMIN_MACHINE_ID="$MACHINE_ID"
  log_dir="$REPO_ROOT/.agent-logs"
  mkdir -p "$log_dir"
  log_file="$log_dir/${QUEUE_NAME}-${AGENT_TOKEN}-${loop_run_id}.log"

  set +e
  # Claude and Grok take the prompt as an argument, so redirect stdin from
  # /dev/null rather than leaving launchd's inherited stdin open.
  if (( prompt_via_stdin )); then
    "${command_line[@]}" <<<"$prompt_text" > >(tee "$log_file") 2>&1 &
  else
    "${command_line[@]}" </dev/null > >(tee "$log_file") 2>&1 &
  fi
  local worker_pid=$! heartbeat_seconds=0 progress_seconds=0 model_seconds=0 progress_summary
  while kill -0 "$worker_pid" 2>/dev/null; do
    sleep 5
    heartbeat_seconds=$((heartbeat_seconds + 5))
    progress_seconds=$((progress_seconds + 5))
    model_seconds=$((model_seconds + 5))
    if [[ -n "$claude_session" && -z "$run_model" ]] && (( model_seconds >= 15 )); then
      record_claude_model "$loop_run_id" "$claude_session"
      model_seconds=0
    fi
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
  [[ -n "$claude_session" && -z "$run_model" ]] && record_claude_model "$loop_run_id" "$claude_session"
  set -e
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
