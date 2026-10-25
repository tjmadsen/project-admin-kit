# Runner adapters

`run-loop.sh` never builds a CLI command line itself. It resolves the agent
from the configured roster (`node scripts/lib/agents.js resolve <token>`), then
runs `runners/<runner>.sh` for that agent's `runner`. Adding a CLI means adding
one adapter here, or using the generic `command` runner with no code at all.

| Adapter | CLI | Prompt | headless-guard.py |
|---|---|---|---|
| `claude.sh` | Claude Code `-p` | argument | **enforced** (PreToolUse hook) |
| `codex.sh` | `codex exec` | stdin (`-`) | not available; `sandbox` is the only containment |
| `grok.sh` | `grok -p` | argument | not available |
| `command.sh` | the agent's `command` template | `{{prompt}}`, `{{prompt_file}}`, or stdin | not available |

An agent is `guarded` only when its adapter actually wires the guard into the
CLI. Unguarded agents get a warning line from `run-loop.sh` at start, a `⚠` line
from `provision-machine.sh check`, and an "unguarded" badge on the Agent Loops
page. Do not mark a runner guarded unless its CLI really runs the hook.

## Contract

Two required invocations and two optional ones:

- `<adapter> check` locates the CLI (with the same fallbacks the run uses),
  prints its path, and exits 0; or prints a reason on stderr and exits non-zero.
  `run-loop.sh` calls it before creating a run record, so a missing CLI fails
  fast exactly as it did before adapters existed. `provision-machine.sh` sets
  `PA_CHECK_DEEP=1` to request a slower readiness probe (Grok runs `--version`).
- `<adapter>` with no argument runs one iteration and must `exec` the CLI, so
  the outer `timeout` signals the CLI directly and its exit code is the run's.
- `<adapter> resolve` prints `<model>\t<effort>`: the exact model and effort
  to launch. Loops run the newest model in a tier rather than a pinned
  version, so Codex picks the highest-versioned listed `gpt-<version>-<tier>`
  slug (`resolve-model.js`) and clamps the effort to that model's menu, and
  Grok reports its CLI default. An empty model means the CLI only reveals it
  after launch; `PA_MODEL_PINNED=1` (an env override or `pinModel`) means
  launch `PA_MODEL` as is. No output keeps the configured values.
- `<adapter> observe-model` prints the model a running or finished session
  actually used, or nothing yet. `run-loop.sh` polls it every 15 seconds,
  only for runners with `observesModel` in `scripts/lib/agent-defaults.json`
  (Claude, which reads the transcript for `PA_SESSION_ID`), until it answers.
  Either way the run record ends up with the exact model ID.

`run-loop.sh` owns everything around the CLI: the outer `timeout --signal=TERM
--kill-after=30s` wall, stdin (always `/dev/null`, never launchd's inherited
descriptor), the log tee, heartbeats, classification, and usage capture. The
adapter's stdout and stderr go straight to the run log.

Environment passed to every adapter:

| Variable | Meaning |
|---|---|
| `PA_AGENT`, `PA_QUEUE`, `PA_RUNNER` | canonical agent token, queue (a work kind or `deploy`), runner name |
| `PA_MODEL` | the model to launch: `resolve`'s answer, else the configured `model` after the runner's env override (`CODEX_MODEL`, `CLAUDE_MODEL`) |
| `PA_EFFORT` | item thinking effort, after the runner's env override (`CODEX_EFFORT`, `CLAUDE_EFFORT`, `GROK_EFFORT`) and `resolve`'s clamp; this is also what the run record shows |
| `PA_PROMPT_FILE` | the rendered prompt (`{{AGENT}}` substituted) under `.agent-logs/`; removed after the run |
| `PA_REPO_ROOT` | the loop checkout of the product repository to work in (`PRODUCT_ROOT`, docs/LAYOUTS.md) |
| `PA_SANDBOX` | Codex `--sandbox` mode (empty for other runners) |
| `PA_HEADLESS_GUARD` | absolute path to `headless-guard.py` |
| `PA_BG_WAIT_CEILING_MS` | Claude print-mode background-wait ceiling for this queue |
| `PA_TIMEOUT_SECONDS` | the outer wall, for CLIs that accept their own budget |
| `PA_COMMAND_JSON`, `PA_PROMPT_VIA` | `command` runner template and prompt delivery |
| `PA_SESSION_ID` | a fresh UUID per run; Claude passes it as `--session-id` so `observe-model` can find the transcript |

A CLI that reads its prompt from stdin must redirect it from `PA_PROMPT_FILE`
inside the adapter (`exec cli ... - <"$PA_PROMPT_FILE"`); one that takes it as
an argument uses `"$(cat "$PA_PROMPT_FILE")"`. Either way the CLI sees an
immediate EOF on stdin instead of hanging on launchd's descriptor.

## The `command` runner

`command` is an argv template. Each element stays exactly one argument (no shell
parsing), and placeholders may appear inside a larger element:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | prompt text, trailing newlines removed |
| `{{prompt_file}}` | path to the prompt file |
| `{{model}}` | `PA_MODEL` |
| `{{effort}}` | `PA_EFFORT` |
| `{{repo}}` | `PA_REPO_ROOT` |

`promptVia` is `"arg"` (default; the template must contain `{{prompt}}` or
`{{prompt_file}}`) or `"stdin"` (the prompt file is fed on stdin). The first
element is the executable and is looked up on the loop's `PATH`.

Example agents for `project-admin.config.json` `agents` (adjust flags to the
CLI version you install; the kit does not ship these as active agents):

```jsonc
// Gemini CLI, non-interactive, auto-approving tool calls.
{ "token": "gemini", "label": "Gemini Pro", "short": "Gemini", "emoji": "✦",
  "runner": "command", "model": "gemini-2.5-pro",
  "command": ["gemini", "--model", "{{model}}", "--yolo", "--prompt", "{{prompt}}"] }

// A CLI that reads the task from stdin.
{ "token": "local", "label": "Local model", "runner": "command", "model": "qwen-coder",
  "command": ["my-agent", "--model", "{{model}}", "--cwd", "{{repo}}"], "promptVia": "stdin" }
```

These agents run unguarded. Prefer CLIs and flags that confine writes to the
repository, and add each token to `machine-roster.json` before provisioning.

## Usage capture

After each poll `run-loop.sh` runs the agent's usage hook, if it has one: the
runner default (`claude` and `codex` providers) or the agent's own
`usage: { "provider": "...", "script": "relative/or/absolute.sh" }`. `usage:
false` disables it. The script runs with `PA_USAGE_PROVIDER` set and records
through `node scripts/agent-loops/log-run.js usage --provider <provider>
--used-percent N`. `PROJECT_ADMIN_<PROVIDER>_USAGE_CAPTURE` overrides the script
path (for example `PROJECT_ADMIN_CODEX_USAGE_CAPTURE`).
