#!/usr/bin/env bash
set -euo pipefail

OPT_BIN=${OPT_BIN:-build/llvm-rel/bin/opt}
TRACE_FILE=${TRACE_FILE:-llvm_fuzz_info.txt}
TRACE_JSON=${TRACE_JSON:-llvm_fuzz_info.json}
SMOKE_IR=${SMOKE_IR:-$(mktemp)}

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

rm -f "$TRACE_FILE" "$TRACE_JSON"
"$OPT_BIN" -passes=instcombine "$SMOKE_IR" -S -o /dev/null

if [ ! -s "$TRACE_FILE" ]; then
    echo "FAIL: $TRACE_FILE missing or empty"
    ls -la "$TRACE_FILE" || true
    exit 1
fi
if ! grep -q "SESSION START" "$TRACE_FILE"; then
    echo "FAIL: no SESSION marker in trace"
    cat "$TRACE_FILE"
    exit 1
fi
if ! grep -qE "ITERATION|NEW INSTRUCTIONS|REPLACEMENTS" "$TRACE_FILE"; then
    echo "FAIL: no trace records (instrumentation produced an empty session)"
    cat "$TRACE_FILE"
    exit 1
fi
# The patcher-maintained call path always carries the visit* dispatch frame
# (e.g. InstCombinerImpl::visitAdd) for the trivial `add %x, 0` smoke input.
if ! grep -q "visitAdd" "$TRACE_FILE"; then
    echo "FAIL: instrumentation trace has no visitAdd frame"
    cat "$TRACE_FILE"
    exit 1
fi
# ConstantFolding instrumentation must record the folded constant for @trigger.
if ! grep -q "ConstantFoldBinaryOpOperands" "$TRACE_FILE"; then
    echo "FAIL: instrumentation trace has no ConstantFoldBinaryOpOperands record"
    cat "$TRACE_FILE"
    exit 1
fi

# Call-site assertion: with call-site instrumentation, the visitAdd frame's
# line should be a call site *inside* visitAdd's body (where it dispatches to
# a callee), not visitAdd's own signature line. Skip if we can't locate the
# patched source file (e.g. running against a prebuilt opt binary).
VISITADD_SOURCE=${VISITADD_SOURCE:-thirdparty/llvm-project/llvm/lib/Transforms/InstCombine/InstCombineAddSub.cpp}
if [ -f "$VISITADD_SOURCE" ]; then
    VISITADD_SIG_LINE=$(grep -n 'Instruction \*InstCombinerImpl::visitAdd' "$VISITADD_SOURCE" | head -1 | cut -d: -f1)
    VISITADD_TRACE_LINE=$(grep -oE 'visitAdd\([^)]*\)[^[:space:]]* at [^ ]+\.cpp:[0-9]+' "$TRACE_FILE" | head -1 | awk -F: '{print $NF}')

    if [ -n "$VISITADD_SIG_LINE" ] && [ -n "$VISITADD_TRACE_LINE" ]; then
        if [ "$VISITADD_TRACE_LINE" = "$VISITADD_SIG_LINE" ]; then
            echo "FAIL: visitAdd frame line ($VISITADD_TRACE_LINE) equals signature line ($VISITADD_SIG_LINE) — call-site instrumentation didn't take effect"
            cat "$TRACE_FILE"
            exit 1
        fi
        echo "Call-site assertion OK: visitAdd frame line $VISITADD_TRACE_LINE != signature line $VISITADD_SIG_LINE"
    else
        echo "WARN: could not extract visitAdd lines for call-site assertion (sig=$VISITADD_SIG_LINE trace=$VISITADD_TRACE_LINE) — skipping"
    fi
fi

# JSONL must preserve event snapshots and source context, while leaving
# opcode/rule derivation and stack formatting to the web consumer.
if [ ! -s "$TRACE_JSON" ]; then
    echo "FAIL: $TRACE_JSON missing or empty"
    exit 1
fi
python3 - "$TRACE_JSON" <<'PY' || exit 1
import json, sys
path = sys.argv[1]
n_iter = 0
n_values = 0
n_replacements = 0
saw_parent_fn = False
saw_visit_add = False
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
print(f"JSONL OK: {n_iter} iteration(s), {n_values} values, {n_replacements} replacements; retained context, no derived fields")
PY

echo "Smoke test passed; trace size: $(wc -c < "$TRACE_FILE") bytes"
head -50 "$TRACE_FILE"
