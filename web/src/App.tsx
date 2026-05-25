import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { CopyButton, OutputIrPane } from "./components/OutputIrPane";
import { TracePanel, type TraceViewMode } from "./components/TracePanel";
import { useColorScheme, type ColorSchemePref } from "./components/useColorScheme";
import { parseTraceJsonl } from "./trace/parse";
import { githubSourceFromRelease } from "./trace/githubLink";
import { compressIr, decompressIr, isCompressionSupported } from "./share/irCompress";
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

const DEFAULT_ARTIFACT_BRANCH = "wasm-pkgs";
const VERSION_STORAGE_PREFIX = "wasmVersion:";
const BRANCH_STORAGE_KEY = "wasmArtifactBranch";
const SHARE_PARAM_IR = "ir";
const SHARE_PARAM_IR_COMPRESSED = "irz";
const SHARE_PARAM_TAG = "tag";

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

function getRepositoryFullName(): string | null {
  const env = (import.meta as ImportMeta & {
    env?: { VITE_GITHUB_REPOSITORY?: string; VITE_REMOTE_MANIFEST_URL?: string };
  }).env;
  if (env?.VITE_GITHUB_REPOSITORY) return env.VITE_GITHUB_REPOSITORY;
  const remote = env?.VITE_REMOTE_MANIFEST_URL;
  if (!remote) return null;
  const match = remote.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/manifest\.json$/);
  return match?.[1] ?? null;
}

function getRemoteManifestUrl(branch: string): string | null {
  const repo = getRepositoryFullName();
  return repo ? `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/manifest.json` : null;
}

