import { notImplemented } from "../core/todo.js";

/**
 * Apply a replicated event idempotently: fast-forward, already known, missing parent,
 * or concurrent with per-kind conflict policy (SPEC sections 7.3 and 7.4). Milestone M3.
 */
export function applyEvent(_event: unknown): void {
  notImplemented("applyEvent", "M3");
}
