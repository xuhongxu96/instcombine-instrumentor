#!/usr/bin/env bash
set -euo pipefail

OPT_BIN=${OPT_BIN:-build/llvm-rel/bin/opt}
TRACE_FILE=${TRACE_FILE:-llvm_fuzz_info.txt}
TRACE_JSON=${TRACE_JSON:-llvm_fuzz_info.json}
SMOKE_IR=${SMOKE_IR:-$(mktemp --suffix=.ll)}

cat > "$SMOKE_IR" <<'EOF'
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
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

# JSONL sidecar must exist, parse as one object per line, and carry the
# enriched fields (opcode/parent_fn/rule) on at least one new value.
if [ ! -s "$TRACE_JSON" ]; then
    echo "FAIL: $TRACE_JSON missing or empty"
    exit 1
fi
python3 - "$TRACE_JSON" <<'PY' || exit 1
import json, sys
path = sys.argv[1]
n_iter = 0
saw_opcode = False
saw_rule = False
with open(path) as fh:
    for lineno, line in enumerate(fh, 1):
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        assert isinstance(obj, dict), f"line {lineno} not an object"
        for k in ("iteration", "new_values", "replacements"):
            assert k in obj, f"line {lineno} missing key {k!r}"
        for v in obj["new_values"]:
            for k in ("ptr", "ir", "opcode", "parent_fn", "rule", "frames"):
                assert k in v, f"line {lineno} value missing key {k!r}"
            if v["opcode"]: saw_opcode = True
            if v["rule"]: saw_rule = True
        n_iter += 1
assert n_iter > 0, "no iterations in JSONL"
assert saw_opcode, "no new value had opcode populated"
assert saw_rule, "no new value had rule populated"
print(f"JSONL sidecar OK: {n_iter} iteration(s); opcode + rule populated")
PY

echo "Smoke test passed; trace size: $(wc -c < "$TRACE_FILE") bytes"
head -50 "$TRACE_FILE"
