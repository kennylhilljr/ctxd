import type { Kind, Significance, Status } from "../core/kinds.js";

/**
 * Open signals (SPEC v6 section 11.4), derived deterministically from entries, relations and flags,
 * so every node computes the same rows from the same events.
 */

export interface SignalEntry {
  id: string;
  scope: string;
  kind: Kind;
  status: Status;
  significance?: Significance | null;
  createdHlc: string;
  /** HLC at which it left active (archived, superseded, quarantined, deleted or purged), if it did. */
  retiredHlc?: string | null;
}

export interface SignalRelation {
  source: string;
  type: "resolved" | "blocks" | string;
  target: string;
  addedHlc: string;
  removed: boolean;
}

export interface SignalFlag {
  entry: string;
  flaggedHlc: string;
  resolvedHlc?: string | null;
}

export interface Signal {
  entryId: string;
  scope: string;
  source: "journal" | "task" | "flag";
  openedHlc: string;
  resolvedHlc: string | null;
  resolvedBy: string | null;
}

const minHlc = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);
const maxHlc = (a: string, b: string): string => (a > b ? a : b);

export function computeSignals(
  entries: readonly SignalEntry[],
  relations: readonly SignalRelation[],
  flags: readonly SignalFlag[],
): Signal[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const live = relations.filter((r) => !r.removed);
  const isActive = (id: string): boolean => byId.get(id)?.status === "active";

  /** Earliest `resolved` link to `target` from an active entry; proposed sources do not count. */
  const resolution = (target: string): { hlc: string; by: string } | null => {
    let best: { hlc: string; by: string } | null = null;
    for (const r of live) {
      if (r.type !== "resolved" || r.target !== target || !isActive(r.source)) continue;
      if (best === null || r.addedHlc < best.hlc) best = { hlc: r.addedHlc, by: r.source };
    }
    return best;
  };

  const out: Signal[] = [];
  for (const e of entries) {
    const opensAsJournal =
      e.kind === "journal" && (e.significance === "blocker" || e.significance === "incident");
    const blocking = e.kind === "task"
      ? live.filter((r) => r.type === "blocks" && r.source === e.id && byId.get(r.target)?.kind === "task")
      : [];
    if (opensAsJournal || blocking.length > 0) {
      // A retired entry that was never active (e.g. a rejected proposal) never opened a signal.
      if (e.status === "proposed" || (e.status !== "active" && !e.retiredHlc)) continue;
      const res = resolution(e.id);
      let resolvedHlc = minHlc(res?.hlc ?? null, e.retiredHlc ?? null);
      let resolvedBy = res && res.hlc === resolvedHlc ? res.by : resolvedHlc ? "retired" : null;
      const openedHlc = opensAsJournal ? e.createdHlc : blocking.map((r) => r.addedHlc).reduce(maxHlc, e.createdHlc);
      if (!opensAsJournal) {
        // The blocked task leaving active also closes the signal.
        for (const r of blocking) {
          const t = byId.get(r.target);
          if (t?.retiredHlc && (resolvedHlc === null || t.retiredHlc < resolvedHlc)) {
            resolvedHlc = t.retiredHlc;
            resolvedBy = "retired";
          }
        }
      }
      out.push({ entryId: e.id, scope: e.scope, source: opensAsJournal ? "journal" : "task", openedHlc, resolvedHlc, resolvedBy });
    }
  }

  const flagsByEntry = new Map<string, SignalFlag[]>();
  for (const f of flags) flagsByEntry.set(f.entry, [...(flagsByEntry.get(f.entry) ?? []), f]);
  for (const [entryId, fs] of flagsByEntry) {
    const e = byId.get(entryId);
    if (!e) continue;
    const open = fs.some((f) => !f.resolvedHlc);
    const opened = fs.map((f) => f.flaggedHlc).reduce((a, b) => (a < b ? a : b));
    const resolved = open ? null : fs.map((f) => f.resolvedHlc as string).reduce(maxHlc);
    out.push({ entryId, scope: e.scope, source: "flag", openedHlc: opened, resolvedHlc: resolved, resolvedBy: resolved ? "flag" : null });
  }
  return out.sort((a, b) => (a.openedHlc < b.openedHlc ? -1 : a.openedHlc > b.openedHlc ? 1 : a.entryId < b.entryId ? -1 : 1));
}

/** Brief line for an open signal, e.g. `BLOCKER (2d): waiting on fixtures, ctxd:notes/01JAB...`. */
export function signalLine(label: string, ageMs: number, title: string, ref: string): string {
  const h = Math.floor(ageMs / 3_600_000);
  const age = h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
  return `${label.toUpperCase()} (${age}): ${title}, ${ref}`;
}
