import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { CopyButton, OutputIrPane } from "./components/OutputIrPane";
import { TracePanel, type TraceViewMode } from "./components/TracePanel";
import { useColorScheme, type ColorSchemePref } from "./components/useColorScheme";
import { parseTraceJsonl } from "./trace/parse";
import { llvmRefFromManifestTag } from "./trace/githubLink";
import {
  releaseToSource,
  type WasmManifest,
  type WasmRelease,
} from "./wasm/manifest";

const DEFAULT_IR = `; paste LLVM IR here, then press Run.
define i32 @f(i32 %x) {
  %a = add i32 %x, 0
  ret i32 %a
}
`;

const STORAGE_KEY = "wasmVersion";

type WasmState =
  | { kind: "loadingManifest" }
  | { kind: "manifestError"; message: string }
  | { kind: "noVersions" }
  | { kind: "loadingVersion"; tag: string }
  | { kind: "ready"; tag: string }
  | { kind: "running"; tag: string }
  | { kind: "loadError"; tag: string; message: string }
  | { kind: "runError"; tag: string; message: string }
  | { kind: "done"; tag: string; bytes: number };

function getBaseUrl(): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : base + "/";
}

function getRemoteManifestUrl(): string | null {
  const url = (import.meta as ImportMeta & { env?: { VITE_REMOTE_MANIFEST_URL?: string } })
    .env?.VITE_REMOTE_MANIFEST_URL;
  return url && url.length > 0 ? url : null;
}

async function fetchManifest(url: string): Promise<WasmManifest> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as WasmManifest;
}

// Fallback manifest used when `wasm/manifest.json` is missing (typically `npm run dev`
// before the manifest builder has run). Points at whatever `build_wasm.sh` last copied
// into `web/public/wasm/`.
function fallbackManifest(): WasmManifest {
  const now = new Date().toISOString();
  const entry: WasmRelease = {
    tag: "(local build)",
    name: "(local build)",
    slug: "_local",
    kind: "tag",
    publishedAt: now,
    prerelease: false,
    bundled: true,
    jsAsset: "instcombine_driver.js",
    wasmAsset: "instcombine_driver.wasm",
  };
  return { generatedAt: now, defaultTag: entry.tag, releases: [entry] };
}

function pickInitialTag(manifest: WasmManifest): string | null {
  if (manifest.releases.length === 0) return null;
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (stored && manifest.releases.some((r) => r.tag === stored)) return stored;
  if (manifest.defaultTag && manifest.releases.some((r) => r.tag === manifest.defaultTag)) {
    return manifest.defaultTag;
  }
  return manifest.releases[0].tag;
}

function formatLabel(r: WasmRelease): string {
  const base = r.name || r.tag;
  const pre = r.prerelease ? " · pre-release" : "";
  return `${base}${pre}`;
}

