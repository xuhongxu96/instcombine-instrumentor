import type { Iteration, NewValue, RawIteration } from "./types";
import { deriveOpcode } from "./opcode";
import { computeRule } from "./rule";

// One JSON object per line. Defensive: a corrupted trailing line (e.g. crash
// mid-write) is logged and skipped rather than failing the whole parse.
export function parseTraceJsonl(raw: string): Iteration[] {
  if (!raw) return [];
  const out: Iteration[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as RawIteration;
      if (typeof obj === "object" && obj !== null && Array.isArray(obj.new_values) && Array.isArray(obj.replacements)) {
        const iteration: Iteration = {
          iteration: obj.iteration,
          new_values: obj.new_values.map((v) => {
            const value: NewValue = {
              ...v,
              opcode: v.opcode ?? deriveOpcode(v.ir),
              rule: "",
            };

            // Derive the rule from the producing location and caller frames.
            value.rule = computeRule(value);
            return value;
          }),
          replacements: obj.replacements.map((r) => ({
            ...r,
            old_opcode: r.old_opcode ?? deriveOpcode(r.old_ir),
            new_opcode: r.new_opcode ?? deriveOpcode(r.new_ir),
          })),
          vt_queries: (obj.vt_queries ?? []).map((q) => ({
            ...q,
            rule: computeRule(q),
          })),
        };

        out.push(iteration);
      }
    } catch (e) {
      console.warn(`parseTraceJsonl: skipping malformed line ${i + 1}:`, e);
    }
  }
  return out;
}
