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
#define LLVM_FUZZ_OF_APPEND llvm::sys::fs::OF_Append
#endif
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
    const char *disable_trace = std::getenv("DISABLE_INSTCOMBINE_TRACE");
    bool disabled = disable_trace && (std::string(disable_trace) == "1" ||
                                      std::string(disable_trace) == "true");
    return disabled;
  })();
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
    return;
  }
  if (!call_path.empty()) {
    call_path.pop_back();
  }
}

VTScope::VTScope() {
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

static std::map<void *, TraceInfo> &get_trace_map() {
  static std::map<void *, TraceInfo> trace_map;
  return trace_map;
}

static bool &session_started_flag() {
  static bool started = false;
  return started;
}

// --- helpers ---

static bool is_real_value_ptr(void *v) {
  return reinterpret_cast<uintptr_t>(v) >= 0x10000 &&
         reinterpret_cast<intptr_t>(v) != -1;
}

static std::string format_opcode(void *v) {
  if (!is_real_value_ptr(v))
    return "";
  auto *val = static_cast<llvm::Value *>(v);
  if (auto *inst = llvm::dyn_cast<llvm::Instruction>(val)) {
    return inst->getOpcodeName();
  }
  return "";
}

static std::string format_parent_fn(void *v) {
  if (!is_real_value_ptr(v)) {
    return "";
  }
  auto *val = static_cast<llvm::Value *>(v);
  auto *inst = llvm::dyn_cast<llvm::Instruction>(val);
  if (!inst) {
    return "";
  }
  auto *bb = inst->getParent();
  if (!bb) {
    return "";
  }
  auto *fn = bb->getParent();
  if (!fn) {
    return "";
  }
  return fn->getName().str();
}

static std::string format_parent_bb(void *v) {
  if (!is_real_value_ptr(v)) {
    return "";
  }
  auto *val = static_cast<llvm::Value *>(v);
  auto *inst = llvm::dyn_cast<llvm::Instruction>(val);

  if (!inst) {
    return "";
  }
  auto *bb = inst->getParent();
  if (!bb) {
    return "";
  }
  return bb->getName().str();
}

static std::string format_debug_loc(void *v) {
  if (!is_real_value_ptr(v)) {
    return "";
  }

  auto *val = static_cast<llvm::Value *>(v);
  auto *inst = llvm::dyn_cast<llvm::Instruction>(val);

  if (!inst) {
    return "";
  }
  const llvm::DebugLoc &dl = inst->getDebugLoc();

  if (!dl) {
    return "";
  }
  unsigned line = dl.getLine();
  unsigned col = dl.getCol();
  std::string filename;
  if (auto *dil = llvm::dyn_cast_or_null<llvm::DILocation>(dl.get())) {
    filename = dil->getFilename().str();
  }
  std::string s = filename + ":" + std::to_string(line);
  if (col) {
    s += ":" + std::to_string(col);
  }
  return s;
}

// walk frames and return the first caller whose source contains "InstCombine"
// finding the "original"/"source" of a fired rule.
static std::string compute_rule(const std::vector<Frame> &frames) {
  for (const auto &f : frames) {
    if (f.file && std::strstr(f.file, "InstCombine")) {
      return f.name ? f.name : "";
    }
  }
  return "";
}

// snapshot call_path in print order, shared by new values and ValueTracking
// queries so both know where in InstCombine did this happen.
static std::vector<Frame> snapshot_call_path() {
  std::vector<Frame> frames;
  frames.reserve(call_path.size());
  for (size_t i = 0; i < call_path.size(); ++i) {
    frames.push_back(call_path[call_path.size() - 1 - i]);
  }
  return frames;
}

// render a frame snapshot as a text trace stack.
static std::string render_frames(const std::vector<Frame> &frames) {
  std::string st_str;
  {
    llvm::raw_string_ostream rso_st(st_str);
    for (size_t i = 0; i < frames.size(); ++i) {
      const auto &f = frames[i];
      rso_st << " #" << (i + 1) << " " << (f.name ? f.name : "?") << " at "
             << (f.file ? f.file : "?") << ":" << f.line << "\n";
    }
  }
  return st_str;
}

// create a minimal json writer to avoid adding
// rahhh I hate libraries
namespace {
class JsonWriter {
  llvm::raw_ostream &os;
  bool need_comma = false;
  void maybe_comma() {
    if (need_comma) {
      os << ",";
    }
    need_comma = true;
  }

public:
  explicit JsonWriter(llvm::raw_ostream &o) : os(o) {}
  void begin_obj() {
    maybe_comma();
    os << "{";
    need_comma = false;
  }
  void end_obj() {
    os << "}";
    need_comma = true;
  }

  void begin_arr() {
    maybe_comma();
    os << "[";
    need_comma = false;
  }

  void end_arr() {
    os << "]";
    need_comma = true;
  }

  void key(const char *k) {
    maybe_comma();
    os << "\"";
    emit_escaped(k);
    os << "\":";
    need_comma = false;
  }

  void str(llvm::StringRef s) {
    maybe_comma();
    os << "\"";
    emit_escaped(s);
    os << "\"";
    need_comma = true;
  }

  void num(uint64_t n) {
    maybe_comma();
    os << n;
    need_comma = true;
  }

  void ptr_str(const void *p) {
    maybe_comma();
    char buf[2 * sizeof(uintptr_t) * 2 + 1];
    std::snprintf(buf, sizeof(buf), "0x%lx",
                  static_cast<unsigned long>(reinterpret_cast<uintptr_t>(p)));
    os << "\"" << buf << "\"";
    need_comma = true;
  }

private:
  void emit_escaped(llvm::StringRef s) {
    for (char c : s) {
      switch (c) {
      case '"':
        os << "\\\"";
        break;
      case '\\':
        os << "\\\\";
        break;
      case '\n':
        os << "\\n";
        break;
      case '\r':
        os << "\\r";
        break;
      case '\t':
        os << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(
              buf, sizeof(buf), "\\u%04x",
              static_cast<unsigned int>(static_cast<unsigned char>(c)));
          os << buf;
        } else {
          os << c;
        }
      }
    }
  };
};

// emit "Frames:" :[{"name": ..., "file": ..., "line": N}, ...]
// into current JSON object.
void emit_frames(JsonWriter &w, const std::vector<Frame> &frames) {
  w.key("frames");
  w.begin_arr();
  for (const auto &f : frames) {
    w.begin_obj();
    w.key("name");
    w.str(f.name ? f.name : "");
    w.key("file");
    w.str(f.file ? f.file : "");
    w.key("line");
    w.num(static_cast<uint64_t>(f.line));
    w.end_obj();
  }
  w.end_arr();
}
} // namespace

