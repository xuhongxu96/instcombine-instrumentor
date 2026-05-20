// Minimal driver that runs InstCombine on /work/input.ll.
//
// Designed to be invoked from emscripten as `Module.callMain([])` after the
// caller has placed the IR text at /work/input.ll. The instrumented LLVM
// runtime writes its trace to /work/llvm_fuzz_info.txt (relative path, picked
// up from CWD which the JS worker chdirs to /work before calling main).

#include "llvm/Analysis/CGSCCPassManager.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/PassManager.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/InstCombine/InstCombine.h"

int main(int /*argc*/, char ** /*argv*/) {
  llvm::LLVMContext Ctx;
  llvm::SMDiagnostic Err;

  auto M = llvm::parseIRFile("/work/input.ll", Err, Ctx);
  if (!M) {
    Err.print("instcombine_driver", llvm::errs());
    return 1;
  }

  llvm::LoopAnalysisManager LAM;
  llvm::FunctionAnalysisManager FAM;
  llvm::CGSCCAnalysisManager CGAM;
  llvm::ModuleAnalysisManager MAM;

  llvm::PassBuilder PB;
  PB.registerModuleAnalyses(MAM);
  PB.registerCGSCCAnalyses(CGAM);
  PB.registerFunctionAnalyses(FAM);
  PB.registerLoopAnalyses(LAM);
  PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);

  llvm::FunctionPassManager FPM;
  FPM.addPass(llvm::InstCombinePass());

  llvm::ModulePassManager MPM;
  MPM.addPass(llvm::createModuleToFunctionPassAdaptor(std::move(FPM)));
  MPM.run(*M, MAM);

  return 0;
}
