#include "llvm/IR/fuzz_runtime.h"
#include "llvm/Config/llvm-config.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Value.h"
#include "llvm/IR/Instruction.h"
#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/DebugLoc.h"
#include "llvm/IR/DebugInfoMetadata.h"
#include "llvm/Support/Casting.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Support/FileSystem.h"

// OpenFlags were renamed F_* -> OF_* in LLVM 7; the F_* aliases were dropped
// in LLVM 13. Pick the right symbol for the version we're compiling against.
#if LLVM_VERSION_MAJOR < 7
#define LLVM_FUZZ_OF_NONE   llvm::sys::fs::F_None
#define LLVM_FUZZ_OF_APPEND llvm::sys::fs::F_Append
#else
#define LLVM_FUZZ_OF_NONE   llvm::sys::fs::OF_None
#define LLVM_FUZZ_OF_APPEND llvm::sys::fs::OF_Append
#endif
#include <map>
#include <vector>
#include <string>
#include <mutex>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace llvm_fuzz {

struct Frame {
    const char* file;
    int line;
    const char* name;
};

static thread_local std::vector<Frame> call_path;

struct Replacement {
    void* old_ptr;
    void* new_ptr;
    std::string old_str;
    std::string new_str;
    std::string old_opcode;
    std::string new_opcode;
};

struct IterationState {
    std::vector<Replacement> replacements;
    std::vector<void*> new_values;
};

struct TraceInfo {
    std::string stacktrace;      // pre-rendered for text dump
    std::string value_str;
    std::string loc;
    std::string func_name;
    std::string opcode;
    std::string parent_fn;
    std::string parent_bb;
    std::string debug_loc;
    std::string rule;
    std::vector<Frame> frames;   // structured copy for JSONL emission
};

static IterationState iter_state;
static uint32_t iter_counter = 0;

static bool is_trace_disabled() {
    static bool trace_disabled = ([](){
      const char* disable_trace = std::getenv("DISABLE_INSTCOMBINE_TRACE");
      bool disabled = disable_trace && (std::string(disable_trace) == "1" || std::string(disable_trace) == "true");
      return disabled;
    })();
    return trace_disabled;
}

CallScope::CallScope(const char* file, int line, const char* caller_name) {
    if (is_trace_disabled()) return;
    call_path.push_back({file, line, caller_name});
}

