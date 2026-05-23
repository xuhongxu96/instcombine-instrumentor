#!/usr/bin/env bash
# Set up a worktree for an artifact branch at $WORKTREE_PATH (default
# ./wasm-pkgs-branch). If the branch doesn't exist on origin yet, initialize it
# as an orphan with a README and an empty manifest.json so subsequent commits
# have something to base on.
#
# Run from inside a checkout of `main`.
#
# Env:
#   TARGET_BRANCH — branch to check out or initialize (default wasm-pkgs)
#   WORKTREE_PATH — where to place the worktree (default ./wasm-pkgs-branch)
#
# After this script runs the worktree is on TARGET_BRANCH with the
# bot identity configured for committing.

set -euo pipefail

TARGET_BRANCH=${TARGET_BRANCH:-wasm-pkgs}
WORKTREE_PATH=${WORKTREE_PATH:-./wasm-pkgs-branch}

git config user.name "Hongxu Xu"
git config user.email "hongxu.xu@uwaterloo.ca"

if git ls-remote --exit-code --heads origin "$TARGET_BRANCH" >/dev/null 2>&1; then
    echo "Fetching existing $TARGET_BRANCH branch from origin"
    git fetch --no-tags origin "$TARGET_BRANCH:$TARGET_BRANCH" 2>/dev/null || \
        git fetch --no-tags origin "$TARGET_BRANCH"
    git worktree add "$WORKTREE_PATH" "$TARGET_BRANCH"
else
    echo "$TARGET_BRANCH branch missing on origin; initializing as orphan"
    git worktree add --detach "$WORKTREE_PATH"
    (
        cd "$WORKTREE_PATH"
        git switch --orphan "$TARGET_BRANCH"
        # The detached worktree starts with main's files — clear them so the
        # orphan branch starts empty.
        git rm -rf . >/dev/null 2>&1 || true
        # Defensive: anything stray (e.g. untracked from main) shouldn't be
        # carried in.
        find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
        cat > README.md <<'EOF'
# $TARGET_BRANCH

This branch is bot-managed by the wasm publish workflows. Do not edit by hand
unless you also own the automation that writes here.

Each subdirectory contains an InstCombine instrumentor wasm build for a
specific LLVM source snapshot. Stable LLVM releases use `llvmorg-*` directories,
scheduled upstream snapshots use `main-<YYMMDD>-<sha12>`, and custom-source
builds use immutable `branch-*` / `commit-*` directories. The `manifest.json` at
the root is fetched directly by the webapp at runtime via raw.githubusercontent.com.
EOF
        cat > manifest.json <<EOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "defaultTag": null,
  "releases": []
}
EOF
        git add README.md manifest.json
        git commit -m "init $TARGET_BRANCH"
    )
fi
