/** `ctxd scope add|bind|unbind`: manage scopes (SPEC v6 section 13). */
import { parseArgs } from "node:util";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { resolveDataDir } from "./common.js";
import { openDatabase } from "../store/db.js";
import { newId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import { REPLICATIONS, VENDOR_POLICIES, type Replication, type VendorPolicy } from "../core/kinds.js";
import { bindScope, unbindScope } from "../store/scopeRepos.js";

export function addScope(db: Database.Database, name: string, replication: Replication, vendorPolicy: VendorPolicy): number {
  if (db.prepare("SELECT 1 FROM scopes WHERE name = ?").get(name)) {
    console.error(`ctxd scope: "${name}" already exists.`);
    return 1;
  }
  db.prepare(
    "INSERT INTO scopes (scope_id, name, kind, replication, vendor_policy, created_at) VALUES (?, ?, 'project', ?, ?, ?)",
  ).run(newId(), name, replication, vendorPolicy, nowIso());
  console.log(`ctxd scope added: ${name} (replication: ${replication}, vendor policy: ${vendorPolicy})`);
  return 0;
}

/** `ctxd scope bind <scope> --repo <normalized origin>` (SPEC v6 sections 3, 13). */
export function bindScopeCommand(db: Database.Database, scopeName: string, repo: string): number {
  const scope = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
  if (!scope) {
    console.error(`ctxd scope: "${scopeName}" does not exist.`);
    return 1;
  }
  bindScope(db, repo, scope.scope_id);
  console.log(`ctxd scope bound: ${repo} -> ${scopeName}`);
  return 0;
}

/** `ctxd scope unbind <repo>` (SPEC v6 sections 3, 13). */
export function unbindScopeCommand(db: Database.Database, repo: string): number {
  if (unbindScope(db, repo)) {
    console.log(`ctxd scope unbound: ${repo}`);
  } else {
    console.log(`ctxd scope: no binding found for ${repo}.`);
  }
  return 0;
}

export function run(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub !== "add" && sub !== "bind" && sub !== "unbind") {
    console.error(`ctxd scope: unknown subcommand "${sub}". Use add, bind or unbind.`);
    return 2;
  }

  if (sub === "bind") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { repo: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const name = positionals[0];
    const repo = values.repo?.trim();
    if (!name || !repo) {
      console.error("Usage: ctxd scope bind <scope> --repo <normalized origin>");
      return 1;
    }
    const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
    const db = openDatabase(join(dataDir, "ctxd.db"));
    try {
      return bindScopeCommand(db, name, repo);
    } finally {
      db.close();
    }
  }

  if (sub === "unbind") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { "data-dir": { type: "string" }, config: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const repo = positionals[0]?.trim();
    if (!repo) {
      console.error("Usage: ctxd scope unbind <repo>");
      return 1;
    }
    const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
    const db = openDatabase(join(dataDir, "ctxd.db"));
    try {
      return unbindScopeCommand(db, repo);
    } finally {
      db.close();
    }
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      replication: { type: "string" },
      "vendor-policy": { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (!name) {
    console.error("Usage: ctxd scope add <name> [--replication all|home|local] [--vendor-policy any|local-only]");
    return 1;
  }
  const replication = (values.replication ?? "all") as Replication;
  if (!REPLICATIONS.includes(replication)) {
    console.error(`ctxd scope: --replication must be one of: ${REPLICATIONS.join(", ")}.`);
    return 1;
  }
  const vendorPolicy = (values["vendor-policy"] ?? "any") as VendorPolicy;
  if (!VENDOR_POLICIES.includes(vendorPolicy)) {
    console.error(`ctxd scope: --vendor-policy must be one of: ${VENDOR_POLICIES.join(", ")}.`);
    return 1;
  }
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    return addScope(db, name, replication, vendorPolicy);
  } finally {
    db.close();
  }
}
