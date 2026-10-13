# Extending the kit

Most extensions are configuration plus a markdown runbook; a few need code.

| To add | Needs code? | Touches |
|---|---|---|
| [An agent on a supported CLI](#add-an-agent) | no | `agents`, `machine-roster.json` |
| [An agent on any other CLI](#add-an-agent) | no | `agents` (`command` runner) |
| [A runner adapter](#add-a-runner-adapter) | a shell script | `runners/<name>.sh`, `agent-defaults.json`, schema |
| [A work kind](#add-a-work-kind) | no | `workKinds`, a runbook, a prompt shim, generated rules |
| [A deploy target](#add-a-deploy-target) | no | `deployments.targets`, a runbook |
| [A backend](#add-a-backend) | yes | `scripts/lib/store/`, the console adapter, contract tests |
| [A scheduler](#add-a-scheduler) | yes | `automation.js`, `schedulers/`, `provision-machine.sh` |

Paths are relative to the kit directory. After any change, run the suites in
[CONTRIBUTING.md](../CONTRIBUTING.md#test-matrix).

## Add an agent

An agent is one entry in the top-level `agents` array of
`project-admin.config.json` (the field reference is in
[scripts/agent-loops/README.md](../scripts/agent-loops/README.md)). Defining
`agents` replaces the built-in roster, so list every agent you want.

**On a built-in runner** (`claude`, `codex`, `grok`), set `runner` and `model`:

```jsonc
{ "token": "haiku", "label": "Claude Haiku", "short": "Haiku", "runner": "claude", "model": "haiku" }
{ "token": "codex-ws", "label": "Codex (workspace)", "runner": "codex", "model": "gpt-5.6-terra", "sandbox": "workspace-write" }
```

**On any other CLI**, use the `command` runner: an argv template whose
placeholders (`{{prompt}}`, `{{prompt_file}}`, `{{model}}`, `{{effort}}`,
`{{repo}}`) are filled per run, with `promptVia: "stdin"` for CLIs that read the
task from standard input. The CLI must run non-interactively, approve its own
tool calls, run shell commands (the runbooks drive `git`, `gh`, and the backlog
CLI), and exit when done. Check each CLI's current flags; these are starting
points:

```jsonc
// Gemini CLI
{ "token": "gemini", "label": "Gemini Pro", "runner": "command", "model": "gemini-2.5-pro",
  "command": ["gemini", "--model", "{{model}}", "--yolo", "--prompt", "{{prompt}}"] }

// opencode (allow bash and edits without prompting in its permission config)
{ "token": "opencode", "label": "opencode", "runner": "command", "model": "anthropic/claude-sonnet-4-5",
  "command": ["opencode", "run", "--model", "{{model}}", "{{prompt}}"] }

// aider (an editor first: confirm it runs the runbook's shell commands with --yes-always)
{ "token": "aider", "label": "aider", "runner": "command", "model": "sonnet",
  "command": ["aider", "--model", "{{model}}", "--yes-always", "--message-file", "{{prompt_file}}"] }
```

Then:

1. Add the token to the `agents` list of each machine that should run it in
   `scripts/agent-loops/machine-roster.json` (with the queues it may poll).
2. `node scripts/lib/agents.js tokens` lists the roster;
   `node scripts/lib/agents.js resolve <token>` shows what the loop will run.
3. `scripts/agent-loops/provision-machine.sh check` locates the CLI and flags
   the agent as unguarded; `install` (or `npm run loops`) schedules it.
4. Rebuild the console (`npm run build`) so its model pickers list the agent.

`command` agents never run `headless-guard.py`; read [SECURITY.md](../SECURITY.md).

## Add a runner adapter

Write an adapter when a CLI needs more than an argv template: a guard hook, a
sandbox flag, an environment override, or a usage probe.

1. Create `scripts/agent-loops/runners/<name>.sh` (executable) implementing the
   contract in [runners/README.md](../scripts/agent-loops/runners/README.md):
   `<name>.sh check` prints the CLI path or exits non-zero; with no argument it
   `exec`s one iteration using the `PA_*` environment, reading the prompt from
   `PA_PROMPT_FILE` and never from inherited stdin. `claude.sh` (guarded) and
   `codex.sh` (sandboxed) are the models to copy.
2. Register it under `runners` in `scripts/lib/agent-defaults.json`: `label`,
   `guarded` (`true` only if the adapter really wires
   `scripts/agent-loops/headless-guard.py` into the CLI's tool-call hook),
   optional `modelEnv` / `effortEnv` override variables, `sandboxes` and
   `defaultSandbox` if the CLI has a sandbox flag, and `usage`
   (`{ "provider", "script" }`) if it can report plan usage.
3. Add the name to the `runner` enum in `project-admin.config.schema.json`.
4. Add tests beside the existing ones in `scripts/test/agents.test.js`, then
   reference the runner from an agent entry as above.

## Add a work kind

1. Add the kind to `workKinds` in `project-admin.config.json` (fields in
   [ARCHITECTURE.md](ARCHITECTURE.md#work-kinds)):

   ```jsonc
   "incident": {
     "label": "Incident", "pluralLabel": "Incidents", "prefix": "INC", "route": "incidents",
     "planReview": true, "deploys": true, "runbook": ".claude/commands/incident-loop.md",
     "statuses": { "initial": "open", "done": "closed", "declined": "wont_fix" },
     "icon": "bug", "tone": "violet"
   }
   ```

2. Write the canonical runbook at the path you named, starting from the closest
   existing one (`.claude/commands/bug-loop.md` for a plan-reviewed kind,
   `task-loop.md` for one that never deploys). Keep the layout pre-flight, the
   headless-channel rules, and the worktree steps; `scripts/test/prompt-lint.test.js`
   checks them.
3. Add the prompt shim `scripts/agent-loops/<id>-loop-prompt.md`, modeled on
   `scripts/agent-loops/bug-loop-prompt.md`, pointing at
   `{{KIT_ROOT}}/<runbook>`.
4. Run `npm run sync:work-kinds` to regenerate the kind blocks in
   `firestore.rules`, `storage.rules`, and the extras' configs;
   `node scripts/lib/work-kinds.js check` must be silent afterwards.
5. Add the queue (`node scripts/lib/work-kinds.js queues` lists valid names) to
   each machine's `queues` in `machine-roster.json`.
6. Run the test matrix including `npm run test:rules`, rebuild the console,
   and on firestore deploy the rules
   (`firebase deploy --only firestore:rules,storage --project <id>`) and the
   console. Reinstall the scheduler units so the new queue is polled.

Run `npm run bootstrap-admin` again to create the kind's counter; it adds
missing counters and never resets existing ones. On github, the kind's label
(`pa:kind:<id>`) is created on first use.

## Add a deploy target

1. Write a runbook in `docs/deploy-targets/<id>.md` modeled on
   [deploy-targets/examples/fly.md](deploy-targets/examples/fly.md). It must
   open with ``# Target: `<id>` `` and name preconditions, a `gtimeout`-bounded
   bash block, the live proof to record, and known failures (prompt lint
   enforces all four).
2. Add it to `deployments.targets`:

   ```json
   "fly": { "label": "Fly.io", "runbook": "docs/deploy-targets/fly.md" }
   ```

   Add `"requiresHumanAcceptance": true` when a person must accept the release
   after the proof (as TestFlight does).
3. `node scripts/lib/deploy-targets.js check` must exit 0;
   `node scripts/lib/deploy-targets.js show <id>` prints what the deploy loop
   will read. Rebuild the console so the target picker offers it.

The deploy loop and `.claude/commands/deploy-loop.md` need no change: they read
each approved target's runbook from configuration.

## Add a backend

A backend is a `BacklogStore` for the CLIs and loops plus, if it has a
dashboard, a data adapter for the console.

1. Implement the interface documented at the top of
   `scripts/lib/store/index.js` in `scripts/lib/store/<name>-store.js`: item
   create/get/getMany/list/update, `transact` and `claim` (say in comments how
   concurrent claims are arbitrated), runs, machines, system documents, users,
   and attachments, with `backend` and `capabilities`. `local-store.js` is the
   smallest complete example; `values.js` has the timestamp and merge helpers.
2. Wire it up: add the type to `BACKEND_TYPES` and its options to
   `resolveBackend` in `scripts/lib/project-config.js`, open it in `openStore`
   in `scripts/lib/store/index.js`, add a branch to the `backend` `oneOf` in
   `project-admin.config.schema.json`, and accept it in
   `scripts/configure.js --backend`.
3. Satisfy the contract: add a factory to `BACKENDS` in
   `scripts/test/store-contract.test.js`. Every scenario there (numbering and
   threads, concurrent claims with exactly one winner, the plan gate, message
   order, the full deploy flow with an approved target set and evidence,
   confirmation handback, telemetry) must pass, with the human gates acted out
   the way your backend's people perform them.
4. Console: add an adapter in `admin-app/src/data/` implementing `DataAdapter`
   (`admin-app/src/data/types.ts`; `local.ts` is the reference), load it in
   `loadAdapter` in `admin-app/src/data/index.ts`, and add the type to the list
   in `admin-app/vite.config.ts`. A backend without a dashboard can reuse the
   github path, which renders a pointer page.
5. Document setup, security model, and limits in [BACKENDS.md](BACKENDS.md).

## Add a scheduler

First consider the `foreground` scheduler: `npm run loops` runs the whole job
set under any process supervisor (a container runtime, pm2, a Windows service
via WSL) with no new code. A native scheduler needs:

1. The name in `SCHEDULERS` in `scripts/lib/automation.js` (and in
   `defaultScheduler` there if it should be a platform default), and in the `automation.scheduler` enum
   in `project-admin.config.schema.json`.
2. A renderer and template in `scripts/agent-loops/schedulers/` that turns
   `loopJobs()` into units. Every job runs `loop-wrapper.sh <agent> <queue>`
   with `PROJECT_ADMIN_MACHINE_ID` set, at its interval, never overlapping
   itself, and every unit name carries `project.slug`. Rendering must not touch
   the system so `install --dry-run` can preview it.
3. `<name>_install`, `<name>_uninstall`, and `<name>_status` functions plus a
   binary check in `scripts/agent-loops/provision-machine.sh`. `install` must
   remove this project's previous jobs first, so it stays idempotent.
4. Tests in `scripts/test/automation.test.js` for rendering, and a row in the
   scheduler table in [scripts/agent-loops/README.md](../scripts/agent-loops/README.md#provision-a-runner).
