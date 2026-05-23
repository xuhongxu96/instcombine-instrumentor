# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo does

This is *not* a normal codebase — it is a build harness that patches an upstream LLVM source tree and produces an instrumented `opt` binary that traces every new instruction and every RAUW performed by `InstCombine` / `InstructionSimplify` per pass iteration. The first-party sources are `patch_llvm.py` (the patcher), the C++ runtime under `runtime/`, the minimal wasm driver under `wasm/driver/`, the webapp under `web/`, plus a handful of shell scripts. Live webapp: <https://xuhongxu.com/instcombine-instrumentor/>.

The C++ runtime injected into LLVM lives in real source files at `runtime/fuzz_runtime.{h,cpp}` — edit those, not `patch_llvm.py`. The patcher reads them at module import via `Path.read_text()` and writes them into the LLVM tree at `llvm/include/llvm/IR/fuzz_runtime.h` and `llvm/lib/IR/fuzz_runtime.cpp`. The runtime is target-agnostic for the trace path — call-path frames come from a self-maintained `thread_local` stack populated by an RAII `CallScope` pushed *at each call site*, not from `llvm::sys::PrintStackTrace`, so native and wasm traces are byte-format-identical. The only remaining `#ifdef __EMSCRIPTEN__` guards `std::atexit` (unreliable under emscripten); an always-emitted `extern "C" dump_iteration_info_external` lets the wasm host flush the final iteration explicitly.

## Common commands

```bash
uv sync                                            # install Python deps (tree-sitter)
bash clone_llvm.sh                                 # clone LLVM at the ref in llvm_commit.txt
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh                         # builds opt + llvm-symbolizer into build/llvm-rel
bash smoke_test.sh                                 # runs opt on a tiny IR and checks the trace
```

To bump the LLVM version: edit `llvm_commit.txt`, re-run `clone_llvm.sh` → `patch_llvm.py` → `build_patched_llvm.sh`. `patch_llvm.py` is idempotent on a clean checkout, so running it twice is a no-op (each patcher checks for sentinels like `__llvm_fuzz_record_replace`, `llvm_fuzz::start_iteration()`, `fuzz_runtime.cpp`). It also carries one small build-graph workaround for newer LLVM snapshots: if `llvm/lib/MC/DXContainerInfo.cpp` includes `llvm/Support/VCSRevision.h` but `llvm/lib/MC/CMakeLists.txt` does not depend on `llvm_vcsrevision_h`, the patcher adds that missing dependency so parallel wasm builds do not race on the generated header.

At runtime, `DISABLE_INSTCOMBINE_TRACE=1` makes the patched `opt` behave like stock `opt`. The trace file is hard-coded to `llvm_fuzz_info.txt` in the CWD.

## Patching architecture

`patch_llvm.py` uses tree-sitter (not regex/sed) to walk C++ function definitions. Patching runs in **two passes**:

1. **First pass (`_collect_instrumented_names`)** scans every `.cpp`/`.h` under `llvm/lib/Transforms/InstCombine/` plus `llvm/lib/Analysis/InstructionSimplify.cpp` and collects the bare names of every function whose return type "looks like a pointer to a Value/Instruction subclass" (see `POINTER_TYPE_HINTS` and `_is_pointer_return`). This name set is the **call-site allowlist** used by the second pass.

2. **Second pass** applies three distinct patchers to specific files in `thirdparty/llvm-project`:

   1. **`patch_value_cpp`** → `llvm/lib/IR/Value.cpp`. Finds `doRAUW` and inserts `__llvm_fuzz_record_replace(this, New)` at the top of its body. This is the single RAUW hook for the whole engine.

   2. **`patch_inst_combine_file`** → every `.cpp`/`.h` in `llvm/lib/Transforms/InstCombine/`. For *every* function body (not just pointer-returning ones), it wraps each `call_expression` whose bare callee is in the allowlist or matches `^Create[A-Z]` (IRBuilder `CreateAdd`/`CreateICmp`/… without enumerating dozens of variants) as `__llvm_fuzz_call(callee(args...))`. Additionally, for pointer-returning functions it wraps every *top-level* `return X;` as `return __llvm_fuzz_record(X);` (returns inside nested lambdas/local function definitions are skipped via `is_inside_nested_scope`). In `InstructionCombining.cpp` the `InstCombinerImpl::run` method also gets a `llvm_fuzz::start_iteration()` prelude and its `return MadeIRChange;` is rewritten to dump the iteration trace first.

   3. **`patch_instruction_simplify_file`** → `llvm/lib/Analysis/InstructionSimplify.cpp`. Same as #2 but `_is_pointer_return` is called with `allow_star_in_prefix=True`, which is the practical difference between the two patchers (Simplify writes pointer return types in a style the strict matcher misses).

