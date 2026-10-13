# Architecture and trust model

## Surfaces

| Surface | Responsibility |
|---|---|
| `admin-app/` | Human dashboard, backlog, actions, monitoring, and users |
| Firestore/Storage rules | Browser and native-app authorization boundaries |
| `scripts/` | Server-credential backlog mutations and agent orchestration |
| `.claude/commands/` | Canonical per-kind (feature, bug, task) and deploy lifecycle policy |
| `functions/` | Optional lifecycle email and FCM notifications |
| `native-ios/` | Optional authenticated SwiftUI/WKWebView wrapper |

## Identity

Google Auth proves identity. `adminUsers/{normalizedEmail}` grants an active
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
transactional leases and always release a claim through an explicit lifecycle
mutation. Kinds with `planReview` add a mandatory plan-review gate before
implementation; the deploy queue spans every kind with `deploys: true`.

The deploy approval is a durable capability grant for exactly the recorded PR,
branch, targets, commands, verification, and acceptance behavior. The deploy
loop cannot widen it and closure is rejected until every approved target has
concrete proof. A target with `requiresHumanAcceptance` (TestFlight by default)
always returns to human acceptance.

## Deploy targets

Deploy targets are configuration too. `project-admin.config.json#deployments`
maps each target id (`^[a-z][a-z0-9_]*$`) to a definition:

| Field | Meaning |
|---|---|
| `label` | console and CLI name |
| `runbook` | repository-relative markdown with the target's preconditions, time-bounded commands, live proof, and known failures |
| `requiresHumanAcceptance` | the CLI refuses `complete`; the deploy loop records proof with `verification-pending --target <id>`, which returns the item to acceptance review |
| `enabled` | `false` hides it from the console picker and rejects new `--targets` selections; already-approved scopes still deploy, record proof, and close |

```json
"deployments": {
  "targets": {
    "firebase_hosting": {},
    "testflight": { "enabled": false },
    "fly": { "label": "Fly.io", "runbook": "docs/deploy-targets/fly.md" }
  }
}
```

Built-in ids (`testflight`, `firebase_hosting`, `firebase_functions`,
`firebase_rules_indexes`, `vercel`, `flutter_web`, `cloud_run`) may omit fields,
which fall back to `scripts/lib/deploy-targets.defaults.json` and the runbooks in
`docs/deploy-targets/`. `none` is built in, reserved, exclusive, and always
available. The backlog CLI (`scripts/lib/deployment-contract.js`), the console's
target picker and labels, and the deploy loop all read the same resolved list;
`.claude/commands/deploy-loop.md` is generic and opens each approved target's
runbook through `node scripts/lib/deploy-targets.js show <target>`.
[`docs/deploy-targets/examples/fly.md`](deploy-targets/examples/fly.md) shows a
complete non-built-in target added with config and a runbook alone.

The earlier flat boolean map (`{ "firebaseHosting": true, "testflight": false }`)
still loads. Nothing ever enforced those booleans, so it keeps every built-in
target enabled exactly as before; `node scripts/lib/deploy-targets.js migrate`
prints the equivalent `targets` map with each `false` carried over as
`enabled: false`.

## Loop isolation and recovery

Scheduled polls (launchd, systemd user timers, cron, or the portable
`scheduler.js`, all generated from the same machine-roster job set) run from
dedicated clean worktrees. Actual work-item work gets
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
