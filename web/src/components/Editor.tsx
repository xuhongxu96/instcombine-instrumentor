import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useCallback } from "react";
import { monacoBuiltinTheme, useColorScheme } from "./useColorScheme";

// Minimal Monarch tokenizer for LLVM IR. Covers the visual cues that matter:
// keywords, types, %/@ identifiers, numbers, strings, and ;-comments.
function registerLlvmIr(monaco: typeof import("monaco-editor")) {
  if (monaco.languages.getLanguages().some((l) => l.id === "llvm-ir")) return;

  monaco.languages.register({ id: "llvm-ir" });
  monaco.languages.setMonarchTokensProvider("llvm-ir", {
    defaultToken: "",
    ignoreCase: false,
    keywords: [
      "define", "declare", "module", "asm", "target", "datalayout",
      "triple", "source_filename", "global", "constant", "private",
      "internal", "external", "linkonce", "weak", "common", "appending",
      "extern_weak", "dso_local", "dso_preemptable", "unnamed_addr",
      "local_unnamed_addr", "thread_local", "alias", "ifunc",
      "true", "false", "null", "undef", "poison", "void", "zeroinitializer",
      "to", "nuw", "nsw", "exact", "fast", "nnan", "ninf", "nsz", "arcp",
      "contract", "reassoc", "afn", "tail", "musttail", "notail",
      "volatile", "atomic", "acquire", "release", "acq_rel", "seq_cst",
      "monotonic", "syncscope", "inbounds", "align", "nonnull", "noalias",
      "nocapture", "readnone", "readonly", "writeonly", "speculatable",
      "willreturn", "mustprogress", "uwtable", "nofree", "norecurse",
      "noinline", "alwaysinline", "argmemonly", "inaccessiblememonly",
      "inaccessiblemem_or_argmemonly", "ssp", "sspstrong", "sspreq",
      "strictfp", "sanitize_address", "sanitize_thread", "sanitize_memory",
      "noredzone", "noimplicitfloat", "naked", "inlinehint", "cold",
      "hot", "optnone", "optsize", "minsize", "nounwind", "uwtable",
      "personality", "section", "comdat", "attributes", "metadata",
      "distinct", "ret", "br", "switch", "indirectbr", "invoke", "resume",
      "unreachable", "catchswitch", "catchret", "cleanupret", "callbr",
      "fneg", "add", "fadd", "sub", "fsub", "mul", "fmul", "udiv", "sdiv",
      "fdiv", "urem", "srem", "frem", "shl", "lshr", "ashr", "and", "or",
      "xor", "extractelement", "insertelement", "shufflevector",
      "extractvalue", "insertvalue", "alloca", "load", "store", "fence",
      "cmpxchg", "atomicrmw", "getelementptr", "trunc", "zext", "sext",
      "fptrunc", "fpext", "fptoui", "fptosi", "uitofp", "sitofp",
      "ptrtoint", "inttoptr", "bitcast", "addrspacecast", "icmp", "fcmp",
      "phi", "select", "call", "freeze",
      "eq", "ne", "ugt", "uge", "ult", "ule", "sgt", "sge", "slt", "sle",
      "oeq", "ogt", "oge", "olt", "ole", "one", "ord", "ueq", "une", "uno",
    ],
    typeKeywords: ["i1", "i8", "i16", "i32", "i64", "i128", "half", "bfloat",
      "float", "double", "fp128", "x86_fp80", "ppc_fp128", "ptr", "label",
      "token", "x86_mmx", "x86_amx"],
    tokenizer: {
      root: [
        [/;.*$/, "comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/[%@][-a-zA-Z$._][\w$.]*/, "variable"],
        [/[%@]\d+/, "variable"],
        [/![a-zA-Z_][\w]*/, "tag"],
        [/![-]?\d+/, "tag"],
        [/\b(i\d+|half|bfloat|float|double|fp128|x86_fp80|ppc_fp128|ptr|label|token|x86_mmx|x86_amx|void)\b/, "type"],
        [/\b[a-zA-Z_]\w*\b/, {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier",
          },
        }],
        [/0x[0-9A-Fa-f]+/, "number.hex"],
        [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, "number"],
        [/[{}()[\]<>,*=]/, "delimiter"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });
}

export interface EditorProps {
  value: string;
  onChange: (v: string) => void;
}

export function Editor({ value, onChange }: EditorProps) {
  const { scheme } = useColorScheme();
  const handleMount = useCallback<OnMount>((_editor, monaco) => {
    registerLlvmIr(monaco);
  }, []);

  return (
    <MonacoEditor
      value={value}
      onChange={(v) => onChange(v ?? "")}
      defaultLanguage="llvm-ir"
      onMount={handleMount}
      theme={monacoBuiltinTheme(scheme)}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderWhitespace: "selection",
      }}
    />
  );
}
