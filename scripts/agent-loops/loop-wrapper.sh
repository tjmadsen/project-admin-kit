#!/usr/bin/env bash
# launchd entry point for one headless loop iteration.
#
#   Usage: loop-wrapper.sh <sol|terra|luna|opus|sonnet|fable|grok|configured> <feature|bug|deploy>
#
# Every scheduled fire lands here instead of running run-loop.sh straight out of
# the shared primary checkout, which AGENTS.md forbids for build work: a loop
# that edits, resets, or leaves a dirty tree there corrupts whatever a human (or
# another agent) is doing in the same directory. Each (queue,token) pair gets a
# dedicated worktree under .agent-worktrees/loop-<queue>-<token>, reset to
# the configured origin branch on every fire so the run always uses the committed runner,
# prompts, and CLIs.
#
# NOT `set -e` beyond the argument checks: a failed iteration should be logged
# and retried on the next fire, never abort the schedule.
set -uo pipefail

TOKEN="${1:-}"
QUEUE="${2:-}"
case "$TOKEN" in sol|terra|luna|opus|sonnet|fable|grok|configured) ;; *) echo "Usage: $0 <sol|terra|luna|opus|sonnet|fable|grok|configured> <feature|bug|deploy>" >&2; exit 2 ;; esac
case "$QUEUE" in feature|bug|deploy) ;; *) echo "Usage: $0 <sol|terra|luna|opus|sonnet|fable|grok|configured> <feature|bug|deploy>" >&2; exit 2 ;; esac

# QoS fix. Every loop plist sets ProcessType=Background, which on Apple Silicon
# confines this process AND everything it spawns (run-loop.sh, the agent CLI,
# node, git) to the E-cores. Under load that starves the whole tree — `git
# status` took 185 s against ~0.1 s — and the CLI's own child processes miss
# their internal timeouts, so it spins instead of failing and holds the
# single-instance lock for hours. `taskpolicy -a` restores normal QoS for the
# whole tree; `taskpolicy -B` is NOT a substitute because it clears an explicit
# background policy rather than the inherited QoS class. Sentinel-guarded so the
# re-exec happens exactly once.
if [[ -z "${PROJECT_ADMIN_LOOP_QOS_FIXED:-}" ]] && command -v taskpolicy >/dev/null 2>&1; then
  export PROJECT_ADMIN_LOOP_QOS_FIXED=1
  exec taskpolicy -a "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -f "$REPO_ROOT/scripts/project-env.js" ]]; then
  DEFAULT_BRANCH="$(node "$REPO_ROOT/scripts/project-env.js" value DEFAULT_BRANCH)"
  STATE_DIRECTORY="$(node "$REPO_ROOT/scripts/project-env.js" value STATE_DIRECTORY)"
else
  DEFAULT_BRANCH="master"
  STATE_DIRECTORY=".project-admin"
fi
STATE_DIR="${PROJECT_ADMIN_LOOP_STATE_DIR:-$HOME/$STATE_DIRECTORY}"
WORKTREE="$REPO_ROOT/.agent-worktrees/loop-$QUEUE-$TOKEN"
LOCK="$STATE_DIR/$QUEUE-loop-$TOKEN.lock"
POLL_LOG="$STATE_DIR/logs/poll-$QUEUE-$TOKEN.log"

mkdir -p "$STATE_DIR" "$STATE_DIR/logs"
plog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $QUEUE/$TOKEN $*" | tee -a "$POLL_LOG"; }

# Single-instance guard per (queue,token). launchd fires on an interval whether
# or not the previous iteration finished; a long deploy run must not get a
# second copy of itself competing for the same worktree and claims.
if ! mkdir "$LOCK" 2>/dev/null; then
  plog "skip: a previous run still holds the lock."
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Create the dedicated worktree on first use, then refresh it to the configured branch
# so each fire runs the committed runner rather than whatever the last iteration
# happened to leave behind.
if [[ ! -d "$WORKTREE" ]]; then
  git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "origin/$DEFAULT_BRANCH" >>"$POLL_LOG" 2>&1 \
    || { plog "FATAL: could not create the loop worktree $WORKTREE"; exit 3; }
  plog "created loop worktree $WORKTREE"
fi
{
  git -C "$WORKTREE" fetch origin "$DEFAULT_BRANCH" -q || echo "warn: git fetch failed (using the existing checkout)"
  git -C "$WORKTREE" reset --hard FETCH_HEAD -q || echo "warn: git reset failed"
  git -C "$WORKTREE" clean -fdq || echo "warn: git clean failed"
} >>"$POLL_LOG" 2>&1

# The backlog CLIs and the admin build need dependencies that are gitignored, so
# a fresh worktree has none. Link them to the primary checkout's installs rather
# than running an npm install on every fire. provision-worktree.sh does the
# richer version of this for build worktrees; a scheduled loop deliberately
# stays npm-free so a lockfile drift cannot stall the schedule.
for rel in scripts/node_modules admin-app/node_modules; do
  if [[ -d "$REPO_ROOT/$rel" && ! -e "$WORKTREE/$rel" ]]; then
    mkdir -p "$(dirname "$WORKTREE/$rel")" && ln -sfn "$REPO_ROOT/$rel" "$WORKTREE/$rel"
  fi
done

plog "running run-loop.sh $TOKEN $QUEUE --once (HEAD $(git -C "$WORKTREE" rev-parse --short HEAD 2>/dev/null || echo unknown))"
"$WORKTREE/scripts/agent-loops/run-loop.sh" "$TOKEN" "$QUEUE" --once
rc=$?
plog "run-loop.sh $TOKEN $QUEUE finished (exit $rc)"
exit "$rc"
