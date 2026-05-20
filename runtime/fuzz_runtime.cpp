#include "llvm/IR/fuzz_runtime.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Value.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Support/FileSystem.h"
#include <map>
#include <vector>
#include <string>
#include <mutex>
#include <cstdlib>
#include <cstdint>

namespace llvm_fuzz {

struct Frame {
    const char* file;
    int line;
    const char* func;
};

static thread_local std::vector<Frame> call_path;

struct Replacement {
    void* old_ptr;
    void* new_ptr;
    std::string old_str;
    std::string new_str;
};

struct IterationState {
    std::vector<Replacement> replacements;
    std::vector<void*> new_values;
};

struct TraceInfo {
    std::string stacktrace;
    std::string value_str;
    std::string loc;
    std::string func_name;
};

static IterationState iter_state;

static bool is_trace_disabled() {
    static bool trace_disabled = ([](){
      const char* disable_trace = std::getenv("DISABLE_INSTCOMBINE_TRACE");
      bool disabled = disable_trace && (std::string(disable_trace) == "1" || std::string(disable_trace) == "true");
      return disabled;
    })();
    return trace_disabled;
}

TraceScope::TraceScope(const char* file, int line, const char* func) {
    if (is_trace_disabled()) return;
    call_path.push_back({file, line, func});
}

TraceScope::~TraceScope() {
    if (is_trace_disabled()) return;
    if (!call_path.empty()) call_path.pop_back();
}

static std::mutex& get_global_mutex() {
    static std::mutex global_mutex;
    return global_mutex;
}

static std::map<void*, TraceInfo>& get_trace_map() {
    static std::map<void*, TraceInfo> trace_map;
    return trace_map;
}

// Lazily emit "=== SESSION START ===" on the first dump, so the trace lands
// in whatever CWD the host process is in at write time (matters under
// emscripten where the JS host chdirs after module init).
static bool& session_started_flag() {
    static bool started = false;
    return started;
}

void start_iteration() {
    if (is_trace_disabled()) return;

    dump_iteration_info();

    std::lock_guard<std::mutex> lock(get_global_mutex());
    iter_state.new_values.clear();
    iter_state.replacements.clear();
}

static void record_stacktrace_unlocked(void* val, const char* file = nullptr, int line = 0, const char* func = nullptr) {
    if (is_trace_disabled()) return;
    if (!val) return;

    auto it = get_trace_map().find(val);
    if (it == get_trace_map().end()) {
        // Snapshot the patcher-maintained call path (top of stack first, like
        // PrintStackTrace's #0 = innermost frame).
        std::string st_str;
        {
            llvm::raw_string_ostream rso_st(st_str);
            const auto& path = call_path;
            for (size_t i = 0; i < path.size(); ++i) {
                const auto& f = path[path.size() - 1 - i];
                rso_st << " #" << i << " " << (f.func ? f.func : "?")
                       << " at " << (f.file ? f.file : "?") << ":" << f.line << "\n";
            }
        }

        // Capture value string representation
        std::string v_str;
        if (reinterpret_cast<uintptr_t>(val) >= 0x10000) {
            llvm::raw_string_ostream rso_v(v_str);
            static_cast<llvm::Value*>(val)->print(rso_v);
        } else {
            v_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(val)) + ")";
        }

        std::string loc_str = file ? (std::string(file) + ":" + std::to_string(line)) : "unknown:0";
        std::string f_name = func ? func : "unknown";

        get_trace_map()[val] = {st_str, v_str, loc_str, f_name};

        iter_state.new_values.push_back(val);
    }
}

void record_stacktrace(void* val, const char* file, int line, const char* func) {
    if (is_trace_disabled()) return;
    if (!val) return;
    std::lock_guard<std::mutex> lock(get_global_mutex());
    record_stacktrace_unlocked(val, file, line, func);
}

void record_replacement(void* old_val, void* new_val) {
    if (is_trace_disabled()) return;
    if (!old_val || !new_val) return;

    std::lock_guard<std::mutex> lock(get_global_mutex());
    record_stacktrace_unlocked(new_val);

    std::string old_str, new_str;
    {
        if (reinterpret_cast<uintptr_t>(old_val) >= 0x10000) {
            llvm::raw_string_ostream rso_old(old_str);
            static_cast<llvm::Value*>(old_val)->print(rso_old);
        } else {
            old_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(old_val)) + ")";
        }

        if (reinterpret_cast<uintptr_t>(new_val) >= 0x10000) {
            llvm::raw_string_ostream rso_new(new_str);
            static_cast<llvm::Value*>(new_val)->print(rso_new);
        } else {
            new_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(new_val)) + ")";
        }
    }

    iter_state.replacements.push_back({old_val, new_val, old_str, new_str});
}

void dump_iteration_info() {
    if (is_trace_disabled()) return;

    std::lock_guard<std::mutex> lock(get_global_mutex());
    if (iter_state.new_values.empty() && iter_state.replacements.empty()) return;
    std::error_code EC;
    // First write truncates and emits the session header; subsequent writes append.
    auto open_flags = session_started_flag() ? llvm::sys::fs::OF_Append : llvm::sys::fs::OF_None;
    llvm::raw_fd_ostream out("llvm_fuzz_info.txt", EC, open_flags);
    if (EC) return;
    if (!session_started_flag()) {
        out << "=== SESSION START ===\n";
        session_started_flag() = true;
    }

    out << "=== ITERATION START ===\n";

    out << "\nNEW INSTRUCTIONS IN THIS ITERATION:\n";
    for (void* v : iter_state.new_values) {
        auto it = get_trace_map().find(v);
        if (it != get_trace_map().end()) {
            TraceInfo &info = it->second;
            out << "VALUE " << v << " (" << info.value_str << ") at " << info.func_name << " (" << info.loc << "):\n";
            out << info.stacktrace << "\n";
        } else {
            out << "VALUE " << v << " (No trace info)\n";
        }
    }
    out << "REPLACEMENTS IN THIS ITERATION:\n";
    for (auto const& r : iter_state.replacements) {
        out << r.old_ptr << " (" << r.old_str << ") -> " << r.new_ptr << " (" << r.new_str << ")\n";
    }
    out << "=== ITERATION END ===\n";

    // Clear after dumping so we don't dump it again at exit if already dumped
    iter_state.new_values.clear();
    iter_state.replacements.clear();
}

#ifndef __EMSCRIPTEN__
// Native only: register a final flush at process exit so the last iteration
// isn't dropped. Under emscripten the JS host calls dump_iteration_info_external
// explicitly after callMain — std::atexit isn't reliable there.
struct AtExitRegister {
    AtExitRegister() {
        if (is_trace_disabled()) return;
        std::atexit([]() {
            dump_iteration_info();
        });
    }
};
static AtExitRegister reg;
#endif

} // namespace llvm_fuzz

// Always emitted so a wasm host can flush the final iteration explicitly
// (emscripten's std::atexit isn't reliable). Harmless on native builds.
extern "C" void dump_iteration_info_external() {
    llvm_fuzz::dump_iteration_info();
}
