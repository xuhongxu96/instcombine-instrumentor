// Schema mirroring runtime/fuzz_runtime.cpp's dump_json. Pointers come over as
// "0x..." strings so they can be used directly as DOM ids / anchor targets.

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

export interface Iteration {
  iteration: number;
  new_values: NewValue[];
  replacements: Replacement[];
}
