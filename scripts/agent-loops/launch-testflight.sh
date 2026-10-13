#!/usr/bin/env bash
# Launch one TestFlight autoship as a macOS one-shot service so it survives the
# deploy agent's process group. The service gets an explicit tool PATH because
# launchd does not inherit the interactive shell environment.
set -euo pipefail

[[ "$#" -ge 4 ]] || { echo "Usage: $0 <workItems> <docId> <agent> <worktree> [label] [upload-script] [bundle-id]" >&2; exit 2; }
COLLECTION="$1"; DOC_ID="$2"; AGENT_TOKEN="$3"; ITEM_LABEL="${5:-$DOC_ID}"
UPLOAD_SCRIPT="${6:-scripts/upload-testflight.sh}"
BUNDLE_ID="${7:-${PROJECT_ADMIN_IOS_BUNDLE_ID:-}}"
[[ -n "$BUNDLE_ID" ]] || { echo "Missing bundle id argument or PROJECT_ADMIN_IOS_BUNDLE_ID" >&2; exit 2; }
BUILD_WORKTREE="$(cd "$4" && pwd)" || { echo "Release worktree does not exist: $4" >&2; exit 2; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
RUNTIME_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ "$UPLOAD_SCRIPT" == 'scripts/upload-testflight.sh' ]]; then
  FLUTTER_BIN="$(command -v flutter)"
  RUNTIME_PATH="$(dirname "$FLUTTER_BIN"):$RUNTIME_PATH"
fi
JOB_SUFFIX="$(date +%y%m%d%H%M%S)"
JOB_LABEL="com.projectadmin.testflight.${JOB_SUFFIX}"
LOG_DIR="$HOME/Library/Logs/ProjectAdminAgentLoops"
if [[ -f "$SCRIPT_DIR/../project-env.js" ]]; then
  LOG_DIR="$HOME/Library/Logs/$(node "$SCRIPT_DIR/../project-env.js" value LOG_DIRECTORY_NAME)"
fi
LAUNCH_LOG="$LOG_DIR/testflight-${DOC_ID}-launcher-${JOB_SUFFIX}.log"
PLIST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/project-admin-testflight-launch.XXXXXX")"
PLIST_PATH="$PLIST_DIR/$JOB_LABEL.plist"
mkdir -p "$LOG_DIR"
trap 'rm -rf "$PLIST_DIR"' EXIT

# Every kind lives in workItems; the legacy collection names are accepted so a
# launch recorded before the migration still resolves. The CLI reads the kind
# from the document itself.
case "$COLLECTION" in
  workItems|featureRequests|bugs) CLI="$SCRIPT_DIR/../work-agent.js" ;;
  *) echo "Invalid collection $COLLECTION" >&2; exit 2 ;;
esac

# Move the item out of the claimable deploy queue before the detached upload
# begins. Autoship will return it to human acceptance (or ask with a blocker).
node "$CLI" deployment-started "$DOC_ID" --as "$AGENT_TOKEN" --target testflight \
  -m "TestFlight upload is running as a detached macOS release job for $ITEM_LABEL."

plutil -create xml1 "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :Label string $JOB_LABEL" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool false" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LAUNCH_LOG" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LAUNCH_LOG" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $RUNTIME_PATH" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_TESTFLIGHT_JOB_LABEL string $JOB_LABEL" "$PLIST_PATH"
: "${PROJECT_ADMIN_ASC_KEY_ID:?Set PROJECT_ADMIN_ASC_KEY_ID}"
: "${PROJECT_ADMIN_ASC_ISSUER_ID:?Set PROJECT_ADMIN_ASC_ISSUER_ID}"
: "${PROJECT_ADMIN_APPLE_TEAM_ID:?Set PROJECT_ADMIN_APPLE_TEAM_ID}"
PROJECT_ADMIN_ASC_KEY_PATH="${PROJECT_ADMIN_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${PROJECT_ADMIN_ASC_KEY_ID}.p8}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_ASC_KEY_ID string $PROJECT_ADMIN_ASC_KEY_ID" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_ASC_ISSUER_ID string $PROJECT_ADMIN_ASC_ISSUER_ID" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_ASC_KEY_PATH string $PROJECT_ADMIN_ASC_KEY_PATH" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_APPLE_TEAM_ID string $PROJECT_ADMIN_APPLE_TEAM_ID" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_IOS_BUNDLE_ID string $BUNDLE_ID" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PROJECT_ADMIN_ADMIN_BUNDLE_ID string $BUNDLE_ID" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST_PATH"
for ARGUMENT in "$SCRIPT_DIR/testflight-autoship.sh" "$COLLECTION" "$DOC_ID" "$AGENT_TOKEN" "$BUILD_WORKTREE" "$ITEM_LABEL" "$UPLOAD_SCRIPT" "$BUNDLE_ID"; do
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments: string $ARGUMENT" "$PLIST_PATH"
done

plutil -lint "$PLIST_PATH" >/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

sleep 3
launchctl print "gui/$(id -u)/$JOB_LABEL" | grep -Eq 'state = running|pid = [0-9]+' || {
  launchctl bootout "gui/$(id -u)/$JOB_LABEL" >/dev/null 2>&1 || true
  echo "TestFlight service did not remain running. See $LAUNCH_LOG" >&2
  tail -20 "$LAUNCH_LOG" >&2 || true
  exit 1
}
rm -rf "$PLIST_DIR"
trap - EXIT
echo "PROJECT_ADMIN_TESTFLIGHT_JOB=$JOB_LABEL"
echo "PROJECT_ADMIN_TESTFLIGHT_LAUNCH_LOG=$LAUNCH_LOG"
