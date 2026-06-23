# Layer 4 — Kubernetes exposure

Deploys the single stateful world (`replicaCount: 1`) with durable storage,
backups, and an **L4** Service for raw TCP 25565. Not horizontal scale —
self-healing + persistence + clean exposure.

## Files
- `values.yaml` — itzg `minecraft` Helm chart values (NeoForge 1.21.1, StatefulSet, PVC `/data`, mc-backup sidecar).
- `service.yaml` — reference LoadBalancer/NodePort Service + the repo→live deploy-gate notes.

## Deploy
```bash
helm repo add itzg https://itzg.github.io/minecraft-server-charts/
helm upgrade --install mc itzg/minecraft -f k8s/values.yaml
```
> `kubectl` isn't installed on this host yet — set up / point at a cluster first.
> Minecraft is binary TCP: a normal HTTP Ingress will NOT route it — use L4
> (LoadBalancer, or NodePort + MetalLB). Many worlds behind one IP ⇒ `mc-router`.

## Confirm at install
- Current NeoForge `21.1.x` build number (`maven.neoforged.net`) for `extraEnv.NEOFORGE_VERSION`.
- The env-passthrough key on your chart version (`extraEnv` vs `env`); pin the chart `version`.
- Cluster has a LoadBalancer provider (or use NodePort). There is **no** `neoForgeVersion` chart key.
