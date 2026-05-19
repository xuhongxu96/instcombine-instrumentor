#!/usr/bin/env python3
"""Patch an LLVM source tree to record InstCombine folds and RAUWs.

Port of scripts/fuzz/patch_llvm.ts from the lpo-agent-data repo. Behavior is
intended to be diff-equivalent against the original on a clean LLVM checkout.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterator

import tree_sitter_cpp
from tree_sitter import Language, Node, Parser, Query

CPP = Language(tree_sitter_cpp.language())

FUNC_QUERY = Query(CPP, "(function_definition) @func")
RETURN_EXPR_QUERY = Query(CPP, "(return_statement (_) @expr) @ret")
RETURN_ANY_QUERY = Query(CPP, "(return_statement) @ret")

POINTER_TYPE_HINTS = (
    b"Instruction",
    b"Value",
    b"BinaryOperator",
    b"CastInst",
    b"CmpInst",
    b"PHINode",
    b"SelectInst",
)

FUZZ_INCLUDE = b'#include "llvm/IR/fuzz_runtime.h"\n'


FUZZ_RUNTIME_H = r"""
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
"""


FUZZ_RUNTIME_CPP = r"""
#include "llvm/IR/fuzz_runtime.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Value.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Support/Signals.h"
#include "llvm/Support/FileSystem.h"
#include <map>
#include <vector>
#include <string>
#include <mutex>
#include <cstdlib>
#include <cstdint>

namespace llvm_fuzz {

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

static std::mutex& get_global_mutex() {
    static std::mutex global_mutex;
    return global_mutex;
}

static std::map<void*, TraceInfo>& get_trace_map() {
    static std::map<void*, TraceInfo> trace_map;
    return trace_map;
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
        // Capture stack trace
        std::string st_str;
        llvm::raw_string_ostream rso_st(st_str);
        llvm::sys::PrintStackTrace(rso_st);

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

        get_trace_map()[val] = {rso_st.str(), v_str, loc_str, f_name};

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
    llvm::raw_fd_ostream out("llvm_fuzz_info.txt", EC, llvm::sys::fs::OF_Append);
    if (EC) return;

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

struct AtExitRegister {
    AtExitRegister() {
        if (is_trace_disabled()) return;

        // Clear the file on initialization
        std::error_code EC;
        llvm::raw_fd_ostream out("llvm_fuzz_info.txt", EC, llvm::sys::fs::OF_None);
        if (!EC) out << "=== SESSION START ===\n";

        get_trace_map();
        std::atexit([]() {
            dump_iteration_info();
        });
    }
};
static AtExitRegister reg;

} // namespace llvm_fuzz
"""


def _new_parser() -> Parser:
    return Parser(CPP)


def parse_bytes(content: bytes) -> Node:
    parser = _new_parser()
    return parser.parse(content).root_node


def first_capture(captures: dict, name: str) -> Node | None:
    """Return the first node captured under `name`, or None."""
    nodes = captures.get(name)
    if not nodes:
        return None
    return nodes[0]


def descendants_of_type(node: Node, type_name: str) -> Iterator[Node]:
    """DFS yielding all descendants whose `.type == type_name` (matches TS descendantsOfType)."""
    stack = list(node.children)
    while stack:
        current = stack.pop()
        if current.type == type_name:
            yield current
        stack.extend(current.children)


def get_function_name(func_node: Node) -> bytes:
    """Return the function's name as bytes (matches TS getFunctionName)."""
    declarator = func_node.child_by_field_name("declarator")
    if declarator is None:
        return b""

    inner = declarator
    while inner.type in ("function_declarator", "pointer_declarator", "reference_declarator"):
        child = inner.child_by_field_name("declarator")
        if child is None:
            break
        inner = child

    if inner.type in ("identifier", "field_identifier"):
        return inner.text
    if inner.type == "qualified_identifier":
        name_node = inner.child_by_field_name("name")
        if name_node is not None:
            return name_node.text

    idents = list(descendants_of_type(inner, "identifier"))
    if idents:
        return idents[-1].text

