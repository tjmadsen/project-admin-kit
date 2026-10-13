# Backlog backends

The backlog (work items, their threads, leases, and release evidence) and the
loop telemetry (runs, machines, usage, the deploy-agent choice) live in one
pluggable store. Pick it with the top-level `backend` key in
`project-admin.config.json`:

```jsonc
{ "backend": { "type": "firestore" } }                        // default when absent
{ "backend": { "type": "local", "path": "~/pa/store.json" } } // path optional
{ "backend": { "type": "github", "repository": "acme/app", "labelPrefix": "pa:" } } // both optional
```

or `npm run configure -- --backend local|github|firestore` (`--local-path`,
`--github-repo`, `--label-prefix`). Every CLI (`work-agent.js`, `log-run.js`,
`admin-users.js`) and the console build read the same key, so switching is a
config change plus a console rebuild. Data is not migrated between backends.

## Comparison

| | `firestore` (default) | `local` | `github` |
|---|---|---|---|
| Where items live | Firestore `workItems` | one JSON file on this machine | GitHub Issues |
| Dashboard | Firebase Hosting, Google sign-in | `npm run local` on 127.0.0.1 | none: GitHub is the UI |
| People | many; `adminUsers` roles | one (the configured owner) | repository collaborators |
| Claim atomicity | transaction | file lock | best effort (see below) |
| Item numbers | per kind (`FR-1`, `BUG-1`) | per kind | the issue number (`FR-12`, `BUG-13`) |
| Attachments | Firebase Storage | files beside the store | attach in the GitHub UI |
| Loop telemetry | Firestore | the same JSON file | a local JSON file (not shown on GitHub) |
| Multiple loop machines | yes | no (one machine) | yes, with the claim caveat |
| Email/push Functions, iOS shell | yes | no | no (GitHub notifies watchers itself) |
| Needs Firebase | yes | no | no |

## firestore

Unchanged from earlier releases: [SETUP.md](SETUP.md) covers the Firebase
project, `npm run bootstrap-admin`, rules, and Hosting. The `firebase` web keys
and `project.firebaseProjectId` are required only for this backend.

Security: Google Auth proves identity; `adminUsers/{email}` grants a role;
Firestore and Storage rules enforce it for every browser request. The CLIs use
server credentials (Application Default Credentials) and bypass rules, so they
run only on trusted machines.

## local

For one person on one machine, no cloud account.

1. `npm run configure -- --backend local` (no Firebase flags needed).
2. `npm run install:all`, then `npm run bootstrap-admin` (owner record, counters,
   default routing, deploy agent).
3. `npm run build`, then `npm run local` and open
   `http://127.0.0.1:4317/admin/` (`--port` or `PROJECT_ADMIN_LOCAL_PORT` to
   change the port).

The store is a JSON file, by default
`~/<automation.stateDirectory>/<project.slug>/store.json`, shared by every
worktree of the repository (a path inside the checkout would give each agent
worktree its own backlog). `backend.path` overrides it; relative paths resolve
against your home directory and `PROJECT_ADMIN_LOCAL_STORE` overrides both.
Attachments are copied to `attachments/` next to it. Writers (CLI, loops,
server) serialize on a `store.json.lock` file and replace the store with an
atomic rename, so concurrent claims are atomic and a crash never leaves a torn
file; a lock left by a dead process is broken automatically. The repository's
Node floor is 20, where `node:sqlite` does not exist, so the store has no native
dependency. Back it up like any other file.

Security: **there is no authentication.** `npm run local` binds to 127.0.0.1
only and treats every request as the configured owner with admin rights. It
refuses requests whose `Host` is not a loopback name (DNS rebinding) and writes
without an `X-Project-Admin: local` header (cross-site forms), but anything that
can reach the port, including other local users of the machine, has full
access. Do not expose it through port forwarding, tunnels, a reverse proxy, or
`0.0.0.0`. The store file is written with mode 0600.

Unavailable: Google sign-in and the Users screen's access control (the list is
kept, but nothing enforces it), lifecycle email/push Functions, the iOS shell,
and loops on more than one machine.

## github

For teams that already live in GitHub. There is no dashboard: a console built
with this backend shows a page that links to the repository's issues.

1. `npm run configure -- --backend github [--github-repo owner/repo]`
   (defaults to `repository.slug`).
