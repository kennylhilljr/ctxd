import { execFileSync } from "node:child_process";

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

function runSecurity(args: readonly string[]): string {
  return execFileSync("/usr/bin/security", args as string[], { encoding: "utf8" });
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
