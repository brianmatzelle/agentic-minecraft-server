# Architecture & the reality checks behind it

Grounded against primary sources (NVIDIA OpenShell, NousResearch/hermes-agent,
itzg/docker-minecraft-server, Claude Code docs) via a verified research sweep.

## The corrected design

```
Layer 0  Git repo — source of truth (compose, manifests, mod lists, guardrails)
Layer 1  Minecraft server  — itzg/minecraft-server, NeoForge, raw TCP 25565
            └─ a NORMAL container / K8s pod. NOT inside OpenShell.
Layer 2  Maintenance agent — Hermes Agent + claude-code skill + native cron;
            edits mod lists/config in the repo, opens PRs; never touches the
            live world. Runs INSIDE an OpenShell egress sandbox.
Layer 3  @Garvis Discord bot — friends request mods (-> scoped agent task -> PR)
            and get Windows-client install help.
Layer 4  Exposure — itzg Helm chart: StatefulSet + PVC(/data) + backup sidecar,
            Service type LoadBalancer/NodePort for TCP 25565.
Layer 5  OpenShell — default-deny egress allowlist around the AGENT only.
```

## Why these corrections

### OpenShell cannot host the game server
OpenShell's network model is **egress-only**. There is no inbound/ingress policy
concept — you cannot open a public listener on a sandbox. Services inside are
reached via a client-side `ssh -L` tunnel to the operator's loopback, or an
HTTP-only gateway. That is the opposite of what a public Minecraft listener
needs. So: **the server is a normal container; OpenShell wraps the agent**,
whose *outbound* traffic is exactly what we want to constrain.

### Kubernetes does not scale one world
A Minecraft world is a single stateful JVM that owns the world state. The itzg
Helm chart hard-codes `replicaCount: 1` ("Minecraft is not horizontally
scalable"). Two replicas on one volume = world corruption. On K8s, "scale" means
self-healing pod + durable PV + vertical tuning + clean L4 exposure. Real
multi-server scale-out is a *different* architecture: many independent worlds
behind a Velocity/BungeeCord proxy or `mc-router`.

### "NemoHermes" = Hermes Agent
The product is **Hermes Agent** (NousResearch/hermes-agent), configured under
`~/.hermes/`. "NemoHermes" is NVIDIA's alias for running that same agent *inside*
an OpenShell sandbox. For async repo maintenance we use plain Hermes (native
cron + bundled `claude-code` skill) and add the OpenShell sandbox as the
isolation layer.

## Confidence & open gaps
Concrete OpenShell policy/CLI syntax, the exact Hermes `config.yaml` schema
version, and whether a K8s Service can attach to an OpenShell sandbox pod were
flagged for confirmation against the *installed* versions. The deep-research pass
fills these; anything still unverified is marked `[ILLUSTRATIVE]` in the layer
configs and must be checked at install time.