Why two passes: call-site wraps need to know *which* callees are themselves instrumented, so the allowlist must be built before any source mutation.

**Edit-conflict handling.** A call inside a `return` expression is covered by both a call wrap and a return wrap. `_body_edits` resolves this by treating the outermost wrappable unit as the edit target and recursively splicing inner wraps into its replacement text (`_render_wrap_unit` / `_render_with_inner_wraps`). So `return foo(bar(x));` becomes `return __llvm_fuzz_record(__llvm_fuzz_call(foo(__llvm_fuzz_call(bar(x)))));` from a single non-overlapping edit. Idempotency is enforced by `_is_inside_fuzz_wrap`: a call already inside `__llvm_fuzz_call`/`__llvm_fuzz_record` is skipped.

All three patchers prepend `#include "llvm/IR/fuzz_runtime.h"` if not already present. After patching, one `CMakeLists.txt` is updated:
- `llvm/lib/IR/CMakeLists.txt` → adds `fuzz_runtime.cpp` to `LLVMCore`.

(Earlier revisions also forced `-O0 -g` on InstructionSimplify and the InstCombine library so `PrintStackTrace`/`llvm-symbolizer` could resolve frames accurately; those overrides were removed once the trace path switched to compile-time `__FILE__`/`__LINE__` captured at each call site.)

Edits within a single file are collected and applied in reverse byte-order (`apply_edits`) so earlier offsets stay valid.

## Runtime architecture (the C++ injected into LLVM)

The runtime source lives at `runtime/fuzz_runtime.{h,cpp}` and is copied into the LLVM tree by `create_fuzz_runtime` (at `llvm/include/llvm/IR/fuzz_runtime.h` and `llvm/lib/IR/fuzz_runtime.cpp`):
- The header declares `llvm_fuzz::record_stacktrace`, `record_replacement`, `start_iteration`, `dump_iteration_info`, plus the `record_stacktrace_with_loc<T>` template that the `__llvm_fuzz_record` macro uses, and the `CallScope` RAII struct + `__llvm_fuzz_call(expr)` macro. The header is kept narrow: `Frame` and the thread-local `call_path` itself are private to the .cpp. The `__llvm_fuzz_call` macro is a **GCC statement expression** (`__extension__ ({ CallScope cs(...); (expr); })`), not a lambda — InstCombine has many `for (auto [k, v] : ...)` loops whose bodies contain wrappable calls, and C++17 lambdas can't capture structured bindings. A statement-expression block scope references outer names natively, so structured bindings work.
- The cpp holds a global mutex-guarded `IterationState` (new values + replacements) and a `trace_map` from `Value*` → captured stacktrace/IR-print/source-loc, plus a `static thread_local std::vector<Frame> call_path` and the `CallScope` ctor/dtor that push/pop into it (both early-return when `is_trace_disabled()` so push/pop is a no-op under `DISABLE_INSTCOMBINE_TRACE=1`). `start_iteration()` flushes the previous iteration to `llvm_fuzz_info.txt` (append mode) then clears state. An `AtExitRegister` static truncates the file at session start (writes `=== SESSION START ===`) and registers `dump_iteration_info` at `atexit` so the final iteration is not lost (native only — emscripten relies on `dump_iteration_info_external` being called by the JS host).

**Frames represent call sites, not function entries.** Each `Frame` in `call_path` holds the *caller's* identity: `__FILE__:__LINE__` of the call expression and `__PRETTY_FUNCTION__` of the function that made the call (all captured at compile time at the wrap macro's expansion point). Snapshots print `#1, #2, ...` top-of-stack-first (innermost caller is `#1`); `#0` is the location on the `VALUE` header line itself, which is the function that produced the value. This is why the smoke tests assert that the `visitAdd` frame line is *not* the signature line — it should be a call site inside `visitAdd`'s body. Native and wasm produce byte-format-identical traces; no symbolizer is needed and the trace works at any opt level.

