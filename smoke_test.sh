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

echo "Smoke test passed; trace size: $(wc -c < "$TRACE_FILE") bytes"
head -50 "$TRACE_FILE"
