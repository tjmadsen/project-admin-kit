# Project Admin Kit

Project Admin Kit turns a new app repository into a polished operations control
room: an admin site, configurable work-item lifecycles (feature requests,
bugs, tasks, or your own kinds),
fresh-context coding-agent loops, run monitoring, human approval gates, and
auditable releases.

It is a starter repository rather than only a UI package because the useful
system crosses six boundaries: React, access control, backlog data, headless
CLI agents, loop scheduling (launchd, systemd, cron, or a portable foreground
scheduler), and deployment runbooks. The backlog store is pluggable: Firestore
(default, multi-user dashboard), a local JSON file (single user, no cloud
account), or GitHub Issues (no dashboard); see
[docs/BACKENDS.md](docs/BACKENDS.md). Clone or use it
as a GitHub template for each product, then keep the app's own code in the same
repository so isolated agent worktrees and PR release proofs remain coherent.

## Included

- Responsive React/Vite dashboard with dark mode and mobile detail navigation.
- Configurable work kinds (feature requests, bugs, and tasks by default),
  dependencies, priorities, attachments, threaded
  conversations, model/effort/machine routing, PR review, deploy approval, and
  acceptance actions.
- Dynamic admin/collaborator access management in the `adminUsers` collection.
- Agent-loop cards, provider usage, machine health, live progress, run history,
  stale-run recovery, and deploy-model selection.
- Firestore and Storage rules plus emulator tests.
- Backlog CLIs over a pluggable store (Firestore, local file, or GitHub
  Issues) and configurable loop agents: Codex, Claude, and Grok
  runner adapters out of the box, plus a generic `command` runner for any other
  CLI (`agents` in `project-admin.config.json`).
- Human-gated Firebase Hosting, Functions, rules/indexes, Vercel, Flutter web,
  Cloud Run, and TestFlight runbooks; deploy targets are configuration
  (`deployments.targets`), so a new surface is a config entry plus a runbook.
- Optional extras in `extras/`: lifecycle email/push Functions, a SwiftUI iOS
  admin shell, and TestFlight release tooling ([extras/README.md](extras/README.md)).
- CI, screenshot harness, configuration/bootstrap tooling, and a placeholder
  marketing page.

## Start a new project

```bash
git clone <this-repository> my-new-app
cd my-new-app
npm run configure -- \
  --name "My New App" \
  --firebase-project my-new-app-prod \
  --api-key '<firebase-web-api-key>' \
  --messaging-sender-id '<sender-id>' \
  --app-id '<web-app-id>' \
  --production-url 'https://my-new-app.example' \
  --owner-email 'you@example.com' \
  --owner-name 'Your name' \
  --repo 'your-org/my-new-app'
npm run install:all
gcloud auth application-default login
npm run bootstrap-admin
npm test
npm run test:rules
npm run build
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage --project my-new-app-prod
```

Without Firebase, use `npm run configure -- --backend local ...` (then
`npm run bootstrap-admin`, `npm run build`, `npm run local`) or
`--backend github`; [docs/BACKENDS.md](docs/BACKENDS.md) has both setups.

In Firebase Console, enable Google authentication and add the production domain
to authorized domains. The bootstrap command creates the owner access record,
counters, default routing, and deploy-loop configuration. After that, add and
revoke people from **Admin → Users**.

See [docs/SETUP.md](docs/SETUP.md) for the full first-run checklist and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data and trust model.

## Local development

```bash
npm --prefix admin-app run dev
npm --prefix admin-app test
npm run test:extras          # optional extras/ (Functions, TestFlight)
npm --prefix scripts test
```

The console builds into `public/<adminPath>`. Firebase Hosting serves the
marketing site at `/` and rewrites the configured admin path to the SPA.

## Agent loops

```bash
scripts/agent-loops/provision-machine.sh check
scripts/agent-loops/provision-machine.sh install   # launchd on macOS, systemd on Linux
scripts/agent-loops/provision-machine.sh status
npm run loops                                      # or run them in the foreground / Docker
```

`automation.scheduler` selects launchd, systemd, cron, or foreground, and
`notifications` routes loop alerts to the desktop and/or a Slack, ntfy, or JSON
webhook. Edit `scripts/agent-loops/machine-roster.json` when using more than one machine.
Each scheduled queue/model pair gets a dedicated worktree and lock. All human
decisions live in the work-item thread; all releases require an immutable
approved target list and concrete verification evidence.

## Security

Firebase web configuration is intentionally public client configuration. Do not
commit service-account keys, Gmail app passwords, App Store Connect private
keys, `GoogleService-Info.plist`, or `auth.env`. The `.gitignore` excludes these.
Use Firebase secrets for `EMAIL_USER` and `EMAIL_PASS`.
