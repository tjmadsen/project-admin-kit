# Project Admin instructions

This repository combines a product site with a Firebase-hosted operations
console, Firestore-backed work queues, and autonomous agent loops. Work item
kinds (feature, bug, task, ...) are configured in `project-admin.config.json`
under `workKinds`; read that file before operating on a project.

## Build and test

Run every suite a change touches.

| Suite | Command | Expect |
|---|---|---|
| Admin console | `cd admin-app && npm test` | all tests pass |
| Admin production bundle | `cd admin-app && npm run build` | writes `public/admin/` (or the configured admin path) |
| Firestore + Storage rules | `firebase emulators:exec --only firestore,storage --project demo-project-admin "cd admin-app && npm run test:rules"` | all rules tests pass |
| Cloud Functions | `cd functions && npm test` | all tests pass |
| Agent tooling | `cd scripts && npm test` | all tests pass |
| Backlog credential smoke | `node scripts/work-agent.js --kind feature count --as terra` | returns a JSON count |
| Work-kind sync | `node scripts/lib/work-kinds.js check` | silent; run `npm run sync:work-kinds` if it reports drift |

The rules suite needs both emulators. A fresh worktree has no `auth.env` or
`node_modules`; immediately run
`scripts/agent-loops/provision-worktree.sh <worktree-path>` after creating it.
Node/model CLIs may be installed outside launchd's default PATH. Use
`/usr/sbin/scutil` by absolute path when detecting a macOS host.

## Working disposition

- **Autonomous fixing.** Given a reproducible bug or failing suite, find and fix
  the root cause without asking for routine implementation choices.
- Ask only for genuine product or release decisions, with concrete A/B options.
- Prefer the smallest complete solution and verify it before handoff.

## Canonical loop runbooks

| When touching | Read first |
|---|---|
| `scripts/*`, deployment code, or release configuration | `.claude/commands/deploy-loop.md` |
| a work kind's lifecycle behavior | that kind's `runbook` in `workKinds` (feature: `.claude/commands/feature-loop.md`, bug: `.claude/commands/bug-loop.md`, task: `.claude/commands/task-loop.md`) |

Prompt files under `scripts/agent-loops/` are entry-point shims and delegate to
the canonical runbooks.

## Backlogs and loop agents

- Every work item lives in the Firestore `workItems` collection with a `kind`
  field and is changed only through `scripts/work-agent.js --kind <kind>` (or
  the `feature-agent.js`/`bug-agent.js` shims) with `--as <agent>`.
- Build work happens in `.agent-worktrees/<agent>-<item>` based on the configured
  default branch. Never implement a backlog item in the shared checkout.
- An item's `branchName` is durable: fetch and resume it instead of recreating it.
- Kinds with `planReview: true` (bugs by default) post an investigation and
  plan before writing code.
- Kinds with `deploys: false` (tasks) never enter the deploy queue; their loop
  merges the approved PR and closes the item with `close-no-deploy`.
- Build loops open PRs and never deploy. The deploy loop executes only a human-
  approved target set with Scope/Commands/Verification/Acceptance notes.
- Never edit backlog Firestore documents directly.

## Access and deployment

The `adminUsers` collection is the authorization source. Bootstrap the first
owner with `npm run bootstrap-admin`; thereafter use the Users screen. Never
hard-code collaborator emails into source or security rules.

Use Firebase Hosting for the site/admin bundle, deploy Firestore rules only
after the emulator suite passes, and never force-push, bypass red checks, or
mark work shipped before target-specific live verification.