CallScope::~CallScope() {
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

// ---- Helpers --------------------------------------------------------------

static bool is_real_value_ptr(void* v) {
    return reinterpret_cast<uintptr_t>(v) >= 0x10000;
}

static std::string format_opcode(void* v) {
    if (!is_real_value_ptr(v)) return "";
    auto *val = static_cast<llvm::Value*>(v);
    if (auto *inst = llvm::dyn_cast<llvm::Instruction>(val))
        return inst->getOpcodeName();
    return "";
}

static std::string format_parent_fn(void* v) {
    if (!is_real_value_ptr(v)) return "";
    auto *val = static_cast<llvm::Value*>(v);
    auto *inst = llvm::dyn_cast<llvm::Instruction>(val);
    if (!inst) return "";
    auto *bb = inst->getParent();
    if (!bb) return "";
    auto *fn = bb->getParent();
    if (!fn) return "";
    return fn->getName().str();
}

static std::string format_parent_bb(void* v) {
    if (!is_real_value_ptr(v)) return "";
    auto *val = static_cast<llvm::Value*>(v);
    auto *inst = llvm::dyn_cast<llvm::Instruction>(val);
    if (!inst) return "";
    auto *bb = inst->getParent();
    if (!bb) return "";
    return bb->getName().str();
}

static std::string format_debug_loc(void* v) {
    if (!is_real_value_ptr(v)) return "";
    auto *val = static_cast<llvm::Value*>(v);
    auto *inst = llvm::dyn_cast<llvm::Instruction>(val);
    if (!inst) return "";
    const llvm::DebugLoc &dl = inst->getDebugLoc();
    if (!dl) return "";
    unsigned line = dl.getLine();
    unsigned col = dl.getCol();
    std::string filename;
    if (auto *dil = llvm::dyn_cast_or_null<llvm::DILocation>(dl.get()))
        filename = dil->getFilename().str();
    std::string s = filename + ":" + std::to_string(line);
    if (col) s += ":" + std::to_string(col);
    return s;
}

// Walk frames (already in print order, innermost caller first) and return the
// first caller name whose source file contains "InstCombine" — that's the
// visit* / fold* rule that ultimately fired.
static std::string compute_rule(const std::vector<Frame>& frames) {
    for (const auto& f : frames) {
        if (f.file && std::strstr(f.file, "InstCombine"))
            return f.name ? f.name : "";
    }
    return "";
}

// Minimal JSON writer over raw_ostream — no nlohmann/json dependency.
namespace {
class JsonWriter {
    llvm::raw_ostream& os;
    bool need_comma = false;
    void maybe_comma() { if (need_comma) os << ","; need_comma = true; }

public:
    explicit JsonWriter(llvm::raw_ostream& o) : os(o) {}
    void begin_obj() { maybe_comma(); os << "{"; need_comma = false; }
    void end_obj()   { os << "}"; need_comma = true; }
    void begin_arr() { maybe_comma(); os << "["; need_comma = false; }
    void end_arr()   { os << "]"; need_comma = true; }
    void key(const char* k) { maybe_comma(); os << "\""; emit_escaped(k); os << "\":"; need_comma = false; }
    void str(llvm::StringRef s) { maybe_comma(); os << "\""; emit_escaped(s); os << "\""; need_comma = true; }
    void num(uint64_t n) { maybe_comma(); os << n; need_comma = true; }
    void ptr_str(const void* p) {
        maybe_comma();
        char buf[2 + sizeof(uintptr_t) * 2 + 1];
        std::snprintf(buf, sizeof(buf), "0x%lx",
                      static_cast<unsigned long>(reinterpret_cast<uintptr_t>(p)));
        os << "\"" << buf << "\"";
        need_comma = true;
    }

private:
    void emit_escaped(llvm::StringRef s) {
        for (char c : s) {
            switch (c) {
                case '"':  os << "\\\""; break;
                case '\\': os << "\\\\"; break;
                case '\n': os << "\\n"; break;
                case '\r': os << "\\r"; break;
                case '\t': os << "\\t"; break;
                default:
                    if (static_cast<unsigned char>(c) < 0x20) {
                        char buf[8];
                        std::snprintf(buf, sizeof(buf), "\\u%04x",
                                      static_cast<unsigned int>(static_cast<unsigned char>(c)));
                        os << buf;
                    } else {
                        os << c;
                    }
            }
        }
    }
};
} // anonymous namespace

// ---- Public API -----------------------------------------------------------

void start_iteration() {
    if (is_trace_disabled()) return;

    dump_iteration_info();

    std::lock_guard<std::mutex> lock(get_global_mutex());
    iter_state.new_values.clear();
    iter_state.replacements.clear();
    iter_counter++;
}

static void record_stacktrace_unlocked(void* val, const char* file = nullptr, int line = 0, const char* func = nullptr) {
    if (is_trace_disabled()) return;
    if (!val) return;

    auto it = get_trace_map().find(val);
    if (it != get_trace_map().end()) return;

    // Snapshot frames in print order: innermost caller (top of stack) as #1.
    std::vector<Frame> frames;
    frames.reserve(call_path.size());
    for (size_t i = 0; i < call_path.size(); ++i) {
        frames.push_back(call_path[call_path.size() - 1 - i]);
    }

    // Pre-render the text stacktrace.
    std::string st_str;
    {
        llvm::raw_string_ostream rso_st(st_str);
        for (size_t i = 0; i < frames.size(); ++i) {
            const auto& f = frames[i];
            rso_st << " #" << (i + 1) << " " << (f.name ? f.name : "?")
                   << " at " << (f.file ? f.file : "?") << ":" << f.line << "\n";
        }
    }

    // Capture value string representation
    std::string v_str;
    if (is_real_value_ptr(val)) {
        llvm::raw_string_ostream rso_v(v_str);
        static_cast<llvm::Value*>(val)->print(rso_v);
    } else {
        v_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(val)) + ")";
    }

    std::string loc_str = file ? (std::string(file) + ":" + std::to_string(line)) : "unknown:0";
    std::string f_name = func ? func : "unknown";

    TraceInfo info;
    info.stacktrace = std::move(st_str);
    info.value_str = std::move(v_str);
    info.loc = std::move(loc_str);
    info.func_name = std::move(f_name);
    info.opcode = format_opcode(val);
    info.parent_fn = format_parent_fn(val);
    info.parent_bb = format_parent_bb(val);
    info.debug_loc = format_debug_loc(val);
    info.rule = compute_rule(frames);
    info.frames = std::move(frames);

    get_trace_map()[val] = std::move(info);
    iter_state.new_values.push_back(val);
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
    if (is_real_value_ptr(old_val)) {
        llvm::raw_string_ostream rso_old(old_str);
        static_cast<llvm::Value*>(old_val)->print(rso_old);
    } else {
        old_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(old_val)) + ")";
    }
    if (is_real_value_ptr(new_val)) {
        llvm::raw_string_ostream rso_new(new_str);
        static_cast<llvm::Value*>(new_val)->print(rso_new);
    } else {
        new_str = "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(new_val)) + ")";
    }

    iter_state.replacements.push_back({
        old_val, new_val,
        std::move(old_str), std::move(new_str),
        format_opcode(old_val), format_opcode(new_val),
    });
}

// ---- Dumpers --------------------------------------------------------------

