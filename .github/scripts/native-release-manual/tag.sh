#!/usr/bin/env bash
# Create a single release/<tag> in this repo whose commit bumps llvm_commit.txt
# to the given LLVM ref, then dispatch native-build.yml against the new tag. Mirrors
# auto_release_tags.sh but takes one ref via args instead of reading a list
# from stdin. Native opt tarballs only — wasm publishing lives in wasm-publish.yml.
#
# Accepted refs and resulting release tag:
#   - `^llvmorg-*` stable upstream tag      → release/<the tag>
#   - 7-40 hex char commit SHA              → release/<YYMMDD>-<first 12 of full SHA>
#     YYMMDD is the commit's committer date in the LLVM repo, fetched via the
#     GitHub commits API. The full 40-char SHA gets baked into llvm_commit.txt
#     so the release is reproducible even if the short form becomes ambiguous.
#
# Branches (e.g. `main`) are rejected: pin to a specific commit instead.
#
# Args:
#   $1 — LLVM ref to release.
#
# Env:
#   DRY_RUN — "true" prints the plan without pushing.
#   GH_TOKEN — must be set; default GITHUB_TOKEN works.
#   GITHUB_REPOSITORY — passed by GitHub Actions; used as `gh --repo`.

set -euo pipefail

LLVM_REF=${1:?"LLVM ref is required"}

if [[ "$LLVM_REF" =~ ^llvmorg- ]]; then
    REL_NAME=$LLVM_REF
elif [[ "$LLVM_REF" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    echo "Looking up $LLVM_REF in llvm/llvm-project..."
    COMMIT_JSON=$(gh api "repos/llvm/llvm-project/commits/$LLVM_REF")
    FULL_SHA=$(jq -r '.sha' <<<"$COMMIT_JSON")
    COMMIT_DATE=$(jq -r '.commit.committer.date' <<<"$COMMIT_JSON")
    YYMMDD=$(date -u -d "$COMMIT_DATE" +%y%m%d)
    REL_NAME="${YYMMDD}-${FULL_SHA:0:12}"
    LLVM_REF=$FULL_SHA
    echo "Resolved: $FULL_SHA committed $COMMIT_DATE → release/$REL_NAME"
else
    echo "error: llvm_ref must be an llvmorg-* tag or a 7-40 char hex commit SHA (got: $LLVM_REF)" >&2
    exit 1
fi

REL_TAG="release/$REL_NAME"

DRY_RUN=${DRY_RUN:-false}
REPO=${GITHUB_REPOSITORY:?"GITHUB_REPOSITORY must be set"}

echo "=== $LLVM_REF → $REL_TAG ==="

if [ "$DRY_RUN" = "true" ]; then
    echo "dry-run: would create $REL_TAG and dispatch native-build.yml"
    exit 0
fi

if git ls-remote --exit-code origin "refs/tags/$REL_TAG" >/dev/null 2>&1; then
    echo "error: tag $REL_TAG already exists on origin" >&2
    exit 1
fi

git config user.name "Hongxu Xu"
git config user.email "hongxu.xu@uwaterloo.ca"

git switch --detach origin/main
printf '%s\n' "$LLVM_REF" > llvm_commit.txt
git add llvm_commit.txt
git commit -m "manual: bump llvm to $LLVM_REF"
SHA=$(git rev-parse HEAD)
git tag "$REL_TAG" "$SHA"
git push origin "$REL_TAG"

gh release create "$REL_TAG" \
    --repo "$REPO" \
    --target "$SHA" \
    --title "$REL_NAME" \
    --notes "Manual release tracking LLVM ref \`$LLVM_REF\`." \
    || echo "release $REL_TAG may already exist (continuing)"

gh workflow run native-build.yml --repo "$REPO" --ref "refs/tags/$REL_TAG"
