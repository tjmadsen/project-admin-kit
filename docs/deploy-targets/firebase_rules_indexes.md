# Target: `firebase_rules_indexes`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step, as is `$DEPLOY_KIT` (the kit at the merged commit; the same
directory as `$DEPLOY_WT` unless the kit is embedded or separate,
`docs/LAYOUTS.md`); project values come from `$KIT_ROOT/scripts/project-env.js shell`.

**Preconditions:** Run the emulator security suite before the production deploy. This target always
deploys the committed Firestore rules and composite-index file together so the
authorization scope is explicit.

```bash
gtimeout 15m npm --prefix "$DEPLOY_KIT/admin-app" ci
gtimeout 20m bash -c 'cd "$1" && exec firebase emulators:exec --only firestore,storage --project "demo-project-admin" "npm --prefix admin-app run test:rules"' _ "$DEPLOY_KIT"
gtimeout 20m bash -c 'cd "$1" && exec firebase deploy --only firestore:rules,firestore:indexes --project "$2"' _ "$DEPLOY_KIT" "$PROJECT_ID"
gtimeout 5m firebase firestore:indexes --project "$PROJECT_ID" > "/tmp/${ITEM_REF}-firestore-indexes.txt"
gtimeout 2m jq -e '.indexes | type == "array"' "/tmp/${ITEM_REF}-firestore-indexes.txt"
```

**Proof:** Record the passing emulator count, deploy completion, and the relevant live index
state. Then exercise the approved production allow/deny or indexed-query behavior
without weakening data. Known failures: missing Java/emulator binaries, a rules
test failure, an index still building, or insufficient IAM. An index in a build
state is not finished proof; hand the item back or keep polling within the turn.
