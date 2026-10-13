# Target: `testflight`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step; project values come from `scripts/project-env.js shell`.

**Preconditions:** TestFlight is always last when combined with other targets. Use an isolated
worktree at merged `origin/$DEFAULT_BRANCH`. The product client uses
`scripts/upload-testflight.sh`; the optional native admin wrapper uses
`scripts/upload-admin-testflight.sh`. The approved notes must provide the intended
bundle ID and say which app is intended.

```bash
PROJECT_ADMIN_COLLECTION='workItems'
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

**Proof:** Never call `complete` (or `ship`/`resolve`) for a TestFlight item. `VALID` is delivery proof,
not the project owner's hands-on acceptance. Preserve the feature-specific acceptance request.
Logs are under `~/Library/Logs/ProjectAdminAgentLoops/`. Known failures: a fresh
worktree missing `ios/Flutter/ephemeral` because the two Flutter preparation
commands were skipped, a closed marketing-version train, missing App Store
Connect key, provisioning/capability errors, archive/export failure, missing
upload marker, concurrent upload lock, or a build that becomes
`INVALID`/`FAILED`. Vendor-framework dSYM upload warnings are benign unless
archive/export actually fails; autoship hands real failures back with its log
path.
