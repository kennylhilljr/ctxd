// Preloaded with `node --import` by tests that run real `ctxd` subprocesses: a file-backed stand-in
// for the security(1) calls in src/access/keychain.ts, stored under CTXD_TEST_KEYCHAIN_DIR, so those
// tests never touch the developer's or CI runner's real Keychain.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CTXD_TEST_KEYCHAIN_DIR;
if (!dir) throw new Error("test-keychain.mjs needs CTXD_TEST_KEYCHAIN_DIR");

globalThis[Symbol.for("ctxd.testKeychainExec")] = (args) => {
  const flag = (name) => args[args.indexOf(name) + 1] ?? "";
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
};
