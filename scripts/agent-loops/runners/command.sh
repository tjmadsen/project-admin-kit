#!/usr/bin/env bash
# Generic runner adapter: execs the agent's configured `command` template, so a
# new CLI (Gemini, opencode, aider, a local model) needs only config. Contract
# and placeholders: runners/README.md.
#   command.sh check   locate the template's executable
#   command.sh         exec one headless iteration
set -euo pipefail

HELPER="$(cd "$(dirname "$0")/../../lib" && pwd)/agents.js"
mode="${1:-run}"
# A generic CLI launches exactly the configured model and reports nothing more.
if [[ "$mode" == "resolve" ]]; then printf '%s\t%s\n' "$PA_MODEL" "$PA_EFFORT"; exit 0; fi
[[ "$mode" == "observe-model" ]] && exit 0
render=(render-command)
[[ "$mode" == "check" ]] && render+=(--check)
argv=()
# NUL-delimited so a multi-line {{prompt}} stays a single argument.
while IFS= read -r -d '' part; do argv+=("$part"); done < <(node "$HELPER" "${render[@]}")
(( ${#argv[@]} )) || { echo "command runner: could not render the configured command" >&2; exit 1; }

bin="$(command -v "${argv[0]}" || true)"
[[ -n "$bin" ]] || { echo "${argv[0]} not found on PATH" >&2; exit 1; }
if [[ "$mode" == "check" ]]; then echo "$bin"; exit 0; fi

# This runner cannot attach headless-guard.py: generic CLIs expose no common
# pre-tool hook. Any containment must come from the CLI's own flags.
if [[ "${PA_PROMPT_VIA:-arg}" == "stdin" ]]; then
  exec "${argv[@]}" <"$PA_PROMPT_FILE"
fi
exec "${argv[@]}"
