---
description: Drain Project Admin's human-approved deploy queue, merge each PR, execute every approved target, capture live proof, and close or return the item
argument-hint: "[sol|terra|luna|opus|sonnet|fable|grok]"
---

# Project Admin deploy loop

Load the repository's project-specific names, branch, URLs, and Firebase project (if any)
before any command:

```bash
eval "$(node "${PROJECT_ADMIN_KIT_ROOT:-.}/scripts/project-env.js" shell)" && cd "$PRODUCT_ROOT"
```

`$KIT_ROOT` holds the kit's CLIs and runbooks; `$PRODUCT_ROOT` is the repository
you change, where branches, PRs, and `.agent-worktrees/` live. They are the same
directory unless the kit is embedded in a subdirectory of the product or is a
separate repository (`docs/LAYOUTS.md`). Loops export both (and
`PROJECT_ADMIN_KIT_ROOT`); by hand, run the line above from the kit directory.

Drain the entire approved deploy queue, one item at a time. The immutable
`deploymentApprovedAt`, `deploymentApprovedBy`, `deploymentApprovedTargets`, and
`deploymentApprovedNotes` fields are the project owner's durable capability grant. Execute
exactly that scope. Never ask the project owner to repeat it, silently narrow it, or add a
target.
The grant identifies the reviewed PR, branch, targets/surfaces, and acceptance
behavior. A head SHA is audit evidence, not immutable release scope: a verified
merge-only conflict repair may advance it without invalidating the grant.

## You are headless

There is no interactive chat or terminal and nobody can reply during this
turn. The work item thread is the only human channel. The immutable
approval fields above, plus any later the project owner thread message that explicitly says
yes, confirmed, or approved for a named action, are the action-time confirmation
for that action. There is no other confirmation channel. Execute under the
recorded grant or use the backlog CLI's `ask` command to hand the item back.
Never re-ask for an already approved named action. Ending a turn with a question
in prose and no CLI lifecycle mutation is a hard failure.

All backlog state changes go through `$KIT_ROOT/scripts/work-agent.js`. Every command
uses `--as <agent>`. Refer to an item by its reference (the claimed JSON's
`ref`, e.g. FR-N or BUG-N) in notes, never by its Firestore id. Use the id only
as a CLI argument; item commands read the kind from the document.

## 1. Sync and drain the deploy queue

From the checkout in which the loop was launched:

```bash
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
gtimeout 2m git status --short --branch
gtimeout 2m node "$KIT_ROOT/scripts/work-agent.js" deploy-next --as <agent>
```

The deploy queue spans every configured kind with `deploys: true` (kinds such
as tasks never reach it). When it returns `{"none":true}`, stop. After each item has
shipped, resolved, or been handed back with `ask` or a mechanical-conflict
`set`, fetch again and repeat. Keep
a set of ids seen during the run. If the same id is returned twice, hand it back
instead of spinning.

Read the complete item, attachments, thread, PR, approved targets, approved
notes, and latest the project owner message. Before merging, write a release matrix with one
row per approved target:

| Target | Exact command | Live proof | Acceptance behavior |
|---|---|---|---|
| `<approved target>` | `<command from that target's runbook, with item values filled in>` | `<revision, build, URL, or content hash>` | `<observable item outcome>` |

Inspect the PR file list and diff. If they require a target absent from the
approved set, if `mixed` hides the surfaces, or if any value in the matrix is
unknown, use `ask` with the exact proposed correction before merging.
Command success alone is not proof.

Anything unexpected, or any step that is not a mechanical execution of the
recorded grant, is an immediate `ask` handback. The message must state exactly
what is done, what remains, and concrete A/B options for the project owner. Always leave the
item in a clear state: shipped/resolved, at acceptance review, or handed back
with `ask`; never stop on an unrecorded prose question.

## 2. Merge and prepare an isolated release worktree

Set these values from the claimed item. Replace every angle-bracket placeholder
before running anything:

