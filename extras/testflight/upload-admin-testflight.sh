#!/usr/bin/env bash
# Build and upload the optional Project Admin iOS wrapper to TestFlight.
# Usage: extras/testflight/upload-admin-testflight.sh [unique-build-number]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NATIVE_DIR="$KIT_ROOT/extras/native-ios"
REQUESTED_BUILD="${1:-}"
BUILD_NUMBER="${REQUESTED_BUILD:-$(date +%y%m%d%H%M)}"
API_KEY_ID="${PROJECT_ADMIN_ASC_KEY_ID:?Set PROJECT_ADMIN_ASC_KEY_ID}"
API_ISSUER_ID="${PROJECT_ADMIN_ASC_ISSUER_ID:?Set PROJECT_ADMIN_ASC_ISSUER_ID}"
API_KEY_PATH="${PROJECT_ADMIN_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${API_KEY_ID}.p8}"
TEAM_ID="${PROJECT_ADMIN_APPLE_TEAM_ID:?Set PROJECT_ADMIN_APPLE_TEAM_ID}"
APP_VERSION="${PROJECT_ADMIN_ADMIN_APP_VERSION:-1.0.0}"
BUNDLE_ID="${PROJECT_ADMIN_ADMIN_BUNDLE_ID:?Set PROJECT_ADMIN_ADMIN_BUNDLE_ID}"
NATIVE_PROJECT="${PROJECT_ADMIN_NATIVE_PROJECT:-$NATIVE_DIR/ProjectAdmin.xcodeproj}"
NATIVE_SCHEME="${PROJECT_ADMIN_NATIVE_SCHEME:-ProjectAdmin}"

[[ -f "$API_KEY_PATH" ]] || { echo "App Store Connect key not found at $API_KEY_PATH" >&2; exit 1; }
[[ -d "$NATIVE_PROJECT" ]] || { echo "Missing $NATIVE_PROJECT; run xcodegen in extras/native-ios first" >&2; exit 1; }
[[ -f "$NATIVE_DIR/GoogleService-Info.plist" ]] || { echo "Missing extras/native-ios/GoogleService-Info.plist" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "Xcode command-line tools are not installed" >&2; exit 1; }

if [[ "$REQUESTED_BUILD" == "--check" ]]; then
  PROJECT_ADMIN_IOS_BUNDLE_ID="$BUNDLE_ID" node "$SCRIPT_DIR/asc-poll-build.js" --check
  xcodebuild -project "$NATIVE_PROJECT" -scheme "$NATIVE_SCHEME" -list >/dev/null
  echo "TestFlight preflight passed for $BUNDLE_ID"
  exit 0
fi

[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "Build number must contain only digits" >&2; exit 2; }
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Admin app version must use x.y.z" >&2; exit 2; }

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/project-admin-testflight.XXXXXX")"
ARCHIVE_PATH="$BUILD_DIR/ProjectAdmin.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"
EXPORT_OPTIONS_PATH="$BUILD_DIR/ExportOptions.plist"
sed "s/REPLACE_WITH_APPLE_TEAM_ID/$TEAM_ID/g" "$SCRIPT_DIR/ExportOptions.plist" > "$EXPORT_OPTIONS_PATH"
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

echo "Resolving Project Admin packages..."
xcodebuild -resolvePackageDependencies \
  -project "$NATIVE_PROJECT" \
  -scheme "$NATIVE_SCHEME"

echo "Archiving Project Admin version $APP_VERSION build $BUILD_NUMBER..."
xcodebuild -project "$NATIVE_PROJECT" \
  -scheme "$NATIVE_SCHEME" \
  -sdk iphoneos \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  MARKETING_VERSION="$APP_VERSION" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$API_KEY_ID" \
  -authenticationKeyIssuerID "$API_ISSUER_ID" \
  archive

ARCHIVED_INFO="$ARCHIVE_PATH/Products/Applications/${NATIVE_SCHEME}.app/Info.plist"
[[ -f "$ARCHIVED_INFO" ]] || { echo "Archive is missing ${NATIVE_SCHEME}.app/Info.plist" >&2; exit 1; }
ARCHIVED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ARCHIVED_INFO")"
[[ "$ARCHIVED_VERSION" == "$APP_VERSION" ]] || {
  echo "Refusing upload: archived version $ARCHIVED_VERSION does not match $APP_VERSION" >&2
  exit 1
}

echo "Uploading Project Admin build $BUILD_NUMBER to App Store Connect..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PATH" \
  -exportPath "$EXPORT_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$API_KEY_PATH" \
  -authenticationKeyID "$API_KEY_ID" \
  -authenticationKeyIssuerID "$API_ISSUER_ID"

echo "PROJECT_ADMIN_TESTFLIGHT_BUILD=$BUILD_NUMBER"
echo "Project Admin upload accepted. Processing continues in TestFlight."
UPLOAD_COMPLETE=1
