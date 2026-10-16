import { notImplemented } from "../core/todo.js";

export type BriefSize = "micro" | "normal" | "full";

/** Deterministic, budgeted brief assembly (SPEC section 11.1). Milestone M1. */
export function assembleBrief(_scope: string, _size: BriefSize): string {
  return notImplemented("assembleBrief", "M1");
}
