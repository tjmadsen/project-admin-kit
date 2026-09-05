# Setup guide

## Prerequisites

Install Node 20, Java 21, the Firebase CLI, Google Cloud CLI, Git, and GitHub CLI.
macOS loop runners also need Homebrew coreutils (`gtimeout`) and at least one
supported agent CLI. Xcode, Flutter, and XcodeGen are needed only for the
optional mobile release paths.

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
security rules. Later access changes happen in the Users screen.

## 3. Verify locally

Run `npm test`, `npm run test:rules`, and `npm run build`. Start the Hosting and
Firestore emulators for interactive work, or use `npm --prefix admin-app run dev`
against a development Firebase project.

## 4. Deploy

Deploy Hosting and security configuration only after tests pass. Lifecycle
notification Functions are optional. If enabled, configure `EMAIL_USER` and
`EMAIL_PASS` with `firebase functions:secrets:set`, then deploy only
`notifyFeatureLifecycle` and `notifyBugLifecycle`.

## 5. Provision automation

Install Codex, Claude, and/or Grok CLIs on a macOS runner. Update the enforcing
machine roster to include only the models and queues that host may run. Run the
provisioner check, then install its launchd jobs. The Agent Loops page will show
the first heartbeat and subsequent run history.

TestFlight is disabled in the sample configuration. To enable it, provide all
`PROJECT_ADMIN_ASC_*`, Apple team, and bundle-id environment variables; generate
the optional SwiftUI project with XcodeGen; and validate `--check` before adding
TestFlight to any approved target set.
