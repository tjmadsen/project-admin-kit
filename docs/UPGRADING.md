# Upgrading the kit

A project made from the kit (a template fork, a `create-project-admin`
scaffold, or an `install-into.js` copy) owns its copy outright, so upstream
fixes do not arrive by themselves. `npm run kit:upgrade` brings them in with a
3-way merge, without npm publishing or any package registry: the upstream is
just a git URL or a local checkout.

```bash
git status                                     # start clean; the upgrade refuses a dirty kit
npm run kit:upgrade -- --from https://github.com/<owner>/project-admin-kit.git --ref v0.3.0 --dry-run
npm run kit:upgrade -- --from https://github.com/<owner>/project-admin-kit.git --ref v0.3.0
npm run sync:work-kinds && npm run install:all && npm test
git add -A && git commit -m "Upgrade Project Admin Kit to 0.3.0"
```

`--from` defaults to the source recorded at install time; `--ref` takes a tag,
branch, or commit (default: the upstream's default branch). A local path
without `--ref` is read in place, uncommitted files included, which is handy
for trying a kit change before pushing it.

## What is kit-owned

`kit-manifest.json` at the kit root lists globs:

- **kitOwned**: scripts, the console source, runbooks (`.claude/commands/`),
  docs (including the built-in `docs/deploy-targets/` runbooks), rules,
  `extras/`, `AGENTS.md`, `package.json`, the config schema, and CI.
- **projectOwned**: `project-admin.config.json`, `.firebaserc`,
  `firebase.json`, `scripts/agent-loops/machine-roster.json`, `public/`
  (marketing page and generated bundle), `README.md`, the extras' generated
  configs, and `.project-admin/`. These are never read or written by an
  upgrade, even when upstream changes its template copy.
- **exclude**: generated or machine-local paths (`node_modules`, logs,
  worktrees, credentials) that are never copied.

A file you add yourself (a custom deploy-target runbook, a new kind's runbook,
a project script) is in neither the lock nor upstream, so upgrades never touch
it. To protect an edited kit file wholesale, add it to `projectOwned` in your
`kit-manifest.json`; the local manifest's lists are honored alongside the
upstream's.

## How the merge works

`.project-admin/kit-lock.json` (commit it) records the kit version, the
upstream source and commit, whether extras were installed, and the git blob id
of every kit-owned file as it came from upstream. For each kit-owned path:

| Local file vs. lock | Upstream vs. lock | Result |
|---|---|---|
| unchanged | changed | take upstream (`updated`) |
| changed | unchanged | keep yours (`kept local edit`) |
| changed | changed | `git merge-file` with the lock's blob (read from the upstream clone) as the base: `merged`, or `CONFLICT` with `<<<<<<< local` / `>>>>>>> upstream` markers |
| absent | new upstream | `added` |
| unchanged | removed upstream | `removed` |
| changed | removed upstream | kept and reported |
| deleted by you | unchanged upstream | left deleted |
| deleted by you | changed upstream | reported as a conflict, nothing written |

Binary files changed on both sides keep your copy and get the upstream one
beside it as `<file>.upstream`. Any conflict makes the command exit 1 after
applying everything else and listing the files to resolve. The lock is then
rewritten to the new upstream versions, so the next upgrade merges from here.
`--dry-run` prints the same plan and writes nothing.

Layouts (docs/LAYOUTS.md) need nothing special: paths are relative to the kit
directory, so an embedded kit at `ops/` upgrades in place and nothing outside
it is touched.

Limits: the base is found by blob id in the upstream repository, so a history
rewrite that drops those blobs (or a lock written from uncommitted upstream
files) turns both-sides changes into whole-file conflicts. A project with no
lock (forked before 0.2.0) is treated the same way; after resolving once, the
new lock makes later upgrades precise. Renames upstream look like a removal
plus an addition. The upgrade does not run `npm run sync:work-kinds`,
`npm ci`, migrations, or a console rebuild; do those afterwards and read
`CHANGELOG.md` for breaking changes.

## Starting a project with the scaffolder

```bash
node /path/to/project-admin-kit/scripts/create-project-admin.js my-app \
  --name "My App" --backend local --owner-email you@example.com --repo you/my-app
# later, without cloning first (nothing is published to npm):
npx github:<owner>/project-admin-kit my-app --name "My App" ...
```

It copies the kit (extras included unless `--no-extras`), records the lock,
runs `git init` (unless `--no-git`), and passes every other flag to
`npm run configure`. Pass `--source <git-url>` to record where later upgrades
come from when the kit was not cloned from that URL.

## Release-specific migrations

### 0.2.0: extras/

`functions/`, `native-ios/`, and the TestFlight scripts moved under `extras/`.
`firebase.json` is project-owned, so update its Functions source by hand:
`"functions": { "source": "extras/functions", ... }` (or delete the block if
you do not use Functions). A TestFlight item approved with
`scripts/upload-testflight.sh` still resolves (`launch-testflight.sh` accepts
the old path), but the runbook now calls `extras/testflight/`.

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

### Scheduler job names

Loop jobs are namespaced by `project.slug` (`com.projectadmin.<slug>.loop.*`,
`projectadmin-<slug>-loop-*`, and a per-slug crontab block). Run
`scripts/agent-loops/provision-machine.sh install` once on every loop machine;
on macOS it also removes this checkout's pre-namespacing
`com.projectadmin.loop.*` plists.
