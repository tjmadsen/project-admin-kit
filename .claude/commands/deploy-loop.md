---
description: Drain Project Admin's human-approved deploy queue, merge each PR, execute every approved target, capture live proof, and close or return the item
argument-hint: "[sol|terra|luna|opus|sonnet|fable|grok]"
---

# Project Admin deploy loop

Load the repository's project-specific names, branch, URLs, and Firebase target
before any command:

```bash
eval "$(node scripts/project-env.js shell)"
```

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
turn. The Firestore item thread is the only human channel. The immutable
approval fields above, plus any later the project owner thread message that explicitly says
yes, confirmed, or approved for a named action, are the action-time confirmation
for that action. There is no other confirmation channel. Execute under the
recorded grant or use the backlog CLI's `ask` command to hand the item back.
Never re-ask for an already approved named action. Ending a turn with a question
in prose and no CLI lifecycle mutation is a hard failure.

All backlog state changes go through `scripts/feature-agent.js` or
`scripts/bug-agent.js`. Every command uses `--as <agent>`. Refer to an item as
FR-N or BUG-N in notes, never by its Firestore id. Use the id only as a CLI
argument.

## 1. Sync and drain both queues

From the checkout in which the loop was launched:

```bash
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
gtimeout 2m git status --short --branch
gtimeout 2m node scripts/feature-agent.js deploy-next --as <agent>
gtimeout 2m node scripts/bug-agent.js deploy-next --as <agent>
```

Claim from the feature queue first; query the bug queue only when the feature
command returns `{"none":true}`. When both are empty, stop. After each item has
shipped, resolved, or been handed back with `ask` or a mechanical-conflict
`set`, fetch again and repeat. Keep
a set of ids seen during the run. If the same id is returned twice, hand it back
instead of spinning.

Read the complete item, attachments, thread, PR, approved targets, approved
notes, and latest the project owner message. Before merging, write a release matrix with one
row per approved target:

| Target | Exact command | Live proof | Acceptance behavior |
|---|---|---|---|
| `<approved target>` | `<command below, with item values filled in>` | `<revision, build, URL, or content hash>` | `<observable FR/BUG outcome>` |

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
ITEM_CLI='scripts/feature-agent.js' # or scripts/bug-agent.js
ITEM_ID='<Firestore id from the claimed JSON>'
ITEM_REF='FR-N'                     # or BUG-N
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
DEPLOY_WT=".agent-worktrees/deploy-$(printf '%s' "$ITEM_REF" | tr '[:upper:]' '[:lower:]')"
gtimeout 10m git worktree add --detach "$DEPLOY_WT" "origin/$DEFAULT_BRANCH"
DEPLOY_WT="$(cd "$DEPLOY_WT" && pwd)"
```

If the PR is already merged, skip `gh pr checks` and `gh pr merge`, then read
`mergeCommit` and continue. A red check, missing credential, non-mechanical
conflict, or unrecoverable command failure is an `ask` handback under the open
handback rule above. Never force-push or bypass a red check. A warning that the remote branch
could not be deleted because a worktree holds it is benign after `gh pr view`
confirms `MERGED`.

For every completed non-TestFlight target, record proof immediately:

```bash
gtimeout 2m node "$ITEM_CLI" deploy-check "$ITEM_ID" --as "$AGENT" \
  --target '<target>' \
  --proof '<deployed revision/build plus the concrete live check>' \
  --acceptance '<how the observed behavior satisfies the FR/BUG>'
```

## Target: `firebase_hosting`

**Preconditions:** Use this for the Firebase-hosted marketing site or React admin console at
`$PRODUCTION_URL`. The approved notes must name the affected route and a
distinctive string from its committed output. Admin source changes must include
the generated `public/admin` bundle in the merged commit.

```bash
PROJECT_ADMIN_HOSTING_ROUTE="${PRODUCTION_URL}${ADMIN_PATH}/"
PROJECT_ADMIN_PROOF_PATTERN='<distinctive literal from the changed page or bundle>'

gtimeout 15m npm --prefix "$DEPLOY_WT/admin-app" ci
gtimeout 10m npm --prefix "$DEPLOY_WT/admin-app" test
gtimeout 10m npm --prefix "$DEPLOY_WT/admin-app" run build
gtimeout 2m git -C "$DEPLOY_WT" diff --exit-code -- public/admin
gtimeout 20m bash -c 'cd "$1" && exec firebase deploy --only hosting --project "$2"' _ "$DEPLOY_WT" "$PROJECT_ID"

