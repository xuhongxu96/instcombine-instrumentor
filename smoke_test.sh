#!/usr/bin/env bash
set -euo pipefail

OPT_BIN=${OPT_BIN:-build/llvm-rel/bin/opt}
TRACE_JSON=${TRACE_JSON:-llvm_fuzz_info.json}
SMOKE_IR=${SMOKE_IR:-$(mktemp)}
VISITADD_SOURCE=${VISITADD_SOURCE:-thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp}

cat > "$SMOKE_IR" <<'EOF'
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
}

define float @trigger(float %x) {
entry:
  %mul = fmul float %x, 2.000000e+00
  %add = fadd reassoc nsz float %mul, %x
  ret float %add
}
EOF

rm -f llvm_fuzz_info.txt "$TRACE_JSON"
"$OPT_BIN" -passes=instcombine "$SMOKE_IR" -S -o /dev/null

if [ -e llvm_fuzz_info.txt ]; then
    echo "FAIL: runtime still emits llvm_fuzz_info.txt instead of JSONL only"
    exit 1
fi

# JSONL must preserve event snapshots and source context, while leaving
# opcode/rule derivation and stack formatting to the web consumer.
if [ ! -s "$TRACE_JSON" ]; then
    echo "FAIL: $TRACE_JSON missing or empty"
    exit 1
fi
# Preserve the upstream ConstantFolding regression check using canonical JSONL.
if ! grep -q "ConstantFoldBinaryOpOperands" "$TRACE_JSON"; then
    echo "FAIL: instrumentation trace has no ConstantFoldBinaryOpOperands record"
    cat "$TRACE_JSON"
    exit 1
fi
python3 - "$TRACE_JSON" "$VISITADD_SOURCE" <<'PY' || exit 1
import json, pathlib, re, sys
path = sys.argv[1]
n_iter = 0
n_values = 0
n_replacements = 0
saw_parent_fn = False
saw_visit_add = False
visit_add_lines = []
with open(path) as fh:
    for lineno, line in enumerate(fh, 1):
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        assert isinstance(obj, dict), f"line {lineno} not an object"
        for k in ("iteration", "new_values", "replacements"):
            assert k in obj, f"line {lineno} missing key {k!r}"
        assert isinstance(obj["iteration"], int), f"line {lineno} has invalid iteration"
        assert isinstance(obj["new_values"], list), f"line {lineno} has invalid new_values"
        assert isinstance(obj["replacements"], list), f"line {lineno} has invalid replacements"
        for v in obj["new_values"]:
            for k in ("ptr", "ir", "parent_fn", "parent_bb", "debug_loc", "loc", "func_name"):
                assert isinstance(v.get(k), str), f"line {lineno} value missing/invalid {k!r}"
            for k in ("opcode", "rule", "stacktrace"):
                assert k not in v, f"line {lineno} value still emits derived field {k!r}"
            assert isinstance(v.get("frames"), list), f"line {lineno} value missing/invalid frames"
            for frame in v["frames"]:
                assert isinstance(frame.get("name"), str), f"line {lineno} frame has invalid name"
                assert isinstance(frame.get("file"), str), f"line {lineno} frame has invalid file"
                assert isinstance(frame.get("line"), int), f"line {lineno} frame has invalid line"
                if "visitAdd" in frame["name"] and frame["file"].endswith("InstCombineAddSub.cpp"):
                    visit_add_lines.append(frame["line"])
            saw_parent_fn |= bool(v["parent_fn"])
            saw_visit_add |= "visitAdd" in v["func_name"] or any("visitAdd" in f["name"] for f in v["frames"])
            n_values += 1
        for r in obj["replacements"]:
            for k in ("old_ptr", "new_ptr", "old_ir", "new_ir"):
                assert isinstance(r.get(k), str), f"line {lineno} replacement missing/invalid {k!r}"
            for k in ("old_opcode", "new_opcode"):
                assert k not in r, f"line {lineno} replacement still emits derived field {k!r}"
            n_replacements += 1
        n_iter += 1
assert n_iter > 0, "no iterations in JSONL"
assert n_values > 0, "no recorded values in JSONL"
assert n_replacements > 0, "no replacements in JSONL"
assert saw_parent_fn, "no value retained parent function context"
assert saw_visit_add, "no value retained visitAdd source attribution"

# Check actual caller frames, not the producing-site location. Skip only when
# the matching patched source is unavailable (for example, a prebuilt binary).
source = pathlib.Path(sys.argv[2])
sig_line = None
if source.is_file():
    sig_line = next((i for i, line in enumerate(source.read_text().splitlines(), 1)
                     if re.search(r"Instruction\s*\*\s*InstCombiner(?:Impl)?::visitAdd\b", line)), None)
if sig_line is not None:
    assert visit_add_lines, "no visitAdd caller frames in JSONL"
    assert all(line != sig_line for line in visit_add_lines), "visitAdd frame points to signature instead of call site"
    print(f"Call-site assertion OK: visitAdd frames {visit_add_lines}, signature {sig_line}")
else:
    print("WARN: visitAdd source/signature unavailable — skipping call-site assertion")
print(f"JSONL OK: {n_iter} iteration(s), {n_values} values, {n_replacements} replacements; retained context, no derived fields")
PY

echo "Smoke test passed; JSONL size: $(wc -c < "$TRACE_JSON") bytes"
head -3 "$TRACE_JSON"
