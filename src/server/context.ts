import type Database from "better-sqlite3";
import type { HlcClock } from "../core/hlc.js";
import type { Vendor } from "../core/kinds.js";
import type { SealedPoolStore } from "../sealed/store.js";

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
  /**
   * Effective feature flags, reloaded from config.toml and the environment per request
   * (PRD-feature-flags-v1). Optional so the many existing test fixtures that build a
   * RequestContext literal keep compiling; isFlagOn(undefined-safe call sites) treats a missing
   * map as "every flag on", matching the pre-M3 behavior those fixtures exercise.
   */
  flags?: Map<string, boolean>;
  /** The node's data directory, for loading the local embedding model at query time (SPEC v8 11.2). Optional for the same reason as `flags`. */
  dataDir?: string;
  sealedStore?: SealedPoolStore;
}
