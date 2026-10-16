import { notImplemented } from "../core/todo.js";

/**
 * Resolve a scope from cwd: .ctxd.toml, then scope_map by git remote, then by git root,
 * then git root name if the scope exists (SPEC section 3). Milestone M2.
 */
export function resolveScope(_cwd: string): string | null {
  return notImplemented("resolveScope", "M2");
}
