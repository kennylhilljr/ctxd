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
    })
    .default({ listen: "127.0.0.1:7412", interval_seconds: 120 }),
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
    .object({
      age_recipient: z.string().default(""),
      copy_to: z.string().default(""),
      /** `ctxd backup schedule install`'s launchd StartCalendarInterval time, "HH:MM" local (W4). */
      schedule: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").default("03:15"),
    })
    .default({ age_recipient: "", copy_to: "", schedule: "03:15" }),
  hooks: z
    .object({
      bypass_patterns: z.array(z.string()).default([]),
      session_start_max_chars: z.number().int().min(1).default(9500),
      crash_grace_minutes: z.number().int().min(1).default(30),
    })
    .default({ bypass_patterns: [], session_start_max_chars: 9500, crash_grace_minutes: 30 }),
  mirror: z
    .object({
      enabled: z.boolean().default(false),
      dir: z.string().default("~/Library/Application Support/ctxd/mirror"),
    })
    .default({ enabled: false, dir: "~/Library/Application Support/ctxd/mirror" }),
  sealed: z
    .object({ unlock_minutes: z.number().int().min(1).default(60), key_helper: z.string().default("ctxd-keyhelper") })
    .default({ unlock_minutes: 60, key_helper: "ctxd-keyhelper" }),
  local_model: z
    .object({ endpoint: z.string().url().default("http://127.0.0.1:11434/api/generate"), model: z.string().min(1).default("ctxd-local"), timeout_ms: z.number().int().min(100).default(30_000) })
    .default({ endpoint: "http://127.0.0.1:11434/api/generate", model: "ctxd-local", timeout_ms: 30_000 }),
  /** Weekly digest (SPEC v8 11.5): only digest_node writes digests, on digest_weekday after 18:00 local. */
  journal: z
    .object({
      digest_node: z.string().default(""),
      digest_weekday: z
        .enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])
        .default("sunday"),
    })
    .default({ digest_node: "", digest_weekday: "sunday" }),
  /** Native skill sync (SPEC v8 12.2): writes approved skills into a client's personal skills folder. */
  skills: z
    .object({
      sync_clients: z.array(z.string()).default([]),
      include_scopes: z.array(z.string()).default(["_me"]),
      keep_allowed_tools: z.boolean().default(false),
    })
    .default({ sync_clients: [], include_scopes: ["_me"], keep_allowed_tools: false }),
  /** Feature flags (PRD-feature-flags-v1 section 2): per machine, never synced. */
  features: z.record(z.string(), z.boolean()).default({}),
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
