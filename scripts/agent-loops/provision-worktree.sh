#!/usr/bin/env bash
# Give a fresh .agent-worktrees/ checkout the gitignored local state the primary
# checkout already has, so a loop agent can run the test matrix without an
# avoidable "worktrees lack node_modules" round trip.
#
#   scripts/agent-loops/provision-worktree.sh <worktree-path> [--dry-run]
#
# The worktree is a checkout of the product repository. The kit's own state
# (auth.env, its node_modules) lives under the kit's subdirectory of it
# (KIT_SUBDIR, docs/LAYOUTS.md: "." by default, "ops" when embedded); a kit in a
# separate repository runs from its own checkout, so only product state applies.
#
# Idempotent: safe to re-run when resuming a branch. --dry-run prints the plan
# (one "<action> <path>" line each) and changes nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KIT_SUBDIR="${PROJECT_ADMIN_KIT_SUBDIR-$(node "$SCRIPT_DIR/../project-env.js" value KIT_SUBDIR 2>/dev/null || echo .)}"
# Tests and automation may supply an isolated primary fixture. Otherwise the
# shared checkout owns the gitignored state, so resolve it from the common dir.
if [[ -n "${PROJECT_ADMIN_PRIMARY_ROOT:-}" ]]; then
  PRIMARY_ROOT="$(cd "$PROJECT_ADMIN_PRIMARY_ROOT" && pwd)"
else
  PRIMARY_ROOT="$(cd "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
fi

TARGET="${1:-}"
MODE="${2:-}"
[[ -n "$TARGET" ]] || { echo "Usage: $0 <worktree-path> [--dry-run]" >&2; exit 2; }
[[ -z "$MODE" || "$MODE" == "--dry-run" ]] || { echo "Usage: $0 <worktree-path> [--dry-run]" >&2; exit 2; }
DRY_RUN=0
[[ "$MODE" == "--dry-run" ]] && DRY_RUN=1

[[ -d "$TARGET" ]] || { echo "No such worktree: $TARGET" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"
[[ "$TARGET" != "$PRIMARY_ROOT" ]] || { echo "Refusing to provision the shared primary checkout" >&2; exit 1; }
[[ -e "$TARGET/.git" ]] || { echo "Not a git worktree: $TARGET" >&2; exit 1; }

# Gitignored local config the primary checkout owns. Missing entries are skipped
# rather than fatal, so this list can name optional credentials.
CONFIG_FILES=()
# Directories whose node_modules the worktree needs to run its suite.
NODE_PACKAGES=()
case "$KIT_SUBDIR" in
  "") ;;
  .) CONFIG_FILES=(auth.env); NODE_PACKAGES=(scripts admin-app extras/functions) ;;
  *) CONFIG_FILES=("$KIT_SUBDIR/auth.env"); NODE_PACKAGES=("$KIT_SUBDIR/scripts" "$KIT_SUBDIR/admin-app" "$KIT_SUBDIR/extras/functions") ;;
esac

plan() { printf '%s %s\n' "$1" "$2"; }

link_config() {
  local rel="$1" source="$PRIMARY_ROOT/$1" dest="$TARGET/$1"
  [[ -e "$source" ]] || { plan skip "$rel (absent in the primary checkout)"; return; }
  if [[ -L "$dest" && "$(readlink "$dest")" == "$source" ]]; then plan present "$rel"; return; fi
  plan symlink "$rel"
  (( DRY_RUN )) && return
  mkdir -p "$(dirname "$dest")"
  ln -sfn "$source" "$dest"
}

# Sharing node_modules is only safe when the worktree resolves the same tree, so
# compare lockfiles first and fall back to an isolated install when they differ.
provision_node_package() {
  local rel="$1" source="$PRIMARY_ROOT/$1/node_modules" dest="$TARGET/$1/node_modules"
  [[ -f "$TARGET/$1/package.json" ]] || { plan skip "$rel (no package.json)"; return; }
  if [[ -L "$dest" && "$(readlink "$dest")" == "$source" ]]; then plan present "$rel/node_modules"; return; fi
  if [[ -d "$dest" ]]; then plan present "$rel/node_modules"; return; fi
  if [[ -d "$source" ]] && cmp -s "$PRIMARY_ROOT/$1/package-lock.json" "$TARGET/$1/package-lock.json"; then
    plan symlink "$rel/node_modules"
    (( DRY_RUN )) || ln -sfn "$source" "$dest"
    return
  fi
  plan npm-ci "$rel/node_modules"
  (( DRY_RUN )) || (cd "$TARGET/$1" && npm ci --no-audit --no-fund >/dev/null)
}

provision_flutter() {
  [[ -f "$TARGET/pubspec.yaml" ]] || { plan skip "pubspec.yaml (absent)"; return; }
  if ! command -v flutter >/dev/null 2>&1; then plan skip "flutter pub get (flutter not on PATH)"; return; fi
  if [[ -f "$TARGET/.dart_tool/package_config.json" ]]; then plan present ".dart_tool/package_config.json"; return; fi
  plan flutter-pub-get "."
  (( DRY_RUN )) && return
  local before after file
  before="$(git -C "$TARGET" diff --name-only)"
  (cd "$TARGET" && flutter pub get >/dev/null)
  after="$(git -C "$TARGET" diff --name-only)"
  # pub get rewrites checked-in generated registrants, so name what it touched
  # instead of letting it ride along in the next commit unnoticed.
  while read -r file; do
    [[ -n "$file" ]] && plan regenerated "$file"
  done < <(comm -13 <(sort <<<"$before") <(sort <<<"$after"))
}

[[ -n "$KIT_SUBDIR" ]] || plan skip "kit packages (separate layout: the kit runs from its own checkout)"
# ${arr[@]+...}: an empty array is an unbound variable under set -u in bash 3.2.
for config in ${CONFIG_FILES[@]+"${CONFIG_FILES[@]}"}; do link_config "$config"; done
for package in ${NODE_PACKAGES[@]+"${NODE_PACKAGES[@]}"}; do provision_node_package "$package"; done
provision_flutter
