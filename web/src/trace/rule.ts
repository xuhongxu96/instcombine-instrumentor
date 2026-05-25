import type { NewValue } from "./types";
import { splitLoc } from "./githubLink";

// A source file lives under lib/Transforms/InstCombine iff its path contains
// "InstCombine" — matching the runtime's own strstr() heuristic.
const INSTCOMBINE_HINT = "InstCombine";

function isInstCombineFile(file: string | undefined | null): boolean {
  return !!file && file.includes(INSTCOMBINE_HINT);
}

// The InstCombine rule that produced a value is the innermost frame whose source
// lives under lib/Transforms/InstCombine, walking from the value outward.
//
// The runtime's JSON `rule` field computes this from the captured call_path
// frames (#1, #2, …) only — it never considers frame #0, the function that
// actually produced the value (NewValue.func_name at NewValue.loc). So a value
// created directly inside a visit*/fold* function whose body has no further
// InstCombine call site on the stack gets no rule (or a less-specific outer
// one). Recompute here with frame #0 as the innermost candidate.
export function computeRule(v: NewValue): string {
  const loc = v.loc ? splitLoc(v.loc) : null;
  if (isInstCombineFile(loc?.file)) return v.func_name || "";
  for (const f of v.frames ?? []) {
    if (isInstCombineFile(f.file)) return f.name || "";
  }
  return "";
}
