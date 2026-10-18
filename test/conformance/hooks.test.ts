import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ADAPTERS, CTXD_HOOK_EVENTS } from "../../src/hooks/adapters.js";
import { FIXTURES } from "./fixtures.js";

/**
 * Conformance runner (SPEC v6 section 9.7): drives the real `ctxd hook` CLI (via `tsx`, so it
 * runs from source without requiring a prior `npm run build`) against the fixtures, asserting
 * exit code and output shape. Runs under a scratch config/data directory created fresh for this
 * test file; never touches real client configuration or real ctxd data.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

let configPath: string;
let dataDir: string;

beforeAll(() => {
  const scratch = mkdtempSync(join(tmpdir(), "ctxd-conformance-"));
  configPath = join(scratch, "config", "ctxd.toml");
  dataDir = join(scratch, "data");
  run(["init", "--config", configPath, "--data-dir", dataDir]);
  run(["client", "add", "claude-code", "--vendor", "anthropic", "--config", configPath, "--data-dir", dataDir]);
  run(["client", "add", "codex", "--vendor", "openai", "--config", configPath, "--data-dir", dataDir]);
}, 30_000);

function run(args: string[], stdin = ""): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: REPO_ROOT,
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

function runHook(event: string, client: string, stdin: Record<string, unknown>): { stdout: string; stderr: string; status: number } {
  const substituted = JSON.stringify(stdin).replaceAll("GUARDED_DATA_DIR", dataDir);
  return run(["hook", event, "--client", client, "--config", configPath, "--data-dir", dataDir], substituted);
}

describe("conformance: descriptor cross-checks (SPEC v6 9.7)", () => {
  it("every adapter event has at least one fixture", () => {
    for (const [clientId, adapter] of Object.entries(ADAPTERS)) {
      for (const event of CTXD_HOOK_EVENTS) {
        const hasFixture = FIXTURES.some((f) => f.client === clientId && f.event === event);
        expect(hasFixture, `${clientId} declares "${event}" (native ${adapter.events[event].native}) but has no fixture`).toBe(true);
      }
    }
  });

  it("no fixture expects a block on an event the adapter declares as non-blocking", () => {
    for (const fixture of FIXTURES) {
      if (fixture.expected.blocked) {
        expect(ADAPTERS[fixture.client]!.events[fixture.event].canBlock, `${fixture.client}/${fixture.event}/${fixture.variant} expects a block but canBlock is false`).toBe(true);
      }
    }
  });
});

describe("conformance: fixture replay against the real ctxd hook CLI", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.client} ${fixture.event} (${fixture.variant})`, () => {
      const result = runHook(fixture.event, fixture.client, fixture.stdin);

      expect(result.status, `exit code; stderr was: ${result.stderr}`).toBe(fixture.expected.exitCode);

      if (fixture.expected.blocked) {
        const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
        expect(parsed.decision).toBe("block");
        if (fixture.expected.blockReasonContains) expect(parsed.reason).toContain(fixture.expected.blockReasonContains);
      } else if (fixture.expected.textPresent) {
        expect(result.stdout.length).toBeGreaterThan(0);
        if (fixture.expected.textContains) expect(result.stdout).toContain(fixture.expected.textContains);
      } else {
        // No handler registered for this event yet (see fixtures.ts's file note), or a
        // non-blocking outcome: no output at all is the correct, current behavior.
        expect(result.stdout).toBe("");
      }
    });
  }
});

describe("conformance: a non-blocking event never exits non-zero", () => {
  it("every fixture whose event cannot block exits 0", () => {
    for (const fixture of FIXTURES) {
      if (!ADAPTERS[fixture.client]!.events[fixture.event].canBlock) {
        expect(fixture.expected.exitCode, `${fixture.client}/${fixture.event}/${fixture.variant}`).toBe(0);
      }
    }
  });
});
