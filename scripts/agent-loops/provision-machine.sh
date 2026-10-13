#!/usr/bin/env bash
# Install or inspect the scheduled jobs that poll each agent-owned queue.
#
#   provision-machine.sh check                 readiness of CLIs, credentials, roster
#   provision-machine.sh install [--dry-run]   (re)install one job per entitlement
#   provision-machine.sh status                list the installed jobs
#   provision-machine.sh uninstall             remove every installed loop job
#
# The scheduler is `automation.scheduler` in project-admin.config.json
# (launchd on macOS and systemd on Linux by default; also cron or foreground),
# or PROJECT_ADMIN_SCHEDULER for one invocation. schedulers/index.js renders
# the units from the machine roster; this script only applies them.
set -euo pipefail

ACTION="${1:-check}"
OPTION="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# The kit checkout whose loop-wrapper.sh every job runs; worktrees are made in
# the product checkout (PRODUCT_ROOT, docs/LAYOUTS.md).
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ENV="$KIT_ROOT/scripts/project-env.js"
SCHEDULER="${PROJECT_ADMIN_SCHEDULER:-$(node "$PROJECT_ENV" value SCHEDULER)}"
MACHINE_ID="${PROJECT_ADMIN_MACHINE_ID:-$(node "$PROJECT_ENV" value MACHINE_ID)}"
export PROJECT_ADMIN_MACHINE_ID="$MACHINE_ID"
LOG_DIR="$(node "$PROJECT_ENV" value LOOP_LOG_DIR)"
# Every job name carries the project slug so several projects can share a host.
SLUG="$(node "$PROJECT_ENV" value PROJECT_SLUG)"
LAUNCHD_PREFIX="com.projectadmin.$SLUG.loop."
SYSTEMD_PREFIX="projectadmin-$SLUG-loop-"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AGENTS_HELPER="$KIT_ROOT/scripts/lib/agents.js"
UNITS="$SCRIPT_DIR/schedulers/index.js"
# Tests and CI set this to skip the live readiness check and the Firestore reap.
OFFLINE="${PROJECT_ADMIN_PROVISION_OFFLINE:-}"

case "$SCHEDULER" in
  launchd|systemd|cron|foreground) ;;
  *) echo "Unknown scheduler \"$SCHEDULER\" (launchd, systemd, cron, or foreground)" >&2; exit 2 ;;
esac

check_binary() {
  local label="$1" binary="$2"
  if command -v "$binary" >/dev/null 2>&1; then
    printf '✓ %-10s %s\n' "$label" "$(command -v "$binary")"
  else
    printf '✗ %-10s missing\n' "$label"
    return 1
  fi
}

# Each entitled agent's runner adapter locates its own CLI with the same
# fallbacks the loop uses, so a newly configured runner needs no edit here.
# Runs in a subshell so the evaluated PA_* fields stay local to one agent.
check_agent() (
  local agent="$1" fields found
  fields="$(node "$AGENTS_HELPER" resolve "$agent" 2>&1)" || { printf '✗ %-10s %s\n' "$agent" "$fields"; exit 1; }
  eval "$fields"
  if found="$(PA_CHECK_DEEP=1 PA_COMMAND_JSON="$PA_COMMAND_JSON" "$SCRIPT_DIR/runners/$PA_RUNNER.sh" check 2>&1)"; then
    printf '✓ %-10s %s (%s)\n' "$agent" "$found" "$PA_RUNNER"
  else
    printf '✗ %-10s %s\n' "$agent" "${found:-$PA_RUNNER runner check failed}"
    exit 1
  fi
  [[ "$PA_GUARDED" == "1" ]] || printf '⚠ %-10s unguarded: the %s runner does not enforce headless-guard.py%s\n' "$agent" "$PA_RUNNER" "${PA_SANDBOX:+ (sandbox: $PA_SANDBOX)}"
)

check_scheduler() {
  case "$SCHEDULER" in
    launchd) check_binary launchctl launchctl ;;
    systemd)
      check_binary systemctl systemctl || return 1
      # User timers stop at logout unless the user lingers.
      if command -v loginctl >/dev/null 2>&1 && [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
        echo "⚠ Linger     run: loginctl enable-linger $(id -un)  (otherwise loops stop when you log out)"
      fi ;;
    cron) check_binary crontab crontab ;;
    foreground) echo "✓ Scheduler  foreground: run \`npm run loops\` (scripts/agent-loops/scheduler.js)" ;;
  esac
}