```bash
AGENT='<agent>'
ITEM_CLI="$KIT_ROOT/scripts/work-agent.js"
ITEM_ID='<Firestore id from the claimed JSON>'
ITEM_REF='<ref from the claimed JSON, e.g. FR-N or BUG-N>'
PR_NUMBER='<recorded PR number>'

PR_JSON="$(gtimeout 2m gh pr view "$PR_NUMBER" --json state,mergeable,mergeStateStatus,headRefName,headRefOid,files,statusCheckRollup)"
PR_BRANCH="$(printf '%s' "$PR_JSON" | jq -r '.headRefName')"
PR_HEAD="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid')"
gtimeout 2m git fetch origin "$PR_BRANCH"
REVIEWED_BASE="$(gtimeout 2m git merge-base "origin/$DEFAULT_BRANCH" "$PR_HEAD")"
```

If `mergeable` is `CONFLICTING` or `mergeStateStatus` is `DIRTY`, do not ask the project owner
to authorize a mechanical repair. Return the item directly to its assigned build
agent while preserving all deployment approval fields:

```bash
gtimeout 2m node "$ITEM_CLI" set "$ITEM_ID" --as "$AGENT" \
  --status in_progress --waiting agent --gate none \
  -m "Mechanical conflict handback for $ITEM_REF, PR #$PR_NUMBER on $PR_BRANCH. Approved baseline base: $REVIEWED_BASE; approved baseline head: $PR_HEAD. Merge origin/$DEFAULT_BRANCH into this exact head, keep resolution in the merge commit, run focused tests and range-diff, then requeue only if behavior, files, branch, and approved targets are unchanged."
```

The build agent requeues a safe repair with `set --status ready_for_deploy
--waiting deployer --gate none`; it does not create new `pr` or `deploy-pending`
gates. On the next deploy claim, read both baseline SHAs from that handback and
verify the repair before continuing:

```bash
REVIEWED_BASE='<approved baseline base SHA from the conflict handback>'
REVIEWED_HEAD='<approved baseline head SHA from the conflict handback>'
CURRENT_HEAD="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid')"
gtimeout 2m git merge-base --is-ancestor "$REVIEWED_HEAD" "$CURRENT_HEAD"
test -z "$(gtimeout 2m git rev-list --no-merges "$REVIEWED_HEAD..$CURRENT_HEAD" --not "origin/$DEFAULT_BRANCH")"
gtimeout 2m git range-diff "$REVIEWED_BASE..$REVIEWED_HEAD" "origin/$DEFAULT_BRANCH..$CURRENT_HEAD"
gtimeout 2m git diff --name-only "$REVIEWED_BASE..$REVIEWED_HEAD"
gtimeout 2m git diff --name-only "origin/$DEFAULT_BRANCH..$CURRENT_HEAD"
gtimeout 2m git show --cc --stat --oneline "$CURRENT_HEAD"
```

Require the same PR, branch, targets, and approved surface/file set; inspect the
range-diff, both file lists, and combined merge diff for behavioral changes. If a new
non-merge commit, semantic change, or scope change appears, use `ask` to send it
through the project owner's PR review and a fresh deployment approval. If the repair is
equivalent, continue under the existing grant once GitHub reports CLEAN or
MERGEABLE and required checks are green.

```bash
gtimeout 30m gh pr checks "$PR_NUMBER" --watch --fail-fast
gtimeout 10m gh pr merge "$PR_NUMBER" --squash --delete-branch
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"

MERGED_SHA="$(gtimeout 2m gh pr view "$PR_NUMBER" --json mergeCommit --jq '.mergeCommit.oid')"
gtimeout 2m git merge-base --is-ancestor "$MERGED_SHA" "origin/$DEFAULT_BRANCH"
DEPLOY_WT="$PRODUCT_ROOT/.agent-worktrees/deploy-$(printf '%s' "$ITEM_REF" | tr '[:upper:]' '[:lower:]')"
gtimeout 10m git -C "$PRODUCT_ROOT" worktree add --detach "$DEPLOY_WT" "origin/$DEFAULT_BRANCH"
DEPLOY_WT="$(cd "$DEPLOY_WT" && pwd)"
# The kit at the merged commit: inside the release worktree when the kit lives
# in the product repository (KIT_SUBDIR "." or "ops"), else the kit checkout.
if [[ -n "$KIT_SUBDIR" ]]; then DEPLOY_KIT="$(cd "$DEPLOY_WT/$KIT_SUBDIR" && pwd)"; else DEPLOY_KIT="$KIT_ROOT"; fi
```

