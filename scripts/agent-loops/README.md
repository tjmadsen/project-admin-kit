# Project Admin agent loops

The backlog lives in the store selected by `backend` in
`project-admin.config.json` (Firestore, a local JSON file, or GitHub Issues;
see [docs/BACKENDS.md](../../docs/BACKENDS.md)). Every agent shares the same queue protocol with
one selectable owner (`<token>-agent`) per configured model. The roster is the
top-level `agents` array in that file; without one, the built-in roster in
`scripts/lib/agent-defaults.json` applies:

| Token | Admin owner | Runner | Configured model | What runs |
|---|---|---|---|---|
| `sol` | `sol-agent` | `codex` | `gpt-5.6-sol` | newest `gpt-*-sol` |
| `terra` | `terra-agent` | `codex` | `gpt-5.6-terra` | newest `gpt-*-terra` |
| `luna` | `luna-agent` | `codex` | `gpt-5.6-luna` | newest `gpt-*-luna` |
| `opus` | `opus-agent` | `claude` | `opus` | `--model opus` (newest Opus) |
| `sonnet` | `sonnet-agent` | `claude` | `sonnet` | `--model sonnet` (newest Sonnet) |
| `fable` | `fable-agent` | `claude` | `fable` | `--model fable` (newest Fable) |
| `grok` | `grok-agent` | `grok` | `grok` | the Grok CLI's default model |

Each run uses the newest model in its tier and records the exact model ID on
its run record, which the admin console shows as a version ("Claude Opus 5.5",
"Codex Sol 6.1"). The runner adapter decides how (see
[runners/README.md](runners/README.md)): Codex has no "latest" alias, so its
`resolve` step asks `resolve-model.js` for the highest-versioned listed slug in
the configured model's tier from `codex debug models`, clamps the effort to that
model's menu, and falls back to the configured slug when the catalog cannot be
read. Claude's alias resolves at launch, and its `observe-model` step reads the
resolved ID from the session transcript. `CODEX_MODEL`/`CLAUDE_MODEL`, or
`"pinModel": true` on an agent, pin one exact model instead.

`agentAliases` maps shorthand tokens (`codex` → `terra`, `claude` → `sonnet`).
Opus (`claimsUnassigned: true`) also sweeps unassigned work. Every other model
claims only explicitly owned items. All agents respect `targetMachine`; this
installation uses `local-mac`. A host's machine id is `PROJECT_ADMIN_MACHINE_ID`
when set (every scheduler sets it), else the `machine-roster.json` entry whose
optional `hostnames` list names this host, else `automation.defaultMachineId`.

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

Scheduled fires go through the wrapper, which is what every scheduler invokes:

```bash
scripts/agent-loops/loop-wrapper.sh terra feature
scripts/agent-loops/loop-wrapper.sh sonnet bug
scripts/agent-loops/loop-wrapper.sh configured deploy
```

