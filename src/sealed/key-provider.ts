import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CtxdError } from "../core/errors.js";

export interface SealedKeyProvider {
  create(poolId: string): Buffer;
  get(poolId: string): Buffer;
  remove(poolId: string): void;
  /** W2: installs a key received via an authenticated transfer, rather than generating a new one. Overwrites any existing key for this pool, same as a fresh enrollment would. */
  store(poolId: string, key: Buffer): void;
}

export class TestKeyProvider implements SealedKeyProvider {
  readonly keys = new Map<string, Buffer>();
  create(poolId: string): Buffer {
    const existing = this.keys.get(poolId);
    if (existing) return Buffer.from(existing);
    const key = randomBytes(32);
    this.keys.set(poolId, key);
    return Buffer.from(key);
  }
  get(poolId: string): Buffer {
    const key = this.keys.get(poolId);
    if (!key) throw new CtxdError("NOT_ALLOWED", `Sealed pool ${poolId} is locked`);
    return Buffer.from(key);
  }
  remove(poolId: string): void { this.keys.delete(poolId); }
  store(poolId: string, key: Buffer): void {
    if (key.length !== 32) throw new CtxdError("VALIDATION", "Sealed pool key must be 32 bytes");
    this.keys.set(poolId, Buffer.from(key));
  }
}

export class KeyHelperProvider implements SealedKeyProvider {
  constructor(private readonly executable = "ctxd-keyhelper") {}
  private run(action: "create" | "get" | "remove" | "store", poolId: string, extraArg?: string): Buffer {
    const args = extraArg === undefined ? [action, poolId] : [action, poolId, extraArg];
    const result = spawnSync(this.executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new CtxdError("NOT_ALLOWED", result.stderr.trim() || `Key helper failed for ${poolId}`);
    const value = result.stdout.trim();
    if (action === "remove" || action === "store") return Buffer.alloc(0);
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new CtxdError("VALIDATION", "Key helper returned an invalid sealed pool key");
    return key;
  }
  create(poolId: string): Buffer { return this.run("create", poolId); }
  get(poolId: string): Buffer { return this.run("get", poolId); }
  remove(poolId: string): void { this.run("remove", poolId); }
  store(poolId: string, key: Buffer): void {
    if (key.length !== 32) throw new CtxdError("VALIDATION", "Sealed pool key must be 32 bytes");
    this.run("store", poolId, key.toString("base64"));
  }
}
