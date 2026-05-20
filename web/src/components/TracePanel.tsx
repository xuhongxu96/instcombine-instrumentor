import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useCallback } from "react";

interface TracePanelProps {
  trace: string;
}

const PLACEHOLDER = "— click Run to capture a trace —";

const TRACE_LANG_ID = "instcombine-trace";

// Register a Monarch tokenizer + theme rules for the InstCombine trace output.
// Idempotent: safe to call on every mount.
function registerTraceLang(monaco: typeof import("monaco-editor")) {
  if (monaco.languages.getLanguages().some((l) => l.id === TRACE_LANG_ID)) return;

  monaco.languages.register({ id: TRACE_LANG_ID });

  monaco.languages.setMonarchTokensProvider(TRACE_LANG_ID, {
    defaultToken: "",
    tokenizer: {
      root: [
        // === SESSION START ===, === ITERATION START ===, === ITERATION END ===
        [/===\s*(SESSION|ITERATION)\s+(START|END)\s*===/, "trace-marker"],

        // Section headers, terminated by ":"
        [/^(NEW INSTRUCTIONS IN THIS ITERATION|REPLACEMENTS IN THIS ITERATION):/, "trace-section"],

        // (stacktrace disabled ...) — wasm-only sentinel
        [/\(stacktrace disabled[^)]*\)/, "comment"],

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

  monaco.editor.defineTheme("instcombine-trace-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "trace-marker", foreground: "C586C0", fontStyle: "bold" },
      { token: "trace-section", foreground: "569CD6", fontStyle: "bold" },
      { token: "trace-arrow", foreground: "D7BA7D", fontStyle: "bold" },
      { token: "trace-frame", foreground: "B5CEA8" },
      { token: "trace-srcloc", foreground: "9CDCFE" },
      { token: "number.hex", foreground: "B5CEA8" },
      { token: "keyword", foreground: "569CD6" },
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
    ],
    colors: {},
  });
}

export function TracePanel({ trace }: TracePanelProps) {
  const handleMount = useCallback<OnMount>((editor, monaco) => {
    registerTraceLang(monaco);
    monaco.editor.setModelLanguage(editor.getModel()!, TRACE_LANG_ID);
    editor.updateOptions({ theme: "instcombine-trace-dark" });
    editor.revealLine(1);
  }, []);

  return (
    <MonacoEditor
      value={trace || PLACEHOLDER}
      defaultLanguage={TRACE_LANG_ID}
      onMount={handleMount}
      theme="instcombine-trace-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        wrappingStrategy: "advanced",
        renderWhitespace: "none",
        contextmenu: false,
      }}
    />
  );
}
