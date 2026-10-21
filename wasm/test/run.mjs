// Usage: node wasm/test/run.mjs [path/to/instcombine_driver.js]

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
    try {
        Module.ccall("reset_trace_state_external", null, [], []);
    } catch (e) {
        console.error("FAIL: reset_trace_state_external missing or failed:", e?.message ?? e);
        process.exit(1);
    }

    Module.FS.writeFile("/work/input.ll", ir);
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

    let trace = Module.FS.readFile("/work/llvm_fuzz_info.txt", { encoding: "utf8" });
    let traceJson = Module.FS.readFile("/work/llvm_fuzz_info.json", { encoding: "utf8" });
    let outputIr = Module.FS.readFile("/work/output.ll", { encoding: "utf8" });

    return { trace, traceJson, outputIr };
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
    const { trace, traceJson, outputIr } = runOnce(ir);
    if (!trace) {
        console.error("FAIL: no trace produced");
        process.exit(1);
    }
    if (!traceJson) {
        console.error("FAIL: no JSONL produced");
        process.exit(1);
    }
    if (!outputIr) {
        console.error("FAIL: no output IR produced");
        process.exit(1);
    }

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

    console.log(`Smoke test ${f} OK — trace ${trace.length} bytes, JSONL ${traceJson.length} bytes, output.ll ${outputIr.length} bytes`);
});
