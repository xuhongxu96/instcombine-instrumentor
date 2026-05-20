#ifndef LLVM_FUZZ_RUNTIME_H
#define LLVM_FUZZ_RUNTIME_H

namespace llvm {
    class Value;
    class Function;
}

namespace llvm_fuzz {
    void record_stacktrace(void* val, const char* file, int line, const char* func);
    void record_replacement(void* old_val, void* new_val);
    void start_iteration();
    void dump_iteration_info();

    template<typename T>
    T* record_stacktrace_with_loc(T* val, const char* file, int line, const char* func) {
        if (val) record_stacktrace((void*)val, file, line, func);
        return val;
    }
}

#define __llvm_fuzz_record(val) llvm_fuzz::record_stacktrace_with_loc((val), __FILE__, __LINE__, __PRETTY_FUNCTION__)

inline void __llvm_fuzz_record_replace(void* old_v, void* new_v) {
    llvm_fuzz::record_replacement(old_v, new_v);
}

#endif
