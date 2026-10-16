# Tailscale exposure (SPEC section 10.2)

Expose only the sync listener, to the tailnet only:

```bash
tailscale serve --bg --https=443 --set-path=/ctxd-sync http://127.0.0.1:7412
```

Verify the exact `serve` syntax for the installed Tailscale version.

**Never use `tailscale funnel`**, or any other public tunnel (ADR 0003).

ACL intent: only devices tagged `tag:ctxd-node` may reach port 443 on other `tag:ctxd-node` devices.
