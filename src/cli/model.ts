/** `ctxd model fetch|status` (SPEC v8 11.2.1): downloads and caches the pinned embedding model, or reports whether it is cached. */
import { parseArgs } from "node:util";
import { resolveDataDir } from "./common.js";
import { fetchModel, isModelCached, MODEL_ID, MODEL_REVISION, modelCacheDir } from "../embed/model.js";

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
  if (sub !== "fetch" && sub !== "status") {
    console.error(`ctxd model: unknown subcommand "${sub}". Use fetch or status.`);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: { "data-dir": { type: "string" }, config: { type: "string" } },
    strict: true,
  });
  const dataDir = resolveDataDir({ dataDir: values["data-dir"], configPath: values.config });
  return sub === "fetch" ? runFetch(dataDir) : runStatus(dataDir);
}
