// Web Worker that hosts the emscripten-built InstCombine driver.
//
// The wasm module is loaded lazily from the public folder so the main bundle
// stays small. We chdir to /work so the runtime's relative `llvm_fuzz_info.txt`
// write lands somewhere we can read back.

interface RunMessage { type: "run"; ir: string; }
type IncomingMessage = RunMessage;

type EmscriptenModule = {
  FS: {
    mkdir(path: string): void;
    chdir(path: string): void;
    writeFile(path: string, data: string): void;
    readFile(path: string, opts: { encoding: "utf8" }): string;
    unlink(path: string): void;
  };
  callMain: (args: string[]) => number | undefined;
  ccall: (name: string, ret: string | null, args: string[], values: unknown[]) => unknown;
};

declare const self: DedicatedWorkerGlobalScope;

let modulePromise: Promise<EmscriptenModule> | null = null;

function getBaseUrl(): string {
  // Vite injects BASE_URL at build time; defaults to "/".
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : base + "/";
}

async function loadModule(): Promise<EmscriptenModule> {
  if (!modulePromise) {
    const wasmJsUrl = `${getBaseUrl()}wasm/instcombine_driver.js`;
    // dynamic import keeps the wasm loader out of the main bundle entirely
    const mod = await import(/* @vite-ignore */ wasmJsUrl);
    const createModule = (mod.default ?? mod) as (cfg: object) => Promise<EmscriptenModule>;
    modulePromise = createModule({
      noInitialRun: true,
      print: (s: string) => console.log("[wasm stdout]", s),
      printErr: (s: string) => console.warn("[wasm stderr]", s),
    });
  }
  return modulePromise;
}

self.onmessage = async (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (msg.type !== "run") return;

  try {
    const Module = await loadModule();
    try { Module.FS.mkdir("/work"); } catch { /* already exists */ }
    Module.FS.chdir("/work");
    Module.FS.writeFile("/work/input.ll", msg.ir);
    try { Module.FS.unlink("/work/llvm_fuzz_info.txt"); } catch { /* not present */ }

    Module.callMain([]);
    Module.ccall("dump_iteration_info_external", null, [], []);

    let trace = "";
    try {
      trace = Module.FS.readFile("/work/llvm_fuzz_info.txt", { encoding: "utf8" });
    } catch {
      trace = "(no trace produced — InstCombine made no changes, or the runtime failed to open the trace file)";
    }
    self.postMessage({ type: "done", trace });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

self.postMessage({ type: "ready" });
