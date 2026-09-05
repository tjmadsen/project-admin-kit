# Project Admin iOS app

This is an optional native SwiftUI shell around the configured React admin
console. It performs Google sign-in natively, signs in to Firebase Auth, verifies
the same dynamic `adminUsers` access records used by the web
app, and injects the fresh Google credential into the WKWebView. Native sign-in
avoids Google's embedded-webview OAuth restriction.

After an authorized admin or collaborator signs in, the app asks for notification
permission without blocking access to the console. An approved device registers
its Firebase Cloud Messaging token in the private `pushDeviceTokens` collection,
refreshes it when Firebase rotates the token, and removes it before sign-out.
Foreground alerts remain visible, and tapping a lifecycle alert opens the exact
BUG or FR inside the embedded admin console.

- Bundle ID: set `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml`
- Minimum iOS: 17.0
- Firebase project: the project configured in `GoogleService-Info.plist`
- Apple team: set `DEVELOPMENT_TEAM` in `project.yml`
- TestFlight upload: `scripts/upload-admin-testflight.sh`

## Build locally

Generate the Xcode project from `project.yml` with XcodeGen:

```sh
xcodegen generate --spec native-ios/project.yml --project native-ios --project-root native-ios
xcodebuild -project native-ios/ProjectAdmin.xcodeproj -scheme ProjectAdmin \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Download the Firebase iOS app's `GoogleService-Info.plist` into `native-ios/`.
Push delivery additionally requires the Push Notifications capability for the
chosen bundle ID and a valid APNs authentication key in Firebase Cloud Messaging.
Email remains the fallback when permission is denied or push is unavailable.

## First TestFlight release

The first release needs an App Store Connect app for the chosen bundle ID:

1. Register the bundle ID in Apple Developer if automatic signing has not
   already created it.
2. In App Store Connect, create an iOS app for the admin wrapper using that
   bundle ID and a project-specific SKU.
3. Keep the feature open for hands-on acceptance after TestFlight processing.

After that one-time registration, the approved deploy loop can run:

```sh
./scripts/upload-admin-testflight.sh <unique-numeric-build-number>
```

Lifecycle push delivery is released with the affected Firestore rules and Cloud
Functions before TestFlight. TestFlight processing is delivery proof only; the
bug stays open until a real-device alert reaches the expected recipient, opens
the matching work item, and the corresponding email still arrives.
