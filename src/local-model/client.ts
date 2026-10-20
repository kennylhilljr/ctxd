import { CtxdError } from "../core/errors.js";

export interface TextModel {
  readonly modelId: string;
  complete(prompt: string): Promise<string>;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export class LoopbackTextModel implements TextModel {
  readonly modelId: string;
  private readonly endpoint: URL;
  constructor(endpoint: string, model: string, private readonly timeoutMs = 30_000, private readonly fetchImpl: typeof fetch = fetch) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== "http:" || !isLoopback(this.endpoint.hostname)) {
      throw new CtxdError("VALIDATION", "Local model endpoint must use HTTP on loopback");
    }
    this.modelId = model;
  }
  async complete(prompt: string): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.modelId, prompt, stream: false }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`local model returned HTTP ${response.status}`);
    const body = await response.json() as { response?: unknown; output?: unknown };
    const text = typeof body.response === "string" ? body.response : typeof body.output === "string" ? body.output : null;
    if (!text) throw new Error("local model returned no text");
    return text;
  }
}
