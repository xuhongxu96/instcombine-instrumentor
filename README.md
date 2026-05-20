# instcombine-instrumentor

Tools to build an instrumented LLVM `opt` that records every new instruction
and every RAUW replacement performed by InstCombine / InstructionSimplify on
each pass iteration. Useful for fuzzing and differential analysis of
InstCombine folds.

Live webapp: **<https://xuhongxu.com/instcombine-instrumentor/>**

Ships in two flavors:

- **Native `opt`** — full instrumentation with symbolized stack traces.
- **In-browser webapp** — a Vite + React + Monaco SPA that runs a minimal
  WebAssembly build of InstCombine on user-pasted IR and renders the trace
  inline. Deployed from this repo to GitHub Pages at
  <https://xuhongxu.com/instcombine-instrumentor/>.

## Layout

- `llvm_commit.txt` — LLVM ref (commit SHA or tag) to build against.
- `clone_llvm.sh` — clones LLVM into `thirdparty/llvm-project` at that ref.
- `runtime/fuzz_runtime.{h,cpp}` — the C++ instrumentation runtime injected
  into the LLVM tree. Call-path frames come from a self-maintained
  `thread_local` stack populated by an RAII `TraceScope` that the patcher
  inserts at the top of every wrapped function, so native and wasm produce
  identical traces with no dependency on `llvm-symbolizer`. The only
  `#ifdef __EMSCRIPTEN__` guards `std::atexit` (unreliable under emscripten);
  an always-emitted `extern "C" dump_iteration_info_external` lets the JS
  host flush the final iteration explicitly.
- `patch_llvm.py` — loads `runtime/*` and patches the LLVM source tree,
  wrapping pointer-returning functions across InstCombine /
  InstructionSimplify / `Value::doRAUW`.
- `build_patched_llvm.sh` — configures and builds the patched `opt` into
  `build/llvm-rel/`.
- `wasm/driver/` — ~50-line custom driver and `CMakeLists.txt` for the
  minimal in-browser InstCombine binary.
- `build_wasm.sh` — two-stage cross-compile: native `llvm-tblgen` at
  `build/llvm-host/` then `emcmake` LLVM at `build/llvm-wasm/`. Outputs
  land in `web/public/wasm/`.
- `wasm/test/smoke_wasm.mjs` — Node-based smoke test for the wasm bundle.
- `web/` — Vite + React + Monaco frontend. Worker hosts the wasm module.

## Quickstart (native `opt`)

