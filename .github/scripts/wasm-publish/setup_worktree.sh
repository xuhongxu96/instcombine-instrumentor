#!/usr/bin/env bash
# Set up a worktree for the `wasm-pkgs` branch at $WORKTREE_PATH (default
# ./wasm-pkgs-branch). If the branch doesn't exist on origin yet, initialize it
# as an orphan with a README and an empty manifest.json so subsequent commits
# have something to base on.
#
# Run from inside a checkout of `main`.
#
# Env:
#   WORKTREE_PATH — where to place the worktree (default ./wasm-pkgs-branch)
#
# After this script runs the worktree is on the wasm-pkgs branch with the
# bot identity configured for committing.

set -euo pipefail

WORKTREE_PATH=${WORKTREE_PATH:-./wasm-pkgs-branch}

git config user.name "Hongxu Xu"
git config user.email "hongxu.xu@uwaterloo.ca"

if git ls-remote --exit-code origin wasm-pkgs >/dev/null 2>&1; then
    echo "Fetching existing wasm-pkgs branch from origin"
    git fetch --no-tags origin wasm-pkgs:wasm-pkgs 2>/dev/null || \
        git fetch --no-tags origin wasm-pkgs
    git worktree add "$WORKTREE_PATH" wasm-pkgs
else
    echo "wasm-pkgs branch missing on origin; initializing as orphan"
    git worktree add --detach "$WORKTREE_PATH"
    (
        cd "$WORKTREE_PATH"
        git switch --orphan wasm-pkgs
        # The detached worktree starts with main's files — clear them so the
        # orphan branch starts empty.
        git rm -rf . >/dev/null 2>&1 || true
        # Defensive: anything stray (e.g. untracked from main) shouldn't be
        # carried in.
        find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
        cat > README.md <<'EOF'
# wasm-pkgs

This branch is bot-managed by `.github/workflows/wasm-publish.yml`. Do not edit by
hand — any changes will be overwritten.

Each subdirectory contains an InstCombine instrumentor wasm build for a
specific LLVM version (`llvmorg-X.Y.Z[-rcN]/` for stable tags,
`main-<YYMMDD>-<sha12>/` for daily LLVM main snapshots). The `manifest.json`
at the root is fetched directly by the webapp at runtime via
`raw.githubusercontent.com`.
EOF
        cat > manifest.json <<EOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "defaultTag": null,
  "releases": []
}
EOF
        git add README.md manifest.json
        git commit -m "init wasm-pkgs"
    )
fi
