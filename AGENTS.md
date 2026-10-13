# Project Admin instructions

This repository combines a product site with an operations console, work
queues in a pluggable store (`backend` in `project-admin.config.json`:
Firestore by default, a local JSON file, or GitHub Issues; see
`docs/BACKENDS.md`), and autonomous agent loops. Work item
kinds (feature, bug, task, ...) are configured in `project-admin.config.json`
under `workKinds`; read that file before operating on a project.

## Build and test

Run every suite a change touches.

| Suite | Command | Expect |
|---|---|---|
| Admin console | `cd admin-app && npm test` | all tests pass |
| Admin production bundle | `cd admin-app && npm run build` | writes `public/admin/` (or the configured admin path) |
| Firestore + Storage rules | `firebase emulators:exec --only firestore,storage --project demo-project-admin "cd admin-app && npm run test:rules"` | all rules tests pass |
| Store contract | `cd scripts && node --test test/store-contract.test.js` | every scenario passes on firestore, local, and github (part of the agent tooling suite) |
| Cloud Functions (extra) | `cd extras/functions && npm test` | all tests pass |
| TestFlight tooling (extra) | `cd extras/testflight && npm test` | all tests pass |
| Agent tooling | `cd scripts && npm test` | all tests pass |
| Backlog credential smoke | `node scripts/work-agent.js --kind feature count --as terra` | returns a JSON count |
| Work-kind sync | `node scripts/lib/work-kinds.js check` | silent; run `npm run sync:work-kinds` if it reports drift |
| Deploy-target runbooks | `node scripts/lib/deploy-targets.js check` | exits 0; every configured target's runbook exists |

The rules suite needs both emulators. A fresh worktree has no `auth.env` or
`node_modules`; immediately run
`scripts/agent-loops/provision-worktree.sh <worktree-path>` after creating it.
Node/model CLIs may be installed outside a scheduler's default PATH (launchd,
systemd, and cron all start jobs with a minimal one). Use `/usr/sbin/scutil` by
absolute path when detecting a macOS host, and guard macOS-only tools
(`taskpolicy`, `osascript`, `launchctl`) behind a Darwin check; loops also run
on Linux.

## Working disposition

- **Autonomous fixing.** Given a reproducible bug or failing suite, find and fix
  the root cause without asking for routine implementation choices.
- Ask only for genuine product or release decisions, with concrete A/B options.
- Prefer the smallest complete solution and verify it before handoff.

## Canonical loop runbooks

| When touching | Read first |
|---|---|
| `scripts/*`, deployment code, or release configuration | `.claude/commands/deploy-loop.md` |
| a deploy target's procedure | that target's `runbook` in `deployments.targets` (built-ins: `docs/deploy-targets/<target>.md`; `node scripts/lib/deploy-targets.js list`) |
| a work kind's lifecycle behavior | that kind's `runbook` in `workKinds` (feature: `.claude/commands/feature-loop.md`, bug: `.claude/commands/bug-loop.md`, task: `.claude/commands/task-loop.md`) |

Prompt files under `scripts/agent-loops/` are entry-point shims and delegate to
the canonical runbooks.

## Backlogs and loop agents

- Every work item lives in the configured store (Firestore `workItems`, the
  local JSON store, or a GitHub issue) with a `kind` and is changed only through
  `scripts/work-agent.js --kind <kind>` (or the `feature-agent.js`/`bug-agent.js`
  shims) with `--as <agent>`. New persistence goes through `scripts/lib/store/`.
- Build work happens in `.agent-worktrees/<agent>-<item>` based on the configured
  default branch. Never implement a backlog item in the shared checkout.
- An item's `branchName` is durable: fetch and resume it instead of recreating it.
- Kinds with `planReview: true` (bugs by default) post an investigation and
  plan before writing code.
- Kinds with `deploys: false` (tasks) never enter the deploy queue; their loop
  merges the approved PR and closes the item with `close-no-deploy`.
- Build loops open PRs and never deploy. The deploy loop executes only a human-
  approved target set with Scope/Commands/Verification/Acceptance notes, using
  each target's configured runbook. Targets with `requiresHumanAcceptance`
  (TestFlight by default) return to acceptance review instead of closing.
- Never edit backlog data directly: no hand edits to Firestore documents, the
  local store file, or a GitHub issue's `project-admin:fields` block.

## Access and deployment

On firestore, the `adminUsers` collection is the authorization source.
Bootstrap the first owner with `npm run bootstrap-admin`; thereafter use the
Users screen. The local backend is single-user (the configured owner, no
authentication, 127.0.0.1 only); the github backend authorizes repository
collaborators with write access. Never hard-code collaborator emails into
source or security rules.

Use Firebase Hosting for the site/admin bundle, deploy Firestore rules only
after the emulator suite passes, and never force-push, bypass red checks, or
mark work shipped before target-specific live verification.
