// Printed instruction names from LLVM's Instruction::getOpcodeName. Keep this
// separate from the share-link compression dictionary: that list is incomplete
// for opcode parsing, and its order is part of the share-link wire format.
const OPCODES = new Set([
  // Terminators.
  "ret", "br", "switch", "indirectbr", "invoke", "resume", "unreachable",
  "cleanupret", "catchret", "catchswitch", "callbr",
  // Arithmetic and logical operations.
  "fneg", "add", "fadd", "sub", "fsub", "mul", "fmul", "udiv", "sdiv",
  "fdiv", "urem", "srem", "frem", "shl", "lshr", "ashr", "and", "or", "xor",
  // Memory operations.
  "alloca", "load", "store", "getelementptr", "fence", "cmpxchg", "atomicrmw",
  // Casts (including ptrtoaddr in newer LLVM builds).
  "trunc", "zext", "sext", "fptrunc", "fpext", "fptoui", "fptosi",
  "uitofp", "sitofp", "ptrtoint", "ptrtoaddr", "inttoptr", "bitcast", "addrspacecast",
  // Comparisons, calls, aggregates, vectors, and exception handling.
  "icmp", "fcmp", "phi", "select", "call", "va_arg", "extractelement",
  "insertelement", "shufflevector", "extractvalue", "insertvalue", "landingpad",
  "catchpad", "cleanuppad", "freeze",
]);

// Match an assignment only at the start. LLVM names can be quoted, with hex
// escapes and embedded '=' characters. Detached unnamed instructions use
// <badref> instead of a %name or %number.
const ASSIGNMENT = /^(?:%(?:[-a-zA-Z$._0-9]+|"(?:[^"\\\r\n]|\\[0-9a-fA-F]{2})*")|<badref>)[ \t]*=[ \t]*/;
const TAIL_PREFIX = /^(?:tail|musttail|notail)[ \t]+/;
const OPCODE_TOKEN = /^([a-z][a-z0-9_]*)(?=\s|,|$)/;

// Read an instruction header from a Value::print snapshot, not an entire IR
// module. Typed constants and arguments have no instruction opcode. Unknown
// headers return ""; this is a header recognizer, not a full LLVM IR validator.
export function deriveOpcode(ir: string): string {
  let text = ir.trimStart().replace(ASSIGNMENT, "");
  const tail = TAIL_PREFIX.exec(text);
  if (tail) text = text.slice(tail[0].length);

  const token = OPCODE_TOKEN.exec(text);
  if (!token) return "";

  const opcode = token[1];
  if (!OPCODES.has(opcode)) return "";
  if (tail && opcode !== "call") return "";

  // Every supported instruction except unreachable needs operands. Avoid
  // treating a bare opcode or a following metadata attachment as complete.
  const operands = text.slice(token[0].length).replace(/^[ \t]+/, "");
  if (opcode !== "unreachable" && (!operands || /^[\r\n,;]/.test(operands))) return "";

  return opcode;
}
