# Layer 5 — OpenShell egress sandbox (wraps the AGENT, not the server)

OpenShell is **egress-only** — it cannot host the inbound Minecraft listener. The
game server runs as a normal container/pod (Layer 1/4). This layer exists to make
the agent's **broad autonomy** survivable by clamping its *outbound* blast radius.

## Files
| File | What |
|---|---|
| `policy.yaml` | default-deny egress allowlist (Anthropic, Modrinth, GitHub, NeoForge maven) + non-root + writable `/sandbox` only |
| `Dockerfile` | custom long-lived agent image (non-root uid/gid `1000660000`, `claude-code`, Hermes) |
| `run.sh` | gateway register → sandbox create → `policy set` → connect; includes the kill switch |

## Bring-up
```bash
bash openshell/run.sh        # confirm each `openshell ... --help` first (see docs/install-runbook.md)
```

## Confirm at install (these are [ILLUSTRATIVE] until checked on YOUR build)
- `openshell sandbox create` flag set + whether `<name>` is required.
- Supervisor **keep-alive** across disconnect (undocumented) — or self-supervise Hermes.
- Binary paths in `policy.yaml` `binaries[]` (`which git curl gh node claude` in the image).
- `openshell policy set` exact arg order; `policy update` incremental flags.

> What the sandbox does NOT stop: a prompt-injected agent misusing granted
> capabilities, or exfil via an allowed host (SNI-filtered, not payload-inspected).
> The deploy gate + PR review + no-secrets-in-box cover that. See `../docs/security.md`.
