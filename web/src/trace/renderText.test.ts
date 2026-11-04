import { describe, expect, it } from "vitest";
import { parseTraceJsonl } from "./parse";
import { renderTraceText } from "./renderText";
import type { Iteration, RawIteration, RawVTQuery } from "./types";

function iteration(): Iteration {
  return {
    iteration: 1,
    new_values: [{
      ptr: "0x1",
      ir: "%a = add i32 %x, 0",
      opcode: "add",
      parent_fn: "f",
      parent_bb: "entry",
      debug_loc: "example.c:3:5",
      rule: "visitAdd",
      loc: "llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp:100",
      func_name: "visitAdd",
      frames: [
        { name: "foldAdd", file: "InstCombineAddSub.cpp", line: 50 },
        { name: "run", file: "InstructionCombining.cpp", line: 200 },
      ],
    }],
    replacements: [{
      old_ptr: "0x1",
      new_ptr: "0x2",
      old_ir: "%a = add i32 %x, 0",
      new_ir: "i32 %x",
      old_opcode: "add",
      new_opcode: "",
    }],
    vt_queries: [],
  };
}

function rawQuery(): RawVTQuery {
  return {
    query: "haveNoCommonBitsSet",
    result: "true",
    loc: "ValueTracking.cpp:50",
    func_name: "haveNoCommonBitsSet",
    operands: [
      { ptr: "0x1", ir: "  %a = and i32 %x, 15" },
      { ptr: "0x2", ir: "i32 16" },
    ],
    frames: [
      { name: "visitAdd", file: "InstCombineAddSub.cpp", line: 100 },
      { name: "run", file: "InstructionCombining.cpp", line: 200 },
    ],
  };
}

