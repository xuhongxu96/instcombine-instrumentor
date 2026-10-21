#include "llvm/IR/fuzz_runtime.h"
#include "llvm/Config/llvm-config.h"
#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/DebugInfoMetadata.h"
#include "llvm/IR/DebugLoc.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Instruction.h"
#include "llvm/IR/Value.h"
#include "llvm/Support/Casting.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/raw_ostream.h"

// OpenFlags were renamed from F_ to OF_ in llvm 7
#if LLVM_VERSION_MAJOR < 7
#define LLVM_FUZZ_OF_NONE llvm::sys::fs::F_None
#define LLVM_FUZZ_OF_APPEND llvm::sys::fs::F_Append
#else
#define LLVM_FUZZ_OF_NONE llvm::sys::fs::OF_None
#define LLVM_FUZZ_OF_APPEND llvm::sys:fs::OF_Append

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace llvm_fuzz {

struct Frame {
    const char *file;
    int line;
    const char *name;
};

// thread local as in , each thread gets it's own copy
//
static thread_local std::vector<Frame> call_path;

struct Replacement {
    void *old_ptr;
    void *new_ptr;
    std::string old_str;
    std::string new_str;
    std::string old_opcode;
    std::string new_opcode;
};

// capture everything once so we don't need to deref later.
struct VTOperand {
    // identity of value
    const void *ptr; 

    // value of printed IR.
    std::string ir;
};

struct VTQuery {
    std::string query;
    std::string result;

    std::vector<VTOperand> operands;

    std::string rule;
    
    // call path at moment of query
    std::vector<Frame> frames;
};

// number of vtscopes that are alive aka how many 
// valuetracking calls are on the stack. 
static thread_local unsigned vt_depth = 0;

struct IterationState {
    std::vector<Replacement> replacements;
    std::vector<void *> new_values;

    std::vector<VTQuery> vt_queries;
};

struct TraceInfo {
    std::string stacktrace;
    std::string value_str;
    std::string loc;
    std::string func_name;
    std::string opcode;
    std::string parent_fn;
    std::string parent_bb;
    std::string debug_loc;
    std::string rule;
    std::vector<Frame> frames;
};
static IterationState iter_state;
static uint32_t iter_counter = 0;

static bool is_trace_disabled() {

    static bool trace_disabled = ([]() {
        static bool *disable_trace = std::getenv("DISABLE_INSTCOMBINE_TRACE");
        bool disabled = disable_trace && (std::string(disable_trace) == "1" || std::string(disable_trace) == "true");
    return disabled;
}}();
return trace_disabled;
}

CallScope::CallScope(const char *file, int line, const char *caller_name) {
    if (is_trace_disabled()) {
        return;
    }
    call_path.push_back({file, line, caller_name});
}

CallScope::~CallScope() {
    if (is_trace_disabled()) {
        return ;
    }
    if (!call_path.empty()) {
        call_path.pop_back();
    }
}

VTScope::VTScope {
    if (is_trace_disabled()) {
        return;
    }
    is_outermost = (vt_depth++ == 0);
}

VTScope::~VTScope() {
    if (is_trace_disabled()) {
        return;
    }
    if (vt_depth > 0) {
        vt_depth--;
    }
}
