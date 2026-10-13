# Changelog

Versions are recorded in `package.json` and `kit-manifest.json`; projects
record the version they were installed or upgraded from in
`.project-admin/kit-lock.json`. Upgrade with `npm run kit:upgrade`
([docs/UPGRADING.md](docs/UPGRADING.md)).

## 0.2.0

The kit is generalized from one project's operations console into a reusable
starter: almost every project-specific assumption is now configuration.

### Added

- **Configurable agents and runners.** `agents` in `project-admin.config.json`
  defines each loop agent (token, label, runner, model, `claimsUnassigned`,
  `pollSeconds`, `sandbox`, `usage`); `agentAliases` maps shorthands. Runner
  adapters for Codex, Claude, and Grok plus a generic `command` runner for any
  CLI (`scripts/agent-loops/runners/`). Unguarded runners are flagged in the
  loop log, the provisioner check, and the Agent Loops page.
- **Configurable work kinds.** `workKinds` defines kinds (feature, bug, task,
  or your own) with prefixes, routes, plan review, deploy behavior, runbooks,
  and statuses. Queues, rules, Functions, and iOS routes derive from it
  (`npm run sync:work-kinds`); tasks close with `close-no-deploy`.
- **Pluggable backlog backends.** `backend`: `firestore` (default), `local` (a
  JSON file with an atomic file lock and `npm run local`, a loopback-only
  console server), or `github` (Issues, labels, slash commands, best-effort
  claims). See [docs/BACKENDS.md](docs/BACKENDS.md).
- **Portable scheduling and notifications.** `automation.scheduler` runs loops
  on launchd, systemd user timers, cron, or the foreground `npm run loops`
  scheduler (also the entry point of `Dockerfile.loops`). `notifications` sends
  loop alerts to the desktop and/or a JSON, Slack, or ntfy webhook.
- **Configurable deploy targets.** `deployments.targets` maps each target to a
  label, a runbook in `docs/deploy-targets/`, and `requiresHumanAcceptance` /
  `enabled`; a new surface is a config entry plus a runbook
  (`docs/deploy-targets/examples/fly.md`). `verification-pending --target`
  returns any acceptance-gated target to human review.
- **Layouts.** `layout.productRoot` lets the kit live inside an existing product
  repository (embedded) or beside it as its own repository (separate);
  worktrees, branches, and PRs resolve against the product, and
  `project-env.js` exports `KIT_ROOT`, `PRODUCT_ROOT`, `KIT_SUBDIR`, and
  `LAYOUT`. `scripts/install-into.js` installs the kit either way
  ([docs/LAYOUTS.md](docs/LAYOUTS.md)).
- **Extras.** The lifecycle email/push Functions, the SwiftUI iOS shell, and the
  TestFlight tooling are optional under `extras/` with their own
  `npm run install:extras` / `npm run test:extras`
  ([extras/README.md](extras/README.md)).
- **Upgrade tooling.** `kit-manifest.json` separates kit-owned from
  project-owned files; `npm run kit:upgrade -- --from <git URL or path>
  [--ref <tag>] [--dry-run]` 3-way merges upstream changes against the base in
  `.project-admin/kit-lock.json`; `scripts/create-project-admin.js` (the
  package `bin`, for `npx github:<owner>/<repo> my-app`) scaffolds a configured
  project. Nothing is published to npm.

### Breaking changes

- **Work items moved to one collection.** `featureRequests` and `bugs` are
  replaced by `workItems` with a `kind` field. Run
  `npm run migrate:work-items -- --apply`, then deploy the new rules and
  console ([docs/UPGRADING.md](docs/UPGRADING.md#from-separate-featurerequestsbugs-collections-to-workitems)).
- **Notification function renamed.** `notifyFeatureLifecycle` and
  `notifyBugLifecycle` are replaced by `notifyWorkItemLifecycle`; deploy it and
  `firebase functions:delete notifyFeatureLifecycle notifyBugLifecycle`.
- **Scheduler jobs renamed.** launchd labels are now
  `com.projectadmin.<slug>.loop.*` (systemd `projectadmin-<slug>-loop-*`, a
  per-slug crontab block), and locks and logs carry the slug. Rerun
  `provision-machine.sh install` on each loop machine; it removes this
  checkout's old `com.projectadmin.loop.*` plists.
- **Deployments config shape.** `deployments` is now `{ "targets": { ... } }`.
  The old boolean map still loads with every built-in target enabled, as
  before; `node scripts/lib/deploy-targets.js migrate` prints the replacement.
- **Paths moved to `extras/`.** `functions/` → `extras/functions/`,
  `native-ios/` → `extras/native-ios/`, and the TestFlight scripts →
  `extras/testflight/`. Update `firebase.json`'s `functions.source` (it is
  project-owned, so the upgrade leaves it alone) and the gitignored
  `GoogleService-Info.plist` location. `npm run install:all` and `npm test` no
  longer include the Functions suite; use `install:extras` and `test:extras`.
- **Runbooks resolve the layout first.** The loop runbooks now start with
  `eval "$(node "${PROJECT_ADMIN_KIT_ROOT:-.}/scripts/project-env.js" shell)" && cd "$PRODUCT_ROOT"`
  and call kit CLIs as `"$KIT_ROOT/scripts/..."`. Custom runbooks that call
  `node scripts/...` keep working in the default layout only.