    return b""


def is_inside_nested_scope(node: Node, root: Node) -> bool:
    current = node.parent
    while current is not None and current.id != root.id:
        if current.type in ("lambda_expression", "function_definition"):
            return True
        current = current.parent
    return False


def apply_edits(content: bytes, edits: list[tuple[int, int, bytes]]) -> bytes:
    """Apply (start_byte, end_byte, replacement) edits non-overlappingly in reverse."""
    edits_sorted = sorted(edits, key=lambda e: e[0], reverse=True)
    out = content
    for start, end, text in edits_sorted:
        out = out[:start] + text + out[end:]
    return out


def ensure_fuzz_include(content: bytes) -> bytes:
    if b"llvm/IR/fuzz_runtime.h" in content:
        return content
    return FUZZ_INCLUDE + content


def create_fuzz_runtime(llvm_repo: Path) -> None:
    header_path = llvm_repo / "llvm/include/llvm/IR/fuzz_runtime.h"
    source_path = llvm_repo / "llvm/lib/IR/fuzz_runtime.cpp"
    header_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.parent.mkdir(parents=True, exist_ok=True)
    header_path.write_text(FUZZ_RUNTIME_H)
    source_path.write_text(FUZZ_RUNTIME_CPP)


def patch_value_cpp(file_path: Path) -> None:
    print(f"Patching {file_path}...")
    content = file_path.read_bytes()
    root = parse_bytes(content)

    edits: list[tuple[int, int, bytes]] = []
    for _pattern_idx, captures in FUNC_QUERY.matches(root):
        func_node = first_capture(captures, "func")
        if func_node is None:
            continue
        body = func_node.child_by_field_name("body")
        if body is None:
            continue
        if get_function_name(func_node) != b"doRAUW":
            continue
        if b"__llvm_fuzz_record_replace" in body.text:
            continue
        insert_at = body.start_byte + 1
        edits.append((insert_at, insert_at, b"\n  __llvm_fuzz_record_replace(this, New);"))

    if not edits:
        return

    patched = apply_edits(content, edits)
    patched = ensure_fuzz_include(patched)
    file_path.write_bytes(patched)


def _wrap_returns(
    content: bytes,
    body: Node,
    edits: list[tuple[int, int, bytes]],
) -> bool:
    """Wrap top-level `return X;` expressions in __llvm_fuzz_record(...). Returns True if changed."""
    changed = False
    for _pattern_idx, captures in RETURN_EXPR_QUERY.matches(body):
        ret_node = first_capture(captures, "ret")
        expr_node = first_capture(captures, "expr")
        if ret_node is None or expr_node is None:
            continue
        if is_inside_nested_scope(ret_node, body):
            continue
        expr_text = content[expr_node.start_byte:expr_node.end_byte]
        if b"__llvm_fuzz_record" in expr_text or expr_text == b"nullptr":
            continue
        edits.append((
            expr_node.start_byte,
            expr_node.end_byte,
            b"__llvm_fuzz_record(" + expr_text + b")",
        ))
        changed = True
    return changed


def _is_pointer_return(prefix_text: bytes, declarator: Node, allow_star_in_prefix: bool) -> bool:
    type_match = any(hint in prefix_text for hint in POINTER_TYPE_HINTS)
    if not type_match:
        return False
    if declarator.type == "pointer_declarator":
        return True
    if allow_star_in_prefix and b"*" in prefix_text:
        return True
    return False


def patch_inst_combine_file(file_path: Path) -> None:
    print(f"Patching {file_path}...")
    content = file_path.read_bytes()
    root = parse_bytes(content)

    edits: list[tuple[int, int, bytes]] = []
    processed_bodies: set[int] = set()
    changed = False
    file_path_str = str(file_path)

    for _pattern_idx, captures in FUNC_QUERY.matches(root):
        func_node = first_capture(captures, "func")
        if func_node is None:
            continue
        body = func_node.child_by_field_name("body")
        if body is None:
            continue
        if body.id in processed_bodies:
            continue
        processed_bodies.add(body.id)

        declarator = func_node.child_by_field_name("declarator")
        if declarator is None:
            continue

        prefix_text = content[func_node.start_byte:declarator.start_byte]

        if _is_pointer_return(prefix_text, declarator, allow_star_in_prefix=False):
            if _wrap_returns(content, body, edits):
                changed = True

        if get_function_name(func_node) == b"run" and file_path_str.endswith("InstructionCombining.cpp"):
            if b"InstCombinerImpl" in declarator.text:
                if b"llvm_fuzz::start_iteration()" not in body.text:
                    insert_at = body.start_byte + 1
                    edits.append((insert_at, insert_at, b"\n  llvm_fuzz::start_iteration();"))
                    changed = True

                if b"dump_iteration_info" not in body.text:
                    for _pi, ret_caps in RETURN_ANY_QUERY.matches(body):
                        ret_node = first_capture(ret_caps, "ret")
                        if ret_node is None:
                            continue
                        if is_inside_nested_scope(ret_node, body):
                            continue
                        ret_text = content[ret_node.start_byte:ret_node.end_byte]
                        if b"MadeIRChange" in ret_text:
                            edits.append((
                                ret_node.start_byte,
                                ret_node.end_byte,
                                b"if (MadeIRChange) llvm_fuzz::dump_iteration_info(); return MadeIRChange;",
                            ))
                            changed = True

