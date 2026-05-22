#!/usr/bin/env bash
# Resolve the list of LLVM refs that wasm-publish.yml should build this run.
# Prints one line per ref to stdout in the form:
#
#   <dirname>\t<llvm_commit>
#
# where <dirname> is the wasm-pkgs subdirectory to create (used as the
# manifest tag) and <llvm_commit> is what gets written into `llvm_commit.txt`
# before the build.
#
# Usage:
#   resolve_wasm_pkgs_refs.sh weekly-stable <max_tags> [<wasm_pkgs_dir>]
#   resolve_wasm_pkgs_refs.sh daily-main
#   resolve_wasm_pkgs_refs.sh specific-ref <llvm_ref>
#
# Env:
#   FORCE_REBUILD — "true" to skip the "already present in wasm-pkgs" check
#                   (weekly-stable only — daily-main always rebuilds)
#   WASM_PKGS_DIR — wasm-pkgs worktree path (default ./wasm-pkgs-branch);
#                   only used for the weekly-stable existence check
#   UPSTREAM      — upstream LLVM repo URL (default github.com/llvm/llvm-project)
#
# Requires `gh` on PATH and authenticated (for daily-main / specific-ref SHA
# lookups). Stable tag scanning uses `git ls-remote` only.

set -euo pipefail

MODE=${1:?"usage: $0 <mode> [args...]"}
UPSTREAM=${UPSTREAM:-https://github.com/llvm/llvm-project.git}
WASM_PKGS_DIR=${WASM_PKGS_DIR:-./wasm-pkgs-branch}
FORCE_REBUILD=${FORCE_REBUILD:-false}

resolve_sha() {
    # $1 = ref (llvmorg-* tag or 7-40 hex SHA); echoes "<dirname>\t<full-sha-or-tag>"
    local REF=$1
    if [[ "$REF" =~ ^llvmorg-[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ ]]; then
        printf '%s\t%s\n' "$REF" "$REF"
    elif [[ "$REF" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
        local JSON FULL_SHA COMMIT_DATE YYMMDD
        JSON=$(gh api "repos/llvm/llvm-project/commits/$REF")
        FULL_SHA=$(jq -r '.sha' <<<"$JSON")
        COMMIT_DATE=$(jq -r '.commit.committer.date' <<<"$JSON")
        YYMMDD=$(date -u -d "$COMMIT_DATE" +%y%m%d)
        printf 'main-%s-%s\t%s\n' "$YYMMDD" "${FULL_SHA:0:12}" "$FULL_SHA"
    else
        echo "error: $REF is not an llvmorg-* tag or 7-40 hex commit SHA" >&2
        return 1
    fi
}

case "$MODE" in
weekly-stable)
    MAX_TAGS=${2:-3}
    UPSTREAM_TAGS=$(mktemp)
    LOCAL_DIRS=$(mktemp)
    trap 'rm -f "$UPSTREAM_TAGS" "$LOCAL_DIRS"' EXIT

    git ls-remote --tags --refs "$UPSTREAM" 'llvmorg-*' \
        | awk '{print $2}' \
        | sed 's|refs/tags/||' \
        | grep -E '^llvmorg-[0-9]+\.[0-9]+\.[0-9]+$' \
        > "$UPSTREAM_TAGS"

    if [ "$FORCE_REBUILD" != "true" ] && [ -d "$WASM_PKGS_DIR" ]; then
        # Anything already present in wasm-pkgs is excluded from the build list.
        find "$WASM_PKGS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
            | grep -E '^llvmorg-' > "$LOCAL_DIRS" || true
    fi

    grep -vFxf "$LOCAL_DIRS" "$UPSTREAM_TAGS" \
        | sort -V -r \
        | head -n "$MAX_TAGS" \
        | sort -V \
        | while IFS= read -r TAG; do
            [ -z "$TAG" ] && continue
            resolve_sha "$TAG"
        done
    ;;
daily-main)
    JSON=$(gh api repos/llvm/llvm-project/commits/main)
    FULL_SHA=$(jq -r '.sha' <<<"$JSON")
    COMMIT_DATE=$(jq -r '.commit.committer.date' <<<"$JSON")
    YYMMDD=$(date -u -d "$COMMIT_DATE" +%y%m%d)
    DIRNAME="main-${YYMMDD}-${FULL_SHA:0:12}"
    # Don't skip even if present — daily-main always tries to publish today's
    # head. The directory may already exist if main hasn't moved since
    # yesterday, in which case the build will be a no-op git push.
    printf '%s\t%s\n' "$DIRNAME" "$FULL_SHA"
    ;;
specific-ref)
    REF=${2:?"specific-ref requires an llvm_ref argument"}
    resolve_sha "$REF"
    ;;
*)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac
