// Web Worker that hosts the emscripten-built InstCombine driver.
//
// The main thread chooses which wasm bundle to use via a `loadVersion` message
// (bundled = same-origin Pages asset, remote = fetched from a GitHub Release).
// Switching versions tears down the previous module and revokes any blob URLs
// it allocated. The runtime's trace file lives in MEMFS at /work/llvm_fuzz_info.txt;
// we chdir there so the runtime's relative open() succeeds.

import type { WasmSource } from "../wasm/manifest";

interface LoadVersionMessage { type: "loadVersion"; id: string; source: WasmSource; }
interface RunMessage         { type: "run"; ir: string; }
type IncomingMessage = LoadVersionMessage | RunMessage;

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

interface ActiveModule {
  id: string;
  promise: Promise<EmscriptenModule>;
  revokeUrls: string[];
  // Filled by the module's `printErr` callback and drained per run. Lets the
  // main thread show driver diagnostics (e.g. IR parse errors) in the UI
  // instead of leaving them to the dev console.
  stderr: string[];
}

declare const self: DedicatedWorkerGlobalScope;

let active: ActiveModule | null = null;
const moduleCache = new Map<string, ActiveModule>();
const REMOTE_BUNDLE_CACHE = "instcombine-wasm-v1";

function sourceCacheKey(id: string, source: WasmSource): string {
  return `${id}\u0000${source.kind}\u0000${source.jsUrl}\u0000${source.wasmUrl}`;
}

async function fetchWithPersistentCache(url: string): Promise<Response> {
  const cache = await caches.open(REMOTE_BUNDLE_CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (response.ok) await cache.put(url, response.clone());
  return response;
}

async function loadFromSource(id: string, source: WasmSource): Promise<ActiveModule> {
  const cacheKey = sourceCacheKey(id, source);
  const cached = moduleCache.get(cacheKey);
  if (cached) return cached;

  const revokeUrls: string[] = [];
  let jsImportUrl: string;
  let locateFile: ((path: string) => string) | undefined;

  if (source.kind === "bundled") {
    // Same-origin: dynamic import resolves the wasm sibling via the JS loader's own
    // import.meta.url, so no locateFile override is needed.
    jsImportUrl = source.jsUrl;
  } else {
    // Cross-origin module imports require strict CORS + correct Content-Type from
    // the responding server. Sidestep that by fetching as blobs and importing the
    // resulting blob URL — same-origin from the browser's perspective.
    //
    // raw.githubusercontent.com serves .js as `text/plain`, which violates the
    // strict-MIME rule for ES-module imports. The blob URL inherits the response
    // Content-Type unless we override it, so re-wrap with the right MIME types
    // before handing to import() / emscripten.
    const [jsResp, wasmResp] = await Promise.all([
      fetchWithPersistentCache(source.jsUrl),
      fetchWithPersistentCache(source.wasmUrl),
    ]);
    if (!jsResp.ok) throw new Error(`fetch js failed: ${jsResp.status}`);
    if (!wasmResp.ok) throw new Error(`fetch wasm failed: ${wasmResp.status}`);
    const [jsBytes, wasmBytes] = await Promise.all([
      jsResp.arrayBuffer(),
      wasmResp.arrayBuffer(),
    ]);
    const jsBlob = new Blob([jsBytes], { type: "text/javascript" });
    const wasmBlob = new Blob([wasmBytes], { type: "application/wasm" });
    const jsBlobUrl = URL.createObjectURL(jsBlob);
    const wasmBlobUrl = URL.createObjectURL(wasmBlob);
    revokeUrls.push(jsBlobUrl, wasmBlobUrl);
    jsImportUrl = jsBlobUrl;
    locateFile = () => wasmBlobUrl;
  }

  const mod = await import(/* @vite-ignore */ jsImportUrl);
  const createModule = (mod.default ?? mod) as (cfg: object) => Promise<EmscriptenModule>;
  const stderr: string[] = [];
  const promise = createModule({
    noInitialRun: true,
    print: (s: string) => console.log("[wasm stdout]", s),
    printErr: (s: string) => {
      console.warn("[wasm stderr]", s);
      stderr.push(s);
    },
    ...(locateFile ? { locateFile } : {}),
  });
  const activeModule = { id, promise, revokeUrls, stderr };
  moduleCache.set(cacheKey, activeModule);
  return activeModule;
}

self.onmessage = async (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (msg.type === "loadVersion") {
    try {
      const next = await loadFromSource(msg.id, msg.source);
      await next.promise;
      active = next;
      self.postMessage({ type: "loaded", id: msg.id });
    } catch (err) {
      self.postMessage({
        type: "loadError",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "run") {
    if (!active) {
      self.postMessage({ type: "error", message: "no version loaded", stderr: "", exitCode: 0 });
      return;
    }
    active.stderr.length = 0;
    try {
      const Module = await active.promise;
      try { Module.FS.mkdir("/work"); } catch { /* already exists */ }
      Module.FS.chdir("/work");
      Module.FS.writeFile("/work/input.ll", msg.ir);
      for (const f of ["/work/llvm_fuzz_info.txt", "/work/llvm_fuzz_info.json", "/work/output.ll"]) {
        try { Module.FS.unlink(f); } catch { /* not present */ }
      }

      const exitCode = Module.callMain([]) ?? 0;
      // Driver may have bailed before the runtime initialized anything worth
      // dumping (e.g. IR parse failure); guard the flush so a crash here
      // doesn't mask the real error in stderr.
      try {
        Module.ccall("dump_iteration_info_external", null, [], []);
      } catch { /* runtime not in a flushable state */ }

      let trace = "";
      try {
        trace = Module.FS.readFile("/work/llvm_fuzz_info.txt", { encoding: "utf8" });
      } catch { /* no trace file — either no changes, or driver bailed */ }
      let traceJson = "";
      try {
        traceJson = Module.FS.readFile("/work/llvm_fuzz_info.json", { encoding: "utf8" });
      } catch { /* older wasm bundle won't emit the JSONL sidecar */ }
      let outputIr = "";
      try {
        outputIr = Module.FS.readFile("/work/output.ll", { encoding: "utf8" });
      } catch { /* older wasm bundle won't emit /work/output.ll, or driver bailed */ }
      self.postMessage({
        type: "done",
        trace,
        traceJson,
        outputIr,
        stderr: active.stderr.join("\n"),
        exitCode,
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        stderr: active.stderr.join("\n"),
        exitCode: -1,
      });
    }
  }
};

self.postMessage({ type: "ready" });