static void dump_text(bool first_dump) {
    std::error_code EC;
    auto open_flags = first_dump ? LLVM_FUZZ_OF_NONE : LLVM_FUZZ_OF_APPEND;
    llvm::raw_fd_ostream out("llvm_fuzz_info.txt", EC, open_flags);
    if (EC) return;
    if (first_dump) out << "=== SESSION START ===\n";

    out << "=== ITERATION " << iter_counter << " START ===\n";
    out << "\nNEW INSTRUCTIONS IN THIS ITERATION:\n";
    for (void* v : iter_state.new_values) {
        auto it = get_trace_map().find(v);
        if (it != get_trace_map().end()) {
            const TraceInfo &info = it->second;
            out << "VALUE " << v << " (" << info.value_str << ") at "
                << info.func_name << " (" << info.loc << "):\n";
            if (!info.opcode.empty() || !info.parent_fn.empty() || !info.debug_loc.empty() || !info.rule.empty()) {
                out << " ";
                if (!info.opcode.empty())    out << "[opcode=" << info.opcode << "] ";
                if (!info.parent_fn.empty()) out << "[fn=" << info.parent_fn
                                                  << (info.parent_bb.empty() ? "" : ("/" + info.parent_bb))
                                                  << "] ";
                if (!info.rule.empty())      out << "[rule=" << info.rule << "] ";
                if (!info.debug_loc.empty()) out << "[dbg=" << info.debug_loc << "] ";
                out << "\n";
            }
            out << info.stacktrace << "\n";
        } else {
            out << "VALUE " << v << " (No trace info)\n";
        }
    }
    out << "REPLACEMENTS IN THIS ITERATION:\n";
    for (auto const& r : iter_state.replacements) {
        out << r.old_ptr << " (" << r.old_str << ") -> "
            << r.new_ptr << " (" << r.new_str << ")\n";
    }
    out << "=== ITERATION END ===\n";
}

static void dump_json(bool first_dump) {
    std::error_code EC;
    auto open_flags = first_dump ? LLVM_FUZZ_OF_NONE : LLVM_FUZZ_OF_APPEND;
    llvm::raw_fd_ostream out("llvm_fuzz_info.json", EC, open_flags);
    if (EC) return;

    JsonWriter w(out);
    w.begin_obj();
    w.key("iteration"); w.num(iter_counter);

    w.key("new_values"); w.begin_arr();
    for (void* v : iter_state.new_values) {
        auto it = get_trace_map().find(v);
        w.begin_obj();
        w.key("ptr"); w.ptr_str(v);
        if (it != get_trace_map().end()) {
            const TraceInfo &info = it->second;
            w.key("ir");         w.str(info.value_str);
            w.key("opcode");     w.str(info.opcode);
            w.key("parent_fn");  w.str(info.parent_fn);
            w.key("parent_bb");  w.str(info.parent_bb);
            w.key("debug_loc");  w.str(info.debug_loc);
            w.key("rule");       w.str(info.rule);
            w.key("loc");        w.str(info.loc);
            w.key("func_name");  w.str(info.func_name);
            w.key("frames");     w.begin_arr();
            for (const auto &f : info.frames) {
                w.begin_obj();
                w.key("name"); w.str(f.name ? f.name : "");
                w.key("file"); w.str(f.file ? f.file : "");
                w.key("line"); w.num(static_cast<uint64_t>(f.line));
                w.end_obj();
            }
            w.end_arr();
        }
        w.end_obj();
    }
    w.end_arr();

    w.key("replacements"); w.begin_arr();
    for (auto const& r : iter_state.replacements) {
        w.begin_obj();
        w.key("old_ptr");    w.ptr_str(r.old_ptr);
        w.key("new_ptr");    w.ptr_str(r.new_ptr);
        w.key("old_ir");     w.str(r.old_str);
        w.key("new_ir");     w.str(r.new_str);
        w.key("old_opcode"); w.str(r.old_opcode);
        w.key("new_opcode"); w.str(r.new_opcode);
        w.end_obj();
    }
    w.end_arr();
    w.end_obj();
    out << "\n";
}

void dump_iteration_info() {
    if (is_trace_disabled()) return;

    std::lock_guard<std::mutex> lock(get_global_mutex());
    if (iter_state.new_values.empty() && iter_state.replacements.empty()) return;

    bool first_dump = !session_started_flag();
    dump_text(first_dump);
    dump_json(first_dump);
    if (first_dump) session_started_flag() = true;

    iter_state.new_values.clear();
    iter_state.replacements.clear();
}

void reset_trace_state() {
    if (is_trace_disabled()) return;

    std::lock_guard<std::mutex> lock(get_global_mutex());
    call_path.clear();
    get_trace_map().clear();
    iter_state.new_values.clear();
    iter_state.replacements.clear();
    iter_counter = 0;
    session_started_flag() = false;
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

extern "C" void reset_trace_state_external() {
    llvm_fuzz::reset_trace_state();
}