    if not changed:
        return

    patched = apply_edits(content, edits)
    patched = ensure_fuzz_include(patched)
    file_path.write_bytes(patched)


def patch_instruction_simplify_file(file_path: Path) -> None:
    print(f"Patching {file_path} (Specialized for Simplify)...")
    content = file_path.read_bytes()
    root = parse_bytes(content)

    edits: list[tuple[int, int, bytes]] = []
    processed_bodies: set[int] = set()
    changed = False

    for _pattern_idx, captures in FUNC_QUERY.matches(root):
        func_node = first_capture(captures, "func")
        if func_node is None:
            continue
        body = func_node.child_by_field_name("body")
        if body is None:
            continue
        if body.id in processed_bodies:
            continue
        processed_bodies.add(body.id)

        declarator = func_node.child_by_field_name("declarator")
        if declarator is None:
            continue

        prefix_text = content[func_node.start_byte:declarator.start_byte]
        if _is_pointer_return(prefix_text, declarator, allow_star_in_prefix=True):
            if _wrap_returns(content, body, edits):
                changed = True

    if not changed:
        return

    patched = apply_edits(content, edits)
    patched = ensure_fuzz_include(patched)
    file_path.write_bytes(patched)


def update_core_cmake(file_path: Path) -> None:
    print(f"Updating {file_path}...")
    content = file_path.read_text()
    if "fuzz_runtime.cpp" in content:
        return
    new_content = content.replace(
        "add_llvm_component_library(LLVMCore",
        "add_llvm_component_library(LLVMCore\n  fuzz_runtime.cpp",
    )
    file_path.write_text(new_content)


def update_analysis_cmake(file_path: Path) -> None:
    print(f"Updating {file_path}...")
    content = file_path.read_text()
    if "set_source_files_properties(InstructionSimplify.cpp" in content:
        return
    new_content = (
        content
        + '\nset_source_files_properties(InstructionSimplify.cpp PROPERTIES COMPILE_OPTIONS "-O0;-g")\n'
    )
    file_path.write_text(new_content)


def update_inst_combine_cmake(file_path: Path) -> None:
    print(f"Updating {file_path}...")
    content = file_path.read_text()
    if "target_compile_options(LLVMInstCombine" in content:
        return
    new_content = (
        content
        + "\ntarget_compile_options(LLVMInstCombine\n  PRIVATE\n  -O0;-g\n)\n"
    )
    file_path.write_text(new_content)


def patch_llvm(llvm_repo: Path) -> None:
    create_fuzz_runtime(llvm_repo)

    tasks: list[tuple[str, Path]] = []

    value_cpp = llvm_repo / "llvm/lib/IR/Value.cpp"
    tasks.append(("VALUE_CPP", value_cpp))

    inst_combine_dir = llvm_repo / "llvm/lib/Transforms/InstCombine"
    if inst_combine_dir.is_dir():
        for entry in sorted(inst_combine_dir.iterdir()):
            if entry.suffix in (".cpp", ".h") and entry.is_file():
                tasks.append(("INST_COMBINE", entry))

    inst_simplify = llvm_repo / "llvm/lib/Analysis/InstructionSimplify.cpp"
    tasks.append(("INST_SIMPLIFY", inst_simplify))

    print(f"Starting {len(tasks)} patching tasks sequentially...")
    for kind, file_path in tasks:
        if kind == "VALUE_CPP":
            patch_value_cpp(file_path)
        elif kind == "INST_COMBINE":
            patch_inst_combine_file(file_path)
        elif kind == "INST_SIMPLIFY":
            patch_instruction_simplify_file(file_path)
        else:
            raise RuntimeError(f"Unknown task type: {kind}")

    update_core_cmake(llvm_repo / "llvm/lib/IR/CMakeLists.txt")
    update_analysis_cmake(llvm_repo / "llvm/lib/Analysis/CMakeLists.txt")
    update_inst_combine_cmake(llvm_repo / "llvm/lib/Transforms/InstCombine/CMakeLists.txt")

    print("Patching completed.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Patch LLVM source for InstCombine fuzz tracing.")
    parser.add_argument("--llvm-repo", required=True, help="Path to LLVM repository")
    args = parser.parse_args(argv)

    llvm_repo = Path(args.llvm_repo)
    if not llvm_repo.is_dir():
        print(f"error: {llvm_repo} is not a directory", file=sys.stderr)
        return 1

    patch_llvm(llvm_repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
