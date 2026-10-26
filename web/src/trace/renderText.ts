import type { Iteration } from "./types";

// Both web views use normalized iterations. Fall back to runtime text only
// when there are no usable structured records (for example, older bundles).
export function renderTraceText(iterations: readonly Iteration[], legacyTrace = ""): string {
  if (iterations.length === 0) return legacyTrace;

  const lines = ["=== SESSION START ==="];
  for (const iteration of iterations) {
    lines.push(`=== ITERATION ${iteration.iteration} START ===`, "", "NEW INSTRUCTIONS IN THIS ITERATION:");
    for (const value of iteration.new_values) {
      lines.push(`VALUE ${value.ptr} (${value.ir}) at ${value.func_name || "unknown"} (${value.loc || "unknown:0"}):`);

      const tags: string[] = [];
      if (value.opcode) tags.push(`[opcode=${value.opcode}]`);
      if (value.parent_fn) {
        const block = value.parent_bb ? `/${value.parent_bb}` : "";
        tags.push(`[fn=${value.parent_fn}${block}]`);
      }
      if (value.rule) tags.push(`[rule=${value.rule}]`);
      if (value.debug_loc) tags.push(`[dbg=${value.debug_loc}]`);
      if (tags.length > 0) lines.push(` ${tags.join(" ")}`);

      for (const [index, frame] of (value.frames ?? []).entries()) {
        lines.push(` #${index + 1} ${frame.name || "?"} at ${frame.file || "?"}:${frame.line}`);
      }
      lines.push("");
    }

    lines.push("REPLACEMENTS IN THIS ITERATION:");
    for (const replacement of iteration.replacements) {
      lines.push(`${replacement.old_ptr} (${replacement.old_ir}) -> ${replacement.new_ptr} (${replacement.new_ir})`);
    }
    lines.push("=== ITERATION END ===");
  }
  return lines.join("\n") + "\n";
}