describe("renderTraceText", () => {
  it("renders values, metadata, ordered frames, and replacements", () => {
    expect(renderTraceText([iteration()])).toBe(
      "=== SESSION START ===\n" +
      "=== ITERATION 1 START ===\n" +
      "\nNEW INSTRUCTIONS IN THIS ITERATION:\n" +
      "VALUE 0x1 (%a = add i32 %x, 0) at visitAdd (llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp:100):\n" +
      " [opcode=add] [fn=f/entry] [rule=visitAdd] [dbg=example.c:3:5]\n" +
      " #1 foldAdd at InstCombineAddSub.cpp:50\n" +
      " #2 run at InstructionCombining.cpp:200\n" +
      "\nREPLACEMENTS IN THIS ITERATION:\n" +
      "0x1 (%a = add i32 %x, 0) -> 0x2 (i32 %x)\n" +
      "=== ITERATION END ===\n",
    );
  });

  it("emits one session marker and preserves iteration order and numbers", () => {
    const text = renderTraceText([iteration(), { ...iteration(), iteration: 3 }]);

    expect(text.match(/=== SESSION START ===/g)).toHaveLength(1);
    expect(text.match(/=== ITERATION \d+ START ===/g)).toEqual([
      "=== ITERATION 1 START ===", "=== ITERATION 3 START ===",
    ]);
    expect(text.match(/=== ITERATION END ===/g)).toHaveLength(2);
  });

  it("omits empty metadata and handles values with no frames", () => {
    const data = iteration();
    data.new_values[0] = {
      ...data.new_values[0],
      opcode: "", parent_fn: "", parent_bb: "", debug_loc: "", rule: "", frames: [],
    };

    const text = renderTraceText([data]);

    expect(text).toContain(`${data.new_values[0].loc}):\n\nREPLACEMENTS`);
    expect(text).not.toMatch(/\[(opcode|fn|rule|dbg)=/);
    expect(text).not.toContain(" #1 ");
  });

  it("renders a parent function without a named block", () => {
    const data = iteration();
    data.new_values[0].parent_bb = "";

    expect(renderTraceText([data])).toContain("[fn=f] [rule=visitAdd]");
  });

  it("renders unknown source metadata and frame names readably", () => {
    const data = iteration();
    data.new_values[0].func_name = "";
    data.new_values[0].loc = "";
    data.new_values[0].frames = [{ name: "", file: "", line: 0 }];

    const text = renderTraceText([data]);

    expect(text).toContain("at unknown (unknown:0):");
    expect(text).toContain(" #1 ? at ?:0\n");
  });

  it("preserves multiline value and replacement snapshots exactly", () => {
    const data = iteration();
    data.new_values[0].ir = "  %r = landingpad { ptr, i32 }\n          cleanup";
    data.new_values[0].opcode = "landingpad";
    data.replacements[0].old_ir = "  %r = invoke i32 @f()\n          to label %ok unwind label %error";
    data.replacements[0].new_ir = 'ptr @"name with spaces"';

    const text = renderTraceText([data]);

    expect(text).toContain(`VALUE 0x1 (${data.new_values[0].ir}) at `);
    expect(text).toContain(`0x1 (${data.replacements[0].old_ir}) -> 0x2 (${data.replacements[0].new_ir})\n`);
  });

  it("renders replacements even when there are no value records", () => {
    const data = iteration();
    data.new_values = [];

    const text = renderTraceText([data]);

    expect(text).not.toContain("VALUE ");
    expect(text).toContain("REPLACEMENTS IN THIS ITERATION:\n0x1 (%a = add i32 %x, 0) -> 0x2 (i32 %x)\n");
  });

  it("renders values even when there are no replacements", () => {
    const data = iteration();
    data.replacements = [];

    const text = renderTraceText([data]);

    expect(text).toContain("VALUE 0x1 ");
    expect(text).toContain("REPLACEMENTS IN THIS ITERATION:\n=== ITERATION END ===\n");
  });

  it("shows the opcode and rule produced by the shared parser", () => {
    const data = iteration();
    const raw: RawIteration = {
      ...data,
      new_values: [{ ...data.new_values[0], opcode: undefined, rule: "outdated runtime rule" }],
    };
    const parsed = parseTraceJsonl(JSON.stringify(raw));

    const text = renderTraceText(parsed);

    expect(text).toContain(`[opcode=${parsed[0].new_values[0].opcode}]`);
    expect(text).toContain("[opcode=add]");
    expect(text).toContain(`[rule=${parsed[0].new_values[0].rule}]`);
    expect(text).toContain("[rule=visitAdd]");
    expect(text).not.toContain("outdated runtime rule");
  });

  it("renders parsed ValueTracking queries with operands, results, rules, and ordered frames", () => {
    const raw = { ...iteration(), vt_queries: [{ ...rawQuery(), rule: "outdated runtime rule" }] };
    const parsed = parseTraceJsonl(JSON.stringify(raw));

    const text = renderTraceText(parsed);

    expect(text).toContain("VALUE 0x1 (%a = add i32 %x, 0)");
    expect(text).toContain("0x1 (%a = add i32 %x, 0) -> 0x2 (i32 %x)");
    expect(text).toContain(
      "\nVALUETRACKING QUERIES IN THIS ITERATION:\n" +
      "QUERY haveNoCommonBitsSet(0x1 (  %a = and i32 %x, 15), 0x2 (i32 16)) = true at haveNoCommonBitsSet (ValueTracking.cpp:50):\n" +
      " [rule=visitAdd]\n" +
      " #1 visitAdd at InstCombineAddSub.cpp:100\n" +
      " #2 run at InstructionCombining.cpp:200\n" +
      "\n=== ITERATION END ===\n",
    );
    expect(text).not.toContain("outdated runtime rule");
  });

  it("renders query-only iterations and preserves multiline operands and results", () => {
    const query = rawQuery();
    query.query = "computeKnownBits";
    query.operands = [{ ptr: "0x3", ir: "  %r = phi i32 [ 0, %entry ],\n                [ %next, %loop ]" }];
    query.result = "Zero: 0xFFFFFFF0\nOne: 0x00000000";
    const raw: RawIteration = { iteration: 2, new_values: [], replacements: [], vt_queries: [query] };

    const text = renderTraceText(parseTraceJsonl(JSON.stringify(raw)));

    expect(text).toContain("=== ITERATION 2 START ===");
    expect(text).toContain(`QUERY computeKnownBits(0x3 (${query.operands[0].ir})) = ${query.result} at `);
    expect(text).not.toContain("VALUE ");
    expect(text.match(/QUERY /g)).toHaveLength(1);
  });

  it("omits an empty query rule and handles missing source names", () => {
    const query = { ...rawQuery(), loc: "", func_name: "", frames: [{ name: "", file: "", line: 0 }] };
    const raw: RawIteration = { iteration: 1, new_values: [], replacements: [], vt_queries: [query] };

    const text = renderTraceText(parseTraceJsonl(JSON.stringify(raw)));

    expect(text).toContain("= true at unknown (unknown:0):\n #1 ? at ?:0\n");
    expect(text).not.toContain("[rule=");
  });

  it("does not add a ValueTracking section to older traces", () => {
    const raw: RawIteration = { iteration: 1, new_values: [], replacements: [] };

    expect(renderTraceText(parseTraceJsonl(JSON.stringify(raw)))).not.toContain("VALUETRACKING");
  });

  it("returns empty text when no structured records exist", () => {
    expect(renderTraceText([])).toBe("");
    expect(renderTraceText(parseTraceJsonl(""))).toBe("");
  });

  it("renders a valid empty iteration", () => {
    const data = [{ iteration: 1, new_values: [], replacements: [], vt_queries: [] }];

    expect(renderTraceText(data)).toBe(
      "=== SESSION START ===\n" +
      "=== ITERATION 1 START ===\n" +
      "\nNEW INSTRUCTIONS IN THIS ITERATION:\n" +
      "REPLACEMENTS IN THIS ITERATION:\n" +
      "=== ITERATION END ===\n",
    );
  });
});
