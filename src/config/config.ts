import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

/** Node configuration (SPEC section 3). */

const listen = z.string().regex(/^(\[[^\]]+\]|[^:]+):\d+$/, "host:port");

export const configSchema = z.object({
  node: z.object({
    name: z.string().min(1),
    role: z.enum(["home", "roaming"]),
    data_dir: z.string().default("~/Library/Application Support/ctxd"),
  }),
  mcp: z.object({ listen: listen.default("127.0.0.1:7411") }).default({ listen: "127.0.0.1:7411" }),
  sync: z
    .object({
      listen: listen.default("127.0.0.1:7412"),
      interval_seconds: z.number().int().min(15).default(120),
      peers: z.array(z.object({ name: z.string(), url: z.url() })).default([]),
    })
    .default({ listen: "127.0.0.1:7412", interval_seconds: 120, peers: [] }),
  brief: z
    .object({
      micro_tokens: z.number().int().default(300),
      normal_tokens: z.number().int().default(1500),
      full_tokens: z.number().int().default(4000),
    })
    .default({ micro_tokens: 300, normal_tokens: 1500, full_tokens: 4000 }),
  nudge: z
    .object({
      enabled: z.boolean().default(true),
      min_minutes_between: z.number().int().min(1).default(30),
      turns_threshold: z.number().int().min(1).default(20),
      completion_markers: z.array(z.string()).default(["done", "implemented", "merged", "complete"]),
    })
    .default({
      enabled: true,
      min_minutes_between: 30,
      turns_threshold: 20,
      completion_markers: ["done", "implemented", "merged", "complete"],
    }),
  scope_map: z.record(z.string(), z.string()).default({}),
  backup: z
    .object({ age_recipient: z.string().default(""), copy_to: z.string().default("") })
    .default({ age_recipient: "", copy_to: "" }),
});

export type CtxdConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "ctxd", "config.toml");

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): CtxdConfig {
  const raw = parse(readFileSync(path, "utf8"));
  return configSchema.parse(raw);
}
