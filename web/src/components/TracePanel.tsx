import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useCallback } from "react";
import { StructuredTraceView } from "./StructuredTraceView";
import { useColorScheme } from "./useColorScheme";
import type { Iteration } from "../trace/types";

export type TraceViewMode = "text" | "structured";

interface TracePanelProps {
  trace: string;
  wordWrap: boolean;
  viewMode: TraceViewMode;
  iterations: Iteration[];
  llvmRef: string | null;
}

const PLACEHOLDER = "— click Run to capture a trace —";

const TRACE_LANG_ID = "instcombine-trace";
const TRACE_THEME_DARK = "instcombine-trace-dark";
const TRACE_THEME_LIGHT = "instcombine-trace-light";

// Register a Monarch tokenizer + theme rules for the InstCombine trace output.
// Idempotent: safe to call on every mount.
function registerTraceLang(monaco: typeof import("monaco-editor")) {
  if (monaco.languages.getLanguages().some((l) => l.id === TRACE_LANG_ID)) return;

  monaco.languages.register({ id: TRACE_LANG_ID });

  monaco.languages.setMonarchTokensProvider(TRACE_LANG_ID, {
    defaultToken: "",
    tokenizer: {
      root: [
        // === SESSION START ===, === ITERATION N START ===, === ITERATION END ===
        [/===\s*(SESSION|ITERATION)(\s+\d+)?\s+(START|END)\s*===/, "trace-marker"],

        // Section headers, terminated by ":"
        [/^(NEW INSTRUCTIONS IN THIS ITERATION|REPLACEMENTS IN THIS ITERATION):/, "trace-section"],

        // (stacktrace disabled ...) — wasm-only sentinel
        [/\(stacktrace disabled[^)]*\)/, "comment"],

        // [opcode=…] [fn=…] [rule=…] [dbg=…] meta tags
        [/\[(opcode|fn|rule|dbg)=[^\]]*\]/, "trace-meta"],

        // VALUE 0xABCDEF... — leading keyword + pointer
        [/\bVALUE\b/, "keyword"],

        // " at funcName (...)" — the function-name + source-loc capture
        [/\bat\b/, "keyword"],

        // " -> " replacement arrow
        [/->/, "trace-arrow"],

        // #N frame numbers at the start of a stack frame line
        [/(^\s*)(#\d+)/, ["white", "trace-frame"]],

        // File paths like Something.cpp:123 or Something.h:45
        [/[\w./-]+\.(cpp|h|c|hpp|cc|hxx|cxx):\d+(:\d+)?/, "trace-srcloc"],

        // Hex addresses anywhere else
        [/0x[0-9A-Fa-f]+/, "number.hex"],
      ],
    },
  });

  monaco.editor.defineTheme(TRACE_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "trace-marker", foreground: "C586C0", fontStyle: "bold" },
      { token: "trace-section", foreground: "569CD6", fontStyle: "bold" },
      { token: "trace-arrow", foreground: "D7BA7D", fontStyle: "bold" },
      { token: "trace-frame", foreground: "B5CEA8" },
      { token: "trace-srcloc", foreground: "9CDCFE" },
      { token: "trace-meta", foreground: "C586C0" },
      { token: "number.hex", foreground: "B5CEA8" },
      { token: "keyword", foreground: "569CD6" },
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
    ],
    colors: {},
  });

  // Light variant: same hues, darker shades so they read on a white background.
  monaco.editor.defineTheme(TRACE_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "trace-marker", foreground: "AF00DB", fontStyle: "bold" },
      { token: "trace-section", foreground: "0451A5", fontStyle: "bold" },
      { token: "trace-arrow", foreground: "AF5F00", fontStyle: "bold" },
      { token: "trace-frame", foreground: "098658" },
      { token: "trace-srcloc", foreground: "0451A5" },
      { token: "trace-meta", foreground: "AF00DB" },
      { token: "number.hex", foreground: "098658" },
      { token: "keyword", foreground: "0000FF" },
      { token: "comment", foreground: "008000", fontStyle: "italic" },
    ],
    colors: {},
  });
}

export function TracePanel({ trace, wordWrap, viewMode, iterations, llvmRef }: TracePanelProps) {
  const { scheme } = useColorScheme();
  const traceTheme = scheme === "dark" ? TRACE_THEME_DARK : TRACE_THEME_LIGHT;
  const handleMount = useCallback<OnMount>((editor, monaco) => {
    registerTraceLang(monaco);
    monaco.editor.setModelLanguage(editor.getModel()!, TRACE_LANG_ID);
    editor.revealLine(1);
  }, []);

  if (viewMode === "structured") {
    return <StructuredTraceView iterations={iterations} llvmRef={llvmRef} />;
  }

  return (
    <MonacoEditor
      value={trace || PLACEHOLDER}
      defaultLanguage={TRACE_LANG_ID}
      onMount={handleMount}
      theme={traceTheme}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: wordWrap ? "on" : "off",
        wrappingStrategy: "advanced",
        renderWhitespace: "none",
        contextmenu: false,
      }}
    />
  );
}
