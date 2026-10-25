import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTraceJsonl } from "./parse";
import type { RawIteration } from "./types";

function rawIteration(): RawIteration {
  return {
    iteration: 1,
    new_values: [{
      ptr: "0x1",
      ir: "%a = add i32 %x, 0",
      parent_fn: "f",
      parent_bb: "entry",
      debug_loc: "example.c:3:5",
      loc: "llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp:100",
      func_name: "visitAdd",
      frames: [{ name: "run", file: "llvm/lib/Transforms/InstCombine/InstructionCombining.cpp", line: 200 }],
    }],
    replacements: [{
      old_ptr: "0x1",
      new_ptr: "0x2",
      old_ir: "%a = add i32 %x, 0",
      new_ir: "i32 %x",
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseTraceJsonl", () => {
  it("preserves legacy fields while recomputing the rule", () => {
    const raw = rawIteration();
    raw.new_values[0].opcode = "add";
    raw.new_values[0].rule = "outdated runtime rule";
    raw.replacements[0].old_opcode = "add";
    raw.replacements[0].new_opcode = "";

    const parsed = parseTraceJsonl(JSON.stringify(raw));

    expect(parsed).toEqual([{
      ...raw,
      new_values: [{ ...raw.new_values[0], rule: "visitAdd" }],
    }]);
  });

  it("derives missing opcodes from IR while normalizing records", () => {
    const raw = rawIteration();

    expect(parseTraceJsonl(JSON.stringify(raw))).toEqual([{
      ...raw,
      new_values: [{ ...raw.new_values[0], opcode: "add", rule: "visitAdd" }],
      replacements: [{ ...raw.replacements[0], old_opcode: "add", new_opcode: "" }],
    }]);
  });

  it("keeps explicitly empty opcodes even when the IR contains an instruction", () => {
    const raw = rawIteration();
    raw.new_values[0].opcode = "";
    raw.replacements[0].old_opcode = "";
    raw.replacements[0].new_opcode = "";
    raw.replacements[0].new_ir = "%b = sub i32 %x, 1";

    const [parsed] = parseTraceJsonl(JSON.stringify(raw));

    expect(parsed.new_values[0].opcode).toBe("");
    expect(parsed.replacements[0].old_opcode).toBe("");
    expect(parsed.replacements[0].new_opcode).toBe("");
  });

  it("preserves supplied opcodes that the web extractor does not recognize", () => {
    const raw = rawIteration();
    raw.new_values[0].ir = "%a = future_opcode i32 %x";
    raw.new_values[0].opcode = "future_opcode";
    raw.replacements[0].old_ir = raw.new_values[0].ir;
    raw.replacements[0].old_opcode = "future_opcode";
    raw.replacements[0].new_ir = "%b = future_opcode i32 %y";
    raw.replacements[0].new_opcode = "future_opcode";

    const [parsed] = parseTraceJsonl(JSON.stringify(raw));

    expect(parsed.new_values[0].opcode).toBe("future_opcode");
    expect(parsed.replacements[0].old_opcode).toBe("future_opcode");
    expect(parsed.replacements[0].new_opcode).toBe("future_opcode");
  });

  it("derives replacement opcodes from their own IR snapshots, not pointer lookups", () => {
    const raw = rawIteration();
    raw.replacements[0].old_ir = "%a = sub i32 %x, 1";
    raw.replacements[0].new_ir = "%b = mul i32 %x, 2";

    const [parsed] = parseTraceJsonl(JSON.stringify(raw));

    // The old pointer matches a value record; the new pointer has no record.
    // Both sides must use the IR captured on the replacement itself.
    expect(parsed.new_values[0].opcode).toBe("add");
    expect(parsed.replacements[0].old_opcode).toBe("sub");
    expect(parsed.replacements[0].new_opcode).toBe("mul");
  });

  it("uses empty opcodes for non-instructions and unrecognized IR", () => {
    const raw = rawIteration();
    raw.new_values[0].ir = "i32 %x";
    raw.replacements[0].old_ir = "ptr getelementptr (i8, ptr @g, i64 1)";
    raw.replacements[0].new_ir = "%b = future_opcode i32 %x";

    const [parsed] = parseTraceJsonl(JSON.stringify(raw));

    expect(parsed.new_values[0].opcode).toBe("");
    expect(parsed.replacements[0].old_opcode).toBe("");
    expect(parsed.replacements[0].new_opcode).toBe("");
  });

  it("derives a rule from caller frames when the producer is outside InstCombine", () => {
    const raw = rawIteration();
    raw.new_values[0].loc = "llvm/lib/Analysis/InstructionSimplify.cpp:50";
    raw.new_values[0].func_name = "simplifyAddInst";
    raw.new_values[0].frames.unshift({
      name: "visitAdd",
      file: "llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp",
      line: 100,
    });

    const [parsed] = parseTraceJsonl(JSON.stringify(raw));

    expect(parsed.new_values[0].rule).toBe("visitAdd");
  });

  it.each(["", "\n  \n"])("returns no iterations for empty or blank input %j", (raw) => {
    expect(parseTraceJsonl(raw)).toEqual([]);
  });

  it("preserves iteration order and ignores blank lines", () => {
    const first = rawIteration();
    const second = { ...rawIteration(), iteration: 2 };
    const raw = `\n${JSON.stringify(first)}\n  \n${JSON.stringify(second)}\n`;

    expect(parseTraceJsonl(raw).map((iteration) => iteration.iteration)).toEqual([1, 2]);
  });

  it("skips malformed lines, including a truncated final record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = rawIteration();
    const second = { ...rawIteration(), iteration: 2 };
    const raw = [
      JSON.stringify(first),
      "not JSON",
      JSON.stringify(second),
      '{"iteration":3',
    ].join("\n");

    expect(parseTraceJsonl(raw).map((iteration) => iteration.iteration)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("ignores records without the required top-level arrays", () => {
    const raw = [null, {}, { iteration: 1, new_values: [] }, { new_values: [], replacements: {} }]
      .map((record) => JSON.stringify(record))
      .join("\n");

    expect(parseTraceJsonl(raw)).toEqual([]);
  });
});