2. Authenticate the loop machines: `gh auth login`, or export `GITHUB_TOKEN`
   (or `GH_TOKEN`). The store calls the GitHub REST API with Node's `fetch`,
   using `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. The token needs
   Issues read/write and Metadata read on the repository (classic: `repo`).
3. `npm run bootstrap-admin` is a no-op: access is the repository's collaborator
   list and issue numbers need no counters. Labels are created on first use.

### How an item maps onto an issue

| Item | Issue |
|---|---|
| id, number | issue number (`FR-12` is issue #12; numbers are shared by all kinds) |
| title, description | title, body text |
| kind, status, waitingOn, blockedReason, priority | labels `pa:kind:feature`, `pa:status:in_progress`, `pa:waiting:human`, `pa:gate:pr_review`, `pa:priority:high` |
| claim | label `pa:claimed` plus the lease in the fields block |
| assignedTo, lease, branchName, prUrl/prNumber, deployment targets, notes, approval snapshot, evidence, dependsOn, thinkingEffort, targetMachine, ... | a hidden `<!-- project-admin:fields {json} -->` block at the end of the body, owned by the store; do not edit it by hand |
| thread messages | comments (store-written ones carry a hidden author marker; any other comment is a message from `@login`) |
| done / declined | issue closed as completed / not planned |

Telemetry (runs, machines, usage, deploy-agent choice, the sync cursor) is not
shown on GitHub; it is kept per machine in
`~/<stateDirectory>/<slug>/github-telemetry.json`.

### What a human does on GitHub

Commands go on the first line of an issue comment. Labels are an alternative
for the approvals. The store picks both up at the start of every loop poll
(it scans open issues updated since the previous scan), applies them, removes
the approval label, and records the result in the thread.

| Console action | On GitHub |
|---|---|
| Create an item | open an issue with a `pa:kind:<kind>` label; it starts in triage waiting on a human |
| Route it to an agent | `/assign <agent>` (optional), then `/agent [note]` |
| Approve the plan (bugs) | `/approve plan [note]` or add label `pa:approved:plan` |
| Approve the PR | `/approve pr [note]` or add label `pa:approved:pr` |
| Answer a question and continue | comment, then `/agent [note]` (or `/approve` at the `question` gate) |
| Approve the deployment | `/approve deploy` or add label `pa:approved:deploy`: approves exactly the targets and notes the agent recorded with `deploy-pending` (shown in the thread), for the PR those notes cite |
| Accept a verified release | `/accept [note]` or add label `pa:approved:acceptance` |
| Close without a release | `/close-no-deploy <resolution>` |
| Decline | `/decline [reason]`, or close the issue as not planned |

`/approve` without a target approves whatever review gate the item is waiting
on (triage, question, plan, PR) but never a deployment or an acceptance. A plain
comment never moves an item; it is context the agent reads on its next claim.
Commands that do not apply (wrong gate, missing evidence) are answered in the
thread with the reason. A processed command is never applied twice.

**Who is authorized:** the comment author or the person who added the label
must have `write`, `maintain`, or `admin` permission on the repository, checked
with `GET /repos/{owner}/{repo}/collaborators/{user}/permission`. Commands and
labels from anyone else (including `triage` and `read`) are ignored with a note
in the thread. Branch protection and required reviews on the PR itself still
apply as usual.

### Claim atomicity (best effort)

GitHub has no compare-and-swap for issues, so the store cannot run a
transaction. A claim instead:

1. reads the issue and checks eligibility (lease open, owner, dependencies);
2. posts a claim comment with a random token;
3. waits `PROJECT_ADMIN_GITHUB_SETTLE_MS` (default 2000 ms) and lists the
   comments: among claim comments newer than the issue's last recorded claim
   and younger than ten minutes, the lowest comment id wins (GitHub assigns
   ids in creation order, so every claimant computes the same winner);
4. the losers delete their comment; the winner re-reads the issue, re-checks
   eligibility, and writes the lease. Its "Claimed by" comment stays as an
   audit trail.

The remaining window: if GitHub's comment listing lags a competitor's comment
by more than the settle delay, both claimants can proceed; a double claim shows
up as two "Claimed by" comments. A loser's claim comment that failed to delete
blocks new claims on that issue for up to ten minutes. Other writes are
read-modify-write, so an agent and a human editing the same issue in the same
second can lose one edit of the fields block (labels and comments are not
affected). Run one poller per queue per repository (the default machine
roster) and these are practically unreachable.

Unavailable: the dashboard, Users screen, attachments from the CLI (`--images`
is refused; drag files into a comment instead), lifecycle email/push Functions
(GitHub notifies watchers), and the iOS shell.

## Rules for every backend

- Change work items only through `scripts/work-agent.js` (or the human actions
  above). Never edit store documents, the JSON file, or the issue fields block
  directly.
- Kinds, gates, and the deploy contract are identical on every backend; only
  where the data lives and who can press the buttons changes.
