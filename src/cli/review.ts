/**
 * `ctxd review` (SPEC v6 section 13): the review queue, approvals and review-rule management.
 *
 *   ctxd review                                             print the full report
 *   ctxd review --approve <ref>                              approve a proposed/conflicted entry
 *   ctxd review --rules --scope <s>                          list a scope's review rules
 *   ctxd review --add-rule --scope <s> --kind <k> [--client <c>] [--confirmed-by-user]
 *   ctxd review --remove-rule --scope <s> --index <n>
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { openDatabase } from "../store/db.js";
import { buildReviewReport, addRule, listRules, removeRule, resolveEntry, type ReviewReport } from "../store/review.js";
import { CtxdError } from "../core/errors.js";

function printReport(report: ReviewReport): void {
  const counts = [
    `${report.proposed.length} proposed`,
    `${report.conflicted.length} conflicted`,
    `${report.auto_resolved.length} auto-resolved`,
    `${report.name_clashes.length} name clash(es)`,
    `${report.drift.length} drift notice(s)`,
    `${report.takeovers.length} takeover(s)`,
  ].join(", ");
  console.log(`ctxd review: ${counts}`);

  if (report.proposed.length) {
    console.log("\nProposed:");
    for (const i of report.proposed) console.log(`  ${i.ref}  [${i.kind}] ${i.title} (${i.created_by})`);
  }
  if (report.conflicted.length) {
    console.log("\nConflicted:");
    for (const i of report.conflicted) console.log(`  ${i.ref}  [${i.kind}] ${i.title} (${i.created_by})`);
  }
  if (report.auto_resolved.length) {
    console.log("\nAuto-resolved:");
    for (const i of report.auto_resolved) console.log(`  ${i.ref} (${i.at})`);
  }
  if (report.name_clashes.length) {
    console.log("\nName clashes:");
    for (const c of report.name_clashes) console.log(`  ${c.scope}/${c.kind}/"${c.name}": ${c.refs.join(", ")}`);
  }
  if (report.drift.length) {
    console.log("\nDrift:");
    for (const d of report.drift) console.log(`  ${d.ref} (${d.holder}): ${d.drift.join(", ")}`);
  }
  if (report.takeovers.length) {
    console.log("\nTakeovers:");
    for (const t of report.takeovers) console.log(`  ${t.ref}: ${t.holder} took over from ${t.taken_over_from}`);
  }
  if (report.rejections.length) {
    console.log("\nRejections (last 7 days):");
    for (const r of report.rejections) console.log(`  ${r.client}: ${r.count} ${r.code}${r.scope ? ` on ${r.scope}` : ""}`);
  }
}

export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      approve: { type: "string" },
      rules: { type: "boolean" },
      "add-rule": { type: "boolean" },
      "remove-rule": { type: "boolean" },
      scope: { type: "string" },
      kind: { type: "string" },
      client: { type: "string" },
      "confirmed-by-user": { type: "boolean" },
      index: { type: "string" },
      "data-dir": { type: "string" },
      config: { type: "string" },
    },
    strict: true,
  });

  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const ctx = resolveHumanWriteContext(db);

    if (values.approve) {
      const result = resolveEntry(ctx, values.approve);
      console.log(`ctxd review: ${result.ref} -> ${result.status}`);
      return 0;
    }

    if (values.rules) {
      if (!values.scope) {
        console.error("ctxd review --rules: --scope is required.");
        return 1;
      }
      const rules = listRules(db, values.scope);
      if (!rules.length) console.log(`ctxd review: no rules for ${values.scope}.`);
      else rules.forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r)}`));
      return 0;
    }

    if (values["add-rule"]) {
      if (!values.scope || !values.kind) {
        console.error("ctxd review --add-rule: --scope and --kind are required.");
        return 1;
      }
      const rules = addRule(ctx, values.scope, {
        kind: values.kind,
        client: values.client,
        confirmed_by_user: values["confirmed-by-user"] ? true : undefined,
        action: "auto-accept",
      });
      console.log(`ctxd review: rule added; ${values.scope} now has ${rules.length} rule(s).`);
      return 0;
    }

    if (values["remove-rule"]) {
      if (!values.scope || values.index === undefined) {
        console.error("ctxd review --remove-rule: --scope and --index are required.");
        return 1;
      }
      const rules = removeRule(ctx, values.scope, Number(values.index));
      console.log(`ctxd review: rule removed; ${values.scope} now has ${rules.length} rule(s).`);
      return 0;
    }

    printReport(buildReviewReport(db));
    return 0;
  } catch (err) {
    console.error(`ctxd review: ${err instanceof CtxdError ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
