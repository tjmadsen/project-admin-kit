# Target: `flutter_web`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step; project values come from `scripts/project-env.js shell`.

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
