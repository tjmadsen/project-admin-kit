#!/usr/bin/env bash
# Read the shared Codex plan's 7-day rate limit from the newest local session.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSIONS_DIR="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions/$(date +%Y)/$(date +%m)/$(date +%d)}"
LOG_RUN="${CODEX_USAGE_LOG_RUN:-$SCRIPT_DIR/log-run.js}"
[[ -d "$SESSIONS_DIR" ]] || exit 0

session_file="$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1)"
[[ -z "$session_file" || ! -f "$session_file" ]] && exit 0

line="$(grep -o '"rate_limits":{[^}]*"primary":{[^}]*}' "$session_file" | tail -1)"
[[ -z "$line" ]] && exit 0

used_percent="$(printf '%s' "$line" | grep -oE '"used_percent":[0-9.]+' | grep -oE '[0-9.]+')"
resets_epoch="$(printf '%s' "$line" | grep -oE '"resets_at":[0-9]+' | grep -oE '[0-9]+')"
[[ -z "$used_percent" ]] && exit 0

resets_iso=""
if [[ -n "$resets_epoch" ]]; then
  resets_iso="$(date -u -r "$resets_epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
fi

args=(usage --provider codex --used-percent "$used_percent")
[[ -n "$resets_iso" ]] && args+=(--resets-at "$resets_iso")
node "$LOG_RUN" "${args[@]}" >/dev/null 2>&1 || true
