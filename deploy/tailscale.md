# Tailscale exposure (SPEC section 10.2)

Expose only the sync listener, to the tailnet only:

```bash
tailscale serve --bg --https=443 --set-path=/ctxd-sync http://127.0.0.1:7412
```

Verify the exact `serve` syntax for the installed Tailscale version.

**Never use `tailscale funnel`**, or any other public tunnel (ADR 0003).

ACL intent: only devices tagged `tag:ctxd-node` may reach port 443 on other `tag:ctxd-node` devices.

## Hub checklist (SPEC section 12)

The hub is the Mac that stays on, serves peers through `tailscale serve` above, and takes nightly
backups. Settings to check once, not re-verified by any ctxd command:

- Prevent sleep on power (System Settings > Lock Screen, or `pmset -c sleep 0` for a headless box).
- Restart automatically after a power failure (System Settings > General > Energy, "automatically
  start up after a power failure" or the UPS-equivalent setting if there is no UPS).
- FileVault on. Accept a manual unlock after power outages; ctxd never stores the FileVault
  passphrase or tries to automate around it.
- Battery charge limiting, if the hardware supports it, to reduce wear on a Mac that stays plugged
  in.

`ctxd doctor` (M4 slice 4) checks FileVault's own status on every run; the sleep, restart and
charge-limiting settings are not independently re-checked by any ctxd command, so this list is the
source of truth for them.

## Migrating to a new hub

1. Stop the old server (`ctxd service uninstall`, or `launchctl unload` the plist by hand).
2. Copy the data directory and config to the new machine (`ctxd backup` / `ctxd restore <file>`
   covers the database; the config file and the `tokens/` directory next to it still need a plain
   file copy, since they are never part of a backup archive).
3. Set the new machine's `node.name` in `config.toml`, keeping the same `node_id` the copied
   database already has, so peers keep recognizing this node under its existing identity.
   `ctxd node adopt` (named in SPEC section 12 as the alternative to this manual step) is not
   built yet; the manual edit above is the only supported path today. Flagged here rather than
   left implicit, per this repository's own rule to raise a spec/implementation gap instead of
   silently diverging from it.
4. Move the `tailscale serve` configuration (the command above) to the new machine.
5. Update each peer's recorded URL for this node (`ctxd node add-peer <name> <url>` again with the
   new address), or give the new machine a stable MagicDNS name on a dedicated tailnet machine name
   so peers never need updating at all.