function getInitialArtifactBranch(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("branch");
  if (fromUrl) return fromUrl;
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(BRANCH_STORAGE_KEY) : null;
  return stored || DEFAULT_ARTIFACT_BRANCH;
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

interface InitialIr {
  value: string;
  isDecoding: boolean;
  compressed: string | null;
}

function readInitialIr(): InitialIr {
  const params = new URLSearchParams(window.location.search);
  const compressed = params.get(SHARE_PARAM_IR_COMPRESSED);
  if (compressed) {
    return { value: "", isDecoding: true, compressed };
  }
  const legacy = params.get(SHARE_PARAM_IR);
  if (legacy) {
    return { value: decodeBase64Url(legacy) ?? DEFAULT_IR, isDecoding: false, compressed: null };
  }
  return { value: DEFAULT_IR, isDecoding: false, compressed: null };
}

function versionStorageKey(branch: string): string {
  return `${VERSION_STORAGE_PREFIX}${branch}`;
}

function persistArtifactBranch(branch: string) {
  try { localStorage.setItem(BRANCH_STORAGE_KEY, branch); } catch { /* private mode */ }
  const url = new URL(window.location.href);
  if (branch === DEFAULT_ARTIFACT_BRANCH) url.searchParams.delete("branch");
  else url.searchParams.set("branch", branch);
  window.history.replaceState({}, "", url);
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

function pickInitialTag(manifest: WasmManifest, branch: string): string | null {
  if (manifest.releases.length === 0) return null;
  const fromUrl = new URLSearchParams(window.location.search).get(SHARE_PARAM_TAG);
  if (fromUrl && manifest.releases.some((r) => r.tag === fromUrl)) return fromUrl;
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(versionStorageKey(branch)) : null;
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
  const initialIrRef = useRef<InitialIr | null>(null);
  if (initialIrRef.current === null) initialIrRef.current = readInitialIr();
  const [ir, setIr] = useState(initialIrRef.current.value);
  const [isDecodingShared, setIsDecodingShared] = useState(initialIrRef.current.isDecoding);
  const [trace, setTrace] = useState("");
  const [traceJson, setTraceJson] = useState("");
  const [outputIr, setOutputIr] = useState("");
  const [runError, setRunError] = useState("");
  const [viewMode, setViewMode] = useState<TraceViewMode>("structured");
  const [artifactBranch, setArtifactBranch] = useState(() => getInitialArtifactBranch());
  const [artifactBranchInput, setArtifactBranchInput] = useState(() => getInitialArtifactBranch());
  const [manifest, setManifest] = useState<WasmManifest | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [state, setState] = useState<WasmState>({ kind: "loadingManifest" });
  const [wordWrap, setWordWrap] = useState(true);
  const [shareCopied, setShareCopied] = useState(false);
  const { pref: colorPref, setPref: setColorPref } = useColorScheme();
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const pendingLoadRef = useRef<string | null>(null);
  const lastLoadRequestRef = useRef<string | null>(null);

  const iterations = useMemo(() => parseTraceJsonl(traceJson), [traceJson]);

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
  const selectedRelease = useMemo(
    () => (selectedTag ? releaseByTag.get(selectedTag) ?? null : null),
    [releaseByTag, selectedTag],
  );
  const githubSource = useMemo(
    () => githubSourceFromRelease(selectedRelease),
    [selectedRelease],
  );

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

  // Fetch the manifest whenever the selected artifact branch changes.
  // Waterfall:
  //   1. The selected remote branch manifest on raw.githubusercontent.com.
  //   2. Same-origin `wasm/manifest.json` (the Pages-time builder emits this).
  //   3. fallbackManifest() — single entry pointing at whatever
  //      build_wasm.sh last dropped under public/wasm/.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setManifest(null);
      setSelectedTag(null);
      setState({ kind: "loadingManifest" });
      lastLoadRequestRef.current = null;
      let manifest: WasmManifest | null = null;
      const remote = getRemoteManifestUrl(artifactBranch);
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
      const initial = pickInitialTag(m, artifactBranch);
      setManifest(m);
      if (initial) {
        setSelectedTag(initial);
        setState({ kind: "loadingVersion", tag: initial });
      } else {
        setState({ kind: "noVersions" });
      }
    })();
    return () => { cancelled = true; };
  }, [artifactBranch]);

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

  // Decode a shared compressed IR (?irz=) on first mount. Synchronous decode of
  // the legacy ?ir= param happens inside readInitialIr.
  useEffect(() => {
    const initial = initialIrRef.current;
    if (!initial || !initial.compressed) return;
    let cancelled = false;
    (async () => {
      try {
        const decoded = await decompressIr(initial.compressed!);
        if (cancelled) return;
        setIr(decoded);
      } catch (err) {
        if (cancelled) return;
        console.warn("failed to decode shared IR; falling back to default", err);
        setIr(DEFAULT_IR);
      } finally {
        if (!cancelled) setIsDecodingShared(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const tag = e.target.value;
    if (tag === selectedTag) return;
    setSelectedTag(tag);
    try { localStorage.setItem(versionStorageKey(artifactBranch), tag); } catch { /* private mode */ }
    requestLoad(tag);
  }, [artifactBranch, selectedTag, requestLoad]);

  const commitArtifactBranch = useCallback(() => {
    const next = artifactBranchInput.trim() || DEFAULT_ARTIFACT_BRANCH;
    setArtifactBranchInput(next);
    if (next === artifactBranch) return;
    persistArtifactBranch(next);
    setArtifactBranch(next);
  }, [artifactBranch, artifactBranchInput]);

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
    isDecodingShared ||
    (state.kind !== "ready" && state.kind !== "done" && state.kind !== "runError");
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

  const onShare = useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("branch", artifactBranch);
    if (selectedTag) url.searchParams.set(SHARE_PARAM_TAG, selectedTag);
    else url.searchParams.delete(SHARE_PARAM_TAG);
    if (isCompressionSupported()) {
      try {
        const compressed = await compressIr(ir);
        url.searchParams.set(SHARE_PARAM_IR_COMPRESSED, compressed);
        url.searchParams.delete(SHARE_PARAM_IR);
      } catch (err) {
        console.warn("IR compression failed; falling back to legacy ?ir=", err);
        url.searchParams.set(SHARE_PARAM_IR, encodeBase64Url(ir));
        url.searchParams.delete(SHARE_PARAM_IR_COMPRESSED);
      }
    } else {
      url.searchParams.set(SHARE_PARAM_IR, encodeBase64Url(ir));
      url.searchParams.delete(SHARE_PARAM_IR_COMPRESSED);
    }
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1500);
    } catch {
      // clipboard may be blocked in some contexts; ignore silently
    }
  }, [artifactBranch, selectedTag, ir]);

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
        <label className="branch-picker">
          branch
          <input
            type="text"
            placeholder={`leave empty for ${DEFAULT_ARTIFACT_BRANCH}`}
            value={artifactBranchInput}
            onChange={(e) => setArtifactBranchInput(e.target.value)}
            onBlur={commitArtifactBranch}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitArtifactBranch();
              }
            }}
            disabled={state.kind === "running"}
            spellCheck={false}
          />
        </label>
        <button onClick={onRun} disabled={runDisabled}>Run</button>
        <button onClick={onShare} title="Copy permalink to current settings and IR">
          {shareCopied ? "link copied" : "Share"}
        </button>
        <a
          className="toolbar-icon-link"
          href="https://xuhongxu.com/projects/instcombine-debugger/USER_MANUAL.html"
          target="_blank"
          rel="noopener noreferrer"
          title="Open help manual in a new tab"
          aria-label="Open help manual in a new tab"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 14.5A6.5 6.5 0 1 1 8 1.5a6.5 6.5 0 0 1 0 13ZM6.84 6.58a.75.75 0 0 1-1.48-.26 2.65 2.65 0 0 1 5.2.77c0 .97-.46 1.5-1.03 1.98-.55.46-.84.77-.84 1.27v.16a.75.75 0 0 1-1.5 0v-.16c0-1.15.68-1.86 1.38-2.45.48-.4.49-.62.49-.81a1.15 1.15 0 0 0-2.22-.5ZM8 12.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
          </svg>
        </a>
        <a
          className="toolbar-icon-link"
          href="https://github.com/xuhongxu96/instcombine-instrumentor"
          target="_blank"
          rel="noopener noreferrer"
          title="Open the GitHub repository in a new tab"
          aria-label="Open the GitHub repository in a new tab"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.69 0 8.23c0 3.63 2.29 6.7 5.47 7.78.4.08.55-.18.55-.4 0-.2-.01-.85-.01-1.54-2.01.38-2.53-.51-2.69-.98-.09-.24-.48-.98-.82-1.18-.28-.15-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.2-.36-1.02.08-2.13 0 0 .67-.22 2.2.84.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.06 2.2-.84 2.2-.84.44 1.11.16 1.93.08 2.13.51.57.82 1.29.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .22.15.49.55.4A8.24 8.24 0 0 0 16 8.23C16 3.69 12.42 0 8 0Z" />
          </svg>
        </a>
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
                  <div className="pane-header">
                    <span>LLVM IR</span>
                    <CopyButton text={ir} />
                  </div>
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
                {viewMode === "text" && <CopyButton text={trace} />}
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
                  githubSource={githubSource}
                />
              </div>
            </section>
          </Panel>
        </PanelGroup>
      </main>
    </div>
  );
}
