import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useState } from "react";

const PLACEHOLDER = "; run InstCombine to see the optimized IR";

interface Props {
  ir: string;
}

export function OutputIrPane({ ir }: Props) {
  const handleMount = useCallback<OnMount>((editor, _monaco) => {
    editor.revealLine(1);
  }, []);

  return (
    <MonacoEditor
      value={ir || PLACEHOLDER}
      defaultLanguage="llvm-ir"
      onMount={handleMount}
      theme="vs-dark"
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderWhitespace: "none",
        contextmenu: false,
      }}
    />
  );
}

interface CopyButtonProps {
  text: string;
  disabled?: boolean;
}

export function CopyButton({ text, disabled }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked in some contexts; ignore silently
    }
  }, [text]);
  return (
    <button
      type="button"
      className="pane-header-button"
      onClick={onClick}
      disabled={disabled || !text}
      title="Copy to clipboard"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
