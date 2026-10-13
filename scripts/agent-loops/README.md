# Project Admin agent loops

The admin backlog is stored in the Firebase project selected by
`project-admin.config.json`. Every agent shares the same queue protocol with
one selectable owner (`<token>-agent`) per configured model. The roster is the
top-level `agents` array in that file; without one, the built-in roster in
`scripts/lib/agent-defaults.json` applies:

| Token | Admin owner | Runner | Model |
|---|---|---|---|
| `sol` | `sol-agent` | `codex` | `gpt-5.6-sol` |
| `terra` | `terra-agent` | `codex` | `gpt-5.6-terra` |
| `luna` | `luna-agent` | `codex` | `gpt-5.6-luna` |
| `opus` | `opus-agent` | `claude` | `opus` |
| `sonnet` | `sonnet-agent` | `claude` | `sonnet` |
| `fable` | `fable-agent` | `claude` | `fable` |
| `grok` | `grok-agent` | `grok` | print mode |

`agentAliases` maps shorthand tokens (`codex` → `terra`, `claude` → `sonnet`).
Opus (`claimsUnassigned: true`) also sweeps unassigned work. Every other model
claims only explicitly owned items. All agents respect `targetMachine`; this
installation uses `local-mac`.

Each entry is `{ token, label, short?, emoji?, runner, model,
claimsUnassigned?, pollSeconds?, sandbox?, usage? }` (plus `command` and
`promptVia` for the `command` runner). The config loader rejects duplicate or
malformed tokens, unknown runners or keys, and an
`automation.defaultWorkAgent`/`defaultDeployAgent` that is not configured.
`node scripts/lib/agents.js tokens` lists the roster; `resolve <token>` prints
what the loop will run.

Runners are adapters under `runners/` with one documented contract; see
[runners/README.md](runners/README.md), including how to add Gemini CLI or any
other CLI through the generic `command` runner. Only the Claude runner enforces
`headless-guard.py`. Codex runs with `--sandbox danger-full-access` unless an
agent sets `sandbox` (`read-only`, `workspace-write`); unguarded agents are
flagged when the loop starts and on the Agent Loops page.

## Run once

Scheduled fires go through the wrapper, which is what `launchd` invokes:

```bash
scripts/agent-loops/loop-wrapper.sh terra feature
scripts/agent-loops/loop-wrapper.sh sonnet bug
scripts/agent-loops/loop-wrapper.sh configured deploy
```

The wrapper re-execs once under `taskpolicy -a` (so `ProcessType=Background`
cannot pin the whole process tree to the E-cores), holds a single-instance lock
per `(queue,token)` under `~/.project-admin`, refreshes a dedicated
`.agent-worktrees/loop-<queue>-<token>` checkout to the configured default branch, links the
gitignored `node_modules` installs, and runs that checkout's `run-loop.sh`. No
loop ever works in the shared primary checkout.

To drive one iteration by hand, call the runner directly:

```bash
scripts/agent-loops/run-loop.sh terra feature --once
```

Each iteration launches a new headless process, creates an `agentLoopRuns`
record, heartbeats while working, and claims at most one build item. Deploy
iterations drain the explicitly approved deploy queue. The runner also records
the actual thinking effort used and publishes the latest 4 KB of captured output
as a progress snapshot every fifteen minutes. The Agent Loops page shows that
snapshot without adding noisy heartbeat messages to the work-item thread. Set
`PROJECT_ADMIN_LOOP_PROGRESS_SECONDS` to a positive integer to change the snapshot cadence.

