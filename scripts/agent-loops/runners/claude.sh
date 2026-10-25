#!/usr/bin/env bash
# Runner adapter for Claude Code print mode. Contract: runners/README.md.
#   claude.sh check   locate the CLI (exit 1 with a message when missing)
#   claude.sh         exec one headless iteration
set -euo pipefail

claude_bin="$(command -v claude || true)"
# The native installer puts the CLI in ~/.local/bin, which launchd's PATH omits.
[[ -z "$claude_bin" && -x "$HOME/.local/bin/claude" ]] && claude_bin="$HOME/.local/bin/claude"
[[ -n "$claude_bin" ]] || { echo "Claude CLI not found" >&2; exit 1; }
if [[ "${1:-}" == "check" ]]; then echo "$claude_bin"; exit 0; fi
# The alias (`opus`) resolves to the newest model at launch, and only the
# session transcript names it: resolve leaves the model empty and run-loop.sh
# polls observe-model, which reads the transcript for PA_SESSION_ID.
if [[ "${1:-}" == "resolve" ]]; then printf '\t%s\n' "$PA_EFFORT"; exit 0; fi
if [[ "${1:-}" == "observe-model" ]]; then
  exec node "$(dirname "$0")/../resolve-model.js" claude-session "${PA_SESSION_ID:-}"
fi

# --dangerously-skip-permissions leaves no human to approve anything, so the
# PreToolUse hook below is the seatbelt that blocks catastrophic shell commands.
guard="${PA_HEADLESS_GUARD:-$(cd "$(dirname "$0")/.." && pwd)/headless-guard.py}"
settings="{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"python3 $guard\"}]}]}}"
# run-loop.sh picks the per-queue background-wait ceiling (deploy waits longer).
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${PA_BG_WAIT_CEILING_MS:-0}"
# The prompt stays a positional argument; run-loop.sh already points stdin at
# /dev/null rather than launchd's inherited descriptor.
exec "$claude_bin" -p --model "$PA_MODEL" --effort "$PA_EFFORT" --dangerously-skip-permissions --settings "$settings" ${PA_SESSION_ID:+--session-id "$PA_SESSION_ID"} "$(cat "$PA_PROMPT_FILE")"
