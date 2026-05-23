import { useCallback, useMemo, useRef, useState } from "react";
import type { Frame, Iteration, NewValue, Replacement } from "../trace/types";
import { displayPath, githubUrlFor, splitLoc, type GitHubSourceRef } from "../trace/githubLink";

interface Props {
  iterations: Iteration[];
  githubSource: GitHubSourceRef | null;
}

interface Filters {
  text: string;
  opcode: string;
  rule: string;
  fn: string;
}

const EMPTY_FILTERS: Filters = { text: "", opcode: "", rule: "", fn: "" };

function matchesNeedle(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// Strip a leading "@" so a user can type either `@f` or `f` in the IR-function
// filter (the pill renders the @ as decoration but parent_fn stores the bare name).
function normFn(s: string): string {
  return s.startsWith("@") ? s.slice(1) : s;
}

function matchValue(v: NewValue, f: Filters): boolean {
  if (!matchesNeedle(v.opcode, f.opcode)) return false;
  if (!matchesNeedle(v.rule, f.rule)) return false;
  if (!matchesNeedle(v.parent_fn, normFn(f.fn))) return false;
  if (f.text) {
    const blob = [v.ir, v.opcode, v.rule, v.parent_fn, v.parent_bb, v.debug_loc, v.loc, v.func_name].join(" ");
    if (!matchesNeedle(blob, f.text)) return false;
  }
  return true;
}

function matchReplacement(r: Replacement, f: Filters): boolean {
  if (!matchesNeedle(r.old_opcode + " " + r.new_opcode, f.opcode)) return false;
  if (f.rule || f.fn) return false; // replacements have no rule/fn directly; hide when those filters active
  if (f.text) {
    const blob = [r.old_ir, r.new_ir, r.old_opcode, r.new_opcode, r.old_ptr, r.new_ptr].join(" ");
    if (!matchesNeedle(blob, f.text)) return false;
  }
  return true;
}

function SrcLoc({ file, line, githubSource }: { file: string; line: number; githubSource: GitHubSourceRef | null }) {
  const text = `${displayPath(file || "?")}:${line}`;
  const url = file ? githubUrlFor(file, line, githubSource) : null;
  if (!url) return <span className="src-loc">{text}</span>;
  return (
    <a className="src-loc" href={url} target="_blank" rel="noopener noreferrer" title="open on GitHub">
      {text}
    </a>
  );
}

function FrameList({ frames, githubSource }: { frames: Frame[]; githubSource: GitHubSourceRef | null }) {
  if (frames.length === 0) return null;
  return (
    <details className="trace-frames">
      <summary>stack ({frames.length} frame{frames.length === 1 ? "" : "s"})</summary>
      <ol>
        {frames.map((f, idx) => (
          <li key={idx}>
            <span className="frame-name">{f.name || "?"}</span>
            <span className="frame-loc"> at <SrcLoc file={f.file} line={f.line} githubSource={githubSource} /></span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ValueCard({ value, githubSource }: { value: NewValue; githubSource: GitHubSourceRef | null }) {
  const split = splitLoc(value.loc);
  return (
    <div className="trace-card" id={value.ptr}>
      <div className="trace-card-header">
        <span className="trace-card-ptr">{value.ptr}</span>
        {value.opcode && <span className="trace-pill opcode">{value.opcode}</span>}
        {value.parent_fn && (
          <span className="trace-pill fn">
            @{value.parent_fn}
            {value.parent_bb && <span className="trace-pill-bb">/{value.parent_bb}</span>}
          </span>
        )}
        {value.rule && <span className="trace-pill rule" title={value.rule}>{shortRule(value.rule)}</span>}
        {value.debug_loc && <span className="trace-pill dbg" title="source location from IR debug info">{value.debug_loc}</span>}
      </div>
      <pre className="ir-text">{value.ir}</pre>
      <div className="trace-card-meta">
        produced at <code>{value.func_name}</code>{" "}
        <span className="meta-loc">
          ({split ? <SrcLoc file={split.file} line={split.line} githubSource={githubSource} /> : displayPath(value.loc)})
        </span>
      </div>
      <FrameList frames={value.frames} githubSource={githubSource} />
    </div>
  );
}

// "llvm::Instruction *llvm::InstCombinerImpl::visitAdd(...)" → "InstCombinerImpl::visitAdd"
function shortRule(rule: string): string {
  // strip return type before the first '*' or last space outside parens
  const parenIdx = rule.indexOf("(");
  const head = parenIdx >= 0 ? rule.slice(0, parenIdx) : rule;
  const tokens = head.trim().split(/\s+/);
  let name = tokens[tokens.length - 1] || rule;
  // strip leading "llvm::" if present
  name = name.replace(/^llvm::/, "");
  // strip leading '*' from pointer return type that stuck to the name
  name = name.replace(/^\*+/, "");
  return name;
}

function PtrSpan({ ptr }: { ptr: string }) {
  return <span className="ptr-link" data-ptr={ptr}>{ptr}</span>;
}

function ReplacementRow({ r }: { r: Replacement }) {
  return (
    <div className="trace-replacement-row">
      <div className="rep-side rep-old">
        <PtrSpan ptr={r.old_ptr} />
        {r.old_opcode && <span className="trace-pill opcode">{r.old_opcode}</span>}
        <code className="ir-text-inline">{r.old_ir}</code>
      </div>
      <div className="rep-arrow">→</div>
      <div className="rep-side rep-new">
        <PtrSpan ptr={r.new_ptr} />
        {r.new_opcode && <span className="trace-pill opcode">{r.new_opcode}</span>}
        <code className="ir-text-inline">{r.new_ir}</code>
      </div>
    </div>
  );
}

export function StructuredTraceView({ iterations, githubSource }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    return iterations
      .map((it) => ({
        iteration: it.iteration,
        new_values: it.new_values.filter((v) => matchValue(v, filters)),
        replacements: it.replacements.filter((r) => matchReplacement(r, filters)),
      }))
      .filter((it) => it.new_values.length > 0 || it.replacements.length > 0);
  }, [iterations, filters]);

  // Delegated click handler: clicking any [data-ptr] scrolls to the matching
  // value card (id={ptr}) inside this view.
  const onClick = useCallback((e: React.MouseEvent) => {
    const t = (e.target as HTMLElement).closest("[data-ptr]");
    if (!t) return;
    const ptr = t.getAttribute("data-ptr");
    if (!ptr || !rootRef.current) return;
    const target = rootRef.current.querySelector(`[id="${CSS.escape(ptr)}"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("flash");
      window.setTimeout(() => target.classList.remove("flash"), 1200);
    }
  }, []);

  const hasAny = iterations.length > 0;
  const empty = hasAny ? filtered.length === 0 : true;

  return (
    <div className="structured-trace" ref={rootRef} onClick={onClick}>
      <div className="trace-filter-bar">
        <input
          type="search"
          placeholder="search text"
          value={filters.text}
          onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
        />
        <input
          type="search"
          placeholder="opcode"
          value={filters.opcode}
          onChange={(e) => setFilters((f) => ({ ...f, opcode: e.target.value }))}
        />
        <input
          type="search"
          placeholder="rule (visit*)"
          title="filter by the InstCombine rule that fired (e.g. visitAdd)"
          value={filters.rule}
          onChange={(e) => setFilters((f) => ({ ...f, rule: e.target.value }))}
        />
        <input
          type="search"
          placeholder="IR function (@…)"
          title="filter by the user's IR function that owns the value (e.g. @f)"
          value={filters.fn}
          onChange={(e) => setFilters((f) => ({ ...f, fn: e.target.value }))}
        />
        {(filters.text || filters.opcode || filters.rule || filters.fn) && (
          <button type="button" className="filter-clear" onClick={() => setFilters(EMPTY_FILTERS)}>clear</button>
        )}
      </div>

      {empty && (
        <div className="trace-empty">
          {hasAny
            ? "no records match the current filters"
            : "no structured data — run InstCombine, or your wasm bundle predates the JSONL sidecar"}
        </div>
      )}

      {filtered.map((it) => (
        <details key={it.iteration} open className="trace-iteration">
          <summary>
            <span className="iter-num">Iteration {it.iteration}</span>
            <span className="iter-counts">
              {it.new_values.length} new · {it.replacements.length} replacement{it.replacements.length === 1 ? "" : "s"}
            </span>
          </summary>
          {it.new_values.length > 0 && (
            <section className="iter-section">
              <h4>New instructions</h4>
              <div className="trace-cards">
                {it.new_values.map((v) => <ValueCard key={v.ptr} value={v} githubSource={githubSource} />)}
              </div>
            </section>
          )}
          {it.replacements.length > 0 && (
            <section className="iter-section">
              <h4>Replacements</h4>
              <div className="trace-replacements">
                {it.replacements.map((r, i) => <ReplacementRow key={`${r.old_ptr}-${r.new_ptr}-${i}`} r={r} />)}
              </div>
            </section>
          )}
        </details>
      ))}
    </div>
  );
}
