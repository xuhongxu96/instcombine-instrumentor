#!/usr/bin/env bash
set -euo pipefail

LLVM_DIR=${LLVM_DIR:-thirdparty/llvm-project}
LLVM_REMOTE=${LLVM_REMOTE:-https://github.com/llvm/llvm-project.git}
COMMIT_FILE=${COMMIT_FILE:-llvm_commit.txt}

if [ ! -f "$COMMIT_FILE" ]; then
    echo "error: $COMMIT_FILE not found" >&2
    exit 1
fi

REF=$(grep -v '^[[:space:]]*\(#\|$\)' "$COMMIT_FILE" | head -n1 | tr -d '[:space:]')
if [ -z "$REF" ]; then
    echo "error: $COMMIT_FILE is empty or contains only comments" >&2
    exit 1
fi

echo "Target LLVM ref: $REF"

if [ -d "$LLVM_DIR/.git" ]; then
    if ! git -C "$LLVM_DIR" fetch --depth 1 origin "$REF"; then
        git -C "$LLVM_DIR" fetch origin
    fi
else
    mkdir -p "$(dirname "$LLVM_DIR")"
    git init "$LLVM_DIR" >/dev/null
    git -C "$LLVM_DIR" remote add origin "$LLVM_REMOTE"
    git -C "$LLVM_DIR" fetch --depth 1 origin "$REF"
fi

git -C "$LLVM_DIR" checkout --detach FETCH_HEAD

echo "Checked out $(git -C "$LLVM_DIR" rev-parse HEAD) into $LLVM_DIR"
