#ifndef LLVM_FUZZ_RUNTIME_H
#define LLVM_FUZZ_RUNTIME_H

namespace llvm {
    class Value;
    class Function;
}

namespace llvm_fuzz {
    struct CallScope {
        CallScope(const char* file, int line, const char* caller_name);
        ~CallScope();
    };

    void record_stacktrace(void* val, const char* file, int line, const char* func);
    void record_replacement(void* old_val, void* new_val);
    void start_iteration();
    void dump_iteration_info();
    void reset_trace_state();

    template<typename T>
    T* record_stacktrace_with_loc(T* val, const char* file, int line, const char* func) {
        if (val) record_stacktrace((void*)val, file, line, func);
        return val;
    }
}

#define __llvm_fuzz_record(val) ::llvm_fuzz::record_stacktrace_with_loc((val), __FILE__, __LINE__, __PRETTY_FUNCTION__)

// GCC statement expression instead of a lambda: in C++17 lambdas can't capture
// structured bindings, and InstCombine has many `for (auto [k, v] : ...)` loops
// whose bodies contain wrappable calls. The block scope doesn't "capture" —
// `expr` references outer names natively — so structured bindings work.
#define __llvm_fuzz_call(expr) \
    __extension__ ({ \
        ::llvm_fuzz::CallScope __llvm_fuzz_cs(__FILE__, __LINE__, __PRETTY_FUNCTION__); \
        (expr); \
    })

inline void __llvm_fuzz_record_replace(void* old_v, void* new_v) {
    ::llvm_fuzz::record_replacement(old_v, new_v);
}

#endif
