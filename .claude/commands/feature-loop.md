---
description: Advance exactly one Project Admin feature request to its next explicit human or release gate
argument-hint: "[sol|terra|luna|opus|sonnet|fable|grok]"
---

# Project Admin feature loop — one lifecycle step

Load the repository's project-specific names and targets before any command:

```bash
eval "$(node "${PROJECT_ADMIN_KIT_ROOT:-.}/scripts/project-env.js" shell)" && cd "$PRODUCT_ROOT"
```

`$KIT_ROOT` holds the kit's CLIs and runbooks; `$PRODUCT_ROOT` is the repository
you change, where branches, PRs, and `.agent-worktrees/` live. They are the same
directory unless the kit is embedded in a subdirectory of the product or is a
separate repository (`docs/LAYOUTS.md`). Loops export both (and
`PROJECT_ADMIN_KIT_ROOT`); by hand, run the line above from the kit directory.

You are the feature worker identified by `$ARGUMENTS`. Advance exactly one
feature request, honor the latest human decision, and leave the item at an
explicit gate. The item thread is the durable conversation; admin actions
are the authority boundary.

You are headless: there is no interactive chat or terminal and nobody can reply
during the turn. The work item thread is the only human channel. Every
handoff must use a backlog CLI lifecycle mutation; record a question with `ask`
because a prose question cannot reach the project owner.

## 1. Sync and claim

1. Read `AGENTS.md`, then run `git fetch origin "$DEFAULT_BRANCH"`.
2. Claim the owned item with
   `node "$KIT_ROOT/scripts/feature-agent.js" next --as <agent>`.
3. Stop on `{"none":true}`. Otherwise read the full description, attachments,
   delivery fields, messages, and `approvedGate`.
4. Refer to the item as FR-N, never by its store id in prose.

## 2. Honor the lifecycle

- `approvedGate: triage|question` means the project owner approved implementation or answered
  the question. The newest the project owner message is authoritative.
- `approvedGate: pr_review` means the project owner accepted the PR direction. Inspect the PR;
  when release is needed, record the exact next deployment with
  `deploy-pending` instead of reopening the same review.
- `approvedGate: acceptance_review` means the project owner requested another implementation
  pass after trying a deployed/TestFlight build. Resume the recorded branch and
  address that feedback.
- If the project owner explicitly authorizes a normally gated release in the thread, preserve
  that intent with `deploy-pending --targets ...`. Do not answer with a policy
  refusal or ask the project owner to repeat the authorization.

The feature loop does not merge or deploy. It translates approved release intent
into the deploy gate for the dedicated deploy loop.

## 3. Decide and implement

- If required information is ambiguous or missing, ask instead of guessing.
  Offer concrete lettered options ("A) ... B) ... C) ...") so the project owner can answer with
  a single letter, then run
  `node "$KIT_ROOT/scripts/feature-agent.js" ask <id> --as <agent> -m "..."` and stop.
- For clear implementation work, set up an isolated worktree:

  1. `git -C "$PRODUCT_ROOT" worktree add "$PRODUCT_ROOT/.agent-worktrees/<agent>-fr-N" "origin/$DEFAULT_BRANCH" -b <agent>/fr-N`
     for a fresh item, or resume the recorded branch as described below.
  2. `"$KIT_ROOT/scripts/agent-loops/provision-worktree.sh" "$PRODUCT_ROOT/.agent-worktrees/<agent>-fr-N"`
     — a fresh checkout has no `auth.env` and no `node_modules`, so the backlog
     CLI and every suite fail there until this runs. It is idempotent, so run it
     on resume too; `--dry-run` prints the plan without touching anything.

  Never implement in the shared primary checkout.
- `branchName` is the durable cross-agent, cross-machine handle for the item. It
  lives on `origin` and outlives worktree cleanup and ownership changes, so when
  the claimed item already carries one, always
  `git fetch origin <branchName>` and base the worktree on `origin/<branchName>`
  to continue that history. Never recreate a branch the item already names.
- Screenshots and comparison images go into the thread as attachments, not
  GitHub links: pass `--images a.png,b.png` (up to 10 files) with any `reply`,
  `ask`, `pr`, or `deploy-pending` message. The CLI stores them with the configured
  backend (Firebase Storage, or files beside the local store; the github
  backend refuses `--images`) and the admin console renders them inline.
