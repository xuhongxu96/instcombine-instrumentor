#!/usr/bin/env bash
# Finalize a wasm publish run after all per-ref builds have staged their
# outputs:
#   1. Copy the staged outputs into the target branch worktree.
#   2. Prune older main-* snapshots (daily-main only) so the branch doesn't
#      grow unbounded.
#   3. Regenerate manifest.json from the directory listing.
#   4. Commit and push (unless DRY_RUN=true). A no-op (nothing staged) exits
#      cleanly so re-runs against an already-published ref don't error.
#
# Env:
#   MODE          — weekly-stable | daily-main | specific-ref (controls prune)
#   PRUNE_MAIN    — number of main-* snapshots to retain (daily-main only)
#   DRY_RUN       — "true" to skip the commit + push
#   REFS_FILE     — TSV of refs built this run (only column 1 is read; used
#                   for the commit subject)
#   GH_OWNER      — github.repository_owner — passed to manifest builder
#   GH_REPO       — github.event.repository.name — passed to manifest builder
#   STAGING_DIR   — directory containing <dirname>/{js,wasm,metadata.json} outputs
#   TARGET_BRANCH — branch to commit/push (default wasm-pkgs)
#   WORKTREE_PATH — target branch worktree path (default ./wasm-pkgs-branch)

set -euo pipefail

: "${MODE:?MODE required}"
: "${PRUNE_MAIN:?PRUNE_MAIN required}"
: "${DRY_RUN:?DRY_RUN required}"
: "${REFS_FILE:?REFS_FILE required}"
: "${GH_OWNER:?GH_OWNER required}"
: "${GH_REPO:?GH_REPO required}"
STAGING_DIR=${STAGING_DIR:-./wasm-publish-staging}
TARGET_BRANCH=${TARGET_BRANCH:-wasm-pkgs}
WORKTREE_PATH=${WORKTREE_PATH:-./wasm-pkgs-branch}

if [ -d "$STAGING_DIR" ]; then
    find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type d -print0 \
        | while IFS= read -r -d '' SRC; do
            DEST="$WORKTREE_PATH/$(basename "$SRC")"
            rm -rf "$DEST"
            mkdir -p "$DEST"
            cp -R "$SRC"/. "$DEST"/
        done
fi

if [ "$MODE" = "daily-main" ]; then
    pushd "$WORKTREE_PATH" >/dev/null
    # Newest first by directory name (lex sort works because format is
    # main-YYMMDD-...); drop everything beyond PRUNE_MAIN.
    mapfile -t SNAPS < <(find . -mindepth 1 -maxdepth 1 -type d -name 'main-*' -printf '%f\n' | sort -r)
    if [ "${#SNAPS[@]}" -gt "$PRUNE_MAIN" ]; then
        for OLD in "${SNAPS[@]:$PRUNE_MAIN}"; do
            echo "pruning $OLD"
            rm -rf "./$OLD"
        done
    fi
    popd >/dev/null
fi

node .github/scripts/wasm-publish/build_manifest.mjs \
    --owner "$GH_OWNER" \
    --repo "$GH_REPO" \
    --branch "$TARGET_BRANCH" \
    --root "$WORKTREE_PATH"

if [ "$DRY_RUN" = "true" ]; then
    echo "dry-run: would commit and push the changes below"
    echo "target_branch=$TARGET_BRANCH"
    echo "publish_dirs=$(cut -f1 "$REFS_FILE" | paste -sd, -)"
    git -C "$WORKTREE_PATH" status --short
    exit 0
fi

git -C "$WORKTREE_PATH" add -A
if git -C "$WORKTREE_PATH" diff --cached --quiet; then
    echo "Nothing to commit — manifest already matches."
    exit 0
fi
REFS=$(cut -f1 "$REFS_FILE" | paste -sd, -)
git -C "$WORKTREE_PATH" commit -m "publish: $REFS"
git -C "$WORKTREE_PATH" push origin "$TARGET_BRANCH"
