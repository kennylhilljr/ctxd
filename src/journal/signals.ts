import type { Kind, Significance } from "../core/kinds.js";

/**
 * Open signals (SPEC v6 section 11.4), derived deterministically from entry and link history,
 * so every node computes the same rows from the same events. One row per (entry, source).
 */

export interface SignalEntry {
  id: string;
  scope: string;
  kind: Kind;
  significance?: Significance | null;
  /** HLC at which the entry first became active; null if it never did (still proposed or rejected). */
  activeHlc: string | null;
  /**
   * HLC at which it left the live states (archived, superseded, quarantined, deleted or purged).
   * Flagged and conflicted entries are still live.
   */
  retiredHlc?: string | null;
}

export interface SignalRelation {
  source: string;
  type: string;
  target: string;
  addedHlc: string;
  /** HLC of the unrelate event, if the link was removed. */
  removedHlc?: string | null;
}

export interface SignalFlag {
  entry: string;
  flaggedHlc: string;
  resolvedHlc?: string | null;
}

export type SignalSource = "journal" | "task" | "flag";

export interface Signal {
  entryId: string;
  scope: string;
  source: SignalSource;
  openedHlc: string;
  resolvedHlc: string | null;
  /** Reference of the resolving entry, or "retired", "unblocked" or "flag". */
  resolvedBy: string | null;
}

type Close = { hlc: string; by: string };

const later = (a: string, b: string): string => (a > b ? a : b);

/** Keep the earliest close. */
function earliest(a: Close | null, b: Close | null): Close | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.hlc < a.hlc ? b : a;
}

export function computeSignals(
  entries: readonly SignalEntry[],
  relations: readonly SignalRelation[],
  flags: readonly SignalFlag[],
): Signal[] {
  const byId = new Map(entries.map((e) => [e.id, e]));

  /**
   * Earliest `resolved` link to `target` that counts: its source must have become active, and it counts
   * from the later of the link and that approval, unless the link was removed before then.
   * Once counted, a resolution stands, so archiving the fix later does not reopen the signal.
   */
  const resolution = (target: string): Close | null => {
    let best: Close | null = null;
    for (const r of relations) {
      if (r.type !== "resolved" || r.target !== target) continue;
      const src = byId.get(r.source);
      if (!src?.activeHlc) continue;
      const at = later(r.addedHlc, src.activeHlc);
      if (r.removedHlc && r.removedHlc <= at) continue;
      best = earliest(best, { hlc: at, by: r.source });
    }
    return best;
  };

  const retired = (e: SignalEntry): Close | null => (e.retiredHlc ? { hlc: e.retiredHlc, by: "retired" } : null);

  const out: Signal[] = [];
  const push = (e: SignalEntry, source: SignalSource, openedHlc: string, close: Close | null): void => {
    out.push({ entryId: e.id, scope: e.scope, source, openedHlc, resolvedHlc: close?.hlc ?? null, resolvedBy: close?.by ?? null });
  };

  for (const e of entries) {
    if (!e.activeHlc) continue;

    if (e.kind === "journal" && (e.significance === "blocker" || e.significance === "incident")) {
      push(e, "journal", e.activeHlc, earliest(resolution(e.id), retired(e)));
    }

    if (e.kind === "task") {
      // Each blocks link to a task that became active blocks for an interval; the signal covers them all.
      let opened: string | null = null;
      let allEnd: string | null = "";
      for (const r of relations) {
        if (r.type !== "blocks" || r.source !== e.id) continue;
        const t = byId.get(r.target);
        if (t?.kind !== "task" || !t.activeHlc) continue;
        const start = later(later(r.addedHlc, t.activeHlc), e.activeHlc);
        const ends = [r.removedHlc, t.retiredHlc].filter((x): x is string => !!x);
        const end = ends.length ? ends.reduce((a, b) => (a < b ? a : b)) : null;
        if (end !== null && end <= start) continue;
        if (opened === null || start < (opened as string)) opened = start;
        allEnd = end === null || allEnd === null ? null : later(allEnd, end);
      }
      if (opened !== null) {
        const unblocked = allEnd ? { hlc: allEnd, by: "unblocked" } : null;
        push(e, "task", opened, earliest(earliest(resolution(e.id), retired(e)), unblocked));
      }
    }
  }

  const flagsByEntry = new Map<string, SignalFlag[]>();
  for (const f of flags) flagsByEntry.set(f.entry, [...(flagsByEntry.get(f.entry) ?? []), f]);
  for (const [entryId, fs] of flagsByEntry) {
    const e = byId.get(entryId);
    if (!e) continue;
    const opened = fs.map((f) => f.flaggedHlc).reduce((a, b) => (a < b ? a : b));
    const open = fs.some((f) => !f.resolvedHlc);
    push(e, "flag", opened, open ? null : { hlc: fs.map((f) => f.resolvedHlc as string).reduce(later), by: "flag" });
  }

  const key = (s: Signal): string => `${s.openedHlc}\u0000${s.entryId}\u0000${s.source}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Brief line for an open signal, e.g. `BLOCKER (2d): waiting on fixtures, ctxd:notes/01JAB...`. */
export function signalLine(label: string, ageMs: number, title: string, ref: string): string {
  const h = Math.floor(ageMs / 3_600_000);
  const age = h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
  return `${label.toUpperCase()} (${age}): ${title}, ${ref}`;
}