### Trace format

`llvm_fuzz_info.txt` is append-only, segmented by `=== SESSION START ===` (per process) and `=== ITERATION <N> START === / === ITERATION END ===` (per InstCombine fixed-point iteration; `<N>` is a 1-based counter bumped in `start_iteration()`). Each iteration has two sections:

```text
NEW INSTRUCTIONS IN THIS ITERATION:
VALUE 0x55ef...46d0 (i32 %x) at llvm::Value *simplifyAddInst(...) (InstructionSimplify.cpp:622):
 [opcode=add] [fn=f/entry] [rule=llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...)]
 #1 llvm::Value *llvm::simplifyAddInst(...)        at InstructionSimplify.cpp:676
 #2 llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...) at InstCombineAddSub.cpp:1556
 #3 bool llvm::InstCombinerImpl::run()             at InstructionCombining.cpp:5679

REPLACEMENTS IN THIS ITERATION:
0x55ef...5130 (  %a = add i32 %x, 0) -> 0x55ef...46d0 (i32 %x)
```

- The `VALUE … at <func> (<file>:<line>)` header is frame `#0` — the function that produced the value and the source line of the wrapping `__llvm_fuzz_record(...)` return.
- The `[opcode=…] [fn=… / bb=…] [rule=…] [dbg=…]` meta line appears for instruction-typed values: opcode name, the containing user IR function (and basic block), the rule that fired (innermost stack frame from `lib/Transforms/InstCombine/`), and the value's `DebugLoc` if the user IR carries DI metadata. Any missing field is omitted; the whole line is omitted when every field would be empty.
- `#1, #2, …` are call sites walking outward: each frame's func is the *caller's* `__PRETTY_FUNCTION__`, the file/line is the call expression where it dispatched to the next callee in.
- `REPLACEMENTS` lists every `Value::doRAUW` performed during the iteration. Cross-reference a pointer (e.g. `0x55ef...46d0`) between the two sections to see which new value participated in which replacement.

### JSONL sidecar

Alongside the text dump, the runtime writes `llvm_fuzz_info.json` in JSON Lines format (one object per iteration, newline-terminated). The webapp's "structured" view consumes this; terminal users can ignore it. Schema:

```jsonc
{
  "iteration": 1,
  "new_values": [
    { "ptr": "0x55…", "ir": "%a = add i32 %x, 0",
      "opcode": "add", "parent_fn": "f", "parent_bb": "entry",
      "debug_loc": "src.c:3:5", "rule": "llvm::...visitAdd(...)",
      "loc": "Value.cpp:1234", "func_name": "...",
      "frames": [{ "name": "...", "file": "...", "line": 42 }] }
  ],
  "replacements": [
    { "old_ptr": "0x55…", "new_ptr": "0x55…",
      "old_ir": "  %a = add i32 %x, 0", "new_ir": "i32 %x",
      "old_opcode": "add", "new_opcode": "" }
  ]
}
```

JSONL (not a single JSON document) matches the existing append-on-each-iteration write model: a process that dies mid-iteration leaves an unfinished trailing line, but every prior iteration remains parseable. The webapp's `web/src/trace/parse.ts` defensively skips malformed lines. Pointers are emitted as `"0x<hex>"` strings so they double as DOM ids / anchor targets in the structured view.

## WebAssembly build (webapp at `web/`)

The repo also produces an in-browser InstCombine debugger: `web/` is a Vite + React + Monaco SPA that loads a wasm InstCombine driver, runs it on user-pasted IR, and shows the optimized IR plus the resulting `llvm_fuzz_info.txt`. The layout is three resizable panes (`react-resizable-panels`): input IR top-left, post-pass `output.ll` bottom-left, trace on the right. The trace pane has a Text / Structured toggle — "Structured" parses `llvm_fuzz_info.json` and renders collapsible iterations with opcode/rule/function pills, replacement rows with clickable pointer cross-links, and a filter bar (text / opcode / rule / function). Build pipeline:

