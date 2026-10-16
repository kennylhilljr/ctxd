import type { NodeRole, Replication, Vendor, VendorPolicy } from "../core/kinds.js";

/** Replication filter (SPEC section 7.2): may an event in this scope be sent to this node? */
export function mayReplicate(replication: Replication, targetRole: NodeRole): boolean {
  switch (replication) {
    case "all":
      return true;
    case "home":
      return targetRole === "home";
    case "local":
      return false;
  }
}

/** Vendor policy (SPEC section 10.1): may a client from this vendor read this scope? */
export function mayRead(vendorPolicy: VendorPolicy, clientVendor: Vendor): boolean {
  if (vendorPolicy === "any") return true;
  return clientVendor === "local" || clientVendor === "human";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Bind check (ADR 0003): refuse any non-loopback listener. */
export function assertLoopback(listen: string): void {
  const host = listen.startsWith("[") ? listen.slice(1, listen.indexOf("]")) : listen.split(":")[0] ?? "";
  if (!LOOPBACK.has(host)) {
    throw new Error(`Refusing to listen on ${listen}: ctxd binds to loopback only (ADR 0003).`);
  }
}
