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

function runOnce() {
  try {
    Module.ccall("reset_trace_state_external", null, [], []);
  } catch (e) {
    console.error("FAIL: reset_trace_state_external missing or failed:", e?.message ?? e);
    process.exit(1);
  }

  Module.FS.writeFile("/work/input.ll", SMOKE_IR);
  for (const f of ["/work/llvm_fuzz_info.txt", "/work/llvm_fuzz_info.json", "/work/output.ll"]) {
    try { Module.FS.unlink(f); } catch { /* not present yet — fine */ }
  }

  const rc = Module.callMain([]);
  if (rc !== 0 && rc !== undefined) {
    console.error("FAIL: driver exited with code", rc);
    console.error(stderrChunks.join("\n"));
    process.exit(1);
  }

  Module.ccall("dump_iteration_info_external", null, [], []);

  let trace = "";
  let traceJson = "";
  let outputIr = "";
  try {
    trace = Module.FS.readFile("/work/llvm_fuzz_info.txt", { encoding: "utf8" });
  } catch {}
  try {
    traceJson = Module.FS.readFile("/work/llvm_fuzz_info.json", { encoding: "utf8" });
  } catch {}
  try {
    outputIr = Module.FS.readFile("/work/output.ll", { encoding: "utf8" });
  } catch {}
  return { trace, traceJson, outputIr };
}

const { trace, traceJson, outputIr } = runOnce();
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

// JSONL sidecar — parse line-by-line and verify enriched fields exist.
if (!traceJson) {
  console.error("FAIL: /work/llvm_fuzz_info.json missing");
  process.exit(1);
}
let nIter = 0;
let sawOpcode = false;
let sawRule = false;
for (const [idx, line] of traceJson.split("\n").entries()) {
  const t = line.trim();
  if (!t) continue;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    console.error(`FAIL: line ${idx + 1} not valid JSON:`, e.message);
    process.exit(1);
  }
  for (const k of ["iteration", "new_values", "replacements"]) {
    if (!(k in obj)) {
      console.error(`FAIL: line ${idx + 1} missing key ${k}`);
      process.exit(1);
    }
  }
  for (const v of obj.new_values) {
    for (const k of ["ptr", "ir", "opcode", "parent_fn", "rule", "frames"]) {
      if (!(k in v)) {
        console.error(`FAIL: value on line ${idx + 1} missing key ${k}`);
        process.exit(1);
      }
    }
    if (v.opcode) sawOpcode = true;
    if (v.rule) sawRule = true;
  }
  nIter++;
}
if (nIter === 0) { console.error("FAIL: no iterations in JSONL"); process.exit(1); }
if (!sawOpcode) { console.error("FAIL: no value carried opcode"); process.exit(1); }
if (!sawRule)   { console.error("FAIL: no value carried rule"); process.exit(1); }
console.log(`JSONL sidecar OK: ${nIter} iteration(s); opcode + rule populated`);

// Output IR — must exist and look like an LLVM module.
if (!outputIr) {
  console.error("FAIL: /work/output.ll missing — wasm driver did not serialize the post-pass module");
  process.exit(1);
}
if (!outputIr.includes("define ") || !outputIr.includes("@f")) {
  console.error("FAIL: /work/output.ll did not contain the smoke function — got:\n" + outputIr.slice(0, 500));
  process.exit(1);
}
console.log(`output.ll OK: ${outputIr.length} bytes`);

for (let i = 1; i <= 25; i++) {
  const rerun = runOnce();
  const rerunMissing = REQUIRED_MARKERS.filter((m) => !rerun.trace.includes(m));
  if (rerunMissing.length) {
    console.error(`FAIL: repeated run ${i} lost trace markers:`, rerunMissing);
    console.error("--- trace ---\n" + rerun.trace);
    process.exit(1);
  }
}
console.log("Repeated-run reset OK: 25/25 traces retained markers");

console.log(`wasm smoke OK — trace ${trace.length} bytes`);
console.log(trace.slice(0, Math.min(trace.length, 2000)));
