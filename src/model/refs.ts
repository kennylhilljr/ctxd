/**
 * Entry references (SPEC v3 section 4.1; PRD-knowledge-model-v1 section 5).
 * Format: ctxd:<scope name>/<entry ULID>. The ULID identifies the entry; the scope is for readability.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Matches fsview/paths.ts's SCOPE_RE: a leading underscore covers the reserved namespaces
// (_me, _me.<pool>, _hold.<client>, _system), and "@" covers client names like codex@laptop.
const SCOPE = /^[a-z0-9_][a-z0-9._@-]{0,99}$/;

export interface EntryRef {
  scope: string;
  id: string;
}

export function formatRef(scope: string, id: string): string {
  if (!SCOPE.test(scope)) throw new Error(`Invalid scope name: ${scope}`);
  if (!ULID.test(id)) throw new Error(`Invalid entry id: ${id}`);
  return `ctxd:${scope}/${id}`;
}

/** Parse a reference or a bare ULID. Returns null when the input is neither. */
export function parseRef(value: string): EntryRef | { scope: null; id: string } | null {
  const trimmed = value.trim();
  if (ULID.test(trimmed)) return { scope: null, id: trimmed };
  const m = /^ctxd:([^/]+)\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(trimmed);
  if (!m || !SCOPE.test(m[1]!)) return null;
  return { scope: m[1]!, id: m[2]! };
}

/** Extract every well-formed reference from free text, e.g. a commit message or handoff. */
export function findRefs(text: string): EntryRef[] {
  const out: EntryRef[] = [];
  for (const m of text.matchAll(/ctxd:([a-z0-9_][a-z0-9._@-]{0,99})\/([0-9A-HJKMNP-TV-Z]{26})/g)) {
    if (SCOPE.test(m[1]!)) out.push({ scope: m[1]!, id: m[2]! });
  }
  return out;
}
