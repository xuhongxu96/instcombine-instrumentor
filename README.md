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

`.github/workflows/build.yml` builds `opt` on every push / PR. Pushing a tag
matching `release/*` additionally strips the binary, gzips it, and uploads it
to the corresponding GitHub Release as `opt-llvm-<short-sha>.gz`, where the
short SHA reflects whatever `llvm_commit.txt` resolved to at build time.

## Useful env vars

| Var | Default | Meaning |
|---|---|---|
| `LLVM_DIR` | `thirdparty/llvm-project` | LLVM source tree |
| `BUILD_DIR` | `build/llvm-rel` | CMake build directory |
| `BUILD_TARGETS` | `opt` | targets passed to `cmake --build` |
| `CCACHE_DIR` | `$HOME/.cache/ccache` | ccache cache directory |
| `LLVM_PARALLEL_LINK_JOBS` | `1` | parallel link jobs (raise on fat machines) |
| `DISABLE_INSTCOMBINE_TRACE` | unset | set to `1` or `true` to disable instrumentation at runtime |
