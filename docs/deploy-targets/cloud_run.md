# Target: `cloud_run`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step; project values come from `scripts/project-env.js shell`.

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
