#!/usr/bin/env bash
# Runner adapter for the Codex CLI. Contract: runners/README.md.
#   codex.sh check   locate the CLI (exit 1 with a message when missing)
#   codex.sh         exec one headless iteration
set -euo pipefail

codex_bin="$(command -v codex || true)"
# launchd's PATH rarely includes the desktop app's bundled CLI.
[[ -z "$codex_bin" && -x /Applications/Codex.app/Contents/Resources/codex ]] && codex_bin=/Applications/Codex.app/Contents/Resources/codex
[[ -n "$codex_bin" ]] || { echo "Codex CLI not found" >&2; exit 1; }
if [[ "${1:-}" == "check" ]]; then echo "$codex_bin"; exit 0; fi

# `-` reads the prompt from stdin (fed from the prompt file) so the CLI sees an
# immediate EOF instead of inheriting launchd's stdin and waiting on it forever.
# Codex has no PreToolUse hook, so headless-guard.py cannot run here; the
# configured sandbox mode is the only containment.
exec "$codex_bin" exec --sandbox "${PA_SANDBOX:-danger-full-access}" -m "$PA_MODEL" -c "model_reasoning_effort=$PA_EFFORT" -C "$PA_REPO_ROOT" - <"$PA_PROMPT_FILE"
