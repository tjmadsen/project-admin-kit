# Architecture and trust model

## Surfaces

| Surface | Responsibility |
|---|---|
| `admin-app/` | Human dashboard, backlog, actions, monitoring, and users |
| Firestore/Storage rules | Browser and native-app authorization boundaries |
| `scripts/` | Server-credential backlog mutations and agent orchestration |
| `.claude/commands/` | Canonical feature, bug, and deploy lifecycle policy |
| `functions/` | Optional lifecycle email and FCM notifications |
| `native-ios/` | Optional authenticated SwiftUI/WKWebView wrapper |

## Identity

Google Auth proves identity. `adminUsers/{normalizedEmail}` grants an active
`admin` or `collaborator` role. Firestore rules read that document for every
protected request. Admins have lifecycle, routing, deployment, and user
management authority. Collaborators can submit work, change its priority, add
context, answer non-release questions, and inspect automation; they cannot grant
access, route models, approve plans/PRs/releases, or mutate telemetry.

## Work lifecycle

Feature and bug documents carry status, `waitingOn`, review gate, messages,
assignment, machine, lease, PR identity, release targets, immutable approval
snapshot, and per-target evidence. Agent CLIs acquire transactional leases and
always release a claim through an explicit lifecycle mutation. Bug work adds a
mandatory plan-review gate before implementation.

The deploy approval is a durable capability grant for exactly the recorded PR,
branch, targets, commands, verification, and acceptance behavior. The deploy
loop cannot widen it and closure is rejected until every approved target has
concrete proof. TestFlight always returns to human acceptance.

## Loop isolation and recovery

Scheduled polls run from dedicated clean worktrees. Actual feature/bug work gets
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
