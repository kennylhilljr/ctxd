import type Database from "better-sqlite3";

const coordinators = new WeakMap<Database.Database, Database.Database>();

export function registerOriginSequenceCoordinator(db: Database.Database, coordinator: Database.Database): void {
  coordinators.set(db, coordinator);
}

export function allocateOriginSeq(db: Database.Database, nodeId: string): number {
  const coordinator = coordinators.get(db) ?? db;
  const maximum = (coordinator.prepare("SELECT COALESCE(MAX(origin_seq), 0) AS value FROM events WHERE origin_node = ?").get(nodeId) as { value: number }).value;
  const row = coordinator.prepare(
    `INSERT INTO node_origin_sequences (node_id, next_seq) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET next_seq = MAX(node_origin_sequences.next_seq, excluded.next_seq) + 1
     RETURNING next_seq`,
  ).get(nodeId, maximum + 1) as { next_seq: number };
  return row.next_seq;
}
