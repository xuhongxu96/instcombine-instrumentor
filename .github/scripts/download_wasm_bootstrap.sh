#!/usr/bin/env bash
# Download the most recent successful wasm.yml run's `wasm-bundle-latest` artifact
# into <out-dir>/. Used by pages.yml as a synthetic "(latest build)" entry so the
# Pages site stays functional before any release/* tag is pushed.
#
# Env: GH_TOKEN — token with `actions: read` on the repo.
# Args:
#   $1 — gh repo (owner/name)
#   $2 — destination dir (created if missing)
#
# Failure to find or download an artifact is non-fatal: the manifest builder
# tolerates a missing bootstrap dir.

set -euo pipefail

REPO=${1:?"usage: $0 <owner/repo> <out-dir>"}
OUT_DIR=${2:?"usage: $0 <owner/repo> <out-dir>"}

mkdir -p "$OUT_DIR"

RUN_ID=$(gh run list \
    --repo "$REPO" \
    --workflow=wasm.yml \
    --branch=main \
    --status=success \
    --limit=1 \
    --json databaseId \
    --jq '.[0].databaseId // empty')

if [ -z "$RUN_ID" ]; then
    echo "no successful wasm.yml run found on main — skipping bootstrap"
    exit 0
fi

echo "downloading wasm-bundle-latest from wasm.yml run $RUN_ID"
gh run download "$RUN_ID" \
    --repo "$REPO" \
    --name wasm-bundle-latest \
    --dir "$OUT_DIR" \
    || echo "bootstrap download failed (non-fatal)"
