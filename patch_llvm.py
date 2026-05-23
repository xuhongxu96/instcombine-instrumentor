#!/usr/bin/env python3
"""Patch an LLVM source tree to record InstCombine folds and RAUWs.

Port of scripts/fuzz/patch_llvm.ts from the lpo-agent-data repo. Behavior is
intended to be diff-equivalent against the original on a clean LLVM checkout.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterator

import tree_sitter_cpp
from tree_sitter import Language, Node, Parser, Query

CPP = Language(tree_sitter_cpp.language())

FUNC_QUERY = Query(CPP, "(function_definition) @func")
RETURN_EXPR_QUERY = Query(CPP, "(return_statement (_) @expr) @ret")
RETURN_ANY_QUERY = Query(CPP, "(return_statement) @ret")
CALL_QUERY = Query(CPP, "(call_expression) @call")

POINTER_TYPE_HINTS = (
    b"Instruction",
    b"Value",
    b"BinaryOperator",
    b"CastInst",
    b"CmpInst",
    b"PHINode",
    b"SelectInst",
)

# IRBuilder methods that produce new Values. Allowlisted by pattern so we don't
# have to enumerate dozens of CreateAdd/CreateSub/CreateICmp/... variants.
CREATE_PATTERN = re.compile(rb"^Create[A-Z]")

FUZZ_INCLUDE = b'#include "llvm/IR/fuzz_runtime.h"\n'

RUNTIME_DIR = Path(__file__).parent / "runtime"
FUZZ_RUNTIME_H = (RUNTIME_DIR / "fuzz_runtime.h").read_text()
FUZZ_RUNTIME_CPP = (RUNTIME_DIR / "fuzz_runtime.cpp").read_text()


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


def detect_llvm_major_version(llvm_repo: Path) -> int:
    version_files = [
        llvm_repo / "llvm/CMakeLists.txt",
        llvm_repo / "cmake/Modules/LLVMVersion.cmake",
    ]
    version_re = re.compile(r"^[ \t]*set\(LLVM_VERSION_MAJOR[ \t]+([0-9]+)\)")
    for version_file in version_files:
        if not version_file.is_file():
            continue
        for line in version_file.read_text().splitlines():
            match = version_re.match(line)
            if match:
                return int(match.group(1))
    raise RuntimeError(f"Could not detect LLVM_VERSION_MAJOR under {llvm_repo}")


def patch_signals_header_for_older_llvm(llvm_repo: Path, llvm_version_major: int) -> None:
    if llvm_version_major > 13:
        return

    signals_h = llvm_repo / "llvm/include/llvm/Support/Signals.h"
    print(f"Patching {signals_h} for LLVM {llvm_version_major}...")
    content = signals_h.read_text()
    if "#include <cstdint>" in content:
        return

    include_anchor = "#include <string>"
    if include_anchor not in content:
        raise RuntimeError(f"Could not find include anchor in {signals_h}")

    signals_h.write_text(content.replace(include_anchor, '#include <cstdint>\n' + include_anchor, 1))


def _is_pointer_return(prefix_text: bytes, declarator: Node, allow_star_in_prefix: bool) -> bool:
    type_match = any(hint in prefix_text for hint in POINTER_TYPE_HINTS)
    if not type_match:
        return False
    if declarator.type == "pointer_declarator":
        return True
    if allow_star_in_prefix and b"*" in prefix_text:
        return True
    return False


def _extract_callee_name(func_node: Node) -> bytes | None:
    """Extract the bare callee name from a call_expression's `function` field child.

    Walks the field structure explicitly (don't use generic descendant search —
    sibling order through `descendants_of_type`'s stack-pop isn't reliable).
    """
    if func_node is None:
        return None
    t = func_node.type
    if t in ("identifier", "field_identifier"):
        return func_node.text
    if t == "field_expression":
        return _extract_callee_name(func_node.child_by_field_name("field"))
    if t == "qualified_identifier":
        return _extract_callee_name(func_node.child_by_field_name("name"))
    if t == "template_function":
        return _extract_callee_name(func_node.child_by_field_name("name"))
    if t == "parenthesized_expression":
        for child in func_node.children:
            if child.is_named:
                return _extract_callee_name(child)
        return None
    return None


def _call_is_allowlisted(bare: bytes, instrumented_names: set[bytes]) -> bool:
    if bare in instrumented_names:
        return True
    if CREATE_PATTERN.match(bare):
        return True
    return False


def _is_inside_fuzz_wrap(node: Node, content: bytes) -> bool:
    """True if `node` is wrapped by an existing __llvm_fuzz_call / __llvm_fuzz_record."""
    current = node.parent
    while current is not None:
        if current.type == "call_expression":
            func = current.child_by_field_name("function")
            if func is not None:
                func_text = content[func.start_byte:func.end_byte]
                if func_text in (b"__llvm_fuzz_call", b"__llvm_fuzz_record"):
                    return True
        current = current.parent
    return False


def _is_address_of_operand(node: Node, content: bytes) -> bool:
    """True if `node` is the immediate operand of a unary address-of (`&`).

    Clang treats the result of a GCC statement-expression as a temporary
    rvalue, so `&__llvm_fuzz_call(expr)` fails even when `expr` itself yields
    an lvalue/reference (e.g. `&CI->getValue()` in InstructionSimplify.cpp).
    Walks through parenthesized_expression layers between the call and the
    address-of so `&(foo())` is caught too.
    """
    parent = node.parent
    while parent is not None and parent.type == "parenthesized_expression":
        parent = parent.parent
    if parent is None or parent.type != "pointer_expression":
        return False
    op = parent.child_by_field_name("operator")
    if op is None:
        return False
    return content[op.start_byte:op.end_byte] == b"&"


def _collect_wrap_call_ids(
    body: Node,
    content: bytes,
    instrumented_names: set[bytes],
) -> set[int]:
    """IDs of call_expression nodes inside `body` that should be wrapped with __llvm_fuzz_call."""
    wrap_ids: set[int] = set()
    for _pi, captures in CALL_QUERY.matches(body):
        call = first_capture(captures, "call")
        if call is None:
            continue
        # Idempotency: skip the wrapper itself and skip calls already inside a wrapper.
        func = call.child_by_field_name("function")
        if func is not None:
            func_text = content[func.start_byte:func.end_byte]
            if func_text in (b"__llvm_fuzz_call", b"__llvm_fuzz_record"):
                continue
        if _is_inside_fuzz_wrap(call, content):
            continue
        if _is_address_of_operand(call, content):
            continue
        bare = _extract_callee_name(func)
        if bare is None:
            continue
        if not _call_is_allowlisted(bare, instrumented_names):
            continue
        wrap_ids.add(call.id)
    return wrap_ids


def _find_direct_wrap_descendants(node: Node, wrap_ids: set[int]) -> list[Node]:
    """Return descendants of `node` whose id is in `wrap_ids`, skipping into a wrap once found."""
    result: list[Node] = []
    stack = list(node.children)
    while stack:
        n = stack.pop()
        if n.id in wrap_ids:
            result.append(n)
            # Don't descend further into this wrap; its subtree is rendered by the recursive call.
        else:
            stack.extend(n.children)
    return result


def _render_with_inner_wraps(node: Node, content: bytes, wrap_ids: set[int]) -> bytes:
    """Render node's text with inner wrap_ids descendants substituted."""
    inner = _find_direct_wrap_descendants(node, wrap_ids)
    if not inner:
        return content[node.start_byte:node.end_byte]
    inner.sort(key=lambda n: n.start_byte)
    parts: list[bytes] = []
    cursor = node.start_byte
    for w in inner:
        if w.start_byte > cursor:
            parts.append(content[cursor:w.start_byte])
        parts.append(_render_wrap_unit(w, content, wrap_ids))
        cursor = w.end_byte
    if cursor < node.end_byte:
        parts.append(content[cursor:node.end_byte])
    return b"".join(parts)


