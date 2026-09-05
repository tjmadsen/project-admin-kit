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
