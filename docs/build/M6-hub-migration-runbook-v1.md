# M6 hub migration runbook

This runbook moves an existing home node to a Mac Studio while preserving its node ID. Replace every angle bracket before running a command. Use scratch copies for the first rehearsal.

## 1. Rehearse and inspect

On the old hub, record the current identity and paths:

```bash
ctxd status
ctxd doctor
ctxd features
```

Check that the destination has the same ctxd build and a compatible Node version. Build ctxd on the destination, but do not run `ctxd init`. Adoption expects a copied, initialized data directory.

## 2. Stop the old hub

Stop the old service and confirm its health endpoint no longer answers. Do not run both copies with the same node ID.

```bash
ctxd service status
ctxd service uninstall
ctxd status
```

The uninstall command removes the launch agent, not the data directory. Keep the old machine stopped until the migration is accepted or rolled back.

## 3. Copy without changing the source

Copy the config directory and the configured data directory to staging paths on the destination. Preserve modes and extended attributes. The exact source paths depend on the old config.

```bash
rsync -aE --dry-run <old-host>:<old-config-dir>/ <staged-config-dir>/
rsync -aE --dry-run <old-host>:<old-data-dir>/ <staged-data-dir>/
rsync -aE <old-host>:<old-config-dir>/ <staged-config-dir>/
rsync -aE <old-host>:<old-data-dir>/ <staged-data-dir>/
```

Run `ctxd doctor` against the staged config and data. Confirm that signed events rebuild successfully. Check that every sealed pool expected on the new hub lists the destination node as enrolled before attempting a real unlock.

## 4. Adopt the copied identity

With no ctxd server running on the destination:

```bash
ctxd node adopt <new-node-name> --config <staged-config-file> --data-dir <staged-data-dir>
ctxd doctor --config <staged-config-file> --data-dir <staged-data-dir>
ctxd rebuild --config <staged-config-file> --data-dir <staged-data-dir>
```

The name changes. The node ID must match the value recorded on the old hub. Adoption refuses a running server, an uninitialized database and a name that collides with an active peer.

## 5. Move private connectivity

Inspect the old `tailscale serve` configuration and prepare the equivalent loopback forwarding on the destination. Do not configure Funnel or a public listener. Moving the real serve configuration is an owner step because it changes live Tailscale state.

After the destination owns the chosen MagicDNS name, update peer URLs if that name changed. Keep the ctxd MCP and sync listeners on `127.0.0.1`.

## 6. Start and verify

Install and start the destination service. Then check:

```bash
ctxd service status
ctxd status
ctxd doctor
ctxd sync
ctxd review
```

From each peer, run a sync and confirm that its vector advances. Create a disposable entry in an invented scope, sync it in both directions, purge it, sync again and rebuild both nodes. Confirm signature verification after purge. Unlock each sealed pool with the signed key helper, confirm enrolled peers receive ciphertext events, then lock it.

## 7. Accept or roll back

Accept the move only after peer sync, rebuild, purge verification, backups and sealed enrollment checks pass. Keep the old data copy offline as a rollback checkpoint.

For rollback, stop the destination service, restore the previous private serve configuration on the old hub, start the old service and verify health before allowing writes. Never run both copies at once. Copy data back only if the destination accepted writes; stop both sides first and treat the destination copy as the newer source.
