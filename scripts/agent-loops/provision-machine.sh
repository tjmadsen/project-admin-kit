#!/usr/bin/env bash
# Install or inspect the macOS launchd jobs that poll each agent-owned queue.
set -euo pipefail

ACTION="${1:-check}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_MACHINE_ID="$(node "$REPO_ROOT/scripts/project-env.js" value DEFAULT_MACHINE_ID)"
MACHINE_ID="${PROJECT_ADMIN_MACHINE_ID:-$DEFAULT_MACHINE_ID}"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIRECTORY_NAME="$(node "$REPO_ROOT/scripts/project-env.js" value LOG_DIRECTORY_NAME)"
LOG_DIR="$HOME/Library/Logs/$LOG_DIRECTORY_NAME"

check_binary() {
  local label="$1" binary="$2"
  if command -v "$binary" >/dev/null 2>&1; then
    printf '✓ %-10s %s\n' "$label" "$(command -v "$binary")"
  else
    printf '✗ %-10s missing\n' "$label"
    return 1
  fi
}

check() {
  local failed=0
  echo "Project Admin agent-loop readiness"
  check_binary Node node || failed=1
  check_binary Codex codex || failed=1
  check_binary Claude claude || failed=1
  if command -v grok >/dev/null 2>&1 && grok --version >/dev/null 2>&1; then
    printf '✓ %-10s %s\n' Grok "$(command -v grok)"
  else
    echo "✗ Grok       CLI missing or not initialized"
    failed=1
  fi
  check_binary timeout timeout || check_binary gtimeout gtimeout || failed=1
  [[ -x "$SCRIPT_DIR/loop-wrapper.sh" ]] && echo "✓ Wrapper    loop-wrapper.sh is executable" || { echo "✗ Wrapper    scripts/agent-loops/loop-wrapper.sh missing or not executable"; failed=1; }
  command -v taskpolicy >/dev/null 2>&1 && echo "✓ taskpolicy loops re-exec at normal QoS" || echo "⚠ taskpolicy missing — loops stay pinned to the E-cores"
  if gcloud auth application-default print-access-token >/dev/null 2>&1; then
    echo "✓ Firestore  application-default credentials ready"
  else
    echo "✗ Firestore  run: gcloud auth application-default login"
    failed=1
  fi
  [[ -d "$REPO_ROOT/scripts/node_modules/@google-cloud/firestore" ]] && echo "✓ Node deps  Firestore SDK installed" || { echo "✗ Node deps  run: cd scripts && npm install"; failed=1; }
  [[ -n "$(node "$SCRIPT_DIR/roster-check.js" --list "$MACHINE_ID")" ]] && echo "✓ Roster    $MACHINE_ID is entitled to $(node "$SCRIPT_DIR/roster-check.js" --agents "$MACHINE_ID")" || { echo "✗ Roster    machine-roster.json has no entry for $MACHINE_ID"; failed=1; }
  node "$SCRIPT_DIR/log-run.js" machine-heartbeat --machine "$MACHINE_ID" >/dev/null 2>&1 && echo "✓ Heartbeat  Firestore write succeeded" || { echo "✗ Heartbeat  Firestore write failed"; failed=1; }
  local deploy_agent
  deploy_agent="$(node "$SCRIPT_DIR/log-run.js" configured-agent --queue deploy 2>/dev/null)" && echo "✓ Deploy     dashboard selects $deploy_agent" || { echo "✗ Deploy     could not read dashboard model"; failed=1; }
  return "$failed"
}

plist() {
  local label="$1" agent="$2" queue="$3" interval="$4"
  local path="$LAUNCH_DIR/$1.plist" temp_path
  temp_path="$(mktemp)"
  sed -e "s|__LABEL__|$label|g" -e "s|__REPO__|$REPO_ROOT|g" -e "s|__AGENT__|$agent|g" -e "s|__QUEUE__|$queue|g" -e "s|__INTERVAL__|$interval|g" -e "s|__LOGDIR__|$LOG_DIR|g" -e "s|__MACHINE__|$MACHINE_ID|g" -e "s|__PATH__|$PATH|g" "$SCRIPT_DIR/launchd.plist.template" > "$temp_path"
  install -m 0644 "$temp_path" "$path"
  rm "$temp_path"
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$path"
  echo "Installed $label ($agent $queue every ${interval}s)"
}

interval_for() {
  [[ "$1" == "grok" ]] && echo 1800 || echo 300
}

install_jobs() {
  mkdir -p "$LAUNCH_DIR" "$LOG_DIR"
  check
  local file label
  for file in "$LAUNCH_DIR"/com.projectadmin.loop.*.plist; do
    [[ -e "$file" ]] || continue
    label="$(basename "$file" .plist)"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    rm "$file"
  done
  local queue agent installed=0 deploy_installed=0
  # machine-roster.json is the only place that says which agent x queue loops
  # this host runs, so enumerate it instead of repeating the roster here.
  while read -r queue agent; do
    [[ -n "$queue" && -n "$agent" ]] || continue
    if [[ "$queue" == "deploy" ]]; then
      # The dashboard picks the deploy model at poll time, so every deploy
      # entitlement collapses into the one `configured` dispatcher.
      if (( deploy_installed )); then continue; fi
      plist com.projectadmin.loop.configured-deploy configured deploy 900
      deploy_installed=1
    else
      plist "com.projectadmin.loop.$agent-$queue" "$agent" "$queue" "$(interval_for "$agent")"
    fi
    installed=$((installed + 1))
  done < <(node "$SCRIPT_DIR/roster-check.js" --list "$MACHINE_ID")
  (( installed )) || { echo "machine-roster.json entitles $MACHINE_ID to nothing" >&2; return 1; }
  # The bootout above ended every running loop's process tree. Hand their items
  # back now rather than waiting out four-hour leases. RunAtLoad covers the case
  # where this script was itself booted out mid-install: each job just
  # bootstrapped fires immediately and sweeps before it counts work.
  node "$SCRIPT_DIR/log-run.js" reap --machine "$MACHINE_ID" --stale-minutes 0 || true
  echo "$installed Project Admin loop jobs are loaded for $MACHINE_ID. Item owners select build models; the dashboard selects the shared deploy model."
  echo "Each job runs loop-wrapper.sh, which works in its own .agent-worktrees/loop-<queue>-<agent> checkout, never the primary one."
}

status() {
  launchctl print-disabled "gui/$(id -u)" | rg 'com\.projectadmin\.loop' || true
  for file in "$LAUNCH_DIR"/com.projectadmin.loop.*.plist; do
    [[ -e "$file" ]] && basename "$file"
  done
}

case "$ACTION" in
  check) check ;;
  install) install_jobs ;;
  status) status ;;
  *) echo "Usage: $0 <check|install|status>" >&2; exit 2 ;;
esac
