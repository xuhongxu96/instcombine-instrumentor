#!/usr/bin/env bash
#
# Two-stage build:
#  1. Native llvm-tblgen at build/llvm-host/ (LLVM's wasm cross-build can't run
#     tblgen itself, so we always rebuild the host tools incrementally first).
#  2. Emscripten LLVM build at build/llvm-wasm/ that compiles only our minimal
#     InstCombine driver via LLVM_EXTERNAL_PROJECTS.
#
# Outputs build/llvm-wasm/bin/instcombine_driver.{js,wasm} and copies them
# into web/public/wasm/.
#
# Prereqs:
#  - emsdk activated (emcmake/emmake/emcc on PATH)
#  - thirdparty/llvm-project/ checked out + patched (run patch_llvm.py first)

set -euo pipefail

LLVM_DIR=${LLVM_DIR:-thirdparty/llvm-project}
HOST_BUILD_DIR=${HOST_BUILD_DIR:-build/llvm-host}
WASM_BUILD_DIR=${WASM_BUILD_DIR:-build/llvm-wasm}
DRIVER_DIR=${DRIVER_DIR:-wasm/driver}
WEB_PUBLIC_DIR=${WEB_PUBLIC_DIR:-web/public/wasm}

if ! command -v emcmake >/dev/null 2>&1; then
    echo "error: emcmake not on PATH — activate emsdk first" >&2
    exit 1
fi

export CCACHE_DIR=${CCACHE_DIR:-$HOME/.cache/ccache}
export CCACHE_BASEDIR=$(realpath .)
export CCACHE_COMPILERCHECK=${CCACHE_COMPILERCHECK:-"%compiler% --version"}
export CCACHE_NOHASHDIR=${CCACHE_NOHASHDIR:-1}

HOST_TBLGEN="$HOST_BUILD_DIR/bin/llvm-tblgen"

# llvm-min-tblgen was introduced upstream in LLVM 17 (commit 243e8f8d23ac,
# May 2023). For LLVM <= 16 the target doesn't exist, so asking cmake to
# build it would fail the whole stage. Parse LLVM_VERSION_MAJOR from
# whichever file defines it on the target tree — older trees set it in
# llvm/CMakeLists.txt, newer trees in cmake/Modules/LLVMVersion.cmake.
LLVM_VERSION_FILES=()
if [ -f "$LLVM_DIR/llvm/CMakeLists.txt" ]; then
    LLVM_VERSION_FILES+=("$LLVM_DIR/llvm/CMakeLists.txt")
fi
if [ -f "$LLVM_DIR/cmake/Modules/LLVMVersion.cmake" ]; then
    LLVM_VERSION_FILES+=("$LLVM_DIR/cmake/Modules/LLVMVersion.cmake")
fi

LLVM_VERSION_MAJOR=$(grep -hE '^[[:space:]]*set\(LLVM_VERSION_MAJOR[[:space:]]+[0-9]+\)' \
    "${LLVM_VERSION_FILES[@]}" 2>/dev/null \
    | grep -oE '[0-9]+' | head -n 1)
if [ -z "$LLVM_VERSION_MAJOR" ]; then
    echo "error: could not detect LLVM_VERSION_MAJOR from $LLVM_DIR" >&2
    exit 1
fi

HOST_TARGETS=(llvm-tblgen)
if [ "$LLVM_VERSION_MAJOR" -ge 17 ]; then
    HOST_TARGETS+=(llvm-min-tblgen)
fi

echo "=== Stage 1: building native llvm-tblgen (LLVM $LLVM_VERSION_MAJOR) at $HOST_BUILD_DIR ==="
cmake -GNinja \
    -S "$LLVM_DIR/llvm" \
    -B "$HOST_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_TARGETS_TO_BUILD="" \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_ENABLE_PROJECTS="" \
    -DLLVM_CCACHE_BUILD=ON \
    -DLLVM_CCACHE_MAXSIZE=5G

cmake --build "$HOST_BUILD_DIR" -j "$(nproc)" --target "${HOST_TARGETS[@]}"

HOST_TBLGEN_ABS=$(realpath "$HOST_TBLGEN")
DRIVER_DIR_ABS=$(realpath "$DRIVER_DIR")

echo "=== Stage 2: emscripten LLVM build at $WASM_BUILD_DIR ==="
emcmake cmake -GNinja \
    -S "$LLVM_DIR/llvm" \
    -B "$WASM_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_TARGETS_TO_BUILD="" \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_ENABLE_PROJECTS="" \
    -DLLVM_ENABLE_THREADS=OFF \
    -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF \
    -DLLVM_TABLEGEN="$HOST_TBLGEN_ABS" \
    -DLLVM_NATIVE_TOOL_DIR="$(realpath "$HOST_BUILD_DIR/bin")" \
    -DLLVM_EXTERNAL_PROJECTS=instcombine_driver \
    -DLLVM_EXTERNAL_INSTCOMBINE_DRIVER_SOURCE_DIR="$DRIVER_DIR_ABS" \
    -DLLVM_CCACHE_BUILD=ON \
    -DLLVM_CCACHE_MAXSIZE=5G

cmake --build "$WASM_BUILD_DIR" -j "$(nproc)" --target instcombine_driver

mkdir -p "$WEB_PUBLIC_DIR"
cp "$WASM_BUILD_DIR/bin/instcombine_driver.js" "$WEB_PUBLIC_DIR/"
cp "$WASM_BUILD_DIR/bin/instcombine_driver.wasm" "$WEB_PUBLIC_DIR/"

ls -lh "$WEB_PUBLIC_DIR"
echo "Wasm bundle ready in $WEB_PUBLIC_DIR"
