#!/usr/bin/env bash
# Finalize a wasm-publish.yml run after all per-ref builds have copied their
# outputs into the wasm-pkgs worktree:
#   1. Prune older main-* snapshots (daily-main only) so the branch doesn't
#      grow unbounded.
#   2. Regenerate manifest.json from the directory listing.
#   3. Commit and push (unless DRY_RUN=true). A no-op (nothing staged) exits
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
#   WASM_PKGS_DIR — wasm-pkgs worktree path (default ./wasm-pkgs-branch)

set -euo pipefail

: "${MODE:?MODE required}"
: "${PRUNE_MAIN:?PRUNE_MAIN required}"
: "${DRY_RUN:?DRY_RUN required}"
: "${REFS_FILE:?REFS_FILE required}"
: "${GH_OWNER:?GH_OWNER required}"
: "${GH_REPO:?GH_REPO required}"
WASM_PKGS_DIR=${WASM_PKGS_DIR:-./wasm-pkgs-branch}

if [ "$MODE" = "daily-main" ]; then
    pushd "$WASM_PKGS_DIR" >/dev/null
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
    --root "$WASM_PKGS_DIR"

if [ "$DRY_RUN" = "true" ]; then
    echo "dry-run: would commit and push the changes below"
    git -C "$WASM_PKGS_DIR" status --short
    exit 0
fi

git -C "$WASM_PKGS_DIR" add -A
if git -C "$WASM_PKGS_DIR" diff --cached --quiet; then
    echo "Nothing to commit — manifest already matches."
    exit 0
fi
REFS=$(cut -f1 "$REFS_FILE" | paste -sd, -)
git -C "$WASM_PKGS_DIR" commit -m "publish: $REFS"
git -C "$WASM_PKGS_DIR" push origin wasm-pkgs
