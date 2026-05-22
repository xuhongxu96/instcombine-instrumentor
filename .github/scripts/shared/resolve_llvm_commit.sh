#!/usr/bin/env bash
set -euo pipefail

LLVM_DIR=${LLVM_DIR:-thirdparty/llvm-project}

SHA=$(git -C "$LLVM_DIR" rev-parse HEAD)
echo "sha=$SHA" >> "$GITHUB_OUTPUT"
echo "short=${SHA:0:12}" >> "$GITHUB_OUTPUT"
echo "Resolved $LLVM_DIR HEAD: $SHA"
