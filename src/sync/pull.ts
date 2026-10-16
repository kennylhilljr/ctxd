import { notImplemented } from "../core/todo.js";

export interface PullRequest {
  node: string;
  vector: Record<string, number>;
  limit: number;
}

export interface PullResponse {
  events: unknown[];
  through: Record<string, number>;
  more: boolean;
}

/** Serve POST /v1/pull with the replication filter (SPEC sections 7.1 and 7.2). Milestone M3. */
export function servePull(_req: PullRequest): PullResponse {
  return notImplemented("servePull", "M3");
}

/** Pull loop against one peer until more is false (SPEC section 7.1). Milestone M3. */
export async function pullFromPeer(_peerUrl: string): Promise<void> {
  notImplemented("pullFromPeer", "M3");
}
