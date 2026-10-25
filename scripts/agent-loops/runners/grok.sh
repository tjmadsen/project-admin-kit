#!/usr/bin/env bash
# Runner adapter for the Grok CLI in print mode. Contract: runners/README.md.
#   grok.sh check   locate the CLI; with PA_CHECK_DEEP=1 also prove it is initialized
#   grok.sh         exec one headless iteration
set -euo pipefail

grok_bin="$(command -v grok || true)"
[[ -n "$grok_bin" ]] || { echo "Grok CLI not found" >&2; exit 1; }
if [[ "${1:-}" == "check" ]]; then
  if [[ "${PA_CHECK_DEEP:-0}" == "1" ]] && ! "$grok_bin" --version >/dev/null 2>&1; then
    echo "Grok CLI not initialized" >&2
    exit 1
  fi
  echo "$grok_bin"
  exit 0
fi
# Grok runs its CLI default; record which model that is.
if [[ "${1:-}" == "resolve" ]]; then
  printf '%s\t%s\n' "$(node "$(dirname "$0")/../resolve-model.js" grok "$grok_bin" || true)" "$PA_EFFORT"
  exit 0
fi
[[ "${1:-}" == "observe-model" ]] && exit 0

# The Grok CLI picks its own model, so PA_MODEL is informational here. It has no
# PreToolUse hook, so headless-guard.py cannot run.
exec "$grok_bin" -p --reasoning-effort "$PA_EFFORT" "$(cat "$PA_PROMPT_FILE")"
