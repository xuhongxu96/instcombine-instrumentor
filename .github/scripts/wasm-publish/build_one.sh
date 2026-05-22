#!/usr/bin/env bash
# Build the wasm InstCombine driver for one LLVM ref and copy the outputs into
# a staging directory. Called in a loop by wasm-publish.yml.
#
# Args:
#   $1 — DIRNAME      target subdirectory under wasm-pkgs (e.g. "llvmorg-22.1.6")
#   $2 — LLVM_COMMIT  value to write into llvm_commit.txt (tag name or full SHA)
#
# Env (optional):
#   STAGING_DIR — output staging dir (default ./wasm-publish-staging)
#
# build/llvm-wasm is intentionally *not* wiped between iterations. The LLVM
# source dir (thirdparty/llvm-project) always lives at the same path, so
# CMake's incremental rebuild and ccache reuse from previous refs both stay
# valid; only the source files that actually changed between refs recompile.
#
# clone_llvm.sh's `git checkout --detach FETCH_HEAD` errors on a dirty
# checkout, so the previous iteration's patch is reset before re-cloning.

set -euo pipefail

DIRNAME=${1:?"DIRNAME required"}
LLVM_COMMIT=${2:?"LLVM_COMMIT required"}
STAGING_DIR=${STAGING_DIR:-./wasm-publish-staging}

echo "::group::Build $DIRNAME (llvm_commit=$LLVM_COMMIT)"

if [ -d thirdparty/llvm-project/.git ]; then
    git -C thirdparty/llvm-project reset --hard >/dev/null
    git -C thirdparty/llvm-project clean -fdx >/dev/null
fi

printf '%s\n' "$LLVM_COMMIT" > llvm_commit.txt
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash .github/scripts/shared/retry.sh 3 1 -- bash build_wasm.sh
node wasm/test/smoke_wasm.mjs

DEST="$STAGING_DIR/$DIRNAME"
mkdir -p "$DEST"
cp build/llvm-wasm/bin/instcombine_driver.js   "$DEST/"
cp build/llvm-wasm/bin/instcombine_driver.wasm "$DEST/"

echo "::endgroup::"
