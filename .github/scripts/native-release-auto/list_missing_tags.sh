#!/usr/bin/env bash
# Print up to N upstream LLVM stable tags (llvmorg-X.Y.Z) that are missing from
# this repo's release/llvmorg-X.Y.Z tag set AND newer than the newest stable we've
# already released — we never backfill versions deliberately skipped (that's the
# job of native-release-manual). Output is one tag per line, oldest first (so
# callers can process chronologically and the release page sorts naturally).
#
# Args:
#   $1 — max tags (default 1)
#   $2 — upstream repo URL (default https://github.com/llvm/llvm-project.git)
#
# Requires `git` and a checkout with `fetch-depth: 0` so local release tags are
# visible to `git tag -l`.

set -euo pipefail

MAX_TAGS=${1:-1}
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

# Never go older than the newest stable we've already released — backfilling
# skipped versions is a job for native-release-manual, not the auto scanner.
# (Mirrors wasm-publish weekly-stable in resolve_refs.sh.) NEWEST_EXISTING stays
# in UPSTREAM_TAGS here but is removed again by the grep -vFxf subtraction below.
if [ -s "$LOCAL_TAGS" ]; then
    NEWEST_EXISTING=$(sort -V -r "$LOCAL_TAGS" | head -n 1)
    FILTERED=$(mktemp)
    {
        printf '%s\n' "$NEWEST_EXISTING"
        cat "$UPSTREAM_TAGS"
    } | sort -V -u | awk -v cutoff="$NEWEST_EXISTING" '
        $0 == cutoff { seen=1 }
        seen { print }
    ' > "$FILTERED"
    mv "$FILTERED" "$UPSTREAM_TAGS"
fi

# grep -vFxf subtracts whole-line fixed-string matches; order-independent so
# we don't have to fight `comm`'s lexical-sort requirement vs version sort.
# `|| true` keeps `set -o pipefail` happy in the steady state where every
# upstream tag is already released (grep returns 1 on no matches).
{ grep -vFxf "$LOCAL_TAGS" "$UPSTREAM_TAGS" || true; } \
    | sort -V -r \
    | head -n "$MAX_TAGS" \
    | sort -V
