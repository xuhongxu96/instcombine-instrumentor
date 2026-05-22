#!/usr/bin/env bash
# Build the list of LLVM refs to publish this run. Wraps resolve_refs.sh by
# translating the mode-keyed env vars passed in from wasm-publish.yml into the
# right positional invocation, writes the resulting <dirname>\t<llvm_commit>
# table to a temp file, and emits `refs_file=<path>`, `count=<N>`, and a short
# `display_name=...` summary to $GITHUB_OUTPUT.
#
# Env:
#   MODE          — weekly-stable | daily-main | specific-ref | rebuild-existing (required)
#   LLVM_REF      — required if MODE=specific-ref. Accepts a single ref or
#                   a comma-separated list (whitespace around commas is OK):
#                   "llvmorg-22.1.6, llvmorg-21.1.4, abc123def456".
#   MAX_TAGS      — required if MODE=weekly-stable (default 3)
#   FORCE_REBUILD — "true" to skip the "already present" filter
#                   (weekly-stable only, defaults to false)
#   WASM_PKGS_DIR — wasm-pkgs worktree path (default ./wasm-pkgs-branch)
#   RUNNER_TEMP   — temp dir for the refs file (default /tmp)

set -euo pipefail

: "${MODE:?MODE required}"
WASM_PKGS_DIR=${WASM_PKGS_DIR:-./wasm-pkgs-branch}
FORCE_REBUILD=${FORCE_REBUILD:-false}
REFS_FILE="${RUNNER_TEMP:-/tmp}/refs.tsv"

case "$MODE" in
weekly-stable)
    bash .github/scripts/wasm-publish/resolve_refs.sh \
        weekly-stable "${MAX_TAGS:-3}" > "$REFS_FILE"
    ;;
daily-main)
    bash .github/scripts/wasm-publish/resolve_refs.sh daily-main > "$REFS_FILE"
    ;;
specific-ref)
    if [ -z "${LLVM_REF:-}" ]; then
        echo "error: specific-ref requires LLVM_REF" >&2
        exit 2
    fi
    : > "$REFS_FILE"
    # Split LLVM_REF on commas; trim whitespace around each ref. Empty entries
    # (trailing comma, double commas) are silently skipped. resolve_refs.sh
    # validates each ref; any failure aborts via `set -e`.
    IFS=',' read -ra REFS <<< "$LLVM_REF"
    for REF in "${REFS[@]}"; do
        REF="${REF#"${REF%%[![:space:]]*}"}"   # ltrim
        REF="${REF%"${REF##*[![:space:]]}"}"   # rtrim
        [ -z "$REF" ] && continue
        bash .github/scripts/wasm-publish/resolve_refs.sh \
            specific-ref "$REF" >> "$REFS_FILE"
    done
    ;;
rebuild-existing)
    bash .github/scripts/wasm-publish/resolve_refs.sh rebuild-existing > "$REFS_FILE"
    ;;
*)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac

echo "refs to build:"
cat "$REFS_FILE"

COUNT=$(grep -cve '^$' "$REFS_FILE" || true)
DISPLAY_NAME="nothing to build"
if [ "$COUNT" -gt 0 ]; then
    mapfile -t DIRS < <(cut -f1 "$REFS_FILE" | grep -v '^$')
    if [ "$COUNT" -eq 1 ]; then
        DISPLAY_NAME=${DIRS[0]}
    elif [ "$COUNT" -eq 2 ]; then
        DISPLAY_NAME="${DIRS[0]}, ${DIRS[1]}"
    else
        DISPLAY_NAME="${DIRS[0]}, ${DIRS[1]}, +$((COUNT - 2)) more"
    fi
fi

{
    echo "refs_file=$REFS_FILE"
    echo "count=$COUNT"
    echo "display_name=$DISPLAY_NAME"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
