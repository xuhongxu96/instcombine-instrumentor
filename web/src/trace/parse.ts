import type { Iteration } from "./types";
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
      const obj = JSON.parse(line) as Iteration;
      if (typeof obj === "object" && obj !== null && Array.isArray(obj.new_values) && Array.isArray(obj.replacements)) {
        // The runtime's `rule` ignores frame #0 (the producing function); derive
        // it here from frame #0 + the call_path so the UI shows the real rule.
        for (const v of obj.new_values) v.rule = computeRule(v);
        out.push(obj);
      }
    } catch (e) {
      console.warn(`parseTraceJsonl: skipping malformed line ${i + 1}:`, e);
    }
  }
  return out;
}
