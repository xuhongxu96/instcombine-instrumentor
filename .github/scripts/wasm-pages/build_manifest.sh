#!/usr/bin/env bash
# Wrapper around web/scripts/build-manifest.mjs that translates the wasm-pages
# workflow's env-var inputs into CLI flags. Kept here so wasm-pages.yml's step
# stays a one-liner.
#
# Env:
#   REMOTE_MANIFEST_URL    — required; raw URL of wasm-pkgs/manifest.json
#   BUNDLE_MODE            — remote | hybrid | bundled (default hybrid)
#   BUNDLE_COUNT           — auto-pick cap for tag bundles (default 5)
#   INCLUDE_COMMIT_COUNT   — auto-pick cap for commit-snapshot bundles (default 0)
#   MUST_BUNDLE            — CSV of additional tags/SHAs to force-bundle (optional)
#   INCLUDE_FILE           — path to a must-bundle file (default wasm-must-bundle.txt)
#   OUT_DIR                — output directory (default web/public/wasm)

set -euo pipefail

: "${REMOTE_MANIFEST_URL:?REMOTE_MANIFEST_URL required}"
BUNDLE_MODE=${BUNDLE_MODE:-hybrid}
BUNDLE_COUNT=${BUNDLE_COUNT:-5}
INCLUDE_COMMIT_COUNT=${INCLUDE_COMMIT_COUNT:-0}
MUST_BUNDLE=${MUST_BUNDLE:-}
INCLUDE_FILE=${INCLUDE_FILE:-wasm-must-bundle.txt}
OUT_DIR=${OUT_DIR:-web/public/wasm}

ARGS=(
    --bundle-mode "$BUNDLE_MODE"
    --remote-manifest-url "$REMOTE_MANIFEST_URL"
    --out-dir "$OUT_DIR"
    --bundle-count "$BUNDLE_COUNT"
    --include-commit-count "$INCLUDE_COMMIT_COUNT"
    --include-file "$INCLUDE_FILE"
)
if [ -n "$MUST_BUNDLE" ]; then
    ARGS+=(--include "$MUST_BUNDLE")
fi

node web/scripts/build-manifest.mjs "${ARGS[@]}"