On macOS the wrapper re-execs once under `taskpolicy -a` (so
`ProcessType=Background` cannot pin the whole process tree to the E-cores). It
sources the optional `~/<stateDirectory>/loops.env` (for per-host secrets such
as a webhook URL or a container's CLI API keys), holds a single-instance lock
per `(project,queue,token)` under `~/.project-admin`, refreshes a dedicated
`.agent-worktrees/loop-<queue>-<token>` checkout of the product repository to the
configured default branch, links the gitignored `node_modules` installs, and
runs that checkout's `run-loop.sh` (an embedded kit's copy at
`<worktree>/<kit dir>`; a separate kit runs its own `run-loop.sh` with
`PROJECT_ADMIN_PRODUCT_ROOT` pointing at the worktree, see
[docs/LAYOUTS.md](../../docs/LAYOUTS.md)). The agent starts in the product
checkout with `PROJECT_ADMIN_KIT_ROOT` and `PROJECT_ADMIN_PRODUCT_ROOT` set, and
prompts substitute `{{KIT_ROOT}}`. No loop ever works in the shared primary
checkout.

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
(or `systemctl stop`, or the foreground scheduler's SIGTERM) ends a job's whole
process tree, and `provision-machine.sh install` does that to every loop job
including the one issuing the command, so the row stays
`running` with a frozen heartbeat and its item stays claimed until the
four-hour lease lapses. `log-run.js start` therefore records the runner pid, and
every iteration sweeps before it counts work:

```bash
node scripts/agent-loops/log-run.js reap --machine local-mac [--stale-minutes 2] [--dry-run]
```

`reap` closes each running row on that machine whose heartbeat is stale and
whose recorded runner pid is gone, marking it `interrupted` with exit 137 and a
duration frozen at the last heartbeat, and releases the item it claimed. A
paused or sleeping machine keeps its runner pid, so heartbeat age alone never costs
a live run its claim; rows written before pids were recorded are reported and
left alone. `install` sweeps after re-bootstrapping, and because every plist
sets `RunAtLoad` (and every timer `OnActiveSec`), the jobs it just ended sweep
themselves within seconds even when the install killed its own caller.

A run that dies on an expired or broken CLI session is recorded as exit 78 with
an explicit authentication reason, so the Agent Loops page shows it instead of
an apparently idle queue. The project owner gets one alert per thirty minutes
across every loop, debounced through a shared stamp in `~/.project-admin` and
sent through `notify.js` (see [Notifications](#notifications)).

Every poll also refreshes shared seven-day provider usage for the Agent Loops
dashboard through the agent's usage hook. Codex reads the newest local session
rate-limit snapshot. Claude uses a bounded `/usage` PTY probe that is serialized
and debounced to roughly once every 25 minutes. Grok does not expose equivalent
plan telemetry through its CLI, so the dashboard labels it as unavailable rather
than guessing; so does any agent with no hook. An agent can name its own
`usage` script (see runners/README.md).
The Claude probe runs from the repository's parent development directory; set
`CLAUDE_USAGE_WORKDIR` to another already-trusted directory when provisioning a
different machine.

## Provision a worktree

```bash
eval "$(node scripts/project-env.js shell)"
git -C "$PRODUCT_ROOT" worktree add "$PRODUCT_ROOT/.agent-worktrees/<agent>-fr-N" "origin/$DEFAULT_BRANCH" -b <agent>/fr-N
scripts/agent-loops/provision-worktree.sh "$PRODUCT_ROOT/.agent-worktrees/<agent>-fr-N"
```

`PRODUCT_ROOT` is the kit directory itself unless the kit is embedded in or
separate from the product repository ([docs/LAYOUTS.md](../../docs/LAYOUTS.md)).

A fresh checkout has none of the gitignored local state, so the backlog CLI and
every suite fail there until this runs. It symlinks `auth.env` and each
`node_modules` from the primary checkout, falls back to `npm ci` when a
package's lockfile differs, and resolves the Flutter package. It is idempotent,
so run it again when resuming a recorded branch; `--dry-run` prints the plan
without changing anything, and it refuses to target the shared primary checkout.

## Provision a runner

```bash
cd scripts && npm install && cd ..
scripts/agent-loops/provision-machine.sh check
scripts/agent-loops/provision-machine.sh install --dry-run   # preview the units
scripts/agent-loops/provision-machine.sh install
scripts/agent-loops/provision-machine.sh status
scripts/agent-loops/provision-machine.sh uninstall
```

`automation.scheduler` in `project-admin.config.json` picks how jobs run
(`PROJECT_ADMIN_SCHEDULER` overrides it for one command). Every scheduler gets
the same job set from `schedulers/index.js`, with templates beside it:

| Scheduler | Default on | What `install` does | Logs |
|---|---|---|---|
| `launchd` | macOS | one `~/Library/LaunchAgents/com.projectadmin.<slug>.loop.<agent>-<queue>.plist` per job, `RunAtLoad`, `StartInterval` | `~/Library/Logs/ProjectAdminAgentLoops` |
| `systemd` | Linux | one user `projectadmin-<slug>-loop-<agent>-<queue>.service` (oneshot) + `.timer` (`OnActiveSec` staggered, `OnUnitActiveSec` = interval) in `~/.config/systemd/user`, then `enable --now` | `~/.local/state/ProjectAdminAgentLoops` |
| `cron` | — | one marked `# BEGIN/END project-admin agent loops: <slug>` block in your crontab, replaced in place on every install; other lines are untouched | same as systemd |
| `foreground` | other platforms | nothing; run `npm run loops` (below) | same as systemd |

Every job name, lock, and log file (`<logDir>/<slug>-<agent>-<queue>.log`)
carries `project.slug`, so several projects can share one host; `install`,
`status`, and `uninstall` only touch the current project's jobs. `install`
removes the previous loop jobs first, so it is idempotent and drops jobs the
roster no longer entitles. On macOS it also unloads and deletes this checkout's
pre-namespacing `com.projectadmin.loop.*` plists, so an existing machine
migrates on its next install (legacy plists of other checkouts are left alone). User systemd timers stop at logout unless
you run `loginctl enable-linger $USER` (the `check` warns). cron is
minute-granular: sub-hour intervals that divide the hour are offset per job
(`2-59/5`), others round to `*/N`, and nothing fires at install time until the
first matching minute. `PROJECT_ADMIN_LOOP_LOG_DIR` overrides the log
directory. Per-run transcripts always go to the repo's ignored `.agent-logs/`.

`machine-roster.json` is the single source of truth for which host may run which
agent x queue loop, and `roster-check.js` makes it enforcing: `run-loop.sh`
exits 2 on any triple the roster omits, so a hand-copied or stale unit cannot
poll a queue this machine is no longer entitled to run. `install` enumerates the
same roster rather than repeating it, which in the sample roster is feature,
bug, and task pollers for all seven selectable models plus one deploy
dispatcher. Roster entries for tokens the config no longer defines entitle
nothing. `check` asks each entitled agent's runner adapter to locate its CLI and
flags unguarded agents. The dispatcher reads `system/agentLoopConfig` so a
dashboard model change takes effect on its next poll. Empty queues are cheap
no-ops. Build pollers fire every agent's `pollSeconds` (five minutes by
default, thirty for Grok), and the deploy dispatcher every fifteen minutes.

On Linux the loops need GNU coreutils `timeout`; `run-loop.sh` puts a
`gtimeout` alias on the agent's PATH because the runbooks use Homebrew's name.
TestFlight releases (the optional `extras/testflight/launch-testflight.sh`)
remain macOS-only.

## Run loops in the foreground

```bash
npm run loops                                  # every entitled loop, until Ctrl-C
npm run loops -- --dry-run                     # the job table
npm run loops -- --once                        # each loop once (CI smoke), exit 1 on failure
npm run loops -- --only sol-feature,configured-deploy --stagger 10
```

`scheduler.js` is the portable scheduler for Docker, CI, a dev shell, tmux, or
Windows through WSL. It runs the same job set through `loop-wrapper.sh`, starts
jobs `--stagger` seconds apart (default 5), and starts each job's next run one
interval after the previous run started (immediately if it ran longer), never
overlapping a job with itself. Each job holds `~/<stateDirectory>/scheduler/<slug>-<id>.lock`
while the scheduler runs, so two schedulers on one host never drive the same
loop; a lock whose pid is gone is taken over. SIGINT/SIGTERM stops scheduling,
sends SIGTERM to every running job's process group, escalates to SIGKILL after
`--grace` seconds (default 30), and releases the locks; a second signal kills at
once. Output goes to the same per-job log files as the other schedulers.

## Run loops in a container

`Dockerfile.loops` is a minimal starting point: Node 20, git, coreutils, the
Claude and Codex CLIs (`--build-arg AGENT_CLIS=...` to change), and
`scheduler.js` as the entry point. Mount the checkout rather than copying it,
add the container to the roster, and pass CLI and Google credentials in:

```json
{ "id": "container", "label": "Loop container", "agents": ["sonnet", "terra"], "queues": ["feature", "bug", "deploy"] }
```

```bash
docker build -f Dockerfile.loops -t project-admin-loops .
docker run -d --name project-admin-loops \
  -v "$PWD:/repo" \
  -v "$HOME/.config/gcloud:/home/node/.config/gcloud:ro" \
  -v "$HOME/.codex:/home/node/.codex" \
  -v "$HOME/.config/gh:/home/node/.config/gh:ro" \
  -e ANTHROPIC_API_KEY -e PROJECT_ADMIN_NOTIFY_WEBHOOK_URL \
  project-admin-loops
docker logs -f project-admin-loops
```

The image sets `PROJECT_ADMIN_MACHINE_ID=container`; change it per container.
Claude Code accepts `ANTHROPIC_API_KEY` (or a mounted `~/.claude`), Codex reads
`~/.codex/auth.json`, the backlog CLIs use Application Default Credentials from
the mounted gcloud directory (firestore backend; github reads `GITHUB_TOKEN`
or the mounted `gh` login), and `gh` handles PRs. Logs land under
`/home/node/.local/state` inside the container; mount a volume there to keep
them. `docker stop` sends SIGTERM, which the scheduler handles as above.

## Notifications

Loop alerts go through `notify.js`, configured by `notifications`:

```json
"notifications": {
  "desktop": true,
  "webhook": { "urlEnv": "PROJECT_ADMIN_NOTIFY_WEBHOOK_URL", "format": "json" }
}
```

- `desktop` (default `true`): `osascript` on macOS, `notify-send` on Linux when
  installed, otherwise skipped.
- `webhook`: POSTs to the URL in the named environment variable (default
  `PROJECT_ADMIN_NOTIFY_WEBHOOK_URL`); nothing is sent while it is unset. Keep the
  URL out of config and unit files: put it in `~/<stateDirectory>/loops.env`,
  which the wrapper sources. `format` is `json` (`{title, message, level}`, for
  your own receiver), `slack`, or `ntfy`.

```bash
# ~/.project-admin/loops.env
PROJECT_ADMIN_NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX  # format: "slack"
# PROJECT_ADMIN_NOTIFY_WEBHOOK_URL=https://ntfy.sh/my-private-loop-topic         # format: "ntfy"
```

For Slack, create an incoming webhook for a channel; for ntfy, subscribe to a
hard-to-guess topic in the ntfy app (or your own server). Test the channels with:

```bash
node scripts/agent-loops/notify.js --level warning --title "Loop test" --message "Hello from $(hostname)"
```

A channel failure is printed but never fails a loop. `PROJECT_ADMIN_LOOP_NOTIFIER`
replaces `notify.js` with any command that takes the same `--title`,
`--message`, and `--level` arguments.

## Backlog CLI

All state changes go through `scripts/work-agent.js`, which serves every kind
configured in `project-admin.config.json#workKinds` (`--kind <id>`, or
`PROJECT_ADMIN_WORK_KIND`). `feature-agent.js` and `bug-agent.js` are shims
scoped to those two kinds. Item commands (`show`, `reply`, `pr`, `deploy-check`,
...) read the kind from the document, and `deploy-next` without `--kind` spans
every kind with `deploys: true`. `node scripts/lib/work-kinds.js queues` prints
the valid loop queue names.

```bash
node scripts/work-agent.js --kind task next --as terra
node scripts/work-agent.js deploy-next --as sonnet
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