Dependencies are managed with [uv](https://github.com/astral-sh/uv). Install
once with `curl -LsSf https://astral.sh/uv/install.sh | sh` if you don't have
it.

```bash
uv sync                                                       # creates .venv/
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh
build/llvm-rel/bin/opt --version
```

A minimal smoke test:

```bash
echo 'define i32 @f(i32 %x) { %a = add i32 %x, 0
ret i32 %a }' > /tmp/t.ll
build/llvm-rel/bin/opt -passes=instcombine /tmp/t.ll -S -o /dev/null
cat llvm_fuzz_info.txt
```

`llvm_fuzz_info.txt` contains `SESSION` / `ITERATION` markers plus a record of
new instructions and RAUW replacements.

Set `DISABLE_INSTCOMBINE_TRACE=1` at runtime to suppress all instrumentation
output (the patched binary then behaves like a normal `opt`).

## Quickstart (webapp / WebAssembly)

The webapp is a fold-firing-location debugger: paste IR, click Run, see the
trace render next to the source.

Prereqs: native toolchain (clang/lld/cmake/ninja), an activated
[emsdk](https://emscripten.org/) (`latest` is what CI uses), and Node 20+.

```bash
# clone + activate emsdk if you don't have one
git clone --depth 1 https://github.com/emscripten-core/emsdk.git thirdparty/emsdk
./thirdparty/emsdk/emsdk install latest && ./thirdparty/emsdk/emsdk activate latest
source ./thirdparty/emsdk/emsdk_env.sh

# patch + build (re-uses clone_llvm.sh / patch_llvm.py from the native path)
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_wasm.sh                # ~10-30 min cold; reuses build/llvm-host across runs

# smoke (Node) — same IR as smoke_test.sh
node wasm/test/smoke_wasm.mjs

# dev server
cd web && npm install && npm run dev
# → http://localhost:5173/instcombine-instrumentor/
```

The minimal driver only links Core/Support/Analysis/TransformUtils/
InstCombine/IRReader/AsmParser/BitReader/Passes — no codegen or vectorize —
and produces a ~8 MB `instcombine_driver.wasm`. The Web Worker writes IR to
`/work/input.ll` in MEMFS, runs `Module.callMain([])`, calls the exported
`dump_iteration_info_external`, then reads `/work/llvm_fuzz_info.txt` back.

### Example output

Feeding the smoke-test IR through `opt -passes=instcombine` produces a trace
that looks like this:

```text
=== SESSION START ===
=== ITERATION START ===

NEW INSTRUCTIONS IN THIS ITERATION:
VALUE 0x55ef...46d0 (i32 %x) at llvm::Value *simplifyAddInst(...) (InstructionSimplify.cpp:622):
 #0 llvm::Value *simplifyAddInst(...)              at InstructionSimplify.cpp:608
 #1 llvm::Value *llvm::simplifyAddInst(...)        at InstructionSimplify.cpp:676
 #2 llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...) at InstCombineAddSub.cpp:1552
 #3 bool llvm::InstCombinerImpl::run()             at InstructionCombining.cpp:5679

VALUE 0x55ef...5130 (  %a = add i32 %x, 0) at llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...) (InstCombineAddSub.cpp:1556):
 #0 llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...) at InstCombineAddSub.cpp:1552
 #1 bool llvm::InstCombinerImpl::run()             at InstructionCombining.cpp:5679

REPLACEMENTS IN THIS ITERATION:
0x55ef...5130 (  %a = add i32 %x, 0) -> 0x55ef...46d0 (i32 %x)
=== ITERATION END ===
```

How to read it:

- **`SESSION` / `ITERATION`** bracket one InstCombine fixed-point iteration.
- **`NEW INSTRUCTIONS`** lists every `Value*` the instrumentation observed
  being produced this iteration. Each entry pairs the pointer + IR text with
  the call path of patched fold helpers that ran on the way to creating it
  — useful for attributing surprising IR to a specific fold.
- **`REPLACEMENTS`** lists every `Value::doRAUW` performed this iteration in
  `old -> new` form. In the example above, `%a = add i32 %x, 0` was folded
  away and all uses replaced with `%x`.

Cross-reference a pointer like `0x55ef...46d0` between the two sections to
see which new value participated in which replacement.

> **Note:** the frame stack is self-maintained — the patcher inserts
> `LLVM_FUZZ_TRACE_SCOPE()` at the top of every wrapped function, and frames
> carry `__FILE__:__LINE__` + `__PRETTY_FUNCTION__` captured at compile time.
> No `llvm-symbolizer` dependency, and native and wasm traces are identical
> in format and content. (The native release tarball still ships
> `llvm-symbolizer` next to `opt` for LLVM's own PrettyStackTrace on crashes,
> but it's not used by the InstCombine trace path.)

## Bumping the LLVM version

Edit `llvm_commit.txt`, then re-run the patcher and whichever build you
care about:

```bash
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh    # native opt
bash build_wasm.sh            # webapp wasm (requires emsdk)
```

`patch_llvm.py` is idempotent — running it twice on the same checkout is a
no-op. To edit the injected runtime, edit `runtime/fuzz_runtime.{h,cpp}`
directly; the patcher reads them at import time.

## CI

- `.github/workflows/build.yml` — native `opt` + `llvm-symbolizer` on every
  push / PR. Pushing a tag matching `release/*` additionally bundles both
  binaries into `opt-llvm-<short-sha>.tar.xz` and uploads it to the
  corresponding GitHub Release.
- `.github/workflows/web.yml` — builds the wasm bundle + frontend and
  deploys to GitHub Pages on pushes to `main`. Caches the host `llvm-tblgen`
  keyed on the resolved LLVM SHA so only the wasm stage reruns between
  iterations.
- `.github/workflows/weekly-llvm.yml` — every Monday (and on-demand via
  `workflow_dispatch`) builds against LLVM's current `main` tip, uploading
  the artifact for 14 days. Useful for catching upstream changes that break
  the patch.

## Useful env vars

| Var | Default | Meaning |
|---|---|---|
| `LLVM_DIR` | `thirdparty/llvm-project` | LLVM source tree |
| `BUILD_DIR` | `build/llvm-rel` | CMake build directory (native) |
| `BUILD_TARGETS` | `opt` | targets passed to `cmake --build` (native) |
| `CCACHE_DIR` | `$HOME/.cache/ccache` | ccache cache directory |
| `LLVM_PARALLEL_LINK_JOBS` | `1` | parallel link jobs (raise on fat machines) |
| `DISABLE_INSTCOMBINE_TRACE` | unset | set to `1` or `true` to disable instrumentation at runtime |
| `HOST_BUILD_DIR` | `build/llvm-host` | wasm host-stage build dir (where native `llvm-tblgen` lands) |
| `WASM_BUILD_DIR` | `build/llvm-wasm` | wasm cross-compile build dir |
| `WEB_PUBLIC_DIR` | `web/public/wasm` | where `build_wasm.sh` drops the bundle for Vite |
| `VITE_BASE` | `/instcombine-instrumentor/` | override the Vite `base` (e.g. `VITE_BASE=/` for local preview) |

## License

Apache License 2.0 with LLVM Exceptions, matching upstream LLVM. See
[`LICENSE`](LICENSE).