// -------- Public API ---------------

void start_iteration() {
  if (is_trace_disabled()) {
    return;
  }

  dump_iteration_info();
  iter_state.new_values.clear();
  iter_state.replacements.clear();
  iter_state.vt_queries.clear();
  iter_counter++;
}

static void record_stacktrace_internal(void *val, const char *file = nullptr,
                                       int line = 0,
                                       const char *func = nullptr) {
  if (is_trace_disabled()) {
    return;
  }
  if (!val) {
    return;
  }

  auto it = get_trace_map().find(val);
  if (it != get_trace_map().end()) {
    return;
  }

  std::vector<Frame> frames = snapshot_call_path();

  std::string st_str = render_frames(frames);

  std::string v_str;
  if (is_real_value_ptr(val)) {
    llvm::raw_string_ostream rso_v(v_str);
    static_cast<llvm::Value *>(val)->print(rso_v);
  } else {
    v_str =
        "Sentinel(" + std::to_string(reinterpret_cast<uintptr_t>(val)) + ")";
  }

  std::string loc_str =
      file ? (std::string(file) + ":" + std::to_string(line)) : "unknown:0";
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

void record_stacktrace(void *val, const char *file, int line,
                       const char *func) {
  if (is_trace_disabled() || !val) {
    return;
  }

  record_stacktrace_internal(val, file, line, func);
}

void record_replacement(void *old_val, void *new_val) {
  if (is_trace_disabled()) {
    return;
  }
  if (!old_val || !new_val) {
    return;
  }

  record_stacktrace_internal(new_val);
  std::string old_str, new_str;
  if (is_real_value_ptr(old_val)) {
    llvm::raw_string_ostream rso_old(old_str);
    static_cast<llvm::Value *>(old_val)->print(rso_old);
  } else {
    old_str = "Sentinel(" +
              std::to_string(reinterpret_cast<uintptr_t>(old_val)) + ")";
  }

  if (is_real_value_ptr(new_val)) {
    llvm::raw_string_ostream rso_new(new_str);
    static_cast<llvm::Value *>(new_val)->print(rso_new);
  } else {
    new_str = "Sentinel(" +
              std::to_string(reinterpret_cast<uintptr_t>(new_val)) + ")";
  }

  iter_state.replacements.push_back({
      old_val,
      new_val,
      std::move(old_str),
      std::move(new_str),
      format_opcode(old_val),
      format_opcode(new_val),
  });
}

// record one outermost valuetracking query. this is called from the
// hook in ValueTracking.cpp while the call's VTScope is still alive
// so an outermost query sees vt_depth == 1 here
void record_vt_query(const char *query, const char *result,
                     const llvm::Value *v0, const llvm::Value *v1) {
  if (is_trace_disabled()) {
    return;
  }

  // vt_depth > 1 means another hooked ValueTracking call is below us on the
  // stack, so this is ValueTracking asking itself.
  if (vt_depth > 1) {
    return;
  }

  // this if statement trips if the function is not called by code
  // we have instrumented. call_path only has frames when we are inside
  // an __llvm_fuzz_call(...) wrap which only exist in InstCombine and
  // InstructionSimplify
  if (call_path.empty()) {
    return;
  }

  VTQuery q;
  q.query = query ? query : "";
  q.result = result ? result : "";

  // print each operand now before InstCombine rewrites/erases it
  // trace shows IR as it was when the question was asked
  for (const llvm::Value *v : {v0, v1}) {
    if (!v) {
      continue;
    }
    std::string ir;
    {
      // this is scoped so the stream is flushed into ir
      // before it is moved
      llvm::raw_string_ostream rso(ir);
      v->print(rso);
    }
    q.operands.push_back({v, std::move(ir)});
  }

  // get call path and such
  q.frames = snapshot_call_path();
  q.rule = compute_rule(q.frames);

  iter_state.vt_queries.push_back(std::move(q));
}

// dumpers
static void dump_text(bool first_dump) {
  std::error_code EC;
  auto open_flags = first_dump ? LLVM_FUZZ_OF_NONE : LLVM_FUZZ_OF_APPEND;
  llvm::raw_fd_ostream out("llvm_fuzz_info.txt", EC, open_flags);
  if (EC) {
    return;
  }
  if (first_dump) {
    out << "=== SESSION START ===\n";
  }
  out << "=== ITERATION " << iter_counter << " START ===\n";
  out << "\nNEW INSTRUCTIONS IN THIS ITERATION:\n";
  for (void *v : iter_state.new_values) {
    auto it = get_trace_map().find(v);
    if (it != get_trace_map().end()) {
      const TraceInfo &info = it->second;
      out << "VALUE " << v << " (" << info.value_str << ") at "
          << info.func_name << " (" << info.loc << "):\n";
      if (!info.opcode.empty() || !info.parent_fn.empty() ||
          !info.debug_loc.empty() || !info.rule.empty()) {
        out << " ";
        if (!info.opcode.empty())
          out << "[opcode=" << info.opcode << "] ";
        if (!info.parent_fn.empty())
          out << "[fn=" << info.parent_fn
              << (info.parent_bb.empty() ? "" : ("/" + info.parent_bb)) << "] ";
        if (!info.rule.empty())
          out << "[rule=" << info.rule << "] ";
        if (!info.debug_loc.empty())
          out << "[dbg=" << info.debug_loc << "] ";
        out << "\n";
      }
      out << info.stacktrace << "\n";
    } else {
      out << "VALUE " << v << " (No trace info)\n";
    }
  }
  out << "REPLACEMENTS IN THIS ITERATION:\n";
  for (auto const &r : iter_state.replacements) {
    out << r.old_ptr << " (" << r.old_str << ") -> " << r.new_ptr << " ("
        << r.new_str << ")\n";
  }
  // ValueTracking queries
  // each entry is:
  //   QUERY <query>(<ptr> (<ir>)[, <ptr> (<ir>)]) = <result>
  //    [rule=<visit*/fold* that asked>]        <- omitted if no rule found
  //    #1 <caller> at <file>:<line>            <- call path, as for VALUEs
  //    #2 ...
  //   <blank line>
  out << "\nVALUETRACKING QUERIES IN THIS ITERATION:\n";
  for (auto const &q : iter_state.vt_queries) {
    out << "QUERY " << q.query << "(";
    for (size_t i = 0; i < q.operands.size(); ++i) {
      if (i)
        out << ", ";
      out << q.operands[i].ptr << " (" << q.operands[i].ir << ")";
    }
    out << ") = " << q.result << "\n";
    if (!q.rule.empty())
      out << " [rule=" << q.rule << "]\n";
    out << render_frames(q.frames) << "\n";
  }
  out << "=== ITERATION END ===\n";
}

static void dump_json(bool first_dump) {
  std::error_code EC;
  auto open_flags = first_dump ? LLVM_FUZZ_OF_NONE : LLVM_FUZZ_OF_APPEND;
  llvm::raw_fd_ostream out("llvm_fuzz_info.json", EC, open_flags);
  if (EC)
    return;

  JsonWriter w(out);
  w.begin_obj();
  w.key("iteration");
  w.num(iter_counter);

  w.key("new_values");
  w.begin_arr();
  for (void *v : iter_state.new_values) {
    auto it = get_trace_map().find(v);
    w.begin_obj();
    w.key("ptr");
    w.ptr_str(v);
    if (it != get_trace_map().end()) {
      const TraceInfo &info = it->second;
      w.key("ir");
      w.str(info.value_str);
      w.key("opcode");
      w.str(info.opcode);
      w.key("parent_fn");
      w.str(info.parent_fn);
      w.key("parent_bb");
      w.str(info.parent_bb);
      w.key("debug_loc");
      w.str(info.debug_loc);
      w.key("rule");
      w.str(info.rule);
      w.key("loc");
      w.str(info.loc);
      w.key("func_name");
      w.str(info.func_name);
      emit_frames(w, info.frames);
    }
    w.end_obj();
  }
  w.end_arr();

  w.key("replacements");
  w.begin_arr();
  for (auto const &r : iter_state.replacements) {
    w.begin_obj();
    w.key("old_ptr");
    w.ptr_str(r.old_ptr);
    w.key("new_ptr");
    w.ptr_str(r.new_ptr);
    w.key("old_ir");
    w.str(r.old_str);
    w.key("new_ir");
    w.str(r.new_str);
    w.key("old_opcode");
    w.str(r.old_opcode);
    w.key("new_opcode");
    w.str(r.new_opcode);
    w.end_obj();
  }
  w.end_arr();

  // ValueTracking queries
  //   "vt_queries": [
  //     { "query": "haveNoCommonBitsSet", "result": "true",
  //       "operands": [{ "ptr": "0x55...", "ir": "  %a = and i32 %x, 15" },
  //                    { "ptr": "0x55...", "ir": "i32 16" }],
  //       "rule": "llvm::...visitAdd(...)",
  //       "frames": [{ "name": "...", "file": "...", "line": 42 }] }
  //   ]
  //
  w.key("vt_queries");
  w.begin_arr();
  for (auto const &q : iter_state.vt_queries) {
    w.begin_obj();
    w.key("query");
    w.str(q.query);
    w.key("result");
    w.str(q.result);
    w.key("operands");
    w.begin_arr();
    for (const auto &op : q.operands) {
      w.begin_obj();
      w.key("ptr");
      w.ptr_str(op.ptr);
      w.key("ir");
      w.str(op.ir);
      w.end_obj();
    }
    w.end_arr();
    w.key("rule");
    w.str(q.rule);
    emit_frames(w, q.frames);
    w.end_obj();
  }
  w.end_arr();
  w.end_obj();
  out << "\n";
}

void dump_iteration_info() {
  if (is_trace_disabled())
    return;

  if (iter_state.new_values.empty() && iter_state.replacements.empty() &&
      iter_state.vt_queries.empty())
    return;

  bool first_dump = !session_started_flag();
  dump_text(first_dump);
  dump_json(first_dump);
  if (first_dump)
    session_started_flag() = true;

  iter_state.new_values.clear();
  iter_state.replacements.clear();
  iter_state.vt_queries.clear();
}

void reset_trace_state() {
  if (is_trace_disabled())
    return;

  call_path.clear();
  // Like call_path: between runs no ValueTracking call should be on the stack,
  // so start the next run from a clean nesting count.
  vt_depth = 0;
  get_trace_map().clear();
  iter_state.new_values.clear();
  iter_state.replacements.clear();
  iter_state.vt_queries.clear();
  iter_counter = 0;
  session_started_flag() = false;
}

#ifndef __EMSCRIPTEN__
struct AtExitRegister {
  AtExitRegister() {
    if (is_trace_disabled())
      return;
    // atexit handlers and static destructors run in reverse order of
    // registration. Construct the (lazily created) trace map first so it is
    // destroyed after the final flush, not before it; iter_state is defined
    // above `reg` in this file and is thus constructed first already.
    get_trace_map();
    std::atexit([]() { dump_iteration_info(); });
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

extern "C" void reset_trace_state_external() { llvm_fuzz::reset_trace_state(); }
