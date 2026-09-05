#!/usr/bin/env bash
# Detached TestFlight upload that returns an item for hands-on acceptance.
# Usage: testflight-autoship.sh <featureRequests|bugs> <docId> <agent> <worktree> [label] [upload-script] [bundle-id]
set -uo pipefail

[[ "$#" -ge 4 ]] || { echo "Usage: $0 <featureRequests|bugs> <docId> <agent> <worktree> [label] [upload-script] [bundle-id]" >&2; exit 2; }
COLLECTION="$1"; DOC_ID="$2"; AGENT_TOKEN="$3"; BUILD_WORKTREE="$4"; LABEL="${5:-$DOC_ID}"
UPLOAD_SCRIPT="${6:-scripts/upload-testflight.sh}"
BUNDLE_ID="${7:-${PROJECT_ADMIN_IOS_BUNDLE_ID:-}}"
[[ -n "$BUNDLE_ID" ]] || { echo "Missing bundle id argument or PROJECT_ADMIN_IOS_BUNDLE_ID" >&2; exit 2; }
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIRECTORY="$(node "$REPO_ROOT/scripts/project-env.js" value STATE_DIRECTORY)"
LOG_DIRECTORY_NAME="$(node "$REPO_ROOT/scripts/project-env.js" value LOG_DIRECTORY_NAME)"
BUILD_NUMBER="$(date +%y%m%d%H%M)"
LOG_DIR="$HOME/Library/Logs/$LOG_DIRECTORY_NAME"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/testflight-${DOC_ID}-${BUILD_NUMBER}.log"
LOCK_DIR="${PROJECT_ADMIN_TESTFLIGHT_LOCK_DIR:-$HOME/$STATE_DIRECTORY/testflight-lock}"
mkdir -p "$(dirname "$LOCK_DIR")"

case "$COLLECTION" in
  featureRequests) CLI="$REPO_ROOT/scripts/feature-agent.js" ;;
  bugs) CLI="$REPO_ROOT/scripts/bug-agent.js" ;;
  *) echo "Invalid collection $COLLECTION" >&2; exit 2 ;;
esac

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }
release_lock() { if [[ -d "$LOCK_DIR" ]] && [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" == "$$" ]]; then rm -rf "$LOCK_DIR"; fi; }
remove_launch_job() {
  if [[ -n "${PROJECT_ADMIN_TESTFLIGHT_JOB_LABEL:-}" ]]; then
    launchctl bootout "gui/$(id -u)/$PROJECT_ADMIN_TESTFLIGHT_JOB_LABEL" >/dev/null 2>&1 || true
  fi
}
cleanup_worktree() {
  if [[ -d "$BUILD_WORKTREE" ]]; then git -C "$REPO_ROOT" worktree remove --force "$BUILD_WORKTREE" >>"$LOG_FILE" 2>&1 || log "Could not remove $BUILD_WORKTREE"; fi
}
hand_back() {
  log "HAND BACK: $1"
  node "$CLI" ask "$DOC_ID" --as "$AGENT_TOKEN" -m "TestFlight release blocked: $1. Log: $LOG_FILE" >>"$LOG_FILE" 2>&1 || true
  cleanup_worktree
  exit 1
}
cleanup_upload_output() { if [[ -n "${UPLOAD_OUTPUT:-}" ]]; then rm -f "$UPLOAD_OUTPUT"; fi; }
trap 'release_lock; remove_launch_job; cleanup_upload_output' EXIT

case "$UPLOAD_SCRIPT" in
  scripts/upload-testflight.sh|scripts/upload-admin-testflight.sh) ;;
  *) hand_back "unsupported TestFlight upload script: $UPLOAD_SCRIPT" ;;
esac

log "Starting TestFlight build $BUILD_NUMBER for $LABEL with $UPLOAD_SCRIPT"
[[ -x "$BUILD_WORKTREE/$UPLOAD_SCRIPT" ]] || hand_back "release worktree is missing $UPLOAD_SCRIPT"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [[ -f "$LOCK_DIR/pid" ]] && ! kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" || hand_back "could not acquire TestFlight lock";
  else hand_back "another TestFlight upload is already running"; fi
fi
echo "$$" > "$LOCK_DIR/pid"

UPLOAD_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/project-admin-testflight-upload.XXXXXX")"
(cd "$BUILD_WORKTREE" && "./$UPLOAD_SCRIPT" "$BUILD_NUMBER") 2>&1 | tee -a "$LOG_FILE" >"$UPLOAD_OUTPUT"
UPLOAD_STATUS="${PIPESTATUS[0]}"
upload_failure_detail() { grep -v '^[[:space:]]*$' "$UPLOAD_OUTPUT" | tail -1 | cut -c1-300; }
[[ "$UPLOAD_STATUS" -eq 0 ]] || hand_back "archive or upload failed (exit $UPLOAD_STATUS): $(upload_failure_detail)"
# Never trust the exit status alone: macOS bash 3.2 reported 0 after the upload
# script died on an unbound variable, and this loop then polled App Store
# Connect for 45 minutes for a build that was never uploaded. The upload script
# prints PROJECT_ADMIN_TESTFLIGHT_BUILD=<n> only after xcodebuild accepted the export.
grep -q "^PROJECT_ADMIN_TESTFLIGHT_BUILD=${BUILD_NUMBER}\$" "$UPLOAD_OUTPUT" \
  || hand_back "upload script exited 0 without confirming build $BUILD_NUMBER was uploaded: $(upload_failure_detail)"
cleanup_upload_output
release_lock
log "Upload accepted; waiting for App Store Connect processing"
PROJECT_ADMIN_IOS_BUNDLE_ID="$BUNDLE_ID" node "$REPO_ROOT/scripts/agent-loops/asc-poll-build.js" "$BUILD_NUMBER" 45 60 >>"$LOG_FILE" 2>&1
POLL_STATUS=$?
[[ "$POLL_STATUS" -eq 0 ]] || hand_back "build $BUILD_NUMBER did not reach VALID (poll exit $POLL_STATUS)"

RESULT="TestFlight build $BUILD_NUMBER is VALID in App Store Connect. Please test it; this item remains open until acceptance."
node "$CLI" verification-pending "$DOC_ID" --as "$AGENT_TOKEN" --build "$BUILD_NUMBER" -m "$RESULT" >>"$LOG_FILE" 2>&1 || hand_back "build is valid but the acceptance handoff failed"
log "$RESULT"
cleanup_worktree
