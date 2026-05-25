import { describe, expect, it } from "vitest";
import { computeRule } from "./rule";
import type { NewValue } from "./types";

const IC = "../../thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp";
const SIMPLIFY = "../../thirdparty/llvm-project/llvm/lib/Analysis/InstructionSimplify.cpp";
const RUN = "../../thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstructionCombining.cpp";

function value(over: Partial<NewValue>): NewValue {
  return {
    ptr: "0x1",
    ir: "%a = add i32 %x, 0",
    opcode: "add",
    parent_fn: "f",
    parent_bb: "entry",
    debug_loc: "",
    rule: "<runtime-rule>",
    loc: "unknown:0",
    func_name: "unknown",
    frames: [],
    ...over,
  };
}

describe("computeRule", () => {
  it("uses frame #0 (the producing function) when it lives in InstCombine", () => {
    // Value produced directly inside visitAdd with no further InstCombine call
    // site on the stack — the runtime would attribute nothing here.
    const v = value({
      func_name: "llvm::Instruction *llvm::InstCombinerImpl::visitAdd(llvm::BinaryOperator &)",
      loc: `${IC}:1556`,
      frames: [{ name: "bool llvm::InstCombinerImpl::run()", file: RUN, line: 5679 }],
    });
    expect(computeRule(v)).toBe("llvm::Instruction *llvm::InstCombinerImpl::visitAdd(llvm::BinaryOperator &)");
  });

  it("skips a non-InstCombine frame #0 and uses the innermost InstCombine frame", () => {
    // Value produced inside simplifyAddInst (Analysis), reached via visitAdd.
    const v = value({
      func_name: "llvm::Value *llvm::simplifyAddInst(...)",
      loc: `${SIMPLIFY}:676`,
      frames: [
        { name: "llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...)", file: IC, line: 1556 },
        { name: "bool llvm::InstCombinerImpl::run()", file: RUN, line: 5679 },
      ],
    });
    expect(computeRule(v)).toBe("llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...)");
  });

  it("returns empty when nothing on the stack is in InstCombine", () => {
    const v = value({
      func_name: "llvm::Value *llvm::simplifyAddInst(...)",
      loc: `${SIMPLIFY}:676`,
      frames: [],
    });
    expect(computeRule(v)).toBe("");
  });

  it("tolerates missing frames / loc (older bundles)", () => {
    const v = value({ loc: "", frames: undefined as unknown as NewValue["frames"] });
    expect(computeRule(v)).toBe("");
  });
});
