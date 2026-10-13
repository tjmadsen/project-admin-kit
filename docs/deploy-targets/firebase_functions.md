# Target: `firebase_functions`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step; project values come from `scripts/project-env.js shell`.

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
