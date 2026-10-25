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
# Codex has no "latest" alias: run the newest listed slug in the configured
# model's tier (gpt-6.1-sol over gpt-5.6-sol) and clamp the effort to that
# model's menu. A pinned model, or one outside the gpt-<version>-<tier> shape,
# launches as configured.
if [[ "${1:-}" == "resolve" ]]; then
  tier="$(sed -nE 's/^gpt-[0-9]+(\.[0-9]+)*-([a-z]+)$/\2/p' <<<"$PA_MODEL")"
  if [[ "${PA_MODEL_PINNED:-0}" == "1" || -z "$tier" ]]; then printf '%s\t%s\n' "$PA_MODEL" "$PA_EFFORT"; exit 0; fi
  node "$(dirname "$0")/../resolve-model.js" codex "$tier" "$codex_bin" "$PA_MODEL" "$PA_EFFORT" || printf '%s\t%s\n' "$PA_MODEL" "$PA_EFFORT"
  exit 0
fi
[[ "${1:-}" == "observe-model" ]] && exit 0

# `-` reads the prompt from stdin (fed from the prompt file) so the CLI sees an
# immediate EOF instead of inheriting launchd's stdin and waiting on it forever.
# Codex has no PreToolUse hook, so headless-guard.py cannot run here; the
# configured sandbox mode is the only containment.
exec "$codex_bin" exec --sandbox "${PA_SANDBOX:-danger-full-access}" -m "$PA_MODEL" -c "model_reasoning_effort=$PA_EFFORT" -C "$PA_REPO_ROOT" - <"$PA_PROMPT_FILE"