PROJECT_ADMIN_HOSTING_INDEX="/tmp/${ITEM_REF}-hosting-index.html"
PROJECT_ADMIN_HOSTING_ASSET="/tmp/${ITEM_REF}-hosting-asset.js"
: > "$PROJECT_ADMIN_HOSTING_ASSET"
gtimeout 2m curl -fsSL "${PROJECT_ADMIN_HOSTING_ROUTE}?deploy=${MERGED_SHA}" -o "$PROJECT_ADMIN_HOSTING_INDEX"
PROJECT_ADMIN_ASSET_PATH="$(sed -nE 's/.*<script[^>]+src="([^"]+\.js)".*/\1/p' "$PROJECT_ADMIN_HOSTING_INDEX" | head -1)"
if [[ -n "$PROJECT_ADMIN_ASSET_PATH" ]]; then
  gtimeout 2m curl -fsSL "${PROJECT_ADMIN_ASSET_PATH}?deploy=${MERGED_SHA}" -o "$PROJECT_ADMIN_HOSTING_ASSET"
fi
gtimeout 2m rg -F "$PROJECT_ADMIN_PROOF_PATTERN" "$PROJECT_ADMIN_HOSTING_INDEX" "$PROJECT_ADMIN_HOSTING_ASSET"
```

**Proof:** Capture the Firebase deploy completion, the exact route, the served asset name,
and the matching literal in `--proof`. For a marketing-only change, omit the
admin install/test/build commands only when the PR has no `admin-app` or
`public/admin` files, and grep the changed marketing file served at the named
route. Known failures: expired Firebase login, a generated admin bundle that
differs from the committed bundle, or a stale CDN response. Re-authenticate only
if already authorized; otherwise `ask`. Cache-bust the live URL as shown.

## Target: `firebase_functions`

**Preconditions:** The approved notes must list the exact exported function names and the concrete
production behavior to exercise. Convert the names to Firebase's comma-separated
filter and do not deploy all functions when a narrower scope was approved.

```bash
PROJECT_ADMIN_FUNCTION_FILTER='functions:<name>,functions:<name>'
PROJECT_ADMIN_FUNCTION_NAMES=('<name>' '<name>')

gtimeout 15m npm --prefix "$DEPLOY_WT/functions" ci
gtimeout 10m npm --prefix "$DEPLOY_WT/functions" test
gtimeout 30m bash -c 'cd "$1" && exec firebase deploy --only "$2" --project "$3"' _ "$DEPLOY_WT" "$PROJECT_ADMIN_FUNCTION_FILTER" "$PROJECT_ID"
gtimeout 5m firebase functions:list --project "$PROJECT_ID" --json > "/tmp/${ITEM_REF}-functions.json"
for function_name in "${PROJECT_ADMIN_FUNCTION_NAMES[@]}"; do
  gtimeout 2m jq -e --arg name "$function_name" '.result[] | select(.id == $name or .entryPoint == $name)' "/tmp/${ITEM_REF}-functions.json"
done
```

**Proof:** After the revision check, run the exact HTTP/callable/event probe written in the
approved Verification section and capture its response or resulting Firestore
state. Function types do not share one safe universal probe, so a handoff that
only says “check the function” is incomplete and must be returned before merge.
Known failures: Cloud Build/IAM errors, missing function secrets, predeploy test
failure, or a function absent from `functions:list`. Retry only documented
transient Firebase quota/network failures; otherwise `ask`.

## Target: `firebase_rules_indexes`

**Preconditions:** Run the emulator security suite before the production deploy. This target always
deploys the committed Firestore rules and composite-index file together so the
authorization scope is explicit.

```bash
gtimeout 15m npm --prefix "$DEPLOY_WT/admin-app" ci
gtimeout 20m bash -c 'cd "$1" && exec firebase emulators:exec --only firestore,storage --project "demo-project-admin" "npm --prefix admin-app run test:rules"' _ "$DEPLOY_WT"
gtimeout 20m bash -c 'cd "$1" && exec firebase deploy --only firestore:rules,firestore:indexes --project "$2"' _ "$DEPLOY_WT" "$PROJECT_ID"
gtimeout 5m firebase firestore:indexes --project "$PROJECT_ID" > "/tmp/${ITEM_REF}-firestore-indexes.txt"
gtimeout 2m jq -e '.indexes | type == "array"' "/tmp/${ITEM_REF}-firestore-indexes.txt"
```

**Proof:** Record the passing emulator count, deploy completion, and the relevant live index
state. Then exercise the approved production allow/deny or indexed-query behavior
without weakening data. Known failures: missing Java/emulator binaries, a rules
test failure, an index still building, or insufficient IAM. An index in a build
state is not finished proof; hand the item back or keep polling within the turn.

## Target: `vercel`

**Preconditions:** The configured Vercel production URL is
`$VERCEL_PRODUCTION_URL`. Merging to `$DEFAULT_BRANCH` triggers the GitHub/Vercel
integration. Do not invent a local `vercel --prod` release. The approved notes
must name a live route and a distinctive literal or response assertion.

```bash
PROJECT_ADMIN_VERCEL_ROUTE="${VERCEL_PRODUCTION_URL}/api/<changed-route>"
PROJECT_ADMIN_PROOF_PATTERN='<distinctive literal or response value>'
export MERGED_SHA

gtimeout 20m bash -c '
  while :; do
    state="$(gh api "repos/${REPOSITORY_SLUG}/commits/${MERGED_SHA}/status" --jq '\''[.statuses[] | select(.context == "Vercel")][0].state // "pending"'\'')"
    case "$state" in success) exit 0 ;; error|failure) exit 1 ;; esac
    sleep 10
  done
