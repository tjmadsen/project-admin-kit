---
description: Investigate or advance exactly one Project Admin bug to its next explicit plan, review, acceptance, or release gate
argument-hint: "[sol|terra|luna|opus|sonnet|fable|grok]"
---

# Project Admin bug loop — one lifecycle step

Load the repository's project-specific names and targets before any command:

```bash
eval "$(node scripts/project-env.js shell)"
```

You are the bug worker identified by `$ARGUMENTS`. Advance exactly one bug
through investigation, approved repair, review, release, and acceptance. The
internal `messages` thread is the agent/admin conversation; never publish it to
a reporter.

You are headless: there is no interactive chat or terminal and nobody can reply
during the turn. The Firestore item thread is the only human channel. Every
handoff must use a backlog CLI lifecycle mutation; record a question with `ask`
because a prose question cannot reach the project owner.

## 1. Sync and claim

1. Read `AGENTS.md`, then run `git fetch origin "$DEFAULT_BRANCH"`.
2. Claim with `node scripts/bug-agent.js next --as <agent>` and stop on
   `{"none":true}`.
3. Read the description, attachments, full thread, delivery fields, and
   `approvedGate`. Refer to the item as BUG-N.

## 2. Honor the gate

- On first investigation, reproduce or locate the root cause. If invalid, use
  `decline`; if information is missing, use `ask` with concrete lettered options
  ("A) … B) … C) …") so the project owner can answer with a single letter; if actionable, post
  `plan -m "Root cause: … Proposed fix: … Verification: … Risk: …"` and stop.
- `approvedGate: plan_review` permits implementation of the proposed plan.
- `approvedGate: question` carries the project owner's answer; follow the newest the project owner message.
- `approvedGate: pr_review` approves the repair direction for release planning.
- `approvedGate: acceptance_review` means the project owner tried a deployed build and wants a
  further repair. Resume the recorded branch and address the feedback.

When the project owner explicitly approves a release in the thread, encode it as a
`deploy-pending` gate; do not cite the no-deploy rule as a dead end. This loop
does not merge or deploy.

## 3. Implement after plan approval

Set up `.agent-worktrees/<agent>-bug-N` in two steps, and never repair in the
shared primary checkout:

1. `git worktree add .agent-worktrees/<agent>-bug-N "origin/$DEFAULT_BRANCH" -b <agent>/bug-N`
   for a fresh bug, or resume the recorded branch as described below.
2. `scripts/agent-loops/provision-worktree.sh .agent-worktrees/<agent>-bug-N`
   — a fresh checkout has no `auth.env` and no `node_modules`, so the backlog CLI
   and every suite fail there until this runs. It is idempotent, so run it on
   resume too; `--dry-run` prints the plan without touching anything.

`branchName` is the durable cross-agent, cross-machine handle for the bug. It
lives on `origin` and outlives worktree cleanup and ownership changes, so when
the bug already carries one, always `git fetch origin <branchName>` and base the
worktree on `origin/<branchName>`. Never recreate a branch the bug already names.

A deploy-loop conflict handback is an exceptional resume path, not a new review
cycle. Its note names the approved PR/branch plus the reviewed base and head
audit SHAs. Fetch that branch and `origin/$DEFAULT_BRANCH`, confirm it still ends at the
reviewed head, and merge `origin/$DEFAULT_BRANCH` into it. Keep conflict resolution in
the merge commit, run the focused tests, compare the reviewed and repaired patch
with `git range-diff`, and require
`git rev-list --no-merges <reviewed-head>..HEAD --not origin/$DEFAULT_BRANCH` to be empty.
Compare the PR file lists before and after and inspect `git show --cc HEAD` for
the conflict-resolution delta. When the file set and behavior are unchanged,
push and preserve the project owner's existing release grant:

```bash
node scripts/bug-agent.js set <id> --as <agent> \
  --status ready_for_deploy --waiting deployer --gate none \
  -m "Mechanical merge repair complete for PR #N on <branch>; reviewed behavior and approved targets are unchanged; focused tests pass."
```

Do not call `pr` or `deploy-pending` on that safe path. If resolution changes
behavior, files, PR identity, branch, or release targets, use normal PR review
and fresh deploy approval.

Implement, test against the `AGENTS.md` test matrix, commit, push, and open or
update the PR. Give simulator, screenshot, and integration commands explicit
timeouts of at most 60 minutes, and wait for all background work. Record the
review handoff with `pr`, and use `note` only for material progress at most once
per ~20 minutes — a phase finished, a result landed, or a long job died. If the
newest thread message is under ~20 minutes old and nothing changed, post nothing;
the run heartbeat already shows the loop is alive.

After PR approval, read `.claude/commands/deploy-loop.md` and record the exact
release:

```bash
node scripts/bug-agent.js deploy-pending <id> --as <agent> \
  --targets <comma-separated-targets> \
  --notes $'Scope: ...\nCommands: ...\nVerification: ...\nAcceptance: ...' \
  -m "ready for deployment approval"
```

If the fix needs no release (duplicate, already fixed by another item, or
verified by the project owner outside the deploy loop), use
`node scripts/bug-agent.js close-no-deploy <id> --as <agent> -m "..."`. It
closes the bug with the note in the thread and no deployment timestamps, and
refuses while any release scope is planned, approved, queued, or in flight.

Allowed targets are the enabled ids printed by
`node scripts/lib/deploy-targets.js ids` (from `deployments.targets`; `none` is
always available), and each one's runbook says what its notes must cover.
Select every required surface from the PR and root cause; never use `mixed`.
Notes must itemize scope, exact command order, target-specific live proof, and
the behavior demonstrating the bug is fixed. TestFlight (and any target with
`requiresHumanAcceptance`) always returns to the project owner for hands-on
acceptance before resolution.
Identify the release by PR number, recorded branch, approved targets/surfaces,
and expected behavior. Never make the grant conditional on the PR head equaling
a fixed SHA or on `headRefOid` equality; SHAs belong only in audit/comparison
evidence. For target `none`, prescribe the deploy runbook's standard fetch,
ancestry, show-stat, and `deploy-check` sequence from the merged deploy worktree
plus the focused tests that prove the fix, not the whole agent-tool suite.

Every run must leave BUG-N in a state the owner can read at a glance: `waitingOn:
"human"` behind an explicit gate (question, plan review, PR review, deploy
approval), resolved or declined, or still `in_progress` only while a background
job you actually started is running.

Remove the worktree only after the branch is pushed and the item is at an
explicit gate. Always pass `--as <agent>`. Never edit Firestore directly, code
before plan approval, force-push, bypass red checks, or leave an item silently
leased.