export function App() {
  const [ir, setIr] = useState(DEFAULT_IR);
  const [trace, setTrace] = useState("");
  const [traceJson, setTraceJson] = useState("");
  const [outputIr, setOutputIr] = useState("");
  const [runError, setRunError] = useState("");
  const [viewMode, setViewMode] = useState<TraceViewMode>("structured");
  const [manifest, setManifest] = useState<WasmManifest | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [state, setState] = useState<WasmState>({ kind: "loadingManifest" });
  const [wordWrap, setWordWrap] = useState(true);
  const { pref: colorPref, setPref: setColorPref } = useColorScheme();
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const pendingLoadRef = useRef<string | null>(null);
  const lastLoadRequestRef = useRef<string | null>(null);

  const iterations = useMemo(() => parseTraceJsonl(traceJson), [traceJson]);
  const llvmRef = useMemo(() => llvmRefFromManifestTag(selectedTag), [selectedTag]);

  const releaseByTag = useMemo(() => {
    const map = new Map<string, WasmRelease>();
    if (manifest) for (const r of manifest.releases) map.set(r.tag, r);
    return map;
  }, [manifest]);

  const groupedReleases = useMemo(() => {
    const tags: WasmRelease[] = [];
    const commits: WasmRelease[] = [];
    if (manifest) {
      for (const r of manifest.releases) {
        // `kind` is missing on manifests built before the split landed; treat
        // those as tag releases so the picker still renders.
        if (r.kind === "commit") commits.push(r);
        else tags.push(r);
      }
    }
    return { tags, commits };
  }, [manifest]);

  const requestLoad = useCallback((tag: string) => {
    if (lastLoadRequestRef.current === tag) return;
    const worker = workerRef.current;
    const release = releaseByTag.get(tag);
    if (!worker || !release) return;
    if (!workerReadyRef.current) {
      pendingLoadRef.current = tag;
      return;
    }
    const source = releaseToSource(release, getBaseUrl());
    lastLoadRequestRef.current = tag;
    setState({ kind: "loadingVersion", tag });
    worker.postMessage({ type: "loadVersion", id: tag, source });
  }, [releaseByTag]);

  // Fetch the manifest once on mount. Waterfall:
  //   1. The remote `wasm-pkgs/manifest.json` if a URL is baked in via
  //      VITE_REMOTE_MANIFEST_URL — preferred so new published builds appear
  //      without a Pages redeploy.
  //   2. Same-origin `wasm/manifest.json` (the Pages-time builder emits this).
  //   3. fallbackManifest() — single entry pointing at whatever
  //      build_wasm.sh last dropped under public/wasm/.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let manifest: WasmManifest | null = null;
      const remote = getRemoteManifestUrl();
      if (remote) {
        try {
          manifest = await fetchManifest(remote);
        } catch { /* falls through to same-origin manifest */ }
      }
      if (!manifest) {
        try {
          manifest = await fetchManifest(`${getBaseUrl()}wasm/manifest.json`);
        } catch { /* falls through to local fallback */ }
      }
      if (cancelled) return;
      const m = manifest ?? fallbackManifest();
      const initial = pickInitialTag(m);
      setManifest(m);
      if (initial) {
        setSelectedTag(initial);
        setState({ kind: "loadingVersion", tag: initial });
      } else {
        setState({ kind: "noVersions" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Spawn worker once.
  useEffect(() => {
    const worker = new Worker(
      new URL("./worker/instcombine.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready") {
        workerReadyRef.current = true;
        const pending = pendingLoadRef.current;
        if (pending) {
          pendingLoadRef.current = null;
          requestLoad(pending);
        }
        return;
      }
      if (msg.type === "loaded") {
        setState({ kind: "ready", tag: msg.id });
        return;
      }
      if (msg.type === "loadError") {
        lastLoadRequestRef.current = null;
        setState({ kind: "loadError", tag: msg.id, message: msg.message });
        return;
      }
      if (msg.type === "done") {
        const stderr: string = msg.stderr ?? "";
        const exitCode: number = msg.exitCode ?? 0;
        setTrace(msg.trace ?? "");
        setTraceJson(msg.traceJson ?? "");
        setOutputIr(msg.outputIr ?? "");
        // The driver exits non-zero on failure (e.g. IR parse error); surface
        // its stderr (or a synthesized note) so the output pane shows the
        // diagnostic instead of an empty editor.
        if (exitCode !== 0) {
          setRunError(stderr || `instcombine_driver exited with code ${exitCode}`);
          setState((prev) =>
            "tag" in prev
              ? { kind: "runError", tag: prev.tag, message: stderr.split("\n")[0] || `exit ${exitCode}` }
              : prev,
          );
        } else {
          setRunError("");
          setState((prev) =>
            "tag" in prev
              ? { kind: "done", tag: prev.tag, bytes: (msg.trace ?? "").length }
              : prev,
          );
        }
        return;
      }
      if (msg.type === "error") {
        const stderr: string = msg.stderr ?? "";
        const combined = stderr ? `${msg.message}\n\n${stderr}` : msg.message;
        setRunError(combined);
        setState((prev) =>
          "tag" in prev
            ? { kind: "runError", tag: prev.tag, message: msg.message }
            : prev,
        );
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
      workerReadyRef.current = false;
      lastLoadRequestRef.current = null;
    };
  }, [requestLoad]);

  // Kick off the initial load once both the worker exists and we know which tag to load.
  useEffect(() => {
    if (!selectedTag || !workerRef.current) return;
    if (state.kind === "loadingVersion" && state.tag === selectedTag) {
      requestLoad(selectedTag);
    }
  }, [selectedTag, state, requestLoad]);

  const onSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const tag = e.target.value;
    if (tag === selectedTag) return;
    setSelectedTag(tag);
    try { localStorage.setItem(STORAGE_KEY, tag); } catch { /* private mode */ }
    requestLoad(tag);
  }, [selectedTag, requestLoad]);

  const onRun = useCallback(() => {
    if (!workerRef.current) return;
    if (state.kind !== "ready" && state.kind !== "done" && state.kind !== "runError") return;
    setState({ kind: "running", tag: state.tag });
    setTrace("");
    setTraceJson("");
    setOutputIr("");
    setRunError("");
    workerRef.current.postMessage({ type: "run", ir });
  }, [ir, state]);

  const runDisabled =
    state.kind !== "ready" && state.kind !== "done" && state.kind !== "runError";
  const selectDisabled =
    state.kind === "loadingManifest" ||
    state.kind === "manifestError" ||
    state.kind === "noVersions" ||
    state.kind === "running";

  const statusText = (() => {
    switch (state.kind) {
      case "loadingManifest": return "loading manifest…";
      case "manifestError":   return `manifest error: ${state.message}`;
      case "noVersions":      return "no wasm versions published yet — push a release/* tag";
      case "loadingVersion":  return `loading ${state.tag}…`;
      case "ready":           return "ready";
      case "running":         return "running InstCombine…";
      case "done":            return `trace ${state.bytes.toLocaleString()} bytes`;
      case "loadError":       return `load error: ${state.message}`;
      case "runError":        return `run error: ${state.message}`;
    }
  })();

  return (
    <div className="app">
      <header className="toolbar">
        <h1>InstCombine fold debugger</h1>
        <label className="version-picker">
          version
          <select
            value={selectedTag ?? ""}
            onChange={onSelectChange}
            disabled={selectDisabled || !manifest || manifest.releases.length === 0}
          >
            {manifest ? (
              <>
                {groupedReleases.tags.length > 0 && (
                  <optgroup label="Tagged releases">
                    {groupedReleases.tags.map((r) => (
                      <option key={r.tag} value={r.tag}>{formatLabel(r)}</option>
                    ))}
                  </optgroup>
                )}
                {groupedReleases.commits.length > 0 && (
                  <optgroup label="Commit snapshots">
                    {groupedReleases.commits.map((r) => (
                      <option key={r.tag} value={r.tag}>{formatLabel(r)}</option>
                    ))}
                  </optgroup>
                )}
              </>
            ) : (
              <option value="">(loading)</option>
            )}
          </select>
        </label>
        <button onClick={onRun} disabled={runDisabled}>Run</button>
        <span className="status">{statusText}</span>
        <label className="theme-picker">
          theme
          <select
            value={colorPref}
            onChange={(e) => setColorPref(e.target.value as ColorSchemePref)}
            title="color scheme"
          >
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </header>
      <main className="panes">
        <PanelGroup direction="horizontal" autoSaveId="instcombine-h">
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup direction="vertical" autoSaveId="instcombine-left-v">
              <Panel defaultSize={60} minSize={20}>
                <section className="pane">
                  <div className="pane-header">LLVM IR</div>
                  <div className="pane-body">
                    <Editor value={ir} onChange={setIr} />
                  </div>
                </section>
              </Panel>
              <PanelResizeHandle className="pane-resize-handle horizontal" />
              <Panel defaultSize={40} minSize={15}>
                <section className="pane">
                  <div className="pane-header">
                    <span>{runError ? "output.ll (driver error)" : "output.ll (post-InstCombine)"}</span>
                    <CopyButton text={runError || outputIr} />
                  </div>
                  <div className="pane-body">
                    <OutputIrPane ir={outputIr} error={runError || undefined} />
                  </div>
                </section>
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="pane-resize-handle vertical" />
          <Panel defaultSize={50} minSize={20}>
            <section className="pane">
              <div className="pane-header">
                <span>{viewMode === "structured" ? "Structured Trace" : "Plain-Text Trace"}</span>
                {viewMode === "text" && (
                  <button
                    type="button"
                    className="pane-header-button"
                    onClick={() => setWordWrap((w) => !w)}
                    title="Toggle word wrap"
                  >
                    {wordWrap ? "wrap: on" : "wrap: off"}
                  </button>
                )}
                <div className="view-mode-toggle" role="tablist" aria-label="view mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "text"}
                    className={`pane-header-button ${viewMode === "text" ? "active" : ""}`}
                    onClick={() => setViewMode("text")}
                  >text</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "structured"}
                    className={`pane-header-button ${viewMode === "structured" ? "active" : ""}`}
                    onClick={() => setViewMode("structured")}
                  >structured</button>
                </div>
              </div>
              <div className="pane-body">
                <TracePanel
                  trace={trace}
                  wordWrap={wordWrap}
                  viewMode={viewMode}
                  iterations={iterations}
                  llvmRef={llvmRef}
                />
              </div>
            </section>
          </Panel>
        </PanelGroup>
      </main>
    </div>
  );
}
