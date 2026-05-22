// Resolve LLVM repo refs + GitHub blob URLs from trace records.
//
// Trace file paths come from __FILE__ inside the patched LLVM tree and look like
//   "../../thirdparty/llvm-project/llvm/lib/.../File.cpp".
// Line numbers are off by one from the original LLVM source because patch_llvm.py
// prepends `#include "llvm/IR/fuzz_runtime.h"` to every instrumented file. Two
// other edits (start_iteration() inside InstCombinerImpl::run and a
// __llvm_fuzz_record_replace inside Value::doRAUW) additionally shift lines below
// those points, but those are narrow windows we don't try to model.

const REPO_BASE = "https://github.com/llvm/llvm-project";
const LLVM_PROJECT_SEP = "llvm-project/";
const LINE_OFFSET = -1; // undo the include prepend

// Manifest tags come from the wasm-pkgs branch directory names:
//   "llvmorg-X.Y.Z[-rcN]"        → upstream tag of the same name
//   "main-YYMMDD-<12hex>"        → 12-char SHA prefix of an upstream commit
// Older bundler runs may still produce "release/…" prefixed slugs — accept
// both shapes for graceful upgrade.
// Anything else (e.g. "(local build)") yields null so we render plain text.
export function llvmRefFromManifestTag(tag: string | null): string | null {
  if (!tag) return null;
  const llvmorg = tag.match(/^(?:release\/)?(llvmorg-[\w.+-]+)$/);
  if (llvmorg) return llvmorg[1];
  const commit = tag.match(/^(?:release\/|main-)\d{6}-([0-9a-f]{7,40})$/i);
  if (commit) return commit[1];
  // local build uses main
  if (tag === "(local build)") return "main";
  return null;
}

// Strip the build-relative "../../thirdparty/llvm-project/" prefix so the UI
// shows the path as it appears in the upstream repo.
export function displayPath(file: string): string {
  const idx = file.indexOf(LLVM_PROJECT_SEP);
  return idx < 0 ? file : file.slice(idx + LLVM_PROJECT_SEP.length);
}

// "<path>:<line>" → { file, line }; null if there's no trailing :line.
export function splitLoc(loc: string): { file: string; line: number } | null {
  const i = loc.lastIndexOf(":");
  if (i < 0) return null;
  const n = parseInt(loc.slice(i + 1), 10);
  if (!Number.isFinite(n)) return null;
  return { file: loc.slice(0, i), line: n };
}

export function githubUrlFor(file: string, line: number, ref: string | null): string | null {
  if (!ref) return null;
  const idx = file.indexOf(LLVM_PROJECT_SEP);
  if (idx < 0) return null;
  const repoPath = file.slice(idx + LLVM_PROJECT_SEP.length);
  const adjusted = Math.max(1, line + LINE_OFFSET);
  return `${REPO_BASE}/blob/${ref}/${repoPath}#L${adjusted}`;
}
