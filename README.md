# wasm-pkgs

This branch is bot-managed by `.github/workflows/wasm-publish.yml`. Do not edit by
hand — any changes will be overwritten.

Each subdirectory contains an InstCombine instrumentor wasm build for a
specific LLVM version (`llvmorg-X.Y.Z[-rcN]/` for stable tags,
`main-<YYMMDD>-<sha12>/` for daily LLVM main snapshots). The `manifest.json`
at the root is fetched directly by the webapp at runtime via
`raw.githubusercontent.com`.
