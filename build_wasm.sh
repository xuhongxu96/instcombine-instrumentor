#!/usr/bin/env bash
#
# Two-stage build:
#  1. Native llvm-tblgen at build/llvm-host/ (cached across runs by CI; LLVM's
#     wasm cross-build can't run tblgen itself).
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
HOST_MIN_TBLGEN="$HOST_BUILD_DIR/bin/llvm-min-tblgen"

if [ ! -x "$HOST_TBLGEN" ] || [ ! -x "$HOST_MIN_TBLGEN" ]; then
    echo "=== Stage 1: building native llvm-tblgen at $HOST_BUILD_DIR ==="
    cmake -GNinja \
        -S "$LLVM_DIR/llvm" \
        -B "$HOST_BUILD_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_DISABLE_PRECOMPILE_HEADERS=ON \
        -DLLVM_TARGETS_TO_BUILD="" \
        -DLLVM_INCLUDE_TESTS=OFF \
        -DLLVM_INCLUDE_BENCHMARKS=OFF \
        -DLLVM_INCLUDE_EXAMPLES=OFF \
        -DLLVM_ENABLE_PROJECTS="" \
        -DLLVM_CCACHE_BUILD=ON \
        -DLLVM_CCACHE_MAXSIZE=200G
    cmake --build "$HOST_BUILD_DIR" -j "$(nproc)" --target llvm-tblgen llvm-min-tblgen
else
    echo "=== Stage 1: reusing cached llvm-tblgen at $HOST_TBLGEN ==="
fi

HOST_TBLGEN_ABS=$(realpath "$HOST_TBLGEN")
HOST_MIN_TBLGEN_ABS=$(realpath "$HOST_MIN_TBLGEN")
DRIVER_DIR_ABS=$(realpath "$DRIVER_DIR")

echo "=== Stage 2: emscripten LLVM build at $WASM_BUILD_DIR ==="
emcmake cmake -GNinja \
    -S "$LLVM_DIR/llvm" \
    -B "$WASM_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_DISABLE_PRECOMPILE_HEADERS=ON \
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
    -DLLVM_CCACHE_MAXSIZE=200G

cmake --build "$WASM_BUILD_DIR" -j "$(nproc)" --target instcombine_driver

mkdir -p "$WEB_PUBLIC_DIR"
cp "$WASM_BUILD_DIR/bin/instcombine_driver.js" "$WEB_PUBLIC_DIR/"
cp "$WASM_BUILD_DIR/bin/instcombine_driver.wasm" "$WEB_PUBLIC_DIR/"

ls -lh "$WEB_PUBLIC_DIR"
echo "Wasm bundle ready in $WEB_PUBLIC_DIR"
