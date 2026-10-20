/** `ctxd model fetch|status` (SPEC v8 11.2.1): downloads and caches the pinned embedding model, or reports whether it is cached. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { resolveConfigPath, resolveDataDir, resolveHumanWriteContext } from "./common.js";
import { fetchModel, isModelCached, MODEL_ID, MODEL_REVISION, modelCacheDir } from "../embed/model.js";
import { loadConfig } from "../config/config.js";
import { requireFlag, resolveFlags } from "../config/flags.js";
import { openDatabase } from "../store/db.js";
import { LoopbackTextModel } from "../local-model/client.js";
import { runLocalModelSuggestions } from "../local-model/suggestions.js";

async function runFetch(dataDir: string): Promise<number> {
  if (isModelCached(dataDir)) {
    console.log(`ctxd model: ${MODEL_ID}@${MODEL_REVISION.slice(0, 8)} is already cached at ${modelCacheDir(dataDir)}.`);
    return 0;
  }
  console.log(`ctxd model: fetching ${MODEL_ID}@${MODEL_REVISION.slice(0, 8)} to ${modelCacheDir(dataDir)}...`);
  try {
    await fetchModel(dataDir);
  } catch (err) {
    console.error(`ctxd model: fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log("ctxd model: fetched. Embedding and hybrid search can now run fully offline.");
  return 0;
}

function runStatus(dataDir: string): number {
  const cached = isModelCached(dataDir);
  console.log(`ctxd model: ${MODEL_ID}@${MODEL_REVISION.slice(0, 8)} is ${cached ? "cached" : "not cached"} at ${modelCacheDir(dataDir)}.`);
  console.log(cached ? "Embedding and semantic search can run fully offline." : `Run "ctxd model fetch" to download it (one-time, needs network).`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "fetch" && sub !== "status" && sub !== "suggest") {
    console.error(`ctxd model: unknown subcommand "${sub}". Use fetch, status or suggest.`);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  if (sub === "fetch") return runFetch(dataDir);
  if (sub === "status") return runStatus(dataDir);
  const config = loadConfig(resolveConfigPath({ configPath: values.config }));
  const flags = resolveFlags(config);
  requireFlag(flags, "local_model");
  const db = openDatabase(join(dataDir, "ctxd.db"));
  try {
    const ctx = resolveHumanWriteContext(db); ctx.flags = flags;
    const result = await runLocalModelSuggestions(ctx, new LoopbackTextModel(config.local_model.endpoint, config.local_model.model, config.local_model.timeout_ms));
    console.log(`ctxd model: ${result.proposed} proposal(s), ${result.failed} failed source(s).`);
    return result.failed > 0 ? 1 : 0;
  } finally { db.close(); }
}