Product surfaces (Vercel, Flutter, Cloud Run, ...) deploy from `$DEPLOY_WT`;
the kit's own surfaces (its `firebase.json`, admin bundle, rules, and extras)
deploy from `$DEPLOY_KIT`. Both are the same directory in the default layout.

If the PR is already merged, skip `gh pr checks` and `gh pr merge`, then read
`mergeCommit` and continue. A red check, missing credential, non-mechanical
conflict, or unrecoverable command failure is an `ask` handback under the open
handback rule above. Never force-push or bypass a red check. A warning that the remote branch
could not be deleted because a worktree holds it is benign after `gh pr view`
confirms `MERGED`.

## Per-target runbooks

Deploy targets are configuration. `project-admin.config.json` maps each target
id under `deployments.targets` to a label, a `runbook` markdown file, and
optional `requiresHumanAcceptance`/`enabled` flags; built-in targets fall back to
`$KIT_ROOT/scripts/lib/deploy-targets.defaults.json`, and `none` is always available.
Before building the release matrix, print the definition of every approved
target:

```bash
gtimeout 1m node "$KIT_ROOT/scripts/lib/deploy-targets.js" show <approved-target> [<approved-target> ...]
```

Read each printed runbook in full. A runbook names the target's
**Preconditions**, its exact time-bounded commands, the live **Proof** to
capture, and its known failures; fill the matrix from it and execute it from
`$DEPLOY_WT` with the variables set above. An approved target that the command
reports as unknown, disabled, or without a readable runbook is an `ask`
handback; never improvise a procedure for it.

Run targets with `requiresHumanAcceptance: true` (TestFlight by default) last.
For every other completed target, record proof immediately:

```bash
gtimeout 2m node "$ITEM_CLI" deploy-check "$ITEM_ID" --as "$AGENT" \
  --target '<target>' \
  --proof '<deployed revision/build plus the concrete live check>' \
  --acceptance '<how the observed behavior satisfies the item>'
```

The CLI refuses `complete` (or `ship`/`resolve`) whenever an approved target
requires human acceptance. Follow that target's runbook to hand the item back:
TestFlight's autoship records its own proof and returns the item to
`acceptance_review`. For any other such target, record its live proof with
`verification-pending`, which stores the evidence and moves the item to the
project owner's acceptance review instead of closing it (record every other
approved target with `deploy-check` first):

```bash
gtimeout 2m node "$ITEM_CLI" verification-pending "$ITEM_ID" --as "$AGENT" \
  --target '<target>' \
  -m '<merge SHA, every target, its proof, and what the project owner should try>'
```

## Console-only work is not a deployment target

Do not configure a `manual_console` target in `deployments.targets`. Console work is not a
repeatable mechanical deploy. Before release, use `ask` and list the exact
console, project/app, clicks, field values, verification, and screenshot that
will prove completion. the project owner may pre-authorize that exact named console action in
the item thread; that message is sufficient authority and must not trigger a
duplicate approval question. Execute only the named action, capture a screenshot
URL plus the observed field values in the thread, then continue with the
separately approved mechanical targets. A new/different console action requires
a new handback.

## 3. Close, clean up, and continue

When no approved target requires human acceptance and every approved target
has a `deploy-check`, close the item:

```bash
gtimeout 2m node "$ITEM_CLI" complete "$ITEM_ID" --as "$AGENT" -m '<merge SHA, every target, proof, and end-to-end item outcome>'
gtimeout 10m git -C "$PRODUCT_ROOT" worktree remove "$DEPLOY_WT"
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
```

The CLI rejects closure until every approved target has concrete proof and
contextual acceptance. Do not remove a worktree that a detached release still
uses (TestFlight's autoship owns its worktree after launch). Per-item failures
use `ask` and then continue draining. Only a systemic authentication or network
failure stops the whole run.
