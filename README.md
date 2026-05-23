# $TARGET_BRANCH

This branch is bot-managed by the wasm publish workflows. Do not edit by hand
unless you also own the automation that writes here.

Each subdirectory contains an InstCombine instrumentor wasm build for a
specific LLVM source snapshot. Stable LLVM releases use `llvmorg-*` directories,
scheduled upstream snapshots use `main-<YYMMDD>-<sha12>`, and custom-source
builds use immutable `branch-*` / `commit-*` directories. The `manifest.json` at
the root is fetched directly by the webapp at runtime via raw.githubusercontent.com.
