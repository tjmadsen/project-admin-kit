# Target: `none`

Deploy-target runbook read by the deploy loop (`.claude/commands/deploy-loop.md`)
for every approved release that names this target. `$DEPLOY_WT`, `$ITEM_REF`,
`$ITEM_ID`, `$AGENT`, `$ITEM_CLI`, and `$MERGED_SHA` come from that runbook's
merge step; project values come from `scripts/project-env.js shell`.

**Preconditions:** `none` is exclusive and means the merge itself is the release. It still needs
merged-code and acceptance evidence. Run the item-specific focused tests from
the merged deploy worktree; do not substitute an environment-sensitive entire
agent-tool suite unless the approved change actually requires it.

```bash
gtimeout 2m git fetch origin "$DEFAULT_BRANCH"
gtimeout 2m git merge-base --is-ancestor "$MERGED_SHA" "origin/$DEFAULT_BRANCH"
gtimeout 2m git show --stat --oneline "$MERGED_SHA"
gtimeout 2m node "$ITEM_CLI" deploy-check "$ITEM_ID" --as "$AGENT" \
  --target none \
  --proof "Merged commit $MERGED_SHA is present on origin/$DEFAULT_BRANCH; no runtime surface is required." \
  --acceptance '<the merged tests/files that satisfy the item without deployment>'
```

**Proof:** Record the merged commit, passing code-level verification, and why no
runtime surface is involved. Known failure: the PR file list actually changes a runtime surface. Correct the
target set through an `ask` handback instead of calling that change `none`.
