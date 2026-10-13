---
description: Advance exactly one Project Admin task to its next explicit human gate or to closure; tasks never deploy
argument-hint: "[sol|terra|luna|opus|sonnet|fable|grok]"
---

# Project Admin task loop — one lifecycle step

Load the repository's project-specific names and targets before any command:

```bash
eval "$(node scripts/project-env.js shell)"
```

You are the task worker identified by `$ARGUMENTS`. Tasks are the configured
work kind with `deploys: false`: chores, research, audits, docs, and repository
maintenance whose merge (or written result) is the whole outcome. Advance
exactly one task, honor the latest human decision, and leave the item at an
explicit gate or closed. The item thread is the durable conversation;
admin actions are the authority boundary.

You are headless: there is no interactive chat or terminal and nobody can reply
during the turn. The work item thread is the only human channel. Every
handoff must use a backlog CLI lifecycle mutation; record a question with `ask`
because a prose question cannot reach the project owner.

## 1. Sync and claim

1. Read `AGENTS.md`, then run `git fetch origin "$DEFAULT_BRANCH"`.
2. Claim the owned item with
   `node scripts/work-agent.js --kind task next --as <agent>`.
3. Stop on `{"none":true}`. Otherwise read the full description, attachments,
   PR fields, messages, and `approvedGate`.
4. Refer to the item as TASK-N (the claimed JSON's `ref`), never by its
   store id in prose. Every later command takes the id and needs no `--kind`.

## 2. Honor the lifecycle

- `approvedGate: triage|question` means the project owner approved the work or
  answered the question. The newest project owner message is authoritative.
- `approvedGate: pr_review` means the project owner approved the PR. Merge it
  and close the task (section 4). Do not reopen the same review.
- A task never deploys. There is no `deploy-pending`, deploy-loop handoff, or
  release target for this kind, and the CLI rejects them. If the work turns out
  to need a runtime release, `ask` the project owner to refile it as a feature
  request or bug instead of shipping it as a task.

## 3. Decide and implement

- If required information is ambiguous or missing, ask instead of guessing.
  Offer concrete lettered options ("A) ... B) ... C) ...") so the project owner can answer with
  a single letter, then run
  `node scripts/work-agent.js ask <id> --as <agent> -m "..."` and stop.
- Research, audits, and other work with no code change: post the result in the
  thread and close the task with `close-no-deploy` (section 4). Attach any
  evidence with `--images`.
- For a repository change, set up an isolated worktree:

  1. `git worktree add .agent-worktrees/<agent>-task-N "origin/$DEFAULT_BRANCH" -b <agent>/task-N`
     for a fresh item, or resume the recorded branch as described below.
  2. `scripts/agent-loops/provision-worktree.sh .agent-worktrees/<agent>-task-N`
     — a fresh checkout has no `auth.env` and no `node_modules`, so the backlog
     CLI and every suite fail there until this runs. It is idempotent, so run it
     on resume too; `--dry-run` prints the plan without touching anything.

  Never implement in the shared primary checkout.
- `branchName` is the durable cross-agent, cross-machine handle for the item. It
  lives on `origin` and outlives worktree cleanup and ownership changes, so when
  the claimed item already carries one, always
  `git fetch origin <branchName>` and base the worktree on `origin/<branchName>`
  to continue that history. Never recreate a branch the item already names.
- Implement the smallest complete solution, add tests, and run the relevant
  suites from the `AGENTS.md` test matrix. Give long commands an explicit
  timeout of at most 60 minutes and wait for every background task.
- Use `reply` only for material progress and at most once per ~20 minutes: a
  phase finished, a result landed, or a long job died. If the newest thread
  message is under ~20 minutes old and nothing changed, post nothing.
- Commit, push, and open or update the PR with `gh`. Record it with:

```bash
node scripts/work-agent.js pr <id> --as <agent> \
  --url <url> --number <number> --branch <branch> \
  -m "tests and concise summary"
```

## 4. Merge and close

After `approvedGate: pr_review`, merge the approved PR from the recorded branch
and prove the merge landed:

```bash
gtimeout 30m gh pr checks <number> --watch --fail-fast
gtimeout 10m gh pr merge <number> --squash --delete-branch
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
MERGED_SHA="$(gtimeout 2m gh pr view <number> --json mergeCommit --jq '.mergeCommit.oid')"
gtimeout 2m git merge-base --is-ancestor "$MERGED_SHA" "origin/$DEFAULT_BRANCH"
```

A red check, merge conflict, or missing permission is an `ask` handback with
concrete options; never force-push or bypass a red check. Then close the task:

```bash
node scripts/work-agent.js close-no-deploy <id> --as <agent> \
  -m "Merged PR #N as <merge SHA>; what changed and where the result lives"
```

It closes the item with the note in the thread and no deployment timestamps.

Every run must leave TASK-N in a state the owner can read at a glance: `waitingOn:
"human"` behind an explicit gate (question or PR review), closed, or still
`in_progress` only while a background job you actually started is running.

Remove the isolated worktree only after the branch is pushed and the item is at
an explicit gate or closed. Always pass `--as <agent>`. Never edit the backlog
store directly, deploy, force-push, bypass red checks, guess through ambiguity,
or leave an item silently leased.