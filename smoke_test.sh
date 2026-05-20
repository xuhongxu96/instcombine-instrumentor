#!/usr/bin/env bash
set -euo pipefail

OPT_BIN=${OPT_BIN:-build/llvm-rel/bin/opt}
TRACE_FILE=${TRACE_FILE:-llvm_fuzz_info.txt}
SMOKE_IR=${SMOKE_IR:-$(mktemp --suffix=.ll)}

cat > "$SMOKE_IR" <<'EOF'
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
}
EOF

rm -f "$TRACE_FILE"
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

echo "Smoke test passed; trace size: $(wc -c < "$TRACE_FILE") bytes"
head -50 "$TRACE_FILE"
