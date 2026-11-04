// Raw* types describe JSON records received from the runtime, where derived fields
// may be absent. The other types describe normalized records for the UI.
// Pointers come over as "0x..." strings so they can be used directly as DOM ids / anchor targets.

export interface Frame {
  name: string;
  file: string;
  line: number;
}

export interface NewValue {
  ptr: string;
  ir: string;
  opcode: string;
  parent_fn: string;
  parent_bb: string;
  debug_loc: string;
  rule: string;
  loc: string;
  func_name: string;
  frames: Frame[];
}

export interface Replacement {
  old_ptr: string;
  new_ptr: string;
  old_ir: string;
  new_ir: string;
  old_opcode: string;
  new_opcode: string;
}

export interface VTOperand {
  ptr: string;
  ir: string;
}

export interface VTQuery {
  query: string;
  result: string;
  loc: string;
  func_name: string;
  operands: VTOperand[];
  rule: string;
  frames: Frame[];
}

export interface Iteration {
  iteration: number;
  new_values: NewValue[];
  replacements: Replacement[];
  vt_queries: VTQuery[];
}

// Records received from the runtime.
// Derived fields may be absent in newer traces.
export interface RawNewValue
  extends Omit<NewValue, "opcode" | "rule"> {
  opcode?: string;
  rule?: string;
}

export interface RawReplacement
  extends Omit<Replacement, "old_opcode" | "new_opcode"> {
  old_opcode?: string;
  new_opcode?: string;
}

export interface RawVTQuery extends Omit<VTQuery, "rule"> {
  rule?: string;
}

export interface RawIteration {
  iteration: number;
  new_values: RawNewValue[];
  replacements: RawReplacement[];
  // Older bundles predate ValueTracking records.
  vt_queries?: RawVTQuery[];
}
