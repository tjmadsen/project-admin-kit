# Target: `fly`

Example of a deploy target that is not built in. It ships with the kit as
documentation only; nothing selects it until a project adds it to config. To
enable it, copy this file to `docs/deploy-targets/fly.md` (any repository path
works), then add the target to `project-admin.config.json`:

```json
"deployments": {
  "targets": {
    "firebase_hosting": {},
    "fly": { "label": "Fly.io", "runbook": "docs/deploy-targets/fly.md" }
  }
}
```

No code changes are needed: the backlog CLI accepts `--targets fly`, the admin
console offers "Fly.io" in its deployment target picker, and the deploy loop
reads this runbook whenever `fly` is in an approved set. Run
`node scripts/lib/deploy-targets.js check` to confirm the runbook path resolves.

**Preconditions:** The repository has a `fly.toml` for the app being released
and the release host has `flyctl` authenticated (`fly auth whoami`). The approved
notes must name the Fly app, a health or behavior route, and a distinctive
literal from the changed response. Never `fly deploy` from anywhere but the
merged deploy worktree.

```bash
PROJECT_ADMIN_FLY_APP='<approved Fly app name>'
PROJECT_ADMIN_FLY_ROUTE='<approved route, e.g. /healthz>'
PROJECT_ADMIN_PROOF_PATTERN='<expected literal from the approved behavior>'

test -f "$DEPLOY_WT/fly.toml"
gtimeout 2m fly auth whoami
gtimeout 30m bash -c 'cd "$1" && exec fly deploy --app "$2" --remote-only --strategy rolling' _ "$DEPLOY_WT" "$PROJECT_ADMIN_FLY_APP"
gtimeout 2m fly releases --app "$PROJECT_ADMIN_FLY_APP" --json > "/tmp/${ITEM_REF}-fly-releases.json"
gtimeout 2m jq -e '.[0] | select(.Status == "complete" or .status == "complete")' "/tmp/${ITEM_REF}-fly-releases.json"
gtimeout 2m curl -fsSL "https://${PROJECT_ADMIN_FLY_APP}.fly.dev${PROJECT_ADMIN_FLY_ROUTE}?deploy=${MERGED_SHA}" -o "/tmp/${ITEM_REF}-fly.txt"
gtimeout 2m rg -F "$PROJECT_ADMIN_PROOF_PATTERN" "/tmp/${ITEM_REF}-fly.txt"
```

**Proof:** Record the release version from `fly releases`, the merge SHA, the
exact route, and the matching literal with `deploy-check --target fly`. A
successful `fly deploy` exit without the live response check is not proof.
Known failures: an expired `flyctl` token, a remote builder timeout, a release
stuck in `running` or rolled back by failing health checks, and a response
served by the previous machine during a rolling deploy. Retry only a builder
timeout; anything else is an `ask` handback with the release log.
