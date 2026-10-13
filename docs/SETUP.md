# Setup guide

## Prerequisites

Install Node 20, Java 21, the Firebase CLI, Google Cloud CLI, Git, and GitHub CLI.
Loop runners need GNU coreutils (`brew install coreutils` on macOS for
`gtimeout`; Linux distributions ship `timeout`) and at least one supported
agent CLI. Xcode, Flutter, and XcodeGen are needed only for the
optional mobile release paths.

Choose the backlog store first: the default `firestore` backend (below), a
`local` JSON store for one person on one machine, or `github` Issues. Only
Firestore needs a Firebase project; [BACKENDS.md](BACKENDS.md) gives the setup
for the other two, and the rest of this guide applies to all three except
where it names Firebase.

## 1. Create Firebase resources

Create a Firebase project, a Web app, Firestore, Storage, and a Hosting site.
Enable Google in Authentication → Sign-in method. Copy the Web app values into
the `npm run configure` command shown in the root README.

The configuration command updates:

- `project-admin.config.json` for the web console and Node tools;
- `.firebaserc` and `firebase.json` for deployment;
- `functions/project-config.json` for notification branding;
- `native-ios/ProjectAdminConfig.json` for the optional wrapper;
- the machine roster and placeholder marketing page.

## 2. Install and bootstrap

Run `npm run install:all`, authenticate Application Default Credentials with
`gcloud auth application-default login`, then run `npm run bootstrap-admin`.
The owner email from project configuration becomes the first active admin.

This bootstrap step uses server credentials and intentionally bypasses client
rules; it solves the first-admin problem without embedding an owner email in
security rules. Later access changes happen in the Users screen. With the
local backend the same command writes the owner record and counters to the
local store; with the github backend it only explains that repository
collaborators are the access list.

## 3. Verify locally

Run `npm test`, `npm run test:rules`, and `npm run build`. Start the Hosting and
Firestore emulators for interactive work, or use `npm --prefix admin-app run dev`
against a development Firebase project.

## 4. Deploy

Deploy Hosting and security configuration only after tests pass. Lifecycle
notification Functions are optional. If enabled, configure `EMAIL_USER` and
`EMAIL_PASS` with `firebase functions:secrets:set`, then deploy only
`notifyWorkItemLifecycle`.

## 5. Choose work kinds

`workKinds` in `project-admin.config.json` lists the backlog kinds the console,
CLIs, and loops offer. The sample ships `feature`, `bug`, and `task` (a kind
with `deploys: false` that closes after its PR merges). Add, remove, or rename
kinds there (see the field table in [ARCHITECTURE.md](ARCHITECTURE.md#work-kinds)),
give each one a runbook and a `scripts/agent-loops/<id>-loop-prompt.md` shim,
then run `npm run sync:work-kinds` and redeploy rules and Functions. Delete the
key entirely to get only the built-in feature + bug pair.

## 6. Provision automation

Install the CLIs your configured `agents` use (Codex, Claude, and Grok by
default; any other CLI through the `command` runner, see
`scripts/agent-loops/runners/README.md`) on a runner host. Update the enforcing
machine roster to include only the models and queues that host may run. Run the
provisioner check, then install its jobs: launchd on macOS and systemd user
timers on Linux by default, or set `automation.scheduler` to `cron` or
`foreground` (`npm run loops`, also the entry point of `Dockerfile.loops`). See
`scripts/agent-loops/README.md` for each scheduler, containers, and the
`notifications` block (desktop and Slack/ntfy/JSON webhooks). The Agent Loops
page will show the first heartbeat and subsequent run history.

Add each scheduled kind to that host's `queues` in the machine roster; the valid
queue names are printed by `node scripts/lib/work-kinds.js queues`.

## 7. Choose deploy targets

`deployments.targets` in `project-admin.config.json` lists the release surfaces
the console offers and the deploy loop may execute; each one points at a
runbook (see [ARCHITECTURE.md](ARCHITECTURE.md#deploy-targets)). The sample
enables Firebase Hosting, Functions, and rules/indexes and lists the other
built-ins with `"enabled": false`. To add a surface the kit does not ship, write
a runbook modeled on [`deploy-targets/examples/fly.md`](deploy-targets/examples/fly.md),
add `"<id>": { "label": "...", "runbook": "..." }`, and run
`node scripts/lib/deploy-targets.js check`.

TestFlight is disabled in the sample configuration. To enable it, provide all
`PROJECT_ADMIN_ASC_*`, Apple team, and bundle-id environment variables; generate
the optional SwiftUI project with XcodeGen; validate `--check`; then set
`"testflight": {}` (it keeps `requiresHumanAcceptance: true`) before adding
TestFlight to any approved target set.

## Upgrading

### From boolean `deployments` flags to `deployments.targets`

The earlier `"deployments": { "firebaseHosting": true, ... }` map still loads
and keeps every built-in target available, as before. To make the flags real,
print the equivalent `targets` map and paste it over the old block:

```bash
node scripts/lib/deploy-targets.js migrate
```

Each `false` becomes `"enabled": false`, which hides that target from the
console picker and rejects it in new `deploy-pending --targets`; items that
already recorded it keep resolving.

### From separate `featureRequests`/`bugs` collections to `workItems`

Earlier releases stored each kind in its own collection. All kinds now live in
one `workItems` collection with a `kind` field. Counter fields are unchanged
(`nextFeatureNumber`, `nextBugNumber`), so numbering continues.

1. Pause the loops (`scripts/agent-loops/provision-machine.sh uninstall`, or
   stop `npm run loops`) so nothing writes the legacy collections mid-copy.
2. Preview the copy, then apply it with Application Default Credentials:

   ```bash
   npm run migrate:work-items            # dry run: prints what would be copied
   npm run migrate:work-items -- --apply # copies into workItems
   ```

   Each document keeps its id (so `dependsOn` links still resolve), gains
   `kind` and a `migratedFrom` marker, and is never overwritten if it already
   exists. Re-running is safe; a non-zero exit lists id conflicts to resolve by
   hand. The legacy collections are left untouched for rollback.
3. Deploy the new rules and console:
   `firebase deploy --only hosting,firestore:rules,storage --project <id>`.
4. If lifecycle notifications are enabled, deploy `notifyWorkItemLifecycle`
   and delete the old triggers:
   `firebase functions:delete notifyFeatureLifecycle notifyBugLifecycle`.
   Migrated copies carry `migratedFrom`, so they do not send notifications.
5. Reload the loops (`provision-machine.sh install`). Once you are satisfied, delete the legacy collections from
   the Firebase console.
