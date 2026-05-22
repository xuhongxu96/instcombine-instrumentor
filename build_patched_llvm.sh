#!/usr/bin/env bash
set -euo pipefail

export CC=${CC:-clang}
export CXX=${CXX:-clang++}
export LD=${LD:-lld}

LLVM_DIR=${LLVM_DIR:-thirdparty/llvm-project}
BUILD_DIR=${BUILD_DIR:-build/llvm-rel}
BUILD_TARGETS=${BUILD_TARGETS:-opt llvm-symbolizer}

export CCACHE_DIR=${CCACHE_DIR:-$HOME/.cache/ccache}
export CCACHE_BASEDIR=$(realpath .)
export CCACHE_COMPILERCHECK=${CCACHE_COMPILERCHECK:-content}
export CCACHE_NOHASHDIR=${CCACHE_NOHASHDIR:-1}

cmake -GNinja \
    -S "${LLVM_DIR}/llvm" \
    -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS=clang \
    -DLLVM_TARGETS_TO_BUILD="X86;AArch64" \
    -DLLVM_INCLUDE_TESTS=ON \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DCLANG_INCLUDE_TESTS=OFF \
    -DLLVM_USE_LINKER=lld \
    -DLLVM_CCACHE_BUILD=ON \
    -DLLVM_CCACHE_MAXSIZE=5G \
    -DLLVM_PARALLEL_LINK_JOBS=${LLVM_PARALLEL_LINK_JOBS:-1}

cmake --build "${BUILD_DIR}" -j "$(nproc)" --target ${BUILD_TARGETS}
