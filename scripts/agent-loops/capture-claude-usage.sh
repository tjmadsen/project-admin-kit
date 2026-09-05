#!/usr/bin/env bash
# Probe Claude Code's shared weekly limit and persist a freshness-aware snapshot.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIRECTORY="$(node "$REPO_ROOT/scripts/project-env.js" value STATE_DIRECTORY 2>/dev/null || echo .project-admin)"
STAMP="${CLAUDE_USAGE_STAMP:-$HOME/$STATE_DIRECTORY/claude-usage-capture.stamp}"
LOCK_DIR="${CLAUDE_USAGE_LOCK_DIR:-${STAMP}.lock}"
INTERVAL="${CLAUDE_USAGE_INTERVAL:-1500}"
EXPECT_TIMEOUT="${CLAUDE_USAGE_TIMEOUT:-20}"
LOG_RUN="${CLAUDE_USAGE_LOG_RUN:-$SCRIPT_DIR/log-run.js}"
# Probe directory for the CLI. Resolve it from the PRIMARY checkout rather than
# from this script's own copy: scheduled fires run run-loop.sh out of
# .agent-worktrees/loop-<queue>-<token>, so "$SCRIPT_DIR/../../.." lands on
# .agent-worktrees itself, a folder Claude Code has never been trusted in. The
# CLI then opens the workspace-trust prompt and every scheduled capture fails
# with trust_prompt while the same script succeeds by hand from the primary
# checkout. --git-common-dir points at the primary .git from inside any
# worktree, so its grandparent is the same trusted dev root the primary
# checkout resolves to.
default_usage_workdir() {
  local common_git
  common_git="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_git" && -d "$common_git" ]]; then
    (cd "$common_git/../.." && pwd) && return 0
  fi
  (cd "$SCRIPT_DIR/../../.." && pwd)
}
USAGE_WORKDIR="${CLAUDE_USAGE_WORKDIR:-$(default_usage_workdir)}"
STAMP_TMP="${STAMP}.tmp.$$"
lock_held=0

release_lock() {
  rm -f "$STAMP_TMP" 2>/dev/null || true
  if (( lock_held )); then
    rm -f "$LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$(dirname "$STAMP")" 2>/dev/null || exit 1
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then exit 0; fi
  if [[ ! "$lock_pid" =~ ^[0-9]+$ ]]; then
    lock_mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || date +%s)"
    lock_now="$(date +%s)"
    if (( lock_now - lock_mtime <= EXPECT_TIMEOUT + 60 )); then exit 0; fi
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || exit 0
  mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
lock_held=1
printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || exit 1

now="$(date +%s)"
last=0
[[ -f "$STAMP" ]] && last="$(cat "$STAMP" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < INTERVAL )); then exit 0; fi

advance_debounce() {
  printf '%s\n' "$now" > "$STAMP_TMP" 2>/dev/null && mv "$STAMP_TMP" "$STAMP"
}

record_attempt() {
  node "$LOG_RUN" "$@" >/dev/null || return 1
  advance_debounce
}

BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
EXPECT_BIN="${CLAUDE_EXPECT_BIN:-$(command -v expect || true)}"
cli_version=""
[[ -x "$BIN" ]] && cli_version="$("$BIN" --version 2>/dev/null | head -1 | cut -c1-80 || true)"

mark_unavailable() {
  local reason="$1"
  local args=(usage-unavailable --provider claude --reason "$reason")
  [[ -n "$cli_version" ]] && args+=(--cli-version "$cli_version")
  record_attempt "${args[@]}"
}

[[ -z "$BIN" || ! -x "$BIN" ]] && { mark_unavailable cli_missing; exit $?; }
[[ -z "$EXPECT_BIN" || ! -x "$EXPECT_BIN" ]] && { mark_unavailable expect_missing; exit $?; }

out="$(cd "$USAGE_WORKDIR" && "$EXPECT_BIN" "$SCRIPT_DIR/capture-claude-usage.exp" "$BIN" "$EXPECT_TIMEOUT" 2>/dev/null)"
capture_status=$?
if (( capture_status != 0 )); then
  case "$capture_status" in
    10) reason="startup_timeout" ;;
    11) reason="startup_exit" ;;
    12) reason="trust_prompt" ;;
    20) reason="usage_timeout" ;;
    21) reason="usage_exit" ;;
    *) reason="pty_error" ;;
  esac
  mark_unavailable "$reason"
  exit $?
fi

diagnosis="$(printf '%s' "$out" | node "$SCRIPT_DIR/parse-claude-usage.js")"
parse_status=$?
if (( parse_status != 0 )); then
  reason="$(printf '%s' "$diagnosis" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).error || "parse_error"' 2>/dev/null || echo parse_error)"
  mark_unavailable "$reason"
  exit $?
fi

percent="$(printf '%s' "$diagnosis" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).usage.usedPercent')"
label="$(printf '%s' "$diagnosis" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).usage.resetsLabel || ""')"
args=(usage --provider claude --used-percent "$percent")
[[ -n "$label" ]] && args+=(--resets-label "$label")
[[ -n "$cli_version" ]] && args+=(--cli-version "$cli_version")
record_attempt "${args[@]}"