check() {
  local failed=0 agent
  echo "Project Admin agent-loop readiness ($SCHEDULER on $(uname -s))"
  check_binary Node node || failed=1
  while read -r agent; do
    [[ -n "$agent" ]] || continue
    check_agent "$agent" || failed=1
  done < <(node "$SCRIPT_DIR/roster-check.js" --agents "$MACHINE_ID" | tr ',' '\n')
  check_binary timeout timeout || check_binary gtimeout gtimeout || failed=1
  check_scheduler || failed=1
  local product_root layout
  product_root="$(node "$PROJECT_ENV" value PRODUCT_ROOT)"
  layout="$(node "$PROJECT_ENV" value LAYOUT)"
  if git -C "$product_root" rev-parse --git-dir >/dev/null 2>&1 && git -C "$product_root" remote get-url origin >/dev/null 2>&1; then
    echo "✓ Product    $product_root ($layout layout)"
  else
    echo "✗ Product    $product_root is not a git checkout with an origin remote (layout.productRoot, docs/LAYOUTS.md)"
    failed=1
  fi
  [[ -x "$SCRIPT_DIR/loop-wrapper.sh" ]] && echo "✓ Wrapper    loop-wrapper.sh is executable" || { echo "✗ Wrapper    scripts/agent-loops/loop-wrapper.sh missing or not executable"; failed=1; }
  if [[ "$(uname -s)" == "Darwin" ]]; then
    command -v taskpolicy >/dev/null 2>&1 && echo "✓ taskpolicy loops re-exec at normal QoS" || echo "⚠ taskpolicy missing — loops stay pinned to the E-cores"
  fi
  if gcloud auth application-default print-access-token >/dev/null 2>&1; then
    echo "✓ Firestore  application-default credentials ready"
  else
    echo "✗ Firestore  run: gcloud auth application-default login"
    failed=1
  fi
  [[ -d "$KIT_ROOT/scripts/node_modules/@google-cloud/firestore" ]] && echo "✓ Node deps  Firestore SDK installed" || { echo "✗ Node deps  run: cd scripts && npm install"; failed=1; }
  [[ -n "$(node "$SCRIPT_DIR/roster-check.js" --list "$MACHINE_ID")" ]] && echo "✓ Roster    $MACHINE_ID is entitled to $(node "$SCRIPT_DIR/roster-check.js" --agents "$MACHINE_ID")" || { echo "✗ Roster    machine-roster.json has no entry for $MACHINE_ID"; failed=1; }
  node "$SCRIPT_DIR/log-run.js" machine-heartbeat --machine "$MACHINE_ID" >/dev/null 2>&1 && echo "✓ Heartbeat  Firestore write succeeded" || { echo "✗ Heartbeat  Firestore write failed"; failed=1; }
  local deploy_agent
  deploy_agent="$(node "$SCRIPT_DIR/log-run.js" configured-agent --queue deploy 2>/dev/null)" && echo "✓ Deploy     dashboard selects $deploy_agent" || { echo "✗ Deploy     could not read dashboard model"; failed=1; }
  return "$failed"
}

# --- launchd -----------------------------------------------------------------

# Also removes this checkout's pre-namespacing com.projectadmin.loop.* labels,
# so a machine provisioned before per-project names migrates on its next
# install; a legacy plist pointing at another checkout is left alone.
legacy_plist_is_ours() {
  [[ "$(basename "$1")" == com.projectadmin.loop.* ]] && grep -qF "$KIT_ROOT/scripts/agent-loops/loop-wrapper.sh" "$1"
}

launchd_uninstall() {
  local file label
  for file in "$LAUNCH_DIR/$LAUNCHD_PREFIX"*.plist "$LAUNCH_DIR"/com.projectadmin.loop.*.plist; do
    [[ -e "$file" ]] || continue
    [[ "$(basename "$file")" != com.projectadmin.loop.* ]] || legacy_plist_is_ours "$file" || continue
    label="$(basename "$file" .plist)"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    rm "$file"
  done
}

