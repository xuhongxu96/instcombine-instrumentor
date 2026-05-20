# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo does

This is *not* a normal codebase — it is a build harness that patches an upstream LLVM source tree and produces an instrumented `opt` binary that traces every new instruction and every RAUW performed by `InstCombine` / `InstructionSimplify` per pass iteration. The first-party sources are `patch_llvm.py` (the patcher), the C++ runtime under `runtime/`, the minimal wasm driver under `wasm/driver/`, the webapp under `web/`, plus a handful of shell scripts.

The C++ runtime injected into LLVM lives in real source files at `runtime/fuzz_runtime.{h,cpp}` — edit those, not `patch_llvm.py`. The patcher reads them at module import via `Path.read_text()` and writes them into the LLVM tree at `llvm/include/llvm/IR/fuzz_runtime.h` and `llvm/lib/IR/fuzz_runtime.cpp`. The runtime is dual-target: `#ifdef __EMSCRIPTEN__` branches drop `llvm::sys::PrintStackTrace` (wasm frames aren't symbolizable) and `std::atexit` (unreliable under emscripten). An always-emitted `extern "C" dump_iteration_info_external` lets the wasm host flush the final iteration explicitly.

## Common commands

```bash
uv sync                                            # install Python deps (tree-sitter)
bash clone_llvm.sh                                 # clone LLVM at the ref in llvm_commit.txt
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh                         # builds opt + llvm-symbolizer into build/llvm-rel
bash smoke_test.sh                                 # runs opt on a tiny IR and checks the trace
```

To bump the LLVM version: edit `llvm_commit.txt`, re-run `clone_llvm.sh` → `patch_llvm.py` → `build_patched_llvm.sh`. `patch_llvm.py` is idempotent on a clean checkout, so running it twice is a no-op (each patcher checks for sentinels like `__llvm_fuzz_record_replace`, `llvm_fuzz::start_iteration()`, `fuzz_runtime.cpp`).

At runtime, `DISABLE_INSTCOMBINE_TRACE=1` makes the patched `opt` behave like stock `opt`. The trace file is hard-coded to `llvm_fuzz_info.txt` in the CWD.

## Patching architecture

`patch_llvm.py` uses tree-sitter (not regex/sed) to walk C++ function definitions. There are three distinct patchers, each applied to specific files in `thirdparty/llvm-project`:

1. **`patch_value_cpp`** → `llvm/lib/IR/Value.cpp`. Finds `doRAUW` and inserts `__llvm_fuzz_record_replace(this, New)` at the top of its body. This is the single RAUW hook for the whole engine.

2. **`patch_inst_combine_file`** → every `.cpp`/`.h` in `llvm/lib/Transforms/InstCombine/`. For functions whose return type "looks like a pointer to a Value/Instruction subclass" (see `POINTER_TYPE_HINTS` and `_is_pointer_return`), wraps every *top-level* `return X;` as `return __llvm_fuzz_record(X);`. Returns inside nested lambdas/local function definitions are skipped (`is_inside_nested_scope`). Additionally, in `InstructionCombining.cpp` the `InstCombinerImpl::run` method gets a `llvm_fuzz::start_iteration()` prelude and its `return MadeIRChange;` is rewritten to dump the iteration trace first.

3. **`patch_instruction_simplify_file`** → `llvm/lib/Analysis/InstructionSimplify.cpp`. Same as #2 but `_is_pointer_return` is called with `allow_star_in_prefix=True`, which is the practical difference between the two patchers (Simplify writes pointer return types in a style the strict matcher misses).

All three patchers prepend `#include "llvm/IR/fuzz_runtime.h"` if not already present. After patching, three `CMakeLists.txt` files are updated:
- `llvm/lib/IR/CMakeLists.txt` → adds `fuzz_runtime.cpp` to `LLVMCore`.
- `llvm/lib/Analysis/CMakeLists.txt` → forces `InstructionSimplify.cpp` to compile `-O0 -g` (symbols and accurate line info in traces).
- `llvm/lib/Transforms/InstCombine/CMakeLists.txt` → same `-O0 -g` for the whole InstCombine library.

Edits within a single file are collected and applied in reverse byte-order (`apply_edits`) so earlier offsets stay valid.

## Runtime architecture (the C++ injected into LLVM)

The runtime source lives at `runtime/fuzz_runtime.{h,cpp}` and is copied into the LLVM tree by `create_fuzz_runtime` (at `llvm/include/llvm/IR/fuzz_runtime.h` and `llvm/lib/IR/fuzz_runtime.cpp`):
- The header declares `llvm_fuzz::record_stacktrace`, `record_replacement`, `start_iteration`, `dump_iteration_info`, plus the `record_stacktrace_with_loc<T>` template that the `__llvm_fuzz_record` macro uses.
- The cpp holds a global mutex-guarded `IterationState` (new values + replacements) and a `trace_map` from `Value*` → captured stacktrace/IR-print/source-loc. `start_iteration()` flushes the previous iteration to `llvm_fuzz_info.txt` (append mode) then clears state. An `AtExitRegister` static truncates the file at session start (writes `=== SESSION START ===`) and registers `dump_iteration_info` at `atexit` so the final iteration is not lost (native only — emscripten relies on `dump_iteration_info_external` being called by the JS host).

Stack frames are produced by `llvm::sys::PrintStackTrace`, which is symbolized lazily by `llvm-symbolizer`. The patched binary picks the symbolizer up from `$PATH` or `LLVM_SYMBOLIZER_PATH`; the smoke test sets the env var explicitly. Release tarballs ship `llvm-symbolizer` next to `opt` for this reason. Under emscripten the entire `PrintStackTrace` branch is compiled out — wasm frames aren't symbolizable in a browser, and the per-fold source location is still captured by `__llvm_fuzz_record` via `__FILE__/__LINE__/__PRETTY_FUNCTION__`.

## WebAssembly build (webapp at `web/`)

The repo also produces an in-browser InstCombine debugger: `web/` is a Vite + React + Monaco SPA that loads a wasm InstCombine driver, runs it on user-pasted IR, and renders the resulting `llvm_fuzz_info.txt`. Build pipeline:

- `wasm/driver/instcombine_driver.cpp` — ~50-line custom driver that parses `/work/input.ll`, registers PassBuilder analyses, and runs `createModuleToFunctionPassAdaptor(InstCombinePass())`. Not the full `opt` binary — keeps the wasm small.
- `wasm/driver/CMakeLists.txt` — wired into the LLVM build via `LLVM_EXTERNAL_PROJECTS=instcombine_driver`. Emits an ES-module `.js` loader + `.wasm` sidecar.
- `build_wasm.sh` — two-stage cross-compile: native `llvm-tblgen` at `build/llvm-host/` (LLVM's wasm build can't run tblgen itself), then `emcmake cmake` at `build/llvm-wasm/` with `LLVM_TARGETS_TO_BUILD=""` and `LLVM_ENABLE_THREADS=OFF` (no `SharedArrayBuffer`/COOP+COEP on Pages). Outputs land in `web/public/wasm/`.
- `wasm/test/smoke_wasm.mjs` — Node-based smoke. Mirrors `smoke_test.sh` minus the `llvm::InstVisitor` check (no PrintStackTrace under wasm).
- `web/src/worker/instcombine.worker.ts` — runs the wasm Module in a Web Worker; writes IR into MEMFS at `/work/input.ll`, calls `Module.callMain([])`, then `Module.ccall("dump_iteration_info_external")`, then reads back `/work/llvm_fuzz_info.txt`. A worker is mandatory: `MPM.run` is synchronous and the wasm bundle is large.
- `.github/workflows/web.yml` — builds wasm + frontend and deploys to GitHub Pages on pushes to `main`. Caches host tblgen keyed on the resolved LLVM SHA.

## CI

- `.github/workflows/build.yml` — runs on push/PR, and on `release/*` tags it bundles `opt` + `llvm-symbolizer` into `opt-llvm-<short-sha>.tar.xz` and attaches to the GitHub Release.
- `.github/workflows/weekly-llvm.yml` — Monday cron (and `workflow_dispatch`) against LLVM `main` tip; the canary for upstream changes that break the patch.

Both workflows pin `ubuntu-22.04` (not `ubuntu-latest`) and depend on `.github/scripts/install_toolchain.sh` and `.github/scripts/resolve_llvm_commit.sh`. ccache is cached keyed on the LLVM SHA.

## Useful env vars

| Var | Default | Meaning |
|---|---|---|
| `LLVM_DIR` | `thirdparty/llvm-project` | LLVM source tree |
| `BUILD_DIR` | `build/llvm-rel` | CMake build dir |
| `BUILD_TARGETS` | `opt llvm-symbolizer` | targets for `cmake --build` |
| `LLVM_PARALLEL_LINK_JOBS` | `1` | raise on machines with lots of RAM |
| `DISABLE_INSTCOMBINE_TRACE` | unset | `1`/`true` disables instrumentation at runtime |
| `LLVM_SYMBOLIZER_PATH` | unset | path to `llvm-symbolizer` if not on `$PATH` |
