# Architecture and trust model

## Surfaces

| Surface | Responsibility |
|---|---|
| `admin-app/` | Human dashboard, backlog, actions, monitoring, and users |
| Firestore/Storage rules | Browser and native-app authorization boundaries (firestore backend) |
| `scripts/` | Backlog mutations through `scripts/lib/store/` and agent orchestration |
| `scripts/local-server.js` | Loopback console server for the local backend |
| `.claude/commands/` | Canonical per-kind (feature, bug, task) and deploy lifecycle policy |
| `functions/` | Optional lifecycle email and FCM notifications |
| `native-ios/` | Optional authenticated SwiftUI/WKWebView wrapper |

## Backlog store

`project-admin.config.json#backend` selects where the backlog and loop
telemetry live: `firestore` (default), `local` (one JSON file), or `github`
(Issues). Scripts use the `BacklogStore` interface in `scripts/lib/store/`
(items create/get/list/update, transactional `transact` and lease `claim`,
runs, machines, system documents, users, attachments); the console uses the
adapter in `admin-app/src/data/`, chosen at build time. Lifecycle rules are
backend-independent; [BACKENDS.md](BACKENDS.md) covers each store's setup,
security model, and limits (claims on GitHub are best effort).

## Identity

The rest of this document describes the firestore backend. Google Auth proves identity. `adminUsers/{normalizedEmail}` grants an active
`admin` or `collaborator` role. Firestore rules read that document for every
protected request. Admins have lifecycle, routing, deployment, and user
management authority. Collaborators can submit work, change its priority, add
context, answer non-release questions, and inspect automation; they cannot grant
access, route models, approve plans/PRs/releases, or mutate telemetry.

## Work kinds

Work item kinds are configuration. `project-admin.config.json#workKinds` maps
each kind id (`^[a-z][a-z0-9-]*$`; `deploy` is reserved for the deploy queue)
to a small definition:

| Field | Meaning |
|---|---|
| `label`, `pluralLabel`, `shortLabel` | UI and notification names |
| `prefix`, `route` | item reference (`FR-12`) and admin URL segment (`/features`) |
| `planReview` | adds the investigation + `plan_review` gate before implementation |
| `deploys` | `true`: release through the deploy queue; `false`: close with `close-no-deploy` after PR merge or a written result |
| `runbook` | canonical loop runbook; `scripts/agent-loops/<id>-loop-prompt.md` delegates to it |
| `statuses.initial` / `done` / `declined` | `backlog`\|`open`, `shipped`\|`closed`, `declined`\|`wont_fix` |
| `icon`, `tone`, `copy` | optional console presentation |

Omitted fields fall back to the built-in definition with the same id
(`scripts/lib/work-kinds.defaults.json`) and then to generic defaults; an absent
`workKinds` means exactly the built-in feature + bug pair. Claimable statuses,
allowed gates, the per-kind counter field (`next<Id>Number`), and the completion
verb are derived. `node scripts/lib/work-kinds.js queues` lists the valid loop
queue names.

Security rules cannot read JSON, so `npm run sync:work-kinds` (also run by
`npm run configure`) renders the configured kinds into a marked block in
`firestore.rules` and `storage.rules` and into the Functions and iOS configs.
A scripts test fails whenever those generated copies drift from the config.

## Work lifecycle

All kinds share the `workItems` collection, distinguished by `kind`, so
dependencies resolve across kinds. Documents carry status, `waitingOn`, review
gate, messages, assignment, machine, lease, PR identity, release targets,
immutable approval snapshot, and per-target evidence. Agent CLIs acquire
transactional leases (a file lock on the local store; comment arbitration on
GitHub) and always release a claim through an explicit lifecycle
mutation. Kinds with `planReview` add a mandatory plan-review gate before
implementation; the deploy queue spans every kind with `deploys: true`.

The deploy approval is a durable capability grant for exactly the recorded PR,
branch, targets, commands, verification, and acceptance behavior. The deploy
loop cannot widen it and closure is rejected until every approved target has
concrete proof. TestFlight always returns to human acceptance.

## Loop isolation and recovery

Scheduled polls run from dedicated clean worktrees. Actual work-item work gets
another durable branch-backed worktree. Heartbeats and progress snapshots feed
the dashboard. A reaper detects dead runner PIDs, freezes run duration, returns
the exact claim to its queue, and preserves the implementation worktree.

## Agents and runners

The agent roster is configuration: `project-admin.config.json` `agents` (or the
built-in default in `scripts/lib/agent-defaults.json`) defines each token,
owner, model, and runner, and both the scripts and the console read it.
`run-loop.sh` dispatches to a runner adapter in `scripts/agent-loops/runners/`
through one environment contract, keeps the outer timeout and log handling
itself, and runs an optional per-agent usage hook. Only runners that wire
`headless-guard.py` into their CLI (today, Claude) are `guarded`; every other
agent is flagged as unguarded in the loop log, the provisioner check, and the
Agent Loops page. The guard is a seatbelt against accidents, not a sandbox.
