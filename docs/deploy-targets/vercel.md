# Target: `vercel`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step, as is `$DEPLOY_KIT` (the kit at the merged commit; the same
directory as `$DEPLOY_WT` unless the kit is embedded or separate,
`docs/LAYOUTS.md`); project values come from `$KIT_ROOT/scripts/project-env.js shell`.

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