'
gtimeout 2m gh api "repos/${REPOSITORY_SLUG}/commits/${MERGED_SHA}/status" --jq '[.statuses[] | select(.context == "Vercel")][0] | {state,target_url,updated_at}'
gtimeout 2m curl -fsSL "${PROJECT_ADMIN_VERCEL_ROUTE}?deploy=${MERGED_SHA}" -o "/tmp/${ITEM_REF}-vercel-response.txt"
gtimeout 2m rg -F "$PROJECT_ADMIN_PROOF_PATTERN" "/tmp/${ITEM_REF}-vercel-response.txt"
```

**Proof:** Include the successful Vercel status URL, merge SHA, production route,
and response assertion. A successful preview on the PR head is not production
proof. Known failures: no Vercel status on the merge SHA, a failed integration
status, an authentication error from the route, or a stale response. Return a
missing/failed status with `ask`; do not substitute the preview deployment.

## Target: `flutter_web`

**Preconditions:** Flutter web is served from `$VERCEL_PRODUCTION_URL`. During
implementation, the approved notes must provide the repository's canonical builder:

```bash
gtimeout 30m bash -lc '<approved Flutter web build command>'
```

That script runs the asset guard, rebuilds Flutter web, copies `build/web` to the
repository root, commits changed generated assets, pushes the branch, and starts
a Vercel deployment. The deploy loop must confirm those generated root assets
are in the approved PR; it does not rebuild a different bundle after review.
After merge, wait for the Vercel production status and compare the content hash
of the merged bundle with the cache-busted live bundle:

```bash
export MERGED_SHA
gtimeout 20m bash -c '
  while :; do
    state="$(gh api "repos/${REPOSITORY_SLUG}/commits/${MERGED_SHA}/status" --jq '\''[.statuses[] | select(.context == "Vercel")][0].state // "pending"'\'')"
    case "$state" in success) exit 0 ;; error|failure) exit 1 ;; esac
    sleep 10
  done