launchd_install() {
  local rendered="$1" file label
  mkdir -p "$LAUNCH_DIR"
  launchd_uninstall
  for file in "$rendered"/*.plist; do
    label="$(basename "$file" .plist)"
    install -m 0644 "$file" "$LAUNCH_DIR/$label.plist"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$label.plist"
    echo "Installed $label"
  done
}

launchd_status() {
  launchctl print-disabled "gui/$(id -u)" | grep -F -e "$LAUNCHD_PREFIX" -e 'com.projectadmin.loop.' || true
  local file
  for file in "$LAUNCH_DIR/$LAUNCHD_PREFIX"*.plist "$LAUNCH_DIR"/com.projectadmin.loop.*.plist; do
    [[ -e "$file" ]] && basename "$file"
  done
  return 0
}

# --- systemd (user units) ----------------------------------------------------

systemd_uninstall() {
  local file
  for file in "$SYSTEMD_DIR/$SYSTEMD_PREFIX"*.timer; do
    [[ -e "$file" ]] || continue
    systemctl --user disable --now "$(basename "$file")" >/dev/null 2>&1 || true
  done
  rm -f "$SYSTEMD_DIR/$SYSTEMD_PREFIX"*.timer "$SYSTEMD_DIR/$SYSTEMD_PREFIX"*.service
  systemctl --user daemon-reload
}

systemd_install() {
  local rendered="$1" file
  mkdir -p "$SYSTEMD_DIR"
  systemd_uninstall
  install -m 0644 "$rendered"/*.service "$rendered"/*.timer "$SYSTEMD_DIR"/
  systemctl --user daemon-reload
  for file in "$rendered"/*.timer; do
    systemctl --user enable --now "$(basename "$file")"
    echo "Installed $(basename "$file" .timer)"
  done
}

systemd_status() {
  systemctl --user list-timers "$SYSTEMD_PREFIX*" --all --no-pager || true
}

# --- cron --------------------------------------------------------------------

# `crontab -l` exits 1 when the user has no crontab yet; that is an empty one.
current_crontab() {
  crontab -l 2>/dev/null || true
}

cron_install() {
  local merged
  merged="$(current_crontab | node "$UNITS" crontab-merge)"
  printf '%s\n' "$merged" | crontab -
  echo "Installed $(printf '%s\n' "$merged" | grep -c 'loop-wrapper\.sh') cron entries"
}

# Read the whole crontab before writing it back; never pipe `crontab -l` into
# `crontab -` in one pipeline.
cron_uninstall() {
  local stripped
  stripped="$(current_crontab | node "$UNITS" crontab-strip)"
  printf '%s\n' "$stripped" | crontab -
}

cron_status() {
  current_crontab | sed -n "/^# BEGIN project-admin agent loops: $SLUG /,/^# END project-admin agent loops: $SLUG\$/p"
}

# --- foreground --------------------------------------------------------------

foreground_note() {
  echo "automation.scheduler is foreground: nothing is installed. Run \`npm run loops\`"
  echo "(scripts/agent-loops/scheduler.js) in a terminal, tmux, a container, or a CI job."
}

# --- actions -----------------------------------------------------------------

dry_run() {
  local rendered file
  echo "# Dry run: $SCHEDULER jobs for $MACHINE_ID (nothing is installed)"
  case "$SCHEDULER" in
    cron) node "$UNITS" render cron ;;
    foreground) foreground_note; node "$UNITS" jobs ;;
    *)
      rendered="$(mktemp -d)"
      node "$UNITS" render "$SCHEDULER" "$rendered"
      for file in "$rendered"/*; do
        echo "# ---- $(basename "$file")"
        cat "$file"
      done
      rm -rf "$rendered" ;;
  esac
}

install_jobs() {
  if [[ "$OPTION" == "--dry-run" ]]; then dry_run; return 0; fi
  local installed rendered
  installed="$(node "$UNITS" jobs | wc -l | tr -d ' ')"
  (( installed )) || { echo "machine-roster.json entitles $MACHINE_ID to nothing" >&2; return 1; }
  if [[ -z "$OFFLINE" ]]; then
    check || { echo "Fix the ✗ items above, then rerun install." >&2; return 1; }
  fi
  mkdir -p "$LOG_DIR"
  # The machine roster is the only place that says which agent x queue loops
  # this host runs; schedulers/index.js enumerates it, one job per entitlement.
  rendered="$(mktemp -d)"
  case "$SCHEDULER" in
    launchd|systemd) node "$UNITS" render "$SCHEDULER" "$rendered" ;;
  esac
  case "$SCHEDULER" in
    launchd) launchd_install "$rendered" ;;
    systemd) systemd_install "$rendered" ;;
    cron) cron_install ;;
    foreground) foreground_note; rm -rf "$rendered"; return 0 ;;
  esac
  rm -rf "$rendered"
  # Reinstalling ended every running loop's process tree (launchctl bootout,
  # systemctl stop). Hand their items back now rather than waiting out four-hour
  # leases. launchd's RunAtLoad and the timers' OnActiveSec also make each job
  # fire within seconds and sweep before it counts work, which covers the case
  # where this script was itself ended mid-install.
  [[ -n "$OFFLINE" ]] || node "$SCRIPT_DIR/log-run.js" reap --machine "$MACHINE_ID" --stale-minutes 0 || true
  echo "$installed Project Admin loop jobs are scheduled with $SCHEDULER for $MACHINE_ID. Item owners select build models; the dashboard selects the shared deploy model."
  echo "Each job runs loop-wrapper.sh, which works in its own .agent-worktrees/loop-<queue>-<agent> checkout, never the primary one. Logs: $LOG_DIR"
}

status() {
  case "$SCHEDULER" in
    launchd) launchd_status ;;
    systemd) systemd_status ;;
    cron) cron_status ;;
    foreground) foreground_note ;;
  esac
}

uninstall_jobs() {
  case "$SCHEDULER" in
    launchd) launchd_uninstall ;;
    systemd) systemd_uninstall ;;
    cron) cron_uninstall ;;
    foreground) foreground_note; return 0 ;;
  esac
  echo "Removed every Project Admin loop job from $SCHEDULER."
}

case "$ACTION" in
  check) check ;;
  install) install_jobs ;;
  status) status ;;
  uninstall) uninstall_jobs ;;
  *) echo "Usage: $0 <check|install [--dry-run]|status|uninstall>" >&2; exit 2 ;;
esac
