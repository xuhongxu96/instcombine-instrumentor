"""ConstantFolding instrumentation: Constant* returns and call sites are wrapped."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import patch_llvm as p

CONSTANT_FOLDING = r"""
static Constant *foldBinop(Constant *LHS, Constant *RHS) {
  return LHS;
}

Constant *ConstantFoldBinaryOpOperands(unsigned Opcode, Constant *LHS,
                                       Constant *RHS) {
  if (!LHS)
    return nullptr;
  return foldBinop(LHS, RHS);
}

static std::pair<Constant *, Constant *>
ConstantFoldScalarFrexpCall(Constant *Op) {
  if (!Op)
    return {};
  return {Op, Op};
}

static bool canConstantFoldCallTo(Constant *C) { return C != nullptr; }

Constant *takesAddress(Constant *C) { return *(&foldBinop(C)); }
"""

CALLER = r"""
Instruction *visitAdd(BinaryOperator &I) {
  if (Constant *C = ConstantFoldBinaryOpOperands(1, nullptr, nullptr))
    return C;
  return nullptr;
}
"""


class ConstantFoldingPatchTest(unittest.TestCase):
    def test_collect_and_patch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cf = root / "llvm/lib/Analysis/ConstantFolding.cpp"
            caller = root / "llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp"
            cf.parent.mkdir(parents=True)
            caller.parent.mkdir(parents=True)
            cf.write_text(CONSTANT_FOLDING)
            caller.write_text(CALLER)

            names = p._collect_instrumented_names(root)
            self.assertIn(b"ConstantFoldBinaryOpOperands", names)
            self.assertIn(b"foldBinop", names)
            self.assertIn(b"takesAddress", names)
            self.assertNotIn(b"ConstantFoldScalarFrexpCall", names)
            self.assertNotIn(b"canConstantFoldCallTo", names)

            p.patch_constant_folding_file(cf, names)
            p.patch_inst_combine_file(caller, names)
            folded = cf.read_text()
            called = caller.read_text()

            self.assertIn('#include "llvm/IR/fuzz_runtime.h"', folded)
            self.assertIn(
                "return __llvm_fuzz_record(static_cast<class Constant *>("
                "__llvm_fuzz_call(foldBinop(LHS, RHS))));",
                folded,
            )
            frexp_body = folded.split("ConstantFoldScalarFrexpCall", 1)[1].split(
                "canConstantFoldCallTo", 1
            )[0]
            self.assertNotIn("__llvm_fuzz_record", frexp_body)
            self.assertNotIn("__llvm_fuzz_call", frexp_body)
            self.assertIn("return {};", frexp_body)
            self.assertIn("return {Op, Op};", frexp_body)
            self.assertIn(
                "return __llvm_fuzz_record(static_cast<class Constant *>(*(&foldBinop(C))));",
                folded,
            )
            self.assertNotIn("__llvm_fuzz_call(foldBinop", folded[folded.find("takesAddress") :])

            self.assertIn(
                "__llvm_fuzz_call(ConstantFoldBinaryOpOperands(1, nullptr, nullptr))",
                called,
            )
            self.assertIn(
                "return __llvm_fuzz_record(static_cast<class Instruction *>(C));",
                called,
            )

            once = cf.read_bytes()
            p.patch_constant_folding_file(cf, names)
            self.assertEqual(once, cf.read_bytes())


if __name__ == "__main__":
    unittest.main()
