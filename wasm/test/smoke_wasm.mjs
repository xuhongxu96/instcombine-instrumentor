// Node-based smoke test for the wasm InstCombine driver. Mirrors
// smoke_test.sh's IR and assertions. The trace comes from the patcher's
// CallScope call path (caller name + call-site file:line per frame), so
// native and wasm produce the same frame format — see runtime/fuzz_runtime.cpp.
//
// Usage: node wasm/test/smoke_wasm.mjs [path/to/instcombine_driver.js]

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const driverPath = resolve(
  __dirname,
  process.argv[2] ?? "../../build/llvm-wasm/bin/instcombine_driver.js",
);

const SMOKE_IR =
  "define i32 @f(i32 %x) {\n" +
  "  %a = add i32 %x, 0\n" +
  "  ret i32 %a\n" +
  "}\n";

const REQUIRED_MARKERS = [
  "SESSION START",
  "ITERATION",
  "REPLACEMENTS",
  "visitAdd",
];

const { default: createModule } = await import(pathToFileURL(driverPath).href);

const stderrChunks = [];
const Module = await createModule({
  noInitialRun: true,
  print: () => {},
  printErr: (s) => stderrChunks.push(String(s)),
});

try {
  Module.FS.mkdir("/work");
} catch (e) {
  // already exists is fine
  if (!(e && (e.errno === 20 || /File exists/i.test(String(e))))) throw e;
}
Module.FS.chdir("/work");
Module.FS.writeFile("/work/input.ll", SMOKE_IR);
try {
  Module.FS.unlink("/work/llvm_fuzz_info.txt");
} catch {
  // not present yet — fine
}

const rc = Module.callMain([]);
if (rc !== 0 && rc !== undefined) {
  console.error("FAIL: driver exited with code", rc);
  console.error(stderrChunks.join("\n"));
  process.exit(1);
}

Module.ccall("dump_iteration_info_external", null, [], []);

const trace = Module.FS.readFile("/work/llvm_fuzz_info.txt", { encoding: "utf8" });
const missing = REQUIRED_MARKERS.filter((m) => !trace.includes(m));
if (missing.length) {
  console.error("FAIL: missing markers in trace:", missing);
  console.error("--- trace ---\n" + trace);
  if (stderrChunks.length) console.error("--- stderr ---\n" + stderrChunks.join("\n"));
  process.exit(1);
}

// Call-site assertion: the visitAdd frame's line should be a call site
// *inside* visitAdd's body (where it dispatches), not visitAdd's signature
// line. Skip if the patched source isn't available.
const visitAddSource = resolve(
  __dirname,
  "../../thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp",
);
let visitAddSigLine = null;
try {
  const src = readFileSync(visitAddSource, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Instruction *InstCombinerImpl::visitAdd")) {
      visitAddSigLine = i + 1;
      break;
    }
  }
} catch {
  // not fatal — source may not be available
}

const visitAddTraceMatch = trace.match(/visitAdd\([^)]*\)[^\s]* at [^ ]+\.cpp:(\d+)/);
const visitAddTraceLine = visitAddTraceMatch ? parseInt(visitAddTraceMatch[1], 10) : null;

if (visitAddSigLine !== null && visitAddTraceLine !== null) {
  if (visitAddTraceLine === visitAddSigLine) {
    console.error(
      `FAIL: visitAdd frame line ${visitAddTraceLine} equals signature line ${visitAddSigLine} — call-site instrumentation didn't take effect`,
    );
    console.error("--- trace ---\n" + trace);
    process.exit(1);
  }
  console.log(
    `Call-site assertion OK: visitAdd frame at line ${visitAddTraceLine}, sig at ${visitAddSigLine}`,
  );
} else {
  console.warn(
    `WARN: could not extract visitAdd lines (sig=${visitAddSigLine} trace=${visitAddTraceLine}) — skipping call-site assertion`,
  );
}

console.log(`wasm smoke OK — trace ${trace.length} bytes`);
console.log(trace.slice(0, Math.min(trace.length, 2000)));
