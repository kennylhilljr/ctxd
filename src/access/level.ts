import type { AccessLevel, ScopeKind, Vendor, VendorPolicy } from "../core/kinds.js";

/**
 * Access evaluation (SPEC v5 sections 10.5 and 10.7; PRD-pools-access-v2 sections 5 to 7).
 * Pure functions over a snapshot of access metadata. Default deny.
 * Every call is evaluated under the session's persona: the pools assumed by its persona token.
 */

export interface ClientInfo {
  id: string;
  vendor: Vendor;
  tags: readonly string[];
}

export interface ScopeInfo {
  id: string;
  kind: ScopeKind;
  /** For kind "hold": the owning client id. For kind "profile": the owning pool id. */
  owner?: string;
  vendorPolicy: VendorPolicy;
}

export interface PoolGrant {
  poolId: string;
  scopeId: string;
  level: Exclude<AccessLevel, "none">;
}

export interface TemporaryGrant {
  clientId: string;
  scopeId: string;
  level: Exclude<AccessLevel, "none">;
  expiresAt: number;
}

export interface AccessSnapshot {
  grants: readonly PoolGrant[];
  /** pool id -> principals ("client:<id>" or "tag:<tag>") */
  members: ReadonlyMap<string, readonly string[]>;
  /** pool id -> vendor policy default for scopes in that pool, if any */
  poolVendorDefaults: ReadonlyMap<string, VendorPolicy>;
  temporary: readonly TemporaryGrant[];
}

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, propose: 2, write: 3 };

export function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function atLeast(level: AccessLevel, min: AccessLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** Pools the client belongs to, directly or by tag. */
export function poolsOf(client: ClientInfo, snapshot: AccessSnapshot): string[] {
  const principals = new Set([`client:${client.id}`, ...client.tags.map((t) => `tag:${t}`)]);
  const out: string[] = [];
  for (const [poolId, members] of snapshot.members) {
    if (members.some((m) => principals.has(m))) out.push(poolId);
  }
  return out.sort();
}

/** Strictest vendor policy across the scope's own setting and every pool containing it. */
export function effectiveVendorPolicy(scope: ScopeInfo, snapshot: AccessSnapshot): VendorPolicy {
  if (scope.vendorPolicy === "local-only") return "local-only";
  for (const g of snapshot.grants) {
    if (g.scopeId === scope.id && snapshot.poolVendorDefaults.get(g.poolId) === "local-only") return "local-only";
  }
  return "any";
}

/** Pools that actually contribute grants in this session: assumed by the token and still a membership. */
export function effectivePools(client: ClientInfo, snapshot: AccessSnapshot, assumedPools?: readonly string[]): string[] {
  const member = poolsOf(client, snapshot);
  if (!assumedPools) return member;
  const assumed = new Set(assumedPools);
  return member.filter((p) => assumed.has(p));
}

export function accessLevel(
  client: ClientInfo,
  scope: ScopeInfo,
  snapshot: AccessSnapshot,
  now: number = Date.now(),
  assumedPools?: readonly string[],
): AccessLevel {
  // 1. Human client: everything.
  if (client.vendor === "human") return "write";

  // 5 (applied early, overrides everything below). Vendor policy.
  if (effectiveVendorPolicy(scope, snapshot) === "local-only" && client.vendor !== "local") return "none";

  // 3. Holding scopes: owner only, writes forced to proposed.
  if (scope.kind === "hold") return scope.owner === client.id ? "propose" : "none";

  // 4. Grants from pools and unexpired temporary grants.
  const pools = new Set(effectivePools(client, snapshot, assumedPools));
  let level: AccessLevel = "none";
  for (const g of snapshot.grants) {
    if (g.scopeId === scope.id && pools.has(g.poolId)) level = maxLevel(level, g.level);
  }
  for (const t of snapshot.temporary) {
    if (t.clientId === client.id && t.scopeId === scope.id && t.expiresAt > now) level = maxLevel(level, t.level);
  }

  // Profiles: members of the owning pool read them at least.
  if (scope.kind === "profile" && scope.owner && pools.has(scope.owner)) level = maxLevel(level, "read");

  // 2. Global _me: everyone reads; agents write at propose unless granted write.
  if (scope.kind === "me") level = maxLevel(level, "propose");

  return level;
}

/**
 * Session working set (SPEC v4 10.5, PRD-pools-access section 6): the session scope (if readable),
 * global _me, and the profiles of the client's pools that grant the session scope.
 * If poolOverride is given (CTXD_POOL), only that pool is considered.
 */
export function workingSet(
  client: ClientInfo,
  sessionScope: ScopeInfo | null,
  allScopes: readonly ScopeInfo[],
  snapshot: AccessSnapshot,
  poolOverride?: string,
  now: number = Date.now(),
): string[] {
  const set = new Set<string>();
  for (const s of allScopes) if (s.kind === "me") set.add(s.id);
  let pools = poolsOf(client, snapshot);
  if (poolOverride) pools = pools.filter((p) => p === poolOverride);
  const assumed = poolOverride ? pools : undefined;
  if (sessionScope && atLeast(accessLevel(client, sessionScope, snapshot, now, assumed), "read")) {
    if (!poolOverride || snapshot.grants.some((g) => g.poolId === poolOverride && g.scopeId === sessionScope.id)) {
      set.add(sessionScope.id);
    }
    const poolsWithScope = pools.filter((p) => snapshot.grants.some((g) => g.poolId === p && g.scopeId === sessionScope.id));
    for (const s of allScopes) if (s.kind === "profile" && s.owner && poolsWithScope.includes(s.owner)) set.add(s.id);
  } else if (poolOverride && pools.length > 0) {
    for (const s of allScopes) if (s.kind === "profile" && s.owner === poolOverride) set.add(s.id);
  }
  return [...set].sort();
}

/** Opaque reference for traversal targets the session cannot read (SPEC v5 10.7). */
export interface RestrictedRef {
  ref: string;
  restricted: true;
}

/**
 * Traversal rule: re-check access on every hop. Returns the entry unchanged when readable,
 * otherwise an opaque reference with no kind, title, summary or status.
 */
export function visibleOrRestricted<T extends { ref: string }>(
  target: T,
  targetScope: ScopeInfo,
  client: ClientInfo,
  snapshot: AccessSnapshot,
  assumedPools: readonly string[] | undefined,
  sealedLocked: (scope: ScopeInfo) => boolean = () => false,
  now: number = Date.now(),
): T | RestrictedRef {
  if (sealedLocked(targetScope) || !atLeast(accessLevel(client, targetScope, snapshot, now, assumedPools), "read")) {
    return { ref: target.ref, restricted: true };
  }
  return target;
}

export type WriteDecision = { kind: "write" } | { kind: "propose" } | { kind: "hold" } | { kind: "forbidden" };

/** Write path step 1 (SPEC v4 section 6): what happens to a write into this scope. */
export function decideWrite(level: AccessLevel, vendorBlocked: boolean): WriteDecision {
  if (vendorBlocked) return { kind: "forbidden" };
  if (level === "write") return { kind: "write" };
  if (level === "propose") return { kind: "propose" };
  return { kind: "hold" };
}