'
PROJECT_ADMIN_LOCAL_BUNDLE_MD5="$(gtimeout 2m md5 -q "$DEPLOY_WT/main.dart.js")"
PROJECT_ADMIN_LIVE_BUNDLE_MD5="$(gtimeout 5m curl -fsSL "${VERCEL_PRODUCTION_URL}/main.dart.js?deploy=${MERGED_SHA}" | md5)"
test "$PROJECT_ADMIN_LOCAL_BUNDLE_MD5" = "$PROJECT_ADMIN_LIVE_BUNDLE_MD5"
gtimeout 2m curl -fsSL "${VERCEL_PRODUCTION_URL}/<changed-route>?deploy=${MERGED_SHA}" -o "/tmp/${ITEM_REF}-flutter-web.html"
gtimeout 2m rg -F '<distinctive literal from the approved behavior>' "/tmp/${ITEM_REF}-flutter-web.html" "$DEPLOY_WT/main.dart.js"
```

**Proof:** Capture both MD5 values, the Vercel status URL, the exact changed route, and the
observed UI behavior. The equal content hashes prove the reviewed hashed bundle
is live; an HTTP 200 alone does not. Known failures: the PR omitted regenerated
root assets, the project build command committed unrelated files, the merge-SHA
Vercel status failed, or the live checksum differs. Hand back rather than
rebuilding or pushing unreviewed output from the deploy worktree.

## Target: `cloud_run`

**Preconditions:** This target may be approved only when the repository has a
deployable source and the approved notes name
the service, source directory, region, health path, and expected response. With
those values present, the canonical source deploy is:

```bash
PROJECT_ADMIN_CLOUD_RUN_SERVICE='<approved service name>'
PROJECT_ADMIN_CLOUD_RUN_SOURCE='<approved source directory relative to the repo root>'
PROJECT_ADMIN_CLOUD_RUN_REGION='<approved region>'
PROJECT_ADMIN_CLOUD_RUN_HEALTH_PATH='<approved health path>'
PROJECT_ADMIN_PROOF_PATTERN='<expected health/behavior literal>'

test -d "$DEPLOY_WT/$PROJECT_ADMIN_CLOUD_RUN_SOURCE"
gtimeout 30m gcloud run deploy "$PROJECT_ADMIN_CLOUD_RUN_SERVICE" \
  --source "$DEPLOY_WT/$PROJECT_ADMIN_CLOUD_RUN_SOURCE" \
  --region "$PROJECT_ADMIN_CLOUD_RUN_REGION" \
  --project "$PROJECT_ID" \
  --quiet
PROJECT_ADMIN_CLOUD_RUN_REVISION="$(gtimeout 5m gcloud run services describe "$PROJECT_ADMIN_CLOUD_RUN_SERVICE" --region "$PROJECT_ADMIN_CLOUD_RUN_REGION" --project "$PROJECT_ID" --format='value(status.latestReadyRevisionName)')"
PROJECT_ADMIN_CLOUD_RUN_URL="$(gtimeout 5m gcloud run services describe "$PROJECT_ADMIN_CLOUD_RUN_SERVICE" --region "$PROJECT_ADMIN_CLOUD_RUN_REGION" --project "$PROJECT_ID" --format='value(status.url)')"
gtimeout 2m curl -fsSL "${PROJECT_ADMIN_CLOUD_RUN_URL}${PROJECT_ADMIN_CLOUD_RUN_HEALTH_PATH}" -o "/tmp/${ITEM_REF}-cloud-run.txt"
gtimeout 2m rg -F "$PROJECT_ADMIN_PROOF_PATTERN" "/tmp/${ITEM_REF}-cloud-run.txt"
```

**Proof:** Include `latestReadyRevisionName`, service URL, and the behavior response.
If any variable is absent, if the service requires deploy flags beyond this
block, or while the repository still lacks its source, use `ask`; “run the
recorded canonical deploy” is not an acceptable substitute. Known failures:
Cloud Build, Artifact Registry, IAM, unauthenticated health endpoints, and a new
revision that never becomes ready.

## Target: `testflight`

**Preconditions:** TestFlight is always last when combined with other targets. Use an isolated
worktree at merged `origin/$DEFAULT_BRANCH`. The product client uses
`scripts/upload-testflight.sh`; the optional native admin wrapper uses
`scripts/upload-admin-testflight.sh`. The approved notes must provide the intended
bundle ID and say which app is intended.

```bash
PROJECT_ADMIN_COLLECTION='featureRequests' # or bugs
PROJECT_ADMIN_UPLOAD_SCRIPT='scripts/upload-testflight.sh'
PROJECT_ADMIN_BUNDLE_ID='<approved product bundle id>'
# For Project Admin instead use:
# PROJECT_ADMIN_UPLOAD_SCRIPT='scripts/upload-admin-testflight.sh'
# PROJECT_ADMIN_BUNDLE_ID='<configured native admin bundle id>'