- A deploy-loop conflict handback is an exceptional resume path, not a new
  review cycle. The handback note names the approved PR/branch plus its reviewed
  base and head audit SHAs. Fetch that recorded branch and `origin/$DEFAULT_BRANCH`,
  confirm the branch still ends at the reviewed head, and merge `origin/$DEFAULT_BRANCH`
  into it. Keep all conflict resolution in that merge commit; do not add a
  non-merge commit. Run the focused tests, compare the reviewed and repaired
  patch with `git range-diff`, and confirm
  `git rev-list --no-merges <reviewed-head>..HEAD --not origin/$DEFAULT_BRANCH` is empty.
  Compare the PR file lists before and after and inspect `git show --cc HEAD` for
  the conflict-resolution delta. If the file set and behavior are unchanged,
  push and preserve the project owner's existing release grant with:

  ```bash
  node "$KIT_ROOT/scripts/feature-agent.js" set <id> --as <agent> \
    --status ready_for_deploy --waiting deployer --gate none \
    -m "Mechanical merge repair complete for PR #N on <branch>; reviewed behavior and approved targets are unchanged; focused tests pass."
  ```

  Do not call `pr` or `deploy-pending` on that safe path. If resolving the
  conflict changes behavior, files, PR identity, branch, or release targets,
  use the normal `pr` review and fresh `deploy-pending` approval path.
- Implement the smallest complete solution, add tests, and run the relevant
  Flutter/admin/Node suites from the `AGENTS.md` test matrix.
- Give simulator, screenshot, and integration commands an explicit timeout of
  at most 60 minutes. Wait for every background task before handing off.
- Use `reply` only for material progress and at most once per ~20 minutes: a
  phase finished, a result landed, or a long job died. If the newest thread
  message is under ~20 minutes old and nothing changed, post nothing. The run
  heartbeat already shows the loop is alive, and repeated "still working" notes
  bury the project owner's own messages and churn the item's updated time.
- Commit, push, and open or update the PR with `gh`. Record it with:

```bash
node "$KIT_ROOT/scripts/feature-agent.js" pr <id> --as <agent> \
  --url <url> --number <number> --branch <branch> \
  -m "tests and concise summary"
```

## 4. Hand off the release

After PR approval, derive every release surface from the PR file list and the project owner's
latest message. Read `.claude/commands/deploy-loop.md`, then record:

```bash
node "$KIT_ROOT/scripts/feature-agent.js" deploy-pending <id> --as <agent> \
  --targets <comma-separated-targets> \
  --notes $'Scope: ...\nCommands: ...\nVerification: ...\nAcceptance: ...' \
  -m "ready for deployment approval"
```

Allowed targets are the enabled ids printed by
`node "$KIT_ROOT/scripts/lib/deploy-targets.js" ids` (from `deployments.targets`; `none` is
always available), and each one's runbook says what its notes must cover.
Select every required surface explicitly; never use `mixed`. The notes must give
exact commands/order, target-specific live proof, and observable acceptance.
Identify the release by PR number, recorded branch, approved targets/surfaces,
and expected behavior. Never make the grant conditional on the PR head equaling
a fixed SHA or on `headRefOid` equality; SHAs belong only in audit/comparison
evidence. For target `none`, use the deploy runbook's standard fetch, ancestry,
show-stat, and `deploy-check` sequence from the merged deploy worktree plus the
focused tests that prove the item. Do not prescribe the entire agent-tool suite
when it is unrelated to the change.
For TestFlight, preserve whether the project owner wants the item left open for hands-on
acceptance; the deploy loop always returns it to `acceptance_review`.

If the approved PR (or the finished research/audit) leaves nothing to release,
close the item yourself instead of routing it through the deploy loop:

```bash
node "$KIT_ROOT/scripts/feature-agent.js" close-no-deploy <id> --as <agent> \
  -m "How the work was completed and where the result lives"
```

It marks the item shipped with the note in the thread and no deployment
timestamps. It refuses while any release scope is planned, approved, queued, or
in flight; clear the targets or ask the project owner first in that case.

Every run must leave FR-N in a state the owner can read at a glance: `waitingOn:
"human"` behind an explicit gate (question, PR review, deploy approval), shipped
or closed, or still `in_progress` only while a background job you actually
started is running.

Remove the isolated worktree only after the branch is pushed and the item is at
an explicit gate. Always pass `--as <agent>`. Never edit the backlog store
directly, force-push, bypass red checks, guess through ambiguity, or leave an
item silently leased.