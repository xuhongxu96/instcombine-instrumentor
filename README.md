# instcombine-instrumentor

Build an instrumented LLVM `opt` that records every new instruction and every
RAUW replacement performed by InstCombine / InstructionSimplify on each pass
iteration. Useful for fuzzing and differential analysis of InstCombine folds.

Ships in two flavors:

- **Native `opt`** — patched LLVM build, traces to `llvm_fuzz_info.txt`.
- **In-browser webapp** — Vite + React + Monaco SPA running a minimal
  WebAssembly InstCombine on user-pasted IR.
  **Live:** <https://xuhongxu.com/instcombine-instrumentor/>

## Quickstart (native `opt`)

Deps managed by [uv](https://github.com/astral-sh/uv) (`curl -LsSf
https://astral.sh/uv/install.sh | sh`).

```bash
uv sync
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh
bash smoke_test.sh     # builds a tiny IR through opt and checks the trace
```

The patched binary writes its trace to `./llvm_fuzz_info.txt`. Set
`DISABLE_INSTCOMBINE_TRACE=1` at runtime to suppress instrumentation entirely.

## Quickstart (webapp / WebAssembly)

Prereqs: native toolchain (clang/lld/cmake/ninja), activated
[emsdk](https://emscripten.org/) `5.0.7`, Node 20+.

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git thirdparty/emsdk
./thirdparty/emsdk/emsdk install 5.0.7 && ./thirdparty/emsdk/emsdk activate 5.0.7
source ./thirdparty/emsdk/emsdk_env.sh

bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_wasm.sh                # ~10-30 min cold; reuses build/llvm-host
node wasm/test/smoke_wasm.mjs     # smoke

cd web && npm install && npm run dev
# → http://localhost:5173/instcombine-instrumentor/
```

## Bumping the LLVM version

Edit `llvm_commit.txt`, then re-run the patcher and whichever build you care
about. `patch_llvm.py` is idempotent — running it twice on the same checkout
is a no-op.

```bash
bash clone_llvm.sh
uv run python patch_llvm.py --llvm-repo thirdparty/llvm-project
bash build_patched_llvm.sh    # native opt
bash build_wasm.sh            # webapp wasm (requires emsdk)
```

To edit the injected runtime, edit `runtime/fuzz_runtime.{h,cpp}` directly;
the patcher reads them at import time.

## More

See [`CLAUDE.md`](CLAUDE.md) for the patching/runtime architecture, trace
format, CI layout, and the full env-var reference.

## License

Apache License 2.0 with LLVM Exceptions, matching upstream LLVM. See
[`LICENSE`](LICENSE).