The outer worker ceiling is four hours for the build queues and six hours for
deploy (`PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS` overrides either). Claude's print-mode
background wait has no separate ceiling on the build queues, so long simulator
runs remain attached to the worker and are still bounded by that outer limit;
deploy raises it to ninety minutes (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`)
because the default terminated the agent mid-deploy, orphaning the deploy and
leaving the item unshipped. Simulator and integration commands should set their
own limit of at most one hour. If a worker times out, is killed, or emits
Claude's background-task termination marker despite exit code 0, the run is
recorded as failed and its claim is released immediately. Any isolated worktree
is preserved for the next same-model pass to resume.

A run that ends by signal never reaches that path at all. `launchctl bootout`
ends a job's whole process tree, and `provision-machine.sh install` runs it over
every loop label including the one issuing the command, so the row stays
`running` with a frozen heartbeat and its item stays claimed until the
four-hour lease lapses. `log-run.js start` therefore records the runner pid, and
every iteration sweeps before it counts work:

```bash
node scripts/agent-loops/log-run.js reap --machine local-mac [--stale-minutes 2] [--dry-run]
```

`reap` closes each running row on that machine whose heartbeat is stale and
whose recorded runner pid is gone, marking it `interrupted` with exit 137 and a
duration frozen at the last heartbeat, and releases the item it claimed. A
paused or sleeping Mac keeps its runner pid, so heartbeat age alone never costs
a live run its claim; rows written before pids were recorded are reported and
left alone. `install` sweeps after re-bootstrapping, and because every plist
sets `RunAtLoad`, the jobs it just ended sweep themselves within seconds even
when the install killed its own caller.

A run that dies on an expired or broken CLI session is recorded as exit 78 with
an explicit authentication reason, so the Agent Loops page shows it instead of
an apparently idle queue. the project owner gets one macOS notification per thirty minutes
across every loop, debounced through a shared stamp in `~/.project-admin`.

Every poll also refreshes shared seven-day provider usage for the Agent Loops
dashboard through the agent's usage hook. Codex reads the newest local session
rate-limit snapshot. Claude uses a bounded `/usage` PTY probe that is serialized
and debounced to roughly once every 25 minutes. Grok does not expose equivalent
plan telemetry through its CLI, so the dashboard labels it as unavailable rather
than guessing; so does any agent with no hook. An agent can name its own
`usage` script (see runners/README.md).
The Claude probe runs from the repository's parent development directory; set
`CLAUDE_USAGE_WORKDIR` to another already-trusted directory when provisioning a
different Mac.

## Provision a worktree

```bash
git worktree add .agent-worktrees/<agent>-fr-N "origin/$DEFAULT_BRANCH" -b <agent>/fr-N
scripts/agent-loops/provision-worktree.sh .agent-worktrees/<agent>-fr-N
```

A fresh checkout has none of the gitignored local state, so the backlog CLI and
every suite fail there until this runs. It symlinks `auth.env` and each
`node_modules` from the primary checkout, falls back to `npm ci` when a
package's lockfile differs, and resolves the Flutter package. It is idempotent,
so run it again when resuming a recorded branch; `--dry-run` prints the plan
without changing anything, and it refuses to target the shared primary checkout.

## Provision a macOS runner

```bash
cd scripts && npm install && cd ..
scripts/agent-loops/provision-machine.sh check
scripts/agent-loops/provision-machine.sh install
scripts/agent-loops/provision-machine.sh status
```

`machine-roster.json` is the single source of truth for which host may run which
agent x queue loop, and `roster-check.js` makes it enforcing: `run-loop.sh`
exits 2 on any triple the roster omits, so a hand-copied or stale plist cannot
poll a queue this machine is no longer entitled to run. `install` enumerates the
same roster (`roster-check.js --list <machine>`) rather than repeating it, which
in the sample roster is feature and bug pollers for all seven selectable models
plus one deploy dispatcher. Roster entries for tokens the config no longer
defines entitle nothing. `check` asks each entitled agent's runner adapter to
locate its CLI and flags unguarded agents. The dispatcher reads `system/agentLoopConfig` so a
dashboard model change takes effect on its next poll. Empty queues are cheap
no-ops. Feature and bug pollers fire every agent's `pollSeconds` (five minutes
by default, thirty for Grok), and the deploy dispatcher every fifteen minutes. Logs go
to `~/Library/Logs/ProjectAdminAgentLoops`; per-run transcripts go to the repo's
ignored `.agent-logs/` directory.

## Backlog CLI

All state changes go through the wrappers:

```bash
node scripts/feature-agent.js list --as terra
node scripts/feature-agent.js next --as terra
node scripts/feature-agent.js ask <id> --as terra -m "Question for the project owner"
node scripts/bug-agent.js plan <id> --as sonnet -m "Root cause and repair plan"
node scripts/feature-agent.js close-no-deploy <id> --as fable -m "Audit delivered in the thread; nothing to release"
node scripts/bug-agent.js deploy-pending <id> --as sonnet --targets firebase_hosting --notes $'Scope: Admin bundle\nCommands: Build admin and deploy Hosting\nVerification: Load the changed production admin route\nAcceptance: Reproduce the reported workflow successfully in production' -m "Ready for approval"
```

The admin UI is the human surface for creating, assigning, discussing, and
moving items into the deploy queue. `close-no-deploy` marks an item shipped or
closed with a resolution note but no deployment timestamps; it refuses when a
release scope is planned, approved, queued, or in flight. The admin console has
the matching "Mark done (no deployment)" action.
