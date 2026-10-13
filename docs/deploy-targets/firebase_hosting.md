# Target: `firebase_hosting`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step, as is `$DEPLOY_KIT` (the kit at the merged commit; the same
directory as `$DEPLOY_WT` unless the kit is embedded or separate,
`docs/LAYOUTS.md`); project values come from `$KIT_ROOT/scripts/project-env.js shell`.

**Preconditions:** Use this for the Firebase-hosted marketing site or React admin console at
`$PRODUCTION_URL`. The approved notes must name the affected route and a
distinctive string from its committed output. Admin source changes must include
the generated `public/<adminPath>` bundle in the merged commit. This deploys the
kit's `firebase.json` (from `$DEPLOY_KIT`); when the console is hosted by the
product instead, follow the product's own hosting target (`docs/LAYOUTS.md`).

```bash
PROJECT_ADMIN_HOSTING_ROUTE="${PRODUCTION_URL}${ADMIN_PATH}/"
PROJECT_ADMIN_PROOF_PATTERN='<distinctive literal from the changed page or bundle>'

gtimeout 15m npm --prefix "$DEPLOY_KIT/admin-app" ci
gtimeout 10m npm --prefix "$DEPLOY_KIT/admin-app" test
gtimeout 10m npm --prefix "$DEPLOY_KIT/admin-app" run build
gtimeout 2m git -C "$DEPLOY_KIT" diff --exit-code -- "public${ADMIN_PATH}"
gtimeout 20m bash -c 'cd "$1" && exec firebase deploy --only hosting --project "$2"' _ "$DEPLOY_KIT" "$PROJECT_ID"

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
