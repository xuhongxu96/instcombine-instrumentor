// Usage: node wasm/test/run.mjs [path/to/instcombine_driver.js]

import { readFileSync, readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const driverPath = resolve(
    __dirname,
    process.argv[2] ?? "../../build/llvm-wasm/bin/instcombine_driver.js",
);

const { default: createModule } = await import(pathToFileURL(driverPath).href);

const stderrChunks = [];
const Module = await createModule({
    noInitialRun: true,
    print: () => { },
    printErr: (s) => stderrChunks.push(String(s)),
});

try {
    Module.FS.mkdir("/work");
} catch (e) {
    // already exists is fine
    if (!(e && (e.errno === 20 || /File exists/i.test(String(e))))) throw e;
}
Module.FS.chdir("/work");

function runOnce(ir) {
    stderrChunks.length = 0;
    try {
        Module.ccall("reset_trace_state_external", null, [], []);
    } catch (e) {
        console.error("FAIL: reset_trace_state_external missing or failed:", e?.message ?? e);
        process.exit(1);
    }

    Module.FS.writeFile("/work/input.ll", ir);
    for (const f of ["/work/llvm_fuzz_info.json", "/work/output.ll"]) {
        try { Module.FS.unlink(f); } catch { /* not present yet — fine */ }
    }

    const rc = Module.callMain([]);
    if (rc !== 0 && rc !== undefined) {
        console.error("FAIL: driver exited with code", rc);
        console.error(stderrChunks.join("\n"));
        process.exit(1);
    }

    Module.ccall("dump_iteration_info_external", null, [], []);

    const traceJson = Module.FS.readFile("/work/llvm_fuzz_info.json", { encoding: "utf8" });
    const outputIr = Module.FS.readFile("/work/output.ll", { encoding: "utf8" });

    return { traceJson, outputIr };
}

function validateFrames(frames, context) {
    assert.ok(Array.isArray(frames), `${context} has invalid frames`);
    for (const frame of frames) {
        assert.equal(typeof frame.name, "string", `${context} frame has invalid name`);
        assert.equal(typeof frame.file, "string", `${context} frame has invalid file`);
        assert.ok(Number.isInteger(frame.line), `${context} frame has invalid line`);
    }
}

// Check runtime snapshots before source-line normalization changes their types.
function validateTraceJsonl(raw) {
    const iterations = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    assert.ok(iterations.length > 0, "no iterations in JSONL");
    assert.equal(iterations[0].iteration, 1, "reset did not restart the iteration counter");
    let previousIteration = 0;
    for (const iteration of iterations) {
        const context = `iteration ${iteration.iteration}`;
        assert.ok(Number.isInteger(iteration.iteration) && iteration.iteration > previousIteration, `${context} has invalid iteration order`);
        previousIteration = iteration.iteration;
        for (const key of ["new_values", "replacements", "vt_queries"]) {
            assert.ok(Array.isArray(iteration[key]), `${context} has invalid ${key}`);
        }
        for (const value of iteration.new_values) {
            for (const key of ["ptr", "ir", "parent_fn", "parent_bb", "debug_loc", "loc", "func_name"]) {
                assert.equal(typeof value[key], "string", `${context} value has invalid ${key}`);
            }
            for (const key of ["opcode", "rule", "stacktrace"]) {
                assert.ok(!(key in value), `${context} value still emits derived field ${key}`);
            }
            validateFrames(value.frames, context);
        }
        for (const replacement of iteration.replacements) {
            for (const key of ["old_ptr", "new_ptr", "old_ir", "new_ir"]) {
                assert.equal(typeof replacement[key], "string", `${context} replacement has invalid ${key}`);
            }
            for (const key of ["old_opcode", "new_opcode"]) {
                assert.ok(!(key in replacement), `${context} replacement still emits derived field ${key}`);
            }
        }
        for (const query of iteration.vt_queries) {
            for (const key of ["query", "result", "loc", "func_name"]) {
                assert.equal(typeof query[key], "string", `${context} query has invalid ${key}`);
            }
            assert.ok(Array.isArray(query.operands), `${context} query has invalid operands`);
            for (const operand of query.operands) {
                assert.equal(typeof operand.ptr, "string", `${context} query operand has invalid ptr`);
                assert.equal(typeof operand.ir, "string", `${context} query operand has invalid ir`);
            }
            validateFrames(query.frames, context);
        }
    }
    return iterations;
}

function validateSmokeTrace(iterations, outputIr) {
    const values = iterations.flatMap((iteration) => iteration.new_values);
    assert.ok(values.length > 0, "no recorded values in smoke trace");
    assert.ok(iterations.some((iteration) => iteration.replacements.length > 0), "no replacements in smoke trace");
    assert.ok(values.some((value) => value.parent_fn), "no value retained parent function context");
    assert.ok(values.some((value) => value.func_name.includes("visitAdd") || value.frames.some((frame) => frame.name.includes("visitAdd"))), "no visitAdd source attribution");
    assert.ok(values.some((value) => value.func_name.includes("ConstantFoldBinaryOpOperands") || value.frames.some((frame) => frame.name.includes("ConstantFoldBinaryOpOperands"))), "no ConstantFolding record");
    assert.ok(outputIr.includes("define ") && outputIr.includes("@f("), "output.ll does not contain the smoke function");

    const source = resolve(__dirname, "../../thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp");
    const signatureLine = existsSync(source)
        ? readFileSync(source, "utf8").split("\n").findIndex((line) => /Instruction\s*\*\s*InstCombiner(?:Impl)?::visitAdd\b/.test(line)) + 1
        : 0;
    if (signatureLine > 0) {
        const frames = values.flatMap((value) => value.frames)
            .filter((frame) => frame.name.includes("visitAdd") && frame.file.endsWith("InstCombineAddSub.cpp"));
        assert.ok(frames.length > 0, "no visitAdd caller frames in JSONL");
        assert.ok(frames.every((frame) => frame.line !== signatureLine), "visitAdd frame points to signature instead of call site");
    } else {
        console.warn("WARN: visitAdd source/signature unavailable — skipping call-site assertion");
    }
}

function replaceLineNumWithLineStr(obj) {
    for (const key in obj.new_values) {
        const v = obj.new_values[key];
        for (const frame of v.frames) {
            let source = readFileSync(resolve(__dirname, frame.file), "utf8");
            let line = source.split("\n")[frame.line - 1];
            frame.line = line.trim();
        }
        let parts = v.loc.split(":");
        let source = readFileSync(resolve(__dirname, parts[0]), "utf8");
        let line = source.split("\n")[Number(parts[1]) - 1];
        v.loc = line.trim();
    }

    return obj;
}

function mapJsonL(jsonl, f, indent = 0) {
    return jsonl.split("\n").filter((line) => line.trim() !== "").map((line) => {
        try {
            let obj = JSON.parse(line);
            obj = f(obj);
            return JSON.stringify(obj, null, indent);
        } catch (e) {
            console.error("FAIL: invalid JSONL line:", line, "\n", e);
            process.exit(1);
        }
    }).join("\n") + "\n";
}

readdirSync(resolve(__dirname, "input")).forEach((f) => {
    if (!f.endsWith(".ll")) return;
    const path = resolve(__dirname, "input", f);
    const ir = readFileSync(path, "utf8");
    console.log(`=== Running smoke test ${f} ===`);
    const { traceJson, outputIr } = runOnce(ir);
    if (!traceJson) {
        console.error("FAIL: no JSONL produced");
        process.exit(1);
    }
    if (!outputIr) {
        console.error("FAIL: no output IR produced");
        process.exit(1);
    }
    const iterations = validateTraceJsonl(traceJson);
    if (f === "smoke.ll") validateSmokeTrace(iterations, outputIr);

    let expected = {};

    ir.split("\n").forEach((line, i) => {
        if (line.trim().startsWith(";")) {
            if (line.includes(":")) {
                let parts = line.substring(1).trim().split(":");
                expected[parts[0].trim()] = parts[1].split(",").map((s) => s.trim());
            }
        }
    });

    const norm = mapJsonL(traceJson, (line) => { return replaceLineNumWithLineStr(line); });

    if (Object.keys(expected).length === 0) {
        console.error("FAIL: no expected tags found in input IR");
        console.log(mapJsonL(norm, (l) => l, 2));
        process.exit(1);
    }

    const errs = mapJsonL(norm, (line) => {
        let res = [];
        for (const k in line.new_values) {
            const v = line.new_values[k];
            let ir = v.ir.trim();
            let validation = {
                ir: ir,
                err: "",
            };
            if (expected[ir] !== undefined) {
                let actualStr = JSON.stringify(v);
                for (const expectedTag of expected[ir]) {
                    if (!actualStr.includes(expectedTag)) {
                        validation.err += `FAIL: expected tag "${expectedTag}" not found for ${ir}\n`;
                    }
                }
            }
            res.push(validation);
        }
        return res;
    });

    mapJsonL(errs, (line) => {
        for (const v of line) {
            if (v.err) {
                console.error(v.err);
                process.exit(1);
            }

            expected[v.ir.trim()] = null;
        }
        return line;
    });

    for (const k in expected) {
        if (expected[k] !== null) {
            console.error(`FAIL: ${k} not found`);
            process.exit(1);
        }
    }

    console.log(`Smoke test ${f} OK — JSONL ${Buffer.byteLength(traceJson)} bytes, output.ll ${Buffer.byteLength(outputIr)} bytes`);
});

const smokeIr = readFileSync(resolve(__dirname, "input/smoke.ll"), "utf8");
for (let i = 0; i < 25; i++) {
    const { traceJson, outputIr } = runOnce(smokeIr);
    validateSmokeTrace(validateTraceJsonl(traceJson), outputIr);
}
console.log("Repeated-run reset OK: 25/25 runs retained JSONL records, source context, and output IR");
