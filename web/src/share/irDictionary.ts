// Static dictionary for IR-aware preprocessing in irCompress.ts.
// Each entry is mapped to a single byte in the range 0x80..0xFE by its array
// index plus 0x80. The cap is 127 — see DICT_MAX_ENTRIES below. 0xFF is
// reserved as a future escape for an extended (>127) dictionary.
//
// `wordBoundary: true` entries only substitute when surrounded by non-word
// chars (so `add` is not collapsed inside `%add_result` or `addrspacecast`).
// `wordBoundary: false` entries are self-delimiting and substitute anywhere.
//
// The wire format is versioned: any reorder/removal of entries below MUST
// bump the version byte in irCompress.ts. Appending new entries at the end is
// backward-safe.

export interface DictEntry {
  readonly token: string;
  readonly wordBoundary: boolean;
}

export const DICT_MAX_ENTRIES = 127;

export const DICTIONARY: ReadonlyArray<DictEntry> = [
  // --- Hot self-delimiting multi-char fragments ---
  { token: ", align ", wordBoundary: false },
  { token: ", ptr ", wordBoundary: false },
  { token: ", i32 ", wordBoundary: false },
  { token: ", i64 ", wordBoundary: false },
  { token: ", i8 ", wordBoundary: false },
  { token: ", i1 ", wordBoundary: false },
  { token: ", i16 ", wordBoundary: false },
  { token: " noundef ", wordBoundary: false },
  { token: " inbounds ", wordBoundary: false },
  { token: " nsw ", wordBoundary: false },
  { token: " nuw ", wordBoundary: false },
  { token: " = ", wordBoundary: false },
  { token: ", ", wordBoundary: false },
  { token: "  ", wordBoundary: false },
  { token: "ret void", wordBoundary: false },
  { token: "ret i32 ", wordBoundary: false },
  { token: "ret i64 ", wordBoundary: false },
  { token: "ret ptr ", wordBoundary: false },
  { token: "define dso_local ", wordBoundary: false },
  { token: "define internal ", wordBoundary: false },
  { token: "declare ", wordBoundary: false },
  { token: "!dbg ", wordBoundary: false },
  { token: "!tbaa ", wordBoundary: false },
  { token: "!srcloc ", wordBoundary: false },
  { token: "tail call ", wordBoundary: false },
  { token: " = alloca ", wordBoundary: false },
  { token: " = load ", wordBoundary: false },
  { token: " = call ", wordBoundary: false },
  { token: " = getelementptr ", wordBoundary: false },
  { token: " = icmp ", wordBoundary: false },
  { token: ".addr", wordBoundary: false },
  { token: "; preds = ", wordBoundary: false },
  { token: "br label ", wordBoundary: false },
  { token: "br i1 ", wordBoundary: false },
  { token: "  store ", wordBoundary: false },
  { token: "  ret ", wordBoundary: false },
  { token: "  br ", wordBoundary: false },
  { token: "  call ", wordBoundary: false },
  { token: "  %", wordBoundary: false },

  // --- Type tokens ---
  { token: "i32", wordBoundary: true },
  { token: "i64", wordBoundary: true },
  { token: "i1", wordBoundary: true },
  { token: "i8", wordBoundary: true },
  { token: "i16", wordBoundary: true },
  { token: "ptr", wordBoundary: true },
  { token: "void", wordBoundary: true },
  { token: "float", wordBoundary: true },
  { token: "double", wordBoundary: true },
  { token: "label", wordBoundary: true },
  { token: "half", wordBoundary: true },
  { token: "bfloat", wordBoundary: true },
  { token: "i128", wordBoundary: true },
  { token: "metadata", wordBoundary: true },

  // --- Opcodes ---
  { token: "define", wordBoundary: true },
  { token: "declare", wordBoundary: true },
  { token: "call", wordBoundary: true },
  { token: "load", wordBoundary: true },
  { token: "store", wordBoundary: true },
  { token: "alloca", wordBoundary: true },
  { token: "getelementptr", wordBoundary: true },
  { token: "bitcast", wordBoundary: true },
  { token: "trunc", wordBoundary: true },
  { token: "zext", wordBoundary: true },
  { token: "sext", wordBoundary: true },
  { token: "icmp", wordBoundary: true },
  { token: "fcmp", wordBoundary: true },
  { token: "add", wordBoundary: true },
  { token: "sub", wordBoundary: true },
  { token: "mul", wordBoundary: true },
  { token: "sdiv", wordBoundary: true },
  { token: "udiv", wordBoundary: true },
  { token: "srem", wordBoundary: true },
  { token: "urem", wordBoundary: true },
  { token: "shl", wordBoundary: true },
  { token: "lshr", wordBoundary: true },
  { token: "ashr", wordBoundary: true },
  { token: "and", wordBoundary: true },
  { token: "or", wordBoundary: true },
  { token: "xor", wordBoundary: true },
  { token: "select", wordBoundary: true },
  { token: "phi", wordBoundary: true },
  { token: "br", wordBoundary: true },
  { token: "ret", wordBoundary: true },
  { token: "switch", wordBoundary: true },
  { token: "invoke", wordBoundary: true },
  { token: "unreachable", wordBoundary: true },
  { token: "fadd", wordBoundary: true },
  { token: "fsub", wordBoundary: true },
  { token: "fmul", wordBoundary: true },
  { token: "fdiv", wordBoundary: true },
  { token: "extractvalue", wordBoundary: true },
  { token: "insertvalue", wordBoundary: true },

  // --- Predicates / attributes / linkage ---
  { token: "eq", wordBoundary: true },
  { token: "ne", wordBoundary: true },
  { token: "ult", wordBoundary: true },
  { token: "ule", wordBoundary: true },
  { token: "ugt", wordBoundary: true },
  { token: "uge", wordBoundary: true },
  { token: "slt", wordBoundary: true },
  { token: "sle", wordBoundary: true },
  { token: "sgt", wordBoundary: true },
  { token: "sge", wordBoundary: true },
  { token: "nsw", wordBoundary: true },
  { token: "nuw", wordBoundary: true },
  { token: "exact", wordBoundary: true },
  { token: "inbounds", wordBoundary: true },
  { token: "align", wordBoundary: true },
  { token: "noundef", wordBoundary: true },
  { token: "nounwind", wordBoundary: true },
  { token: "readonly", wordBoundary: true },
  { token: "readnone", wordBoundary: true },
  { token: "nonnull", wordBoundary: true },
  { token: "signext", wordBoundary: true },
  { token: "zeroext", wordBoundary: true },
  { token: "dso_local", wordBoundary: true },
  { token: "internal", wordBoundary: true },
  { token: "external", wordBoundary: true },
  { token: "private", wordBoundary: true },
  { token: "linkonce_odr", wordBoundary: true },
  { token: "constant", wordBoundary: true },
  { token: "global", wordBoundary: true },
  { token: "attributes", wordBoundary: true },
  { token: "target", wordBoundary: true },
  { token: "datalayout", wordBoundary: true },
  { token: "triple", wordBoundary: true },
  { token: "source_filename", wordBoundary: true },
];

if (DICTIONARY.length > DICT_MAX_ENTRIES) {
  throw new Error(
    `IR dictionary has ${DICTIONARY.length} entries, exceeds cap of ${DICT_MAX_ENTRIES}`,
  );
}
