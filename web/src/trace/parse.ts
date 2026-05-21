import type { Iteration } from "./types";

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
        out.push(obj);
      }
    } catch (e) {
      console.warn(`parseTraceJsonl: skipping malformed line ${i + 1}:`, e);
    }
  }
  return out;
}
