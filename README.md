# instcombine-instrumentor

Tools to build an instrumented LLVM `opt` that records every new instruction and
every RAUW replacement performed by InstCombine / InstructionSimplify on each
pass iteration. Useful for fuzzing and differential analysis of InstCombine
folds.

## Layout

- `llvm_commit.txt` — LLVM ref (commit SHA or tag) to build against.
- `clone_llvm.sh` — clones LLVM into `thirdparty/llvm-project` at that ref.
- `patch_llvm.py` — injects a fuzz runtime into the LLVM source tree and wraps
  return values across InstCombine / InstructionSimplify / `Value::doRAUW`.
- `build_patched_llvm.sh` — configures and builds the patched `opt` into
  `build/llvm-rel/`.

## Quickstart

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

### Example output

Feeding the smoke-test IR through `opt -passes=instcombine` produces a trace
that looks like this (frames elided for brevity — see `llvm_fuzz_info.txt`
for the full backtraces):

```text
=== SESSION START ===
=== ITERATION START ===

NEW INSTRUCTIONS IN THIS ITERATION:
VALUE 0x55ef...46d0 (i32 %x) at simplifyAddInst (InstructionSimplify.cpp:610):
 #4 simplifyAddInst(...)                      InstructionSimplify.cpp:610:5
 #5 llvm::simplifyAddInst(...)                InstructionSimplify.cpp:664:10
 #6 llvm::InstCombinerImpl::visitAdd(...)     InstCombineAddSub.cpp:1528:14
 #7 llvm::InstVisitor<...>::visit(...)        Instruction.def:147:1
 #8 llvm::InstCombinerImpl::run()             InstructionCombining.cpp:5759:22
 ...
#18 optMain                                   (build/llvm-rel/bin/opt+0x162873a)

VALUE 0x55ef...5130 (  %a = add i32 %x, 0) at visitAdd (InstCombineAddSub.cpp:1531):
 #4 llvm::InstCombinerImpl::visitAdd(...)     InstCombineAddSub.cpp:1531:5
 #5 llvm::InstVisitor<...>::visit(...)        Instruction.def:147:1
 ...

REPLACEMENTS IN THIS ITERATION:
0x55ef...5130 (  %a = add i32 %x, 0) -> 0x55ef...46d0 (i32 %x)
=== ITERATION END ===
```

How to read it:

- **`SESSION` / `ITERATION`** bracket one InstCombine fixed-point iteration.
- **`NEW INSTRUCTIONS`** lists every `Value*` the instrumentation observed
  being produced this iteration. Each entry pairs the pointer + IR text with
  a symbolized stack trace pointing back to the exact LLVM source line that
  created it — useful for attributing surprising IR to a specific fold.
- **`REPLACEMENTS`** lists every `Value::doRAUW` performed this iteration in
  `old -> new` form. In the example above, `%a = add i32 %x, 0` was folded
  away and all uses replaced with `%x`.

Cross-reference a pointer like `0x55ef...46d0` between the two sections to
see which new value participated in which replacement.

> **Note:** symbolized frames require `llvm-symbolizer` to be reachable. The
> patched binary picks it up from `$PATH` or from `LLVM_SYMBOLIZER_PATH`. The
> release/artifact bundle ships `llvm-symbolizer` next to `opt`; keep them in
> the same directory or set `LLVM_SYMBOLIZER_PATH` explicitly.

## Bumping the LLVM version

Edit `llvm_commit.txt`, then:

```bash
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh
```

`patch_llvm.py` is idempotent — running it twice on the same checkout is a
no-op.

## CI

`.github/workflows/build.yml` builds `opt` (and `llvm-symbolizer`) on every
push / PR. Pushing a tag matching `release/*` additionally bundles both
binaries into `opt-llvm-<short-sha>.tar.xz` and uploads it to the
corresponding GitHub Release; the short SHA reflects whatever
`llvm_commit.txt` resolved to at build time.

`.github/workflows/weekly-llvm.yml` runs every Monday (and on-demand via
`workflow_dispatch`) against LLVM's current `main` tip, uploading the build
as a 14-day artifact. Useful for catching upstream changes that break the
patch.

## Useful env vars

| Var | Default | Meaning |
|---|---|---|
| `LLVM_DIR` | `thirdparty/llvm-project` | LLVM source tree |
| `BUILD_DIR` | `build/llvm-rel` | CMake build directory |
| `BUILD_TARGETS` | `opt` | targets passed to `cmake --build` |
| `CCACHE_DIR` | `$HOME/.cache/ccache` | ccache cache directory |
| `LLVM_PARALLEL_LINK_JOBS` | `1` | parallel link jobs (raise on fat machines) |
| `DISABLE_INSTCOMBINE_TRACE` | unset | set to `1` or `true` to disable instrumentation at runtime |

## License

Apache License 2.0 with LLVM Exceptions, matching upstream LLVM. See
[`LICENSE`](LICENSE).
