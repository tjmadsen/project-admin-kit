# Optional extras

Everything under `extras/` is optional. The core kit (admin console, backlog
CLIs, agent loops, rules) never requires it: `npm run install:all` and
`npm test` skip it, and a kit installed with `scripts/install-into.js` without
`--with-extras` (see [docs/LAYOUTS.md](../docs/LAYOUTS.md)) does not contain it.
Delete an extra you do not use; `npm run configure` and
`npm run sync:work-kinds` skip any that is missing.

```bash
npm run install:extras   # npm ci for extras/functions (TestFlight has no dependencies)
npm run test:extras      # Functions and TestFlight suites
```

| Extra | What it is | Backend | Platform |
|---|---|---|---|
| [`functions/`](functions/README.md) | `notifyWorkItemLifecycle`: lifecycle email (SMTP) and FCM push for action-required and final-outcome transitions | firestore only | Firebase Cloud Functions (Node 20) |
| [`native-ios/`](native-ios/README.md) | SwiftUI shell around the admin console with native Google sign-in and push routing to work items | firestore only | iOS 17, Xcode, XcodeGen |
| `testflight/` | `upload-testflight.sh` (a Flutter product), `upload-admin-testflight.sh` (the iOS shell), `launch-testflight.sh` + `testflight-autoship.sh` (detached launchd release job), `asc-poll-build.js` (App Store Connect build polling) | any | macOS with Xcode; Flutter for the product upload |

## functions (firestore only)

The trigger watches Firestore `workItems/{itemId}`, so it cannot run on the
`local` or `github` backends; GitHub notifies issue watchers itself and the
local backend has no second user to notify. `firebase.json` points
`functions.source` at `extras/functions`; `npm run configure` writes its
`project-config.json` and `npm run sync:work-kinds` keeps its `workKinds` copy
in sync. Deploy it through the `firebase_functions` deploy target.

## native-ios (firestore only)

The shell signs in to Firebase Auth and checks the same `adminUsers` records as
the web console, and its push routing depends on the Functions extra. It needs a
`GoogleService-Info.plist` (gitignored) and XcodeGen.
`ProjectAdminConfig.json` is written by `npm run configure` and
`npm run sync:work-kinds`.

## testflight

Backs the `testflight` deploy target ([docs/deploy-targets/testflight.md](../docs/deploy-targets/testflight.md)),
which is disabled in the sample configuration. It works with every backend
because it reaches the backlog only through `scripts/work-agent.js`. It needs
macOS (launchd, `xcodebuild`, `PlistBuddy`) and the `PROJECT_ADMIN_ASC_*`,
`PROJECT_ADMIN_APPLE_TEAM_ID`, and bundle-id environment variables listed in
that runbook. The product upload builds the Flutter app at the product root
(`PROJECT_ADMIN_PRODUCT_ROOT`; the release worktree during a deploy).