- `wasm/driver/instcombine_driver.cpp` — ~60-line custom driver that parses `/work/input.ll`, registers PassBuilder analyses, runs `createModuleToFunctionPassAdaptor(InstCombinePass())`, then serializes the post-pass module to `/work/output.ll` via `Module::print` so the webapp can read it back. Not the full `opt` binary — keeps the wasm small. (Native `opt` keeps printing IR to stdout when run with `-S`, so it doesn't need the same sidecar.)
- `wasm/driver/CMakeLists.txt` — wired into the LLVM build via `LLVM_EXTERNAL_PROJECTS=instcombine_driver`. Emits an ES-module `.js` loader + `.wasm` sidecar.
- `build_wasm.sh` — two-stage cross-compile: native `llvm-tblgen` at `build/llvm-host/` (LLVM's wasm build can't run tblgen itself), then `emcmake cmake` at `build/llvm-wasm/` with `LLVM_TARGETS_TO_BUILD=""` and `LLVM_ENABLE_THREADS=OFF` (no `SharedArrayBuffer`/COOP+COEP on Pages). Outputs land in `web/public/wasm/`.
- `wasm/test/smoke_wasm.mjs` — Node-based smoke. Mirrors `smoke_test.sh`; checks for a `visitAdd` frame in the manual call path and asserts the frame's line is a call site inside `visitAdd`'s body, not its signature line (so call-site instrumentation didn't silently regress to function-entry behavior).
- `web/src/worker/instcombine.worker.ts` — runs the wasm Module in a Web Worker; writes IR into MEMFS at `/work/input.ll`, calls `Module.callMain([])`, then `Module.ccall("dump_iteration_info_external")`, then reads back three MEMFS files: `/work/llvm_fuzz_info.txt` (text trace), `/work/llvm_fuzz_info.json` (JSONL sidecar — optional, older bundles may not emit it), and `/work/output.ll` (post-pass IR — also optional for older bundles). All three are posted back as strings; missing files come through as `""` so the UI degrades cleanly. A worker is mandatory: `MPM.run` is synchronous and the wasm bundle is large. The worker speaks a two-message protocol (`loadVersion` then `run`) so the main thread can swap wasm versions on the fly; `kind: "bundled"` versions dynamic-import a same-origin URL, while `kind: "remote"` versions fetch the JS + .wasm as blobs and dynamic-import the resulting blob URL with `locateFile` pointing at the wasm blob (the blob trick keeps the worker code identical regardless of whether the remote server's CORS happens to permit a direct module import).
- `web/src/wasm/manifest.ts` + `web/scripts/build-manifest.mjs` — runtime manifest type and a Node-only Pages-time builder. The **canonical manifest** lives at `manifest.json` on the `wasm-pkgs` branch (see CI section) and is regenerated by `.github/scripts/wasm-publish/build_manifest.mjs` whenever `wasm-publish.yml` publishes new artifacts. The Pages builder fetches that remote manifest and *transforms* it according to `--bundle-mode`:
  - `remote` (default in CI) — copy through; every entry stays `bundled: false` with absolute `raw.githubusercontent.com` URLs.
  - `hybrid` — force-include any entry from `wasm-must-bundle.txt` or `--include <csv>` (no cap); then bundle the newest stable tag per LLVM major up to `--bundle-count` (default 5); optionally bundle the newest `--include-commit-count` `main-*` snapshots. Bundled entries get same-origin URLs under `web/public/wasm/<slug>/`; the rest stay remote.
  - `bundled` — bundle every entry locally. Equivalent to the pre-wasm-pkgs behaviour, just sourced from `wasm-pkgs` instead of GitHub Releases.

  The dropdown renders two `<optgroup>` sections keyed off the `kind: "tag" | "commit"` field: "Tagged releases" (the bare `llvmorg-X.Y.Z[-rcN]` directories) and "Commit snapshots" (the daily `main-<YYMMDD>-<sha12>` directories). `manifest.defaultTag` is the highest stable `llvmorg-X.Y.Z` so commit snapshots never become the default selection. **Manifest-fetch waterfall** at app startup: `import.meta.env.VITE_REMOTE_MANIFEST_URL` first (baked at build time by `vite.config.ts`, defaults to this repo's wasm-pkgs raw URL), then same-origin `wasm/manifest.json`, then the local `fallbackManifest()` for `npm run dev` against a bare `build_wasm.sh` output.
- `wasm-must-bundle.txt` (repo root) — declarative force-include list for the Pages-time bundler. Entries match either an exact `wasm-pkgs` directory name (`llvmorg-22.1.5` or `main-<YYMMDD>-<12hex>`) or a bare 7-40 char hex SHA matched as a prefix against the 12-hex suffix of any commit snapshot. Force-includes bypass `--bundle-count` / `--include-commit-count` but don't disable the per-major auto-picks.

## CI

Native `opt` releases and wasm artifacts now travel on independent paths:
release tags carry only the native `opt-llvm-*.tar.xz`, while wasm builds are
published as committed directories on the `wasm-pkgs` branch (browser fetches
them at runtime via `raw.githubusercontent.com`).

- `.github/workflows/native-build.yml` — runs on push/PR, and on `release/*` tags it bundles `opt` + `llvm-symbolizer` into `opt-llvm-<short-sha>.tar.xz` and attaches to the GitHub Release. No wasm; the release flow is native-opt-only.
- `.github/workflows/wasm-verify.yml` — **verification-only**. Runs on push/PR (paths gated to wasm-relevant files) and `workflow_dispatch`. Builds the wasm bundle via `build_wasm.sh`, but wraps that build in `.github/scripts/shared/retry.sh` (`3` attempts, `1s` linear backoff) to absorb flaky upstream generated-header races such as `VCSRevision.h`, then runs `wasm/test/smoke_wasm.mjs`, uploads a 14-day `wasm-bundle-latest` workflow artifact so PR authors can preview a build without publishing. No GitHub Release attachment. No tag triggers.
- `.github/workflows/wasm-publish.yml` — the wasm publishing workflow. Mostly a thin orchestrator over the per-step scripts under `.github/scripts/wasm-publish/`. Modes selected via `workflow_dispatch` input (`mode: weekly-stable | daily-main | specific-ref | rebuild-existing`) or by cron schedule (Mon 05 UTC = `weekly-stable`, every 3 days at 06 UTC = `daily-main`). `rebuild-existing` is manual-only and enumerates every existing build directory already present on the `wasm-pkgs` branch (`llvmorg-*` tags and `main-YYMMDD-sha12` snapshots), rebuilding each one from its corresponding LLVM ref and republishing the outputs in place. The workflow splits into a `resolve` job, an unlocked `build` job, and a mutexed `finalize` job: `dispatch.sh` normalizes the event into a mode + inputs tuple → `resolve.sh` (wrapping `resolve_refs.sh`) emits a `<dirname>\t<llvm_commit>` table of refs to build and uploads it as an artifact → `build_one.sh` is invoked per ref to reset/clone/patch/build/smoke-test and copy outputs into a staging directory uploaded as a workflow artifact. Its build step also wraps `build_wasm.sh` in `.github/scripts/shared/retry.sh` (`3` attempts, `1s` linear backoff) so a transient upstream build-graph race can self-heal without restarting the whole workflow. `finalize` downloads both artifacts, runs `setup_worktree.sh` to check out the `wasm-pkgs` branch (auto-initializing the orphan branch on first run), then `finalize.sh` copies the staged outputs into the branch, prunes old `main-*` snapshots (daily-main only, keeps last `prune_main` = 7), regenerates `wasm-pkgs/manifest.json` via `build_manifest.mjs`, and commits + pushes. `build/llvm-wasm` is intentionally kept across iterations so CMake's incremental rebuild and ccache reuse stay valid across refs. Only the finalize job is serialized (`group: wasm-pkgs`), so overlapping runs can build in parallel but still commit atomically. The build/finalize job names include the current resolved build list. Permissions: `contents: write` only. Workflow inputs let you `force_rebuild` (skip the "already published" short-circuit) and `dry_run` (build without pushing). The `rebuild-existing` ref list is emitted in a cache-friendly order: stable `llvmorg-*` releases first in `sort -V` order so adjacent versions build back-to-back, then `main-*` snapshots in date order.
- `.github/workflows/wasm-pages.yml` — runs on push to `main` (web paths), PRs (build only), `workflow_dispatch`, and Mon 09 UTC cron. Runs `web/scripts/build-manifest.mjs` against the live `wasm-pkgs/manifest.json` to produce the same-origin manifest the webapp can use as a fallback. `workflow_dispatch` exposes `bundle_mode` (`remote` / `hybrid` / `bundled`, default `remote`), `bundle_count` (default 5), `include_commit_count` (default 0), and `must_bundle` (CSV, merged with `wasm-must-bundle.txt`). The build also bakes `VITE_REMOTE_MANIFEST_URL` so the webapp prefers the live wasm-pkgs raw manifest at runtime.
- `.github/workflows/native-weekly-canary.yml` — Monday cron (and `workflow_dispatch`) against LLVM `main` tip; the canary for upstream changes that break the patch. Native opt build; no wasm.
- `.github/workflows/native-release-auto.yml` — Monday cron plus `workflow_dispatch`. Scans `git ls-remote --tags https://github.com/llvm/llvm-project.git` for stable `llvmorg-X.Y.Z` tags not yet present as `release/llvmorg-X.Y.Z`, takes the newest `max_tags` (default 1), and for each missing tag pushes a `release/<llvm-tag>` tag on a detached commit that bumps `llvm_commit.txt`, pre-creates the GitHub Release, then explicitly dispatches `native-build.yml` against that tag's ref via `gh workflow run` (the dispatch sidesteps GitHub's loop-prevention rule that suppresses workflow runs triggered by tag pushes from `GITHUB_TOKEN`). Wasm for the same tag is published *independently* by `wasm-publish.yml`'s weekly cron — they aren't coupled.
- `.github/workflows/native-release-manual.yml` — `workflow_dispatch`-only companion to `native-release-auto.yml`. Inputs: `llvm_ref` (an `llvmorg-*` tag or 7-40 hex commit SHA; branches rejected) and `dry_run`. Tag derivation is identical to before: `release/<llvm_ref>` for tags, `release/<YYMMDD>-<first-12-of-full-SHA>` for SHAs (date pulled from `gh api repos/llvm/llvm-project/commits/<sha>`, the 40-char SHA baked into `llvm_commit.txt`). Calls `.github/scripts/native-release-manual/tag.sh`, which dispatches `native-build.yml` only. To publish a wasm bundle for the same ref, dispatch `wasm-publish.yml` with `mode=specific-ref llvm_ref=<same ref>` separately.

`native-build.yml` pins `ubuntu-22.04`; the `wasm-*` / `native-weekly-canary` jobs use `ubuntu-latest`. All depend on `.github/scripts/shared/install_toolchain.sh` and `.github/scripts/shared/resolve_llvm_commit.sh`.

**Helper scripts are grouped by owning workflow under `.github/scripts/`:** `shared/` (`ccache_keys.sh`, `install_toolchain.sh`, `resolve_llvm_commit.sh`, `retry.sh`) is used by multiple workflows. Everything else lives under the subdirectory named after its sole consumer — `native-release-auto/`, `native-release-manual/`, `wasm-publish/`, `wasm-pages/`. Inside each subdir filenames drop the redundant workflow prefix (so the wasm-publish dispatch step lives at `wasm-publish/dispatch.sh`, not `wasm-publish/wasm_publish_dispatch.sh`).

**ccache caching.** All four build workflows (`native-build.yml`, `wasm-verify.yml`, `wasm-publish.yml`, `native-weekly-canary.yml`) share the same actions/cache@v4 strategy. Cache keys come from `.github/scripts/shared/ccache_keys.sh <workflow> <os>` (run in a `Compute ccache keys` step just before the cache restore) and follow the layout `ccache-v2-<workflow>-<os>-<kind>-<id>-<run-id>` where `<kind>-<id>` is derived from **`llvm_commit.txt`** — the actual source-of-truth for which LLVM is being built, *not* the triggering git ref. Deriving from `llvm_commit.txt` means every workflow targeting the same LLVM version shares a bucket: PRs, push-to-main, and the release tag for the same `llvmorg-X.Y.Z` all hit each other's cache, and keying lives or dies with the LLVM bump rather than each git ref. (The `-v2-` prefix invalidates older SHA-keyed caches; bump it again if the layout changes.) The three kinds the helper emits:

- `tag-llvmorg-<X>.<Y>.<Z>[-rcN]` — `llvm_commit.txt` is an `llvmorg-X.Y.Z[-rcN]` upstream tag.
- `tag-commit-<YY>-<MM>-<DD>` — `llvm_commit.txt` is a hex commit SHA; the helper reads the committer date from the cloned LLVM checkout. If the checkout doesn't exist yet the id falls back to `tag-commit-sha-<first-12>`.
- `branch-<name>` — `--branch <name>` override, or `llvm_commit.txt` content that's neither a tag nor a SHA.

`native-weekly-canary.yml` passes `--branch main` because its `Select LLVM ref` step rewrites `llvm_commit.txt` with whatever upstream ref the dispatcher pointed at (often LLVM main tip) — that ref isn't a stable cache identity, so weekly's writes pin to the `branch-main` bucket and rely on the broader fallbacks for restore hits. `wasm-publish.yml` now splits by mode: `daily-main` also passes `--branch main` so its LLVM-main snapshots share the same bucket, while `weekly-stable` / `specific-ref` use `--branch wasm-pkgs` because a single run may cycle through multiple unrelated LLVM refs. `native-build.yml` and `wasm-verify.yml` leave the source detection to `llvm_commit.txt`.

`restore-keys` walks from the most-specific same-id prefix outward — for llvmorg tags that's `X.Y.Z` → `X.Y.` → `X.` → any `tag-llvmorg-`; for commit snapshots `YY-MM-DD` → `YY-MM-` → `YY-` → any `tag-commit-` — then falls back to the `branch-main-` bucket so a brand-new release tag inherits weekly/main cache, then to the workflow-and-os catch-all. The per-run id suffix forces a fresh write each run (`actions/cache@v4` only writes when the primary misses), so the LRU 10 GB budget can evict stale older entries and we never get stuck on a cache locked in by the first successful run.

`wasm-verify.yml` and `wasm-publish.yml` additionally pin `EMSDK_VERSION` and export `CCACHE_COMPILERCHECK=string:emsdk-<version>` around `build_wasm.sh` so emcc (a Python wrapper) gets a stable compiler hash; `build_wasm.sh` / `build_patched_llvm.sh` set `LLVM_CCACHE_BUILD=ON` and `CCACHE_BASEDIR=$(realpath .)` so paths are relativized for cross-runner portability. Each workflow runs `ccache -z` after restore and `ccache -s -v` after the build so the per-run hit/miss numbers in the logs reflect only that run.

## Useful env vars

| Var | Default | Meaning |
|---|---|---|
| `LLVM_DIR` | `thirdparty/llvm-project` | LLVM source tree |
| `BUILD_DIR` | `build/llvm-rel` | native CMake build dir |
| `BUILD_TARGETS` | `opt llvm-symbolizer` | targets for `cmake --build` |
| `CCACHE_DIR` | `$HOME/.cache/ccache` | ccache cache directory |
| `LLVM_PARALLEL_LINK_JOBS` | `1` | raise on machines with lots of RAM |
| `DISABLE_INSTCOMBINE_TRACE` | unset | `1`/`true` disables instrumentation at runtime (also no-ops `CallScope` push/pop) |
| `LLVM_SYMBOLIZER_PATH` | unset | path to `llvm-symbolizer` for LLVM's own PrettyStackTrace on crashes; not used by the InstCombine trace path |
| `HOST_BUILD_DIR` | `build/llvm-host` | wasm host-stage build dir (native `llvm-tblgen` lands here) |
| `WASM_BUILD_DIR` | `build/llvm-wasm` | wasm cross-compile build dir |
| `WEB_PUBLIC_DIR` | `web/public/wasm` | where `build_wasm.sh` drops the bundle for Vite |
| `VITE_BASE` | `/instcombine-instrumentor/` | override the Vite `base` (e.g. `VITE_BASE=/` for local preview) |
| `VITE_REMOTE_MANIFEST_URL` | wasm-pkgs raw URL for this repo | override where the webapp's manifest-fetch waterfall looks if `wasm/manifest.json` is missing same-origin |
