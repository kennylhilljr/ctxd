import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persona token secrets live only in the macOS Keychain (SPEC v6 section 8.4), never on disk,
 * in the database, or in process environment/logs. No Keychain library is pinned in
 * package.json, so this shells out to the system `security` binary (flagged for SPEC-v7)
 * rather than adding a native dependency for M1.
 */

export interface KeychainOptions {
  /** Injected in tests so they never touch the real keychain. */
  exec?: (args: readonly string[]) => string;
}

/**
 * Test seam for tests that drive real `ctxd` subprocesses and so cannot inject `exec`: a file-backed
 * stand-in for the three security(1) calls below. Honored only inside a Vitest run (`VITEST` set)
 * and only with `CTXD_TEST_KEYCHAIN_DIR` set as well, so an ordinary install never uses it.
 */
function testKeychain(dir: string, args: readonly string[]): string {
  const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
  const path = join(dir, createHash("sha256").update(`${flag("-s")}\0${flag("-a")}`).digest("hex"));
  switch (args[0]) {
    case "add-generic-password":
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, flag("-w"), { mode: 0o600 });
      return "";
    case "find-generic-password":
      return `${readFileSync(path, "utf8")}\n`;
    case "delete-generic-password":
      rmSync(path);
      return "";
    default:
      throw new Error(`unsupported test keychain call: ${args[0]}`);
  }
}

function runSecurity(args: readonly string[]): string {
  const testDir = process.env.VITEST ? process.env.CTXD_TEST_KEYCHAIN_DIR : undefined;
  if (testDir) return testKeychain(testDir, args);
  // stderr is suppressed: a "not found" result is an expected, already-handled outcome (readSecret
  // and deleteSecret both catch it), and letting the system security(1) binary print its own
  // diagnostic straight to this process's stderr would look like an unhandled error to the user.
  return execFileSync("/usr/bin/security", args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function storeSecret(service: string, account: string, secret: string, opts: KeychainOptions = {}): void {
  const exec = opts.exec ?? runSecurity;
  exec(["add-generic-password", "-a", account, "-s", service, "-w", secret, "-U"]);
}

export function readSecret(service: string, account: string, opts: KeychainOptions = {}): string | null {
  const exec = opts.exec ?? runSecurity;
  try {
    return exec(["find-generic-password", "-a", account, "-s", service, "-w"]).replace(/\n$/, "");
  } catch {
    return null;
  }
}

export function deleteSecret(service: string, account: string, opts: KeychainOptions = {}): void {
  const exec = opts.exec ?? runSecurity;
  try {
    exec(["delete-generic-password", "-a", account, "-s", service]);
  } catch {
    // Already absent; deletion is idempotent.
  }
}
