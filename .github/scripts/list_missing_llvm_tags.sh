#!/usr/bin/env bash
# Print up to N upstream LLVM stable tags (llvmorg-X.Y.Z) that are missing from
# this repo's release/llvmorg-X.Y.Z tag set. Output is one tag per line, oldest
# first (so callers can process chronologically and the release page sorts naturally).
#
# Args:
#   $1 — max tags (default 3)
#   $2 — upstream repo URL (default https://github.com/llvm/llvm-project.git)
#
# Requires `git` and a checkout with `fetch-depth: 0` so local release tags are
# visible to `git tag -l`.

set -euo pipefail

MAX_TAGS=${1:-3}
UPSTREAM=${2:-https://github.com/llvm/llvm-project.git}

UPSTREAM_TAGS=$(mktemp)
LOCAL_TAGS=$(mktemp)
trap 'rm -f "$UPSTREAM_TAGS" "$LOCAL_TAGS"' EXIT

git ls-remote --tags --refs "$UPSTREAM" 'llvmorg-*' \
    | awk '{print $2}' \
    | sed 's|refs/tags/||' \
    | grep -E '^llvmorg-[0-9]+\.[0-9]+\.[0-9]+$' \
    > "$UPSTREAM_TAGS"

# `grep` may exit 1 when no local release tags exist yet; tolerate that.
git tag -l 'release/llvmorg-*' \
    | sed 's|^release/||' \
    | grep -E '^llvmorg-[0-9]+\.[0-9]+\.[0-9]+$' \
    > "$LOCAL_TAGS" || true

# grep -vFxf subtracts whole-line fixed-string matches; order-independent so
# we don't have to fight `comm`'s lexical-sort requirement vs version sort.
grep -vFxf "$LOCAL_TAGS" "$UPSTREAM_TAGS" \
    | sort -V -r \
    | head -n "$MAX_TAGS" \
    | sort -V
