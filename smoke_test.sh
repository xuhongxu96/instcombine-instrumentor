#!/usr/bin/env bash
set -euo pipefail

OPT_BIN=${OPT_BIN:-build/llvm-rel/bin/opt}
SYMBOLIZER_BIN=${SYMBOLIZER_BIN:-$(dirname "$OPT_BIN")/llvm-symbolizer}
TRACE_FILE=${TRACE_FILE:-llvm_fuzz_info.txt}
SMOKE_IR=${SMOKE_IR:-$(mktemp --suffix=.ll)}

# Picked up by LLVM's PrettyStackTrace / signal-handler symbolization,
# and by the instrumentation when it dumps stack frames into TRACE_FILE.
export LLVM_SYMBOLIZER_PATH="$SYMBOLIZER_BIN"

if [ ! -x "$SYMBOLIZER_BIN" ]; then
    echo "FAIL: $SYMBOLIZER_BIN not found or not executable"
    exit 1
fi
"$SYMBOLIZER_BIN" --version

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
# Symbolized frames carry demangled "llvm::InstVisitor" names; an unsymbolized
# trace shows raw 0x... addresses or mangled _ZN4llvm... symbols, neither
# of which contains the literal "llvm::InstVisitor".
if ! grep -q "llvm::InstVisitor" "$TRACE_FILE"; then
    echo "FAIL: instrumentation trace has no symbolized llvm::InstVisitor frames"
    echo "(LLVM_SYMBOLIZER_PATH=$LLVM_SYMBOLIZER_PATH was not honored, or symbolizer is broken)"
    cat "$TRACE_FILE"
    exit 1
fi

echo "Smoke test passed; trace size: $(wc -c < "$TRACE_FILE") bytes"
head -50 "$TRACE_FILE"
