import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "./components/Editor";
import { TracePanel } from "./components/TracePanel";

const DEFAULT_IR = `; paste LLVM IR here, then press Run.
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
}
`;

type RunState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "running" }
  | { kind: "done"; bytes: number }
  | { kind: "error"; message: string };

export function App() {
  const [ir, setIr] = useState(DEFAULT_IR);
  const [trace, setTrace] = useState("");
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [wordWrap, setWordWrap] = useState(true);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL("./worker/instcombine.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready") setState({ kind: "idle" });
      else if (msg.type === "done") {
        setTrace(msg.trace);
        setState({ kind: "done", bytes: msg.trace.length });
      } else if (msg.type === "error") {
        setState({ kind: "error", message: msg.message });
      }
    };
    workerRef.current = worker;
    setState({ kind: "loading" });
    return () => worker.terminate();
  }, []);

  const onRun = useCallback(() => {
    if (!workerRef.current) return;
    setState({ kind: "running" });
    setTrace("");
    workerRef.current.postMessage({ type: "run", ir });
  }, [ir]);

  const statusText = (() => {
    switch (state.kind) {
      case "idle": return "ready";
      case "loading": return "loading wasm…";
      case "running": return "running InstCombine…";
      case "done": return `trace ${state.bytes.toLocaleString()} bytes`;
      case "error": return `error: ${state.message}`;
    }
  })();

  return (
    <div className="app">
      <header className="toolbar">
        <h1>InstCombine fold debugger</h1>
        <button
          onClick={onRun}
          disabled={state.kind === "loading" || state.kind === "running"}
        >
          Run
        </button>
        <span className="status">{statusText}</span>
      </header>
      <main className="panes">
        <section className="pane">
          <div className="pane-header">LLVM IR</div>
          <div className="pane-body">
            <Editor value={ir} onChange={setIr} />
          </div>
        </section>
        <section className="pane">
          <div className="pane-header">
            <span>llvm_fuzz_info.txt</span>
            <button
              type="button"
              className="pane-header-button"
              onClick={() => setWordWrap((w) => !w)}
              title="Toggle word wrap"
            >
              {wordWrap ? "wrap: on" : "wrap: off"}
            </button>
          </div>
          <div className="pane-body">
            <TracePanel trace={trace} wordWrap={wordWrap} />
          </div>
        </section>
      </main>
    </div>
  );
}