def _render_wrap_unit(node: Node, content: bytes, wrap_ids: set[int]) -> bytes:
    """Render `node`, wrapping it with __llvm_fuzz_call if its id is in wrap_ids,
    and recursively splicing nested wraps."""
    inner_text = _render_with_inner_wraps(node, content, wrap_ids)
    if node.id in wrap_ids:
        return b"__llvm_fuzz_call(" + inner_text + b")"
    return inner_text


def _body_edits(
    content: bytes,
    body: Node,
    wrap_ids: set[int],
    return_exprs: list[Node],
) -> list[tuple[int, int, bytes]]:
    """Produce one set of non-overlapping edits for this body.

    `wrap_ids`: call_expression node ids to wrap with __llvm_fuzz_call.
    `return_exprs`: top-level return expression nodes to additionally wrap with __llvm_fuzz_record.

    Resolves overlaps by treating the outermost "unit" (whatever's at the top of any wrap chain)
    as the edit target, and splicing inner wraps into its replacement text.
    """
    return_expr_ids = {e.id for e in return_exprs}
    unit_ids = wrap_ids | return_expr_ids

    def _has_unit_ancestor(node: Node) -> bool:
        cur = node.parent
        while cur is not None and cur.id != body.id:
            if cur.id in unit_ids:
                return True
            cur = cur.parent
        return False

    edits: list[tuple[int, int, bytes]] = []
    seen_unit: set[int] = set()

    # Process return exprs first — they often subsume call wraps.
    for expr in return_exprs:
        if _has_unit_ancestor(expr):
            continue
        if expr.id in seen_unit:
            continue
        seen_unit.add(expr.id)
        inner = _render_wrap_unit(expr, content, wrap_ids)
        edits.append((expr.start_byte, expr.end_byte, b"__llvm_fuzz_record(" + inner + b")"))

    # Now emit outermost call wraps that weren't covered by a return.
    # Need stable iteration: sort wrap_ids by depth (outermost first) via byte range.
    wrap_nodes: list[Node] = []
    for _pi, captures in CALL_QUERY.matches(body):
        call = first_capture(captures, "call")
        if call is not None and call.id in wrap_ids:
            wrap_nodes.append(call)
    # An outermost wrap is one whose chain of ancestors (within body) contains no other unit.
    wrap_nodes.sort(key=lambda n: (n.start_byte, -n.end_byte))
    for call in wrap_nodes:
        if call.id in seen_unit:
            continue
        if _has_unit_ancestor(call):
            continue
        seen_unit.add(call.id)
        rendered = _render_wrap_unit(call, content, wrap_ids)
        edits.append((call.start_byte, call.end_byte, rendered))

    return edits


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


