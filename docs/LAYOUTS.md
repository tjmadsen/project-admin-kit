# Layouts: where the kit lives

The kit needs two things from a repository: somewhere to keep its own files
(console, CLIs, runbooks, rules) and a product repository whose branches, PRs,
and worktrees its agents work on. `layout.productRoot` in
`project-admin.config.json` says how the two relate:

```jsonc
{ "layout": { "productRoot": "." } }              // self (default when absent)
{ "layout": { "productRoot": ".." } }             // embedded in <product>/ops/
{ "layout": { "productRoot": "../my-app" } }      // separate, beside the product
{ "layout": { "productRoot": "/srv/src/my-app" } }
```

`productRoot` is relative to the kit directory (where the kit's
`project-admin.config.json` lives) or absolute; `~/` expands to your home
directory. `node scripts/project-env.js` reports the result:

| Value | Meaning |
|---|---|
| `LAYOUT` | `self`, `embedded`, or `separate` |
| `KIT_ROOT` | the kit directory: CLIs, runbooks, config |
| `PRODUCT_ROOT` | the product checkout: git operations, `.agent-worktrees/`, the agent's working directory |
| `KIT_SUBDIR` | the kit's path inside a product checkout: `.` (self), e.g. `ops` (embedded), empty (separate) |

`PROJECT_ADMIN_PRODUCT_ROOT` overrides `PRODUCT_ROOT` for one process; the loop
wrapper uses it to point a separate kit at a loop worktree, and the TestFlight
extra uses it to point an upload at a release worktree.

## self (default)

The kit is the product repository: clone or scaffold the kit
(`node scripts/create-project-admin.js my-app`) and keep the app's code in it.
`KIT_ROOT` and `PRODUCT_ROOT` are the same directory, and everything behaves as
it always has.

## embedded: the kit in a subdirectory of an existing product

```bash
node /path/to/project-admin-kit/scripts/install-into.js ~/src/my-app --dir ops [--with-extras]
cd ~/src/my-app/ops && npm run configure -- --repo me/my-app ... && npm run install:all
git -C ~/src/my-app add ops .gitignore && git -C ~/src/my-app commit -m "Add Project Admin"
```

The installer copies the kit (no `node_modules`, `.git`, generated admin bundle,
or `extras/` unless `--with-extras`), writes `"layout": { "productRoot": ".." }`
(`"../.."` for a nested `--dir`), adds `.agent-worktrees/` to the product's
`.gitignore`, and records `.project-admin/kit-lock.json` for later upgrades.

- Loop worktrees and build/release worktrees are checkouts of the product
  repository at `<product>/.agent-worktrees/...`. Each carries its own copy of
  the kit at `<worktree>/ops`, so a loop runs the kit as committed on the
  default branch: commit the kit before installing the loops.
- The agent starts in the worktree root (`PRODUCT_ROOT`) with
  `PROJECT_ADMIN_KIT_ROOT=<worktree>/ops`; runbooks call
  `"$KIT_ROOT/scripts/..."` and create worktrees under `"$PRODUCT_ROOT/.agent-worktrees/"`.
- Kit changes ride in product PRs like any other code, and the deploy loop's
  `$DEPLOY_KIT` is `<release worktree>/ops`.
- The kit's `.github/workflows/ci.yml` sits in `ops/.github/` where GitHub does
  not look; copy the jobs you want into the product's workflow with
  `working-directory: ops`. Claude Code finds slash commands only in the
  product's `.claude/commands/`; link `ops/.claude/commands/*.md` there if you
  run the loops' runbooks interactively.

## separate: the kit as its own repository

```bash
node /path/to/project-admin-kit/scripts/install-into.js ~/src/my-app --mode separate [--dir ~/src/my-app-admin]
cd ~/src/my-app-admin && git init && npm run configure -- --repo me/my-app ... && npm run install:all
```

The kit lands in `--dir` (default: a sibling `<product>-admin`) with
`productRoot` pointing at the product checkout. Keep the two checkouts in the
same relative position on every loop machine, or use an absolute path.

- Loop worktrees are still product checkouts under
  `<product>/.agent-worktrees/`, but the kit is not inside them: `loop-wrapper.sh`
  runs this kit checkout's `run-loop.sh` with `PROJECT_ADMIN_PRODUCT_ROOT` set to
  the loop worktree. Loops therefore run the kit as it is in this checkout;
  keep it on a clean, committed branch.
- `provision-worktree.sh` provisions only product state (Flutter) in build
  worktrees; the kit's dependencies are the kit checkout's own.
- `repository.slug` is the product repository (PRs, `gh`). The kit repository
  has its own history and CI; kit changes are not product PRs, and the deploy
  loop's `$DEPLOY_KIT` is the kit checkout itself.

## The admin bundle and hosting in each layout

`npm run build` (in the kit) always writes the console to the kit's
`public/<adminPath>`, and the kit's `firebase.json` serves `public/` with
rewrites for `adminPath`. How it reaches users depends on who owns hosting:

| Layout | Kit's own hosting (default) | Under the product's hosting |
|---|---|---|
| self | `firebase deploy --only hosting` from the repository; the marketing page is `public/index.html` | the same thing: the kit is the product |
| embedded | deploy from `ops/` (its `firebase.json`, `.firebaserc`), e.g. to a separate Hosting site or project; `firebase_hosting` runs from `$DEPLOY_KIT` | build the console with `adminPath` set to the path the product serves it at (e.g. `/admin`), copy or symlink `ops/public/admin` into the product's static output in the product's build, and add an SPA rewrite for `adminPath/**` to the product's `index.html`; release it with the product's own deploy target and drop `firebase_hosting` from `deployments.targets` |
| separate | deploy from the kit checkout to its own site or project; the product never sees the console | as embedded, but the product's build fetches the bundle from the kit checkout (or a CI artifact) |

The console is a static SPA whose `base` is `adminPath`, so it works from any
static host that rewrites `adminPath/**` to its `index.html` and sends
`Cache-Control: no-cache` for that file (the kit's `firebase.json` shows both).
With the firestore backend the host's domain must be an authorized domain in
Firebase Authentication. The local backend serves the bundle itself
(`npm run local`) in every layout; the github backend builds a pointer page
only.

## Moving between layouts

Layouts change no data. To embed an existing kit checkout into a product,
copy it in with `install-into.js` (or move the directory and set
`productRoot`), rerun `npm run configure` (it rewrites `machine-roster.json`'s
`repoRoot`), then `provision-machine.sh install` so the scheduler units point at
the new kit path. Remove old `.agent-worktrees/loop-*` checkouts with
`git worktree remove`.
