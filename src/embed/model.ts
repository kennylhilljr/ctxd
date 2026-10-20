/**
 * Local embedding model (SPEC v8 11.2.1, ADR 0004): a small, CPU-only, pinned ONNX model run via
 * @huggingface/transformers, cached under ctxd's own data folder rather than the library's
 * default location, so a node never silently depends on files outside ctxd's control.
 *
 * `env.allowRemoteModels = false` triggers a tokenizer-loading failure in this library version
 * even with a complete, correct cache (confirmed empirically), so the "never a surprise network
 * fetch" guarantee is enforced by ctxd's own `isModelCached` check instead: `loadEmbedder` only
 * ever calls the library's `pipeline()` after confirming the model's weight file already exists
 * on disk, and `fetchModel` is the only function in this module that can reach the network.
 *
 * The transformers import is dynamic, not a top-level import, so a node that never calls
 * `fetchModel` or `loadEmbedder` (semantic_search.compute off, no fetch run) never loads the
 * library or its native onnxruntime-node binding into memory at all.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Pinned via https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2 (sha), not "main". */
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const MODEL_DTYPE = "q8";
export const EMBEDDING_DIM = 384;

export function modelCacheDir(dataDir: string): string {
  return join(dataDir, "models");
}

function weightFile(dataDir: string): string {
  return join(modelCacheDir(dataDir), MODEL_ID, MODEL_REVISION, "onnx", "model_quantized.onnx");
}

/** Whether the pinned model's weight file is already cached locally. */
export function isModelCached(dataDir: string): boolean {
  const file = weightFile(dataDir);
  return existsSync(file) && statSync(file).size > 0;
}

/** Downloads and caches the model under dataDir (`ctxd model fetch`). The only network access in this module. */
export async function fetchModel(dataDir: string): Promise<void> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir(dataDir);
  await pipeline("feature-extraction", MODEL_ID, { revision: MODEL_REVISION, dtype: MODEL_DTYPE });
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Loads the embedder from the local cache only. Returns null without touching the network if the model is not cached yet. */
export async function loadEmbedder(dataDir: string): Promise<Embedder | null> {
  if (!isModelCached(dataDir)) return null;
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir(dataDir);
  const extractor = await pipeline("feature-extraction", MODEL_ID, { revision: MODEL_REVISION, dtype: MODEL_DTYPE });
  return {
    async embed(text: string): Promise<number[]> {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(output.data as Float32Array);
    },
  };
}
