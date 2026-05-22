#!/usr/bin/env bash
# For each upstream LLVM tag passed on stdin (one per line, oldest first):
#   1. Create a detached commit that bumps llvm_commit.txt to that tag.
#   2. Tag it as release/<llvm-tag>.
#   3. Push the tag (push uses GITHUB_TOKEN; the push itself does NOT trigger
#      downstream workflows — that's intentional, see step 5).
#   4. Pre-create the GitHub Release so native-build.yml only attaches assets rather
#      than racing to create it.
#   5. Explicitly dispatch native-build.yml against the new tag ref via
#      `gh workflow run`. workflow_dispatch events fired by GITHUB_TOKEN DO
#      trigger workflows (unlike push/PR events), so this side-steps the need
#      for a PAT, deploy key, or GitHub App.
#
# These release tags carry only the native opt-llvm-*.tar.xz now — wasm builds
# moved to the wasm-pkgs branch (see wasm-publish.yml).
#
# Env:
#   DRY_RUN — "true" prints the plan without pushing or creating anything.
#   GH_TOKEN — must be set; the default GITHUB_TOKEN is sufficient.
#   GITHUB_REPOSITORY — passed by GitHub Actions; used as `gh --repo`.
#
# git is expected to already be configured with credentials (via
# `actions/checkout` `token:` input) so `git push` succeeds.

set -euo pipefail

DRY_RUN=${DRY_RUN:-false}
REPO=${GITHUB_REPOSITORY:?"GITHUB_REPOSITORY must be set"}

git config user.name "Hongxu Xu"
git config user.email "hongxu.xu@uwaterloo.ca"

while IFS= read -r LLVM_TAG; do
    [ -z "$LLVM_TAG" ] && continue
    REL_TAG="release/$LLVM_TAG"
    echo "=== $LLVM_TAG → $REL_TAG ==="
    if [ "$DRY_RUN" = "true" ]; then
        echo "dry-run: would create $REL_TAG and dispatch native-build.yml"
        continue
    fi
    git switch --detach origin/main
    printf '%s\n' "$LLVM_TAG" > llvm_commit.txt
    git add llvm_commit.txt
    git commit -m "auto: bump llvm to $LLVM_TAG"
    SHA=$(git rev-parse HEAD)
    git tag "$REL_TAG" "$SHA"
    git push origin "$REL_TAG"
    gh release create "$REL_TAG" \
        --repo "$REPO" \
        --target "$SHA" \
        --title "$LLVM_TAG" \
        --notes "Automated release tracking upstream LLVM $LLVM_TAG." \
        || echo "release $REL_TAG may already exist (continuing)"
    gh workflow run native-build.yml --repo "$REPO" --ref "refs/tags/$REL_TAG"
done