def _collect_returns_for_wrap(content: bytes, body: Node) -> list[Node]:
    """Collect top-level return expression nodes to wrap with __llvm_fuzz_record."""
    result: list[Node] = []
    for _pi, captures in RETURN_EXPR_QUERY.matches(body):
        ret_node = first_capture(captures, "ret")
        expr_node = first_capture(captures, "expr")
        if ret_node is None or expr_node is None:
            continue
        if is_inside_nested_scope(ret_node, body):
            continue
        expr_text = content[expr_node.start_byte:expr_node.end_byte]
        if b"__llvm_fuzz_record" in expr_text or expr_text == b"nullptr":
            continue
        result.append(expr_node)
    return result


def _patch_file_generic(
    file_path: Path,
    instrumented_names: set[bytes],
    *,
    allow_star_in_prefix: bool,
    is_inst_combining_cpp: bool,
) -> None:
    print(f"Patching {file_path}...")
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
        is_pointer = _is_pointer_return(prefix_text, declarator, allow_star_in_prefix=allow_star_in_prefix)

        # Call wraps apply in every body (so calls from utility/void/bool functions
        # still get attributed). Return wraps only in pointer-return functions.
        wrap_ids = _collect_wrap_call_ids(body, content, instrumented_names)
        return_exprs = _collect_returns_for_wrap(content, body) if is_pointer else []

        if wrap_ids or return_exprs:
            body_edits = _body_edits(content, body, wrap_ids, return_exprs)
            if body_edits:
                edits.extend(body_edits)
                changed = True

        # Special-case InstCombinerImpl::run (only in InstructionCombining.cpp).
        if (
            is_inst_combining_cpp
            and get_function_name(func_node) == b"run"
            and b"InstCombinerImpl" in declarator.text
        ):
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


def patch_inst_combine_file(file_path: Path, instrumented_names: set[bytes]) -> None:
    _patch_file_generic(
        file_path,
        instrumented_names,
        allow_star_in_prefix=False,
        is_inst_combining_cpp=file_path.name == "InstructionCombining.cpp",
    )


