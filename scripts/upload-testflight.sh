#!/usr/bin/env bash
# Build and upload the repository's Flutter product to TestFlight.
# Usage: scripts/upload-testflight.sh [unique-build-number]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRODUCT_ROOT="${PROJECT_ADMIN_PRODUCT_ROOT:-$REPO_ROOT}"
REQUESTED_BUILD="${1:-}"
BUILD_NUMBER="${REQUESTED_BUILD:-$(date +%y%m%d%H%M)}"
API_KEY_ID="${PROJECT_ADMIN_ASC_KEY_ID:?Set PROJECT_ADMIN_ASC_KEY_ID}"
API_ISSUER_ID="${PROJECT_ADMIN_ASC_ISSUER_ID:?Set PROJECT_ADMIN_ASC_ISSUER_ID}"
API_KEY_PATH="${PROJECT_ADMIN_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${API_KEY_ID}.p8}"
TEAM_ID="${PROJECT_ADMIN_APPLE_TEAM_ID:?Set PROJECT_ADMIN_APPLE_TEAM_ID}"
APP_BUNDLE_ID="${PROJECT_ADMIN_IOS_BUNDLE_ID:?Set PROJECT_ADMIN_IOS_BUNDLE_ID}"
[[ -f "$PRODUCT_ROOT/pubspec.yaml" ]] || { echo "Missing Flutter product pubspec.yaml at $PRODUCT_ROOT" >&2; exit 1; }
APP_VERSION="$(sed -nE 's/^version:[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$PRODUCT_ROOT/pubspec.yaml" | head -1)"

[[ -f "$API_KEY_PATH" ]] || { echo "App Store Connect key not found at $API_KEY_PATH" >&2; exit 1; }
[[ -f "$PRODUCT_ROOT/ios/Runner.xcworkspace/contents.xcworkspacedata" ]] || { echo "Missing iOS workspace" >&2; exit 1; }
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not read a three-part app version from pubspec.yaml" >&2; exit 1; }
command -v flutter >/dev/null || { echo "Flutter is not installed" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "Xcode command-line tools are not installed" >&2; exit 1; }

if [[ "$REQUESTED_BUILD" == "--check" ]]; then
  node "$REPO_ROOT/scripts/agent-loops/asc-poll-build.js" --check
  xcodebuild -workspace "$PRODUCT_ROOT/ios/Runner.xcworkspace" -scheme Runner -list >/dev/null
  echo "TestFlight preflight passed for $APP_BUNDLE_ID"
  exit 0
fi

[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "Build number must contain only digits" >&2; exit 2; }

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/project-testflight.XXXXXX")"
ARCHIVE_PATH="$BUILD_DIR/ProjectApp.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"
EXPORT_OPTIONS_PATH="$BUILD_DIR/ExportOptions.plist"
sed "s/REPLACE_WITH_APPLE_TEAM_ID/$TEAM_ID/g" "$REPO_ROOT/scripts/ExportOptions.plist" > "$EXPORT_OPTIONS_PATH"
cleanup() { rm -rf "$BUILD_DIR"; }
# macOS /bin/bash is 3.2, which reports status 0 inside an EXIT trap after a
# fatal shell error (for example an unbound variable under set -u). A plain
# `trap cleanup EXIT` therefore let a crashed run exit 0 and look like a
# successful upload. Any exit that never reached the final UPLOAD_COMPLETE=1
# line is a failure.
UPLOAD_COMPLETE=0
finish() {
  status=$?
  cleanup
  if [[ "$status" -eq 0 && "$UPLOAD_COMPLETE" -ne 1 ]]; then status=1; fi
  exit "$status"
}
trap finish EXIT

# PROJECT_ADMIN_FLUTTER_DART_DEFINE accepts one optional KEY=VALUE define. Add
# project-specific flags in the product repository when more are required.
DART_DEFINES=()
if [[ -n "${PROJECT_ADMIN_FLUTTER_DART_DEFINE:-}" ]]; then
  DART_DEFINES+=("--dart-define=$PROJECT_ADMIN_FLUTTER_DART_DEFINE")
  echo "Flutter define: $PROJECT_ADMIN_FLUTTER_DART_DEFINE"
fi

echo "Preparing Flutter iOS release build $BUILD_NUMBER..."
cd "$PRODUCT_ROOT"
flutter pub get
# "${DART_DEFINES[@]}" on an empty array is an unbound-variable error in bash
# 3.2 under set -u; the ${arr[@]+"${arr[@]}"} form expands to nothing instead.
flutter build ios --config-only --release --build-name "$APP_VERSION" --build-number "$BUILD_NUMBER" ${DART_DEFINES[@]+"${DART_DEFINES[@]}"}

echo "Archiving product build $BUILD_NUMBER..."
xcodebuild -workspace "$PRODUCT_ROOT/ios/Runner.xcworkspace" \
  -scheme Runner \
  -sdk iphoneos \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  MARKETING_VERSION="$APP_VERSION" \
  FLUTTER_BUILD_NAME="$APP_VERSION" \
  FLUTTER_BUILD_NUMBER="$BUILD_NUMBER" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$API_KEY_ID" \
  -authenticationKeyIssuerID "$API_ISSUER_ID" \
  archive

ARCHIVED_INFO="$ARCHIVE_PATH/Products/Applications/Runner.app/Info.plist"
[[ -f "$ARCHIVED_INFO" ]] || { echo "Archive is missing Runner.app/Info.plist" >&2; exit 1; }
ARCHIVED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ARCHIVED_INFO")"
[[ "$ARCHIVED_VERSION" == "$APP_VERSION" ]] || {
  echo "Refusing upload: archived version $ARCHIVED_VERSION does not match pubspec version $APP_VERSION" >&2
  exit 1
}

echo "Uploading version $APP_VERSION build $BUILD_NUMBER to App Store Connect..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PATH" \
  -exportPath "$EXPORT_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$API_KEY_ID" \
  -authenticationKeyIssuerID "$API_ISSUER_ID"

echo "PROJECT_ADMIN_TESTFLIGHT_BUILD=$BUILD_NUMBER"
echo "Upload accepted by App Store Connect. Processing continues in TestFlight."
UPLOAD_COMPLETE=1
