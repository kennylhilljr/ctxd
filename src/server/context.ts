import type Database from "better-sqlite3";
import type { HlcClock } from "../core/hlc.js";
import type { Vendor } from "../core/kinds.js";

/**
 * Everything a tool handler needs to act on behalf of one authenticated request
 * (SPEC v6 section 10.5): the resolved client and the pools its persona assumes this session.
 */
export interface RequestContext {
  db: Database.Database;
  clock: HlcClock;
  nodeId: string;
  clientId: string;
  clientName: string;
  vendor: Vendor;
  /** The session persona's pools; [] means _me-only (SPEC v6 section 8.4). */
  assumedPools: readonly string[];
}