def patch_instruction_simplify_file(file_path: Path, instrumented_names: set[bytes]) -> None:
    _patch_file_generic(
        file_path,
        instrumented_names,
        allow_star_in_prefix=True,
        is_inst_combining_cpp=False,
    )


def update_core_cmake(file_path: Path) -> None:
    print(f"Updating {file_path}...")
    content = file_path.read_text()
    if "fuzz_runtime.cpp" in content:
        return
    new_content, count = re.subn(
        r"(add_llvm(?:_component)?_library\(LLVMCore\s*\n)",
        r"\1  fuzz_runtime.cpp\n",
        content,
        count=1,
    )
    if count != 1:
        raise RuntimeError(f"Could not find LLVMCore library declaration in {file_path}")
    file_path.write_text(new_content)


def update_mc_cmake_for_vcsrevision(llvm_repo: Path) -> None:
    mc_cmake = llvm_repo / "llvm/lib/MC/CMakeLists.txt"
    dxcontainer_info = llvm_repo / "llvm/lib/MC/DXContainerInfo.cpp"
    if not mc_cmake.is_file() or not dxcontainer_info.is_file():
        return

    dx_content = dxcontainer_info.read_text()
    if '#include "llvm/Support/VCSRevision.h"' not in dx_content:
        return

    print(f"Updating {mc_cmake} for llvm_vcsrevision_h...")
    content = mc_cmake.read_text()
    if "llvm_vcsrevision_h" in content:
        return

    depends_anchor = "  DEPENDS\n  intrinsics_gen\n"
    if depends_anchor not in content:
        raise RuntimeError(f"Could not find LLVMMC DEPENDS block in {mc_cmake}")

    new_content = content.replace(
        depends_anchor,
        depends_anchor + "  llvm_vcsrevision_h\n",
        1,
    )
    mc_cmake.write_text(new_content)


def _collect_instrumented_names(llvm_repo: Path) -> set[bytes]:
    """First pass: scan all patched files and return the set of bare names of
    functions matching `_is_pointer_return`. These become the call-site
    allowlist (alongside the ^Create[A-Z] regex)."""
    names: set[bytes] = set()
    targets: list[tuple[Path, bool]] = []

    inst_combine_dir = llvm_repo / "llvm/lib/Transforms/InstCombine"
    if inst_combine_dir.is_dir():
        for entry in sorted(inst_combine_dir.iterdir()):
            if entry.suffix in (".cpp", ".h") and entry.is_file():
                targets.append((entry, False))

    inst_simplify = llvm_repo / "llvm/lib/Analysis/InstructionSimplify.cpp"
    if inst_simplify.is_file():
        targets.append((inst_simplify, True))

    for file_path, allow_star in targets:
        content = file_path.read_bytes()
        root = parse_bytes(content)
        processed: set[int] = set()
        for _pi, captures in FUNC_QUERY.matches(root):
            func_node = first_capture(captures, "func")
            if func_node is None:
                continue
            body = func_node.child_by_field_name("body")
            if body is None or body.id in processed:
                continue
            processed.add(body.id)
            declarator = func_node.child_by_field_name("declarator")
            if declarator is None:
                continue
            prefix_text = content[func_node.start_byte:declarator.start_byte]
            if _is_pointer_return(prefix_text, declarator, allow_star_in_prefix=allow_star):
                name = get_function_name(func_node)
                if name:
                    names.add(name)
    return names


def patch_llvm(llvm_repo: Path) -> None:
    llvm_version_major = detect_llvm_major_version(llvm_repo)
    print(f"Detected LLVM_VERSION_MAJOR={llvm_version_major}.")

    create_fuzz_runtime(llvm_repo)
    patch_signals_header_for_older_llvm(llvm_repo, llvm_version_major)

    print("Collecting instrumented function names (first pass)...")
    instrumented_names = _collect_instrumented_names(llvm_repo)
    print(f"  Found {len(instrumented_names)} instrumented function names.")

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
            patch_inst_combine_file(file_path, instrumented_names)
        elif kind == "INST_SIMPLIFY":
            patch_instruction_simplify_file(file_path, instrumented_names)
        else:
            raise RuntimeError(f"Unknown task type: {kind}")

    update_core_cmake(llvm_repo / "llvm/lib/IR/CMakeLists.txt")
    update_mc_cmake_for_vcsrevision(llvm_repo)

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
