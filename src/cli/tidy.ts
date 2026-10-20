/**
 * `ctxd tidy` (SPEC v8 7.6.7): interactive cleanup suggestions, applied only once confirmed.
 *
 *   ctxd tidy [--scope <s>]            list every current finding, numbered
 *   ctxd tidy --apply <n> [--scope <s>]  apply finding #n from that same listing
 *
 * Findings are recomputed fresh on every call, not stored; `--apply <n>` must use the same
 * `--scope` (or lack of one) as the listing it is numbered against, same as `ctxd review
 * --remove-rule --index <n>` already works against its own listing.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { findTidyCandidates, applyTidyFinding, type TidyFinding } from "../store/tidy.js";
import { CtxdError } from "../core/errors.js";

function resolveScopeId(db: import("better-sqlite3").Database, scopeName: string | undefined): string | undefined {
  if (!scopeName) return undefined;
  const row = db.prepare("SELECT scope_id FROM scopes WHERE name = ?").get(scopeName) as { scope_id: string } | undefined;
  if (!row) throw new CtxdError("VALIDATION", `Unknown scope "${scopeName}"`, {}, "scope");
  return row.scope_id;
}

function printFindings(findings: TidyFinding[]): void {
  if (findings.length === 0) {
    console.log("ctxd tidy: nothing to suggest.");
    return;
  }
  console.log(`ctxd tidy: ${findings.length} finding(s)`);
  findings.forEach((f, i) => {
    const target = f.kind === "duplicate" ? `${f.ref} / ${f.other}` : f.ref;
    console.log(`  [${i}] ${f.kind}: ${target} -- ${f.reason}`);
  });
  console.log("\nApply one with: ctxd tidy --apply <n>");
}

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { apply: { type: "string" }, scope: { type: "string" }, "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const scopeId = resolveScopeId(db, values.scope);
    const findings = findTidyCandidates(db, scopeId);

    if (values.apply === undefined) {
      printFindings(findings);
      return 0;
    }

    const index = Number(values.apply);
    const finding = findings[index];
    if (!Number.isInteger(index) || !finding) {
      console.error(`ctxd tidy: no finding at index ${values.apply}. Run ctxd tidy (with the same --scope, if any) to see current indices.`);
      return 1;
    }
    const result = applyTidyFinding(resolveHumanWriteContext(db), finding);
    console.log(`ctxd tidy: ${result.ref} -> ${result.action}`);
    return 0;
  } catch (err) {
    console.error(`ctxd tidy: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