if [[ "$PROJECT_ADMIN_UPLOAD_SCRIPT" == 'scripts/upload-testflight.sh' ]]; then
  gtimeout 10m bash -c 'cd "$1" && exec flutter pub get' _ "$DEPLOY_WT"
  gtimeout 20m bash -c 'cd "$1" && exec flutter build ios --config-only --release' _ "$DEPLOY_WT"
fi
gtimeout 10m "$DEPLOY_WT/$PROJECT_ADMIN_UPLOAD_SCRIPT" --check
gtimeout 10m scripts/agent-loops/launch-testflight.sh \
  "$PROJECT_ADMIN_COLLECTION" "$ITEM_ID" "$AGENT" "$DEPLOY_WT" \
  "$ITEM_REF — <title>" "$PROJECT_ADMIN_UPLOAD_SCRIPT" "$PROJECT_ADMIN_BUNDLE_ID"
```

The launcher uses a one-shot launchd service because a detached child owned by
the agent turn will be killed. Do not replace it with `setsid` (macOS has none)
or raw `nohup`. It moves the item to `waitingOn: hold`; autoship chooses a unique
timestamp build number, uploads, requires the upload marker, polls App Store
Connect to `VALID`, records TestFlight proof, removes the worktree, and returns
the item to `acceptance_review`.

**Proof:** Never call `ship` or `resolve` for a TestFlight item. `VALID` is delivery proof,
not the project owner's hands-on acceptance. Preserve the feature-specific acceptance request.
Logs are under `~/Library/Logs/ProjectAdminAgentLoops/`. Known failures: a fresh
worktree missing `ios/Flutter/ephemeral` because the two Flutter preparation
commands were skipped, a closed marketing-version train, missing App Store
Connect key, provisioning/capability errors, archive/export failure, missing
upload marker, concurrent upload lock, or a build that becomes
`INVALID`/`FAILED`. Vendor-framework dSYM upload warnings are benign unless
archive/export actually fails; autoship hands real failures back with its log
path.

## Target: `none`

**Preconditions:** `none` is exclusive and means the merge itself is the release. It still needs
merged-code and acceptance evidence. Run the item-specific focused tests from
the merged deploy worktree; do not substitute an environment-sensitive entire
agent-tool suite unless the approved change actually requires it.

```bash
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
gtimeout 2m git merge-base --is-ancestor "$MERGED_SHA" "origin/$DEFAULT_BRANCH"
gtimeout 2m git show --stat --oneline "$MERGED_SHA"
gtimeout 2m node "$ITEM_CLI" deploy-check "$ITEM_ID" --as "$AGENT" \
  --target none \
  --proof "Merged commit $MERGED_SHA is present on origin/$DEFAULT_BRANCH; no runtime surface is required." \
  --acceptance '<the merged tests/files that satisfy the FR/BUG without deployment>'
```

**Proof:** Record the merged commit, passing code-level verification, and why no
runtime surface is involved. Known failure: the PR file list actually changes a runtime surface. Correct the
target set through an `ask` handback instead of calling that change `none`.

## Console-only work is not a deployment target

Do not add `manual_console` to `deployment-contract.js`. Console work is not a
repeatable mechanical deploy. Before release, use `ask` and list the exact
console, project/app, clicks, field values, verification, and screenshot that
will prove completion. the project owner may pre-authorize that exact named console action in
the item thread; that message is sufficient authority and must not trigger a
duplicate approval question. Execute only the named action, capture a screenshot
URL plus the observed field values in the thread, then continue with the
separately approved mechanical targets. A new/different console action requires
a new handback.

## 3. Close, clean up, and continue

After every approved non-TestFlight target has a `deploy-check`, close the item:

```bash
gtimeout 2m node "$ITEM_CLI" ship "$ITEM_ID" --as "$AGENT" -m '<merge SHA, every target, proof, and end-to-end FR outcome>'
# For bugs use:
# gtimeout 2m node "$ITEM_CLI" resolve "$ITEM_ID" --as "$AGENT" -m '<merge SHA, every target, proof, and end-to-end BUG outcome>'
gtimeout 10m git worktree remove "$DEPLOY_WT"
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
```

The CLI rejects closure until every approved target has concrete proof and
contextual acceptance. Do not remove a TestFlight worktree after launch; autoship
owns it. Per-item failures use `ask` and then continue draining. Only a systemic
authentication or network failure stops the whole run.
