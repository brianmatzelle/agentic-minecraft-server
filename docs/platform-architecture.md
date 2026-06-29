# Multi-Tenant Teaching Platform — Architecture & Implementation Proposal

> **Status: PROPOSAL for human review. Not final.** Anything marked
> `[UNVERIFIED]` must be confirmed against a live cluster / the Anthropic
> Admin API / the Claude Code harness before it is relied upon. This document
> is the pivot plan from the current single-owner, single-world, PR-gated repo
> to a multi-tenant platform where each Discord friend-group gets its own
> fully-autonomous Minecraft world + AI operator.

---

## 1) TL;DR

- We pivot this repo from **one world + one PR-gated maintenance agent** into a
  **multi-tenant platform**: one Discord guild = one Kubernetes namespace = one
  Minecraft world + one **fully-autonomous** Garvis agent.
- Inside a tenant there are **no PRs, no approval gates**. The agent commits to
  its own `main`, adds/removes mods, edits config, ops/bans, restarts, snapshots
  — total power over its **own** sandbox. Breakage is expected and *fine*.
- The platform's only job is to keep breakage **inside one group's box**. There
  are exactly **three hard boundaries**: (1) **credential** — no master
  Anthropic key on any tenant box; a broker mints per-tenant, capped, revocable
  tokens; (2) **egress** — each namespace is network-fenced so it can't be
  weaponized against third parties; (3) **platform plane** — router, broker, and
  orchestrator are human-controlled and unreachable/unmodifiable by tenants.
- We **reuse** the strongest existing pieces: the PR#38 RCON verb catalog
  (`apps/garvis-bot/src/moderation.js`), PR#39 boot-health rollback
  (`scripts/deploy.sh`), PR#43 backup sidecar, and the OpenShell egress-allowlist
  *concept* (now Kubernetes NetworkPolicy).
- The current `docker compose` world keeps running as **"tenant zero"**
  throughout the early phases; nothing goes dark during the migration.
- Adversarial review surfaced ~30 distinct sandbox-escape paths (broker
  passthrough, kubelet image pulls, DNS tunneling, WIF subject matching, etc.).
  Every one has a concrete mitigation baked into §6.

---

## 2) Vision & the sandbox philosophy

The goal is to **teach gamers to operate a live service by letting them break
it.** A kid who downloads sketchy mods, infects their PC, and digs themselves
out learns more about computers than one who is never allowed to touch anything.
We want that learning loop — but with the blast radius contained to **the kid's
own machine**, never the family's bank account.

So the architecture is explicitly **not** trying to prevent breakage:

- A friend can trash their world, op a griefer, install a junk mod that
  crash-loops the server, or prompt-inject their own agent into deleting
  everything. **All of that is acceptable and expected.**
- What must **never** happen: one group's mess reaching **another group's**
  world, the **platform's** control plane, the **owner's Anthropic bill** beyond
  that group's cap, or **third parties** on the internet.

The childhood-virus analogy is the design's north star: **blast radius = your own
box.** Recovery (snapshots, git history, boot-health rollback) exists so that
"break it and learn" stays fun rather than terminal — but recovery is a
convenience *inside* the sandbox, while isolation is the *wall around* it.

This is a deliberate inversion of the current model. Today the safety story is
"PR review + the owner personally accepts residual risk." That cannot transfer:
there is no single owner who can accept supply-chain or moderation risk on behalf
of other groups (likely minors). So the safety story moves from an **in-tenant
gate** (PRs, deny rules, human approval) to **sandbox-escape boundaries**
(credential broker, egress fence, namespace RBAC). The in-tenant gate dissolves;
the wall around each tenant hardens.

---

## 3) Two-plane architecture

Two trust domains. The **platform plane** (`garvis-system`) is human-controlled,
holds every real secret, and is unreachable from tenants. Each **tenant plane**
(`tenant-<guildId>`) is a self-contained, fully-autonomous sandbox.

```
                                  Discord (one bot account, many guilds)
                                            │
══════════════════════════════ PLATFORM PLANE (namespace: garvis-system) ══════════════════════════════
   human-PR-gated · holds ALL real secrets · tenants can NEVER reach or modify it
   ┌─────────────────┐   ┌──────────────────────┐   ┌────────────────────────────────────────┐
   │  Router (bot)   │   │  Orchestrator /      │   │  Broker                                  │
   │  - Discord token│   │  Provisioner         │   │  - upstream Anthropic auth (WIF only)    │
   │  - guild→tenant │   │  - org:admin OAuth   │   │  - per-tenant budget + RPM/TPM + revoke  │
   │  - fast-lane    │   │  - ns/quota/netpol/  │   │  - STRICT path allowlist (/v1/messages)  │
   │    RCON verbs   │   │    RBAC/workspace    │   │  - ANTHROPIC_BASE_URL target for tenants │
   │  - slow-lane    │   │    lifecycle         │   └────────────────────────────────────────┘
   │    forward      │   └──────────────────────┘
   └───────┬─────────┘            │ creates/reaps                    ▲ inference only
           │ RCON-over-TCP        │ namespaces & creds               │ (per-tenant token)
           │ + agent RPC          ▼                                  │
═══════════╪══════════════════════╪══════ TENANT PLANE (one per guild) ═══════════════════════════════
           │                      │
  namespace tenant-<guildIdHash>  │            ... tenant-<otherGuild> (identical shape, isolated) ...
  ┌────────┼──────────────────────┼───────────────────────────────────────────────┐
  │  Deployment garvis-agent (claude CLI, FULL autonomy, no deny rules)            │
  │    - SA tenant-agent: namespaced Role ONLY (this ns)                           │
  │    - ANTHROPIC_BASE_URL → broker.garvis-system.svc  (NO master key on box)     │
  │    - in-namespace bare git repo (world.git) → push to own main, no PR          │
  │        │ kubectl (ns-scoped)        │ network RCON                              │
  │        ▼                            ▼                                          │
  │  StatefulSet mc (itzg, replicas:1, Recreate)  +  sidecar mc-backup            │
  │    /data ← world PVC (RWO)        /backups ← backups PVC                       │
  │  Service mc-rcon (ClusterIP :25575, internal)                                  │
  │  Service mc-play (:25565 via shared mc-router, NOT per-tenant LB)              │
  │                                                                                │
  │  NetworkPolicy: default-deny egress; allow → broker, Modrinth, Mojang/MS      │
  │   auth, NeoForge, name-allowlisting DNS, game ingress. NO api.anthropic.com,  │
  │   NO other namespace, NO cluster API for the game pod, NO metadata.           │
  │  ResourceQuota + LimitRange (cpu/mem/pods/pvc/ephemeral-storage/snapshots)    │
  │  PodSecurity: restricted (agent) / baseline-or-restricted (mc) [UNVERIFIED]   │
  └────────────────────────────────────────────────────────────────────────────────┘
           players → TCP 25565 → shared platform mc-router (SNI/hostname) → mc-play
```

Trust flows **strictly platform → tenant** (control). Nothing tenant-authored
ever executes on the platform plane: the fast lane runs only a fixed verb
catalog; the slow lane only forwards fenced *data* and renders the agent's reply
as opaque, sanitized bytes.

---

## 4) Tenant plane — one guild's namespace

### 4.1 What runs in the namespace

A near-1:1 port of `apps/server/docker-compose.yml` + `infra/k8s/values.yaml`,
plus the autonomous agent:

| Workload | Source | Notes |
|---|---|---|
| `mc` StatefulSet (`itzg/minecraft-server:java21`) | compose `minecraft` service | `replicas:1`, `Recreate`, `terminationGracePeriodSeconds:120`. `TYPE=NEOFORGE`, `VERSION` pinned (never `latest`), `USE_AIKAR_FLAGS=true`. |
| `mc-backup` **sidecar** (`itzg/mc-backup`) | compose `backups` service (PR#43) | In the **same pod** as `mc` (shares the RWO world volume in-pod; avoids the two-mounter problem). World mounted `:ro`, backups PVC rw, `RCON_HOST=localhost`. |
| `garvis-agent` Deployment (stock `claude` CLI) | `runClaude()` shape, `apps/garvis-bot/src/index.js` | **Separate** Deployment, not a sidecar, so it survives `mc` crash-loops to fix them. **All in-tenant guardrails removed.** |
| `mc-config` ConfigMap | per-tenant render of `server.env` | `OVERRIDE_WHITELIST/SERVER_PROPERTIES=true` keep it source of truth on every boot (ops persist in `ops.json`, not rewritten). |
| `mc-secrets` Secret | generated at provision | Per-tenant `RCON_PASSWORD` (never the compose default `minecraft`). |
| PVCs | new | `world` (RWO, /data), `backups`, `config-repo` (bare repo + clone), `agent-home` (~/.claude session state). |

**CRITICAL FIX carried into the template:** the compose stack sets
`MODRINTH_DOWNLOAD_DEPENDENCIES=none` (commit 2797963) so version pins hold, but
`infra/k8s/values.yaml:36` still says `required` — which silently upgrades pinned
mods and reintroduces the join-rejection bug. **The tenant template must use
`none`.** Keep `MODRINTH_ALLOWED_VERSION_TYPE=alpha` (CC:Tweaked ships alpha).

### 4.2 The autonomous agent's full power

The agent is the same stock `claude` CLI we spawn today, invoked
`claude -p --output-format json --max-turns N [--resume <id>]` — **minus** the
`--disallowedTools` argument. Inside its namespace it **CAN**:

- **git**: edit, commit, and `git push origin main` directly — **no PR, no
  approval**. Origin is an **in-namespace bare repo** (`file:///config-repo/world.git`),
  so there is **no GitHub credential on the box** and nothing to scope.
- **Claude Code**: no deny rules, `bypassPermissions` allowed, any file, any Bash.
- **kubectl (this namespace only)**: get/list/watch/patch on pods, statefulsets,
  configmaps, pvcs, jobs; `rollout restart`; create backup/restore Jobs.
- **RCON**: every verb in `moderation.js` — op/deop/ban/kick/whitelist/tp/give/
  gamerule/time/weather/difficulty/broadcast/restart — **ungated** (it's their world).
- **Mods**: add/remove/pin in `modlist.txt`, deploy via `tenant-deploy.sh` (a
  per-tenant fork of `scripts/deploy.sh`) with boot-health rollback.
- **Lifecycle**: restart, snapshot-then-restart, restore-from-backup.

It **CANNOT** (these are the three boundaries, not in-tenant restrictions): reach
`api.anthropic.com` directly, touch another namespace or the control plane,
egress to arbitrary internet, or exceed its budget. See §6.

The removed layers (vs today): `apps/agent/claude/settings.json` deny list,
`AGENT_DENY_TOOLS` in `index.js`, `block-downloaders.sh`, the
`managed-settings.json` bypass locks, and the PR-only/never-merge/never-push
rules in `CLAUDE.md`. That whole stack was the *in-tenant* guardrail the pivot
deletes on purpose.

### 4.3 Garvis intent flow — two lanes

One untrusted Discord message is routed into exactly one lane by a cheap,
trusted classifier (the PR#38 pipeline, generalized):

| | **FAST LANE** (structured) | **SLOW LANE** (open-ended) |
|---|---|---|
| Trigger | maps to ONE verb in the catalog (`op/ban/give/tp/restart/...`) | anything else ("add cobblemon", "why am I lagging?", "build an arena") |
| Executor | **platform router** (trusted) → tenant RCON | **tenant's own agent** in its namespace |
| LLM role | only NAMES verb+args; router re-validates and runs fixed RCON argv (no shell) | full Claude Code agent, full autonomy |
| Latency | sub-second | seconds → minutes |
| Credential | tenant broker token (for cost attribution) | tenant broker token ONLY |

End-to-end:

```
Discord MessageCreate (guildId=G, userId=U, untrusted text=T)
  platform router (one bot, many guilds)
   1. mentionsGarvis(msg)                         [reuse index.js:684]
   2. ctx = resolveTenant(G)                      [NEW tenants.js: ns, rconEndpoint,
        → null? "this server isn't provisioned"    ownerId, modRoleId, agentEndpoint, brokerToken]
   3. cheap deterministic prefilter, then classify(T, ctx)  [fencedData(T); LLM only emits {action,args}]
   4. FAST LANE: resolved? → role-gate destructive verbs on ctx.ownerId/ctx.modRoleId
        → runActionTenant(resolved, ctx): RCON-over-TCP to mc-rcon.<ns>.svc:25575
        → reply confirm(); DONE
   5. SLOW LANE: POST ctx.agentEndpoint {request: fencedData(T), threadId, sessionId}
        → tenant agent runs `claude -p` with its OWN broker creds; edits/commits/deploys its world
        → stream opaque, size-capped reply back to the Discord thread
```

The classifier prompt is platform-controlled and `T` is always fenced *data*, so
a prompt-injected message buys nothing on the platform plane: the worst an
injected OPEN verb does is a reversible, audited action the author could already
run; gated verbs are re-checked against the caller's tenant role regardless of
what the LLM emits.

**The one piece that does NOT port directly:** `moderation.js` `rconExec()` and
`whitelist.js` shell out to `docker exec <container> rcon-cli` against the host
Docker socket — that path does not exist in k8s. We swap the **transport** for a
**network Source-RCON client** to `mc-rcon.<ns>.svc:25575` (password from
`mc-secrets`), keeping the argv-array/no-shell property. Everything else in
`moderation.js` (`VERBS`, validators, `parseClassification`, `resolveAction`,
`catalogMenu`) is pure and reused verbatim. `dockerRestart()` becomes
`kubectl rollout restart statefulset/mc` (or the agent owns restart).
`[UNVERIFIED: rcon-client npm vs ~60-line homegrown TCP client — either keeps no-shell.]`

### 4.4 Snapshot / restore (safe-to-break substrate)

Two layers, both reused-and-generalized:

- **Archive (Layer A):** the `itzg/mc-backup` sidecar — RCON-quiesced
  (`save-off`/`save-all`/`save-on`) tar to a backups PVC, plus per-tenant offsite
  (restic/rclone, closing the `docs/backups.md` TODO). Scheduled retention +
  on-demand. Storage-agnostic; works today.
- **Checkpoint (Layer B):** CSI `VolumeSnapshot` of the world PVC for fast
  rollback, with a pre-snapshot RCON quiesce hook for app-consistency.
  `[UNVERIFIED: cluster CSI snapshot support — build the loop on Layer A first.]`

The agent runs **snapshot → change → restart → health-check → auto-rollback** on
every mutation (`tenant-apply.sh`, a snapshot-aware generalization of
`deploy.sh`'s `wait_for_ready()` boot-health detection). One-click Discord
restore is a new **gated + confirm** verb in the catalog, and a restore always
takes a `prerestore-<ts>` checkpoint first so a misclick is reversible.

**Key boundary:** the tenant can **CREATE/READ** snapshots and **request** a
restore, but **cannot DELETE** them — retention/GC is a platform-plane job (RBAC:
`create/get/list` on `VolumeSnapshot`, never `delete`; backup object-store creds
are append-only/object-lock). Otherwise a prompt-injected agent erases its own
safety net.

---

## 5) Platform plane

Three deployments in `garvis-system`, each holding exactly the secrets it needs
and nothing else.

### 5.1 Router (Discord gateway) — refactor of `apps/garvis-bot`

- **Multi-guild.** One bot account, many guilds. The single biggest code change:
  every module-scope env constant captured at import today (`MC_CONTAINER`,
  `MC_SERVER_ENV`, `OWNER_ID`/`MOD_ROLE_ID`, `SERVER` facts,
  `GARVIS_AGENT_WORKDIR`, `OPENSHELL_SANDBOX`) becomes a **per-request lookup
  keyed by `msg.guildId`** via `resolveTenant()` (new `tenants.js`).
- **Global command registration.** Switch `register-commands.js` from
  `Routes.applicationGuildCommands(appId, ONE_GUILD)` to
  `Routes.applicationCommands(appId)`, plus `guildCreate`/`guildDelete` handlers
  that trigger provision/reap.
- **Per-tenant authz.** `isOwner`/`hasModRole` read `ctx.ownerId`/`ctx.modRoleId`
  for the **caller's** tenant — a user in guild A can never moderate guild B
  because every action keys to the caller's `ctx`.
- **State.** `db.js` `thread_sessions` gains a `guild_id`/`namespace` column
  (thread ids are globally unique so existing rows stay safe, but we need to
  enumerate/evict a tenant's sessions). Cooldown key becomes
  `${guildId}:${userId}:${bucket}` with a **per-guild aggregate ceiling**, moved
  to a shared store (Redis) for HA.
- **Holds:** the Discord bot token **only**. No K8s API access (it reads tenant
  records via the orchestrator's internal API).

### 5.2 Orchestrator / Provisioner (new)

Internal-only HTTP API + lifecycle state machine + reconcile loop. On
`guildCreate` (admission-gated — see §9), in order, each step idempotent and
reversible by deleting the namespace:

1. Allocate `tenant-<hash(guildId)>` (DNS-safe, no raw snowflake leak).
2. `Namespace` with PodSecurity `enforce=restricted` labels.
3. `ResourceQuota` + `LimitRange` (cpu/mem/**ephemeral-storage**/pods/pvc/
   **snapshot count**/`services.loadbalancers: 0`).
4. `NetworkPolicy` (default-deny + allowlist; §6).
5. `ServiceAccount tenant-agent` + namespaced `Role` + `RoleBinding`
   (**never** a ClusterRole).
6. Per-tenant secrets: unique RCON password; create the Anthropic **Workspace** +
   **service account** + **federation rule** (WIF, `workspace:inference`,
   `token_lifetime_seconds=300`) via the `org:admin` OAuth token; write the
   tenant's opaque **broker token** Secret. **No master key in the namespace.**
7. Render MC workload from the (bug-fixed) `values.yaml` template.
8. Bring up the autonomous agent pod with the broker token.
9. Flip `status=active`; router announces readiness.

On `guildDelete`: `reaping` → final offsite archive → **archive the Anthropic
workspace + federation rule** (instant revoke + frees the 100-workspace slot) →
delete broker token → `kubectl delete namespace` → evict tenant rows. PVC
deletion gated behind a grace period (§9). **Prefer declarative:** the
orchestrator writes a git-backed tenant list and an **ArgoCD ApplicationSet**
fans out the per-tenant manifests, so the GitOps deploy-gate generalizes and the
broad apply rights live in Argo, not a hand-rolled controller.

- **Holds:** `org:admin` OAuth (WIF admin), broker-admin token, and (or Argo
  holds) namespace-CRUD rights. The single highest-value target — keep it small,
  audited, isolated.

### 5.3 Broker (new)

A thin reverse proxy on the platform plane; tenants point
`ANTHROPIC_BASE_URL` → broker and carry only an opaque `sk-broker-<rand>` token
(**not** an Anthropic credential). Per request:

1. Auth: hash the bearer, look up the tenant row; bind to source identity
   (mTLS/SPIFFE or verified source namespace), **not** the bearer alone.
2. **Strict path allowlist:** ONLY `POST /v1/messages`,
   `POST /v1/messages/count_tokens`, `GET /v1/models`. Everything else → 404
   **before** any upstream call. (This is the single most important broker
   property — see §6.)
3. **Pessimistic budget:** reserve `max_tokens`-priced cost atomically *before*
   forwarding (no TOCTOU); reject if `reserved+inflight ≥ cap`.
4. Rate-limit per `(guild, rpm/tpm)` via shared Redis token bucket.
5. Mint/refresh a per-**workspace** WIF `sk-ant-oat01-` token (cached keyed by
   `workspace_id` only), inject it upstream, forward to
   `https://api.anthropic.com` (hardcoded; strip client routing/Host/redirect).
6. **Meter incrementally** off the streamed deltas (the broker is in the byte
   path) so a stream-abort can't evade the cap; reconcile against the Usage/Cost
   API out-of-band and flip `status=capped` on drift.
7. Graceful cap: return an Anthropic-error-shaped `402`/`429` so the harness
   degrades cleanly; the router posts a friendly Discord message. **The MC server
   is untouched** — friends keep playing; only the agent pauses.

- **Holds:** the upstream Anthropic auth (WIF identity), the control DB. The
  master/`org:admin` credential is **never** in the request hot path.

`[UNVERIFIED: that the Claude Code harness honors ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN identically to the SDK — validate in Phase 1 before any fan-out.]`

---

## 6) Security model

### 6.1 The three escape boundaries (the spine)

Everything reduces to **three** sandbox-escape lines (the owner's
"dad's-bank-account" lines). They are never in-tenant restrictions — a friend may
do anything to their own world — they only stop a tenant's mess leaving its box.

1. **CREDENTIAL.** The owner's raw Anthropic key MUST NOT live on any tenant box.
   The broker mints a per-tenant, budget-capped, revocable token; tenants reach
   Anthropic **only through the broker**. Worst case for an abused tenant: it
   burns its own cap and gets revoked. Upstream, the broker authenticates
   per-workspace via WIF so even the broker→Anthropic leg never carries a static
   master key.

2. **EGRESS.** Each tenant namespace is default-deny egress with a strict
   allowlist (broker, Modrinth, Mojang/Microsoft auth, NeoForge, a
   name-allowlisting DNS resolver, game traffic). **`api.anthropic.com` is
   explicitly excluded.** This does not limit what friends do to their own
   server; it stops the box being weaponized against third parties. Requires a
   **DNS-aware CNI (Cilium `toFQDNs` or Calico DNS policy)** — this is a **hard
   cluster-build prerequisite**, not a soft preference.

3. **PLATFORM PLANE.** Router, orchestrator, broker, templates, and shared infra
   are human-controlled and unreachable/unmodifiable by tenants. A tenant's K8s
   credentials are a namespaced `Role` scoped to its **own** namespace only —
   never a ClusterRole, never another namespace, never the control plane.

### 6.2 Adversarial findings → mitigations

Every genuine sandbox-escape finding from the security review, with its
mitigation. Severity: C=critical, H=high, M=medium. **Esc** = escapes the sandbox
if unmitigated.

| # | Finding | Esc | Sev | Mitigation (baked into the design) |
|---|---|---|---|---|
| 1 | `run.sh:30-31` uploads the **owner's** `~/.claude/.credentials.json` + gh token into the box | Y | C | **Delete those uploads from every tenant path.** Broker must exist *before* any multi-tenant phase (reorder: broker first). Box gets only an opaque broker token + in-namespace bare repo. Provisioning assertion fails if `~/.claude`/gh creds present. `ANTHROPIC_API_KEY`/`PROFILE` must be unset (they shadow the broker path). |
| 2 | Broker **passthrough** exposes Anthropic **Admin API** to tenants (create/archive other workspaces, read all spend) | Y | C | Broker is a **strict allowlist proxy**: only `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`; all `/v1/organizations/*` → 404 before upstream. Upstream token is `workspace:inference` WIF only — never org:admin/master in the hot path. CI contract test. |
| 3 | **WIF federation-rule subject prefix** lets tenant A mint tenant B's workspace token | Y | C | Each rule pins the **exact** subject `system:serviceaccount:tenant-<id>:garvis-agent` + exact audience + issuer (CEL equality, never prefix), 1:1 to that workspace, `workspace:inference`, lifetime ≤300s. Provision-time assertion + periodic auditor reject any prefix/overlap. Broker selects workspace from the authenticated token row, never a tenant-supplied field. |
| 4 | **StatefulSet `patch` → rewrite container `image`**; kubelet pulls from any registry (NOT subject to pod NetworkPolicy) → unfenced node egress + node-disk exhaustion | Y | H | Admission policy (Kyverno/ValidatingAdmissionPolicy/ImagePolicyWebhook) pins tenant images to a platform registry by digest and **rejects any tenant patch mutating `image`/`initContainers`** (RBAC can't scope a subfield). containerd registry mirror/allowlist; per-namespace ephemeral-storage quota; node `imageGC`/`evictionHard`. |
| 5 | **Pod-template `tolerations`/`nodeSelector`/`nodeName`** schedule tenant pods onto control-plane/platform nodes (PSA restricted doesn't block scheduling fields) | Y | H | Dedicated **tainted tenant nodepool**; mutating admission injects nodeSelector+toleration and **strips** tenant-supplied tolerations/nodeName/affinity. Taint control-plane/platform nodes. Forbid `nodeName`. |
| 6 | **`priorityClassName`** preemption evicts other tenants cluster-wide | Y | H | Admission forbids tenant pods setting any priorityClassName (or restricts to one zero-value class). ResourceQuota `scopeSelector` on PriorityClass. |
| 7 | Platform-privileged Job/pod running **inside** a tenant ns leaks its cross-ns SA token via `pods/exec` or shared PVC | Y | C | Privileged ops on a tenant ns run **from** the platform plane reaching in, never as a pod **in** the tenant ns. Any in-ns helper uses only the tenant SA (or `automountServiceAccountToken:false`). Kyverno: tenant-ns pods may only use the two designated tenant SAs. Never bind a ClusterRole to an SA ever instantiated in a tenant ns. |
| 8 | Tenant mints cluster SA tokens with **arbitrary `audience`** (projected-token volume) → confused-deputy auth to platform services | Y | H | Every platform service validates issuer + audience + **exact subject** (ns:sa), not audience alone. Broker rejects cluster JWTs at its edge (auths by opaque broker token). NetworkPolicy ingress: tenant → broker only. |
| 9 | **Tenant-influenced strings** interpolated into the GitOps render → manifest injection applied by the privileged orchestrator/Argo SA | Y | H | Treat all tenant inputs as hostile data: normalize guildId to a numeric hash; pass config only as parameterized ConfigMap **values** (Kustomize/Helm quoted), never string-concatenated manifest text. Admission rejects ClusterRole(Binding)s referencing tenant SAs. Render in a least-privilege step separate from apply. |
| 10 | No structural guard against **cluster-scoped RBAC for tenant SAs**; `default` SA token mountable | Y | M | Kyverno/Gatekeeper **denies** any (Cluster)RoleBinding subject that is a tenant SA or the groups `system:serviceaccounts*`/`system:authenticated`. `automountServiceAccountToken:false` on the `default` SA in every tenant ns; pin all pods to explicit SAs. Reconcile fails closed on any cluster-scoped binding to a tenant SA. |
| 11 | **`volumeClaimTemplate` patch + Retain reclaim** → rebind a released PV holding a reaped tenant's world | Y | M | `reclaimPolicy: Delete` for tenant PVs (or wipe-on-release); admission forbids mutating `volumeClaimTemplate`/selector/`volumeName`; cryptographically erase released PVs before reuse. Snapshot `deletionPolicy: Retain` only in platform-owned storage tenants can't bind. |
| 12 | Broker authenticates by **bearer token alone**, no source-identity binding | Y | H | Bind credential → source identity (mTLS/SPIFFE per-namespace, or verify caller's projected-SA namespace) and require token's tenant == network identity. ≥256-bit entropy tokens, store hashes only, never log full tokens, rotate per provision. |
| 13 | Broker **upstream-token cache** mis-key or **master-key fallback** bills across tenants | Y | H | Cache keyed strictly by `workspace_id`, never shared/tenant-influenced. **Fail closed**: if WIF mint fails, return cap-shaped error — never fall back to a master/org key. Master credential in a separate process/secret the hot path can't reach. |
| 14 | **Stream-abort metering evasion** burns the owner's bill past cap | Y | H | Meter **incrementally** off streamed deltas, not a terminal event; on abort charge what streamed + input. Hard per-tier `max_tokens` ceiling. Pessimistic pre-charge then reconcile. Tight Usage/Cost true-up auto-flips `status=capped`. |
| 15 | Egress fence still allows **`api.anthropic.com`** directly; non-Cilium fallback allows any public 443 | Y | H | Per-tenant egress **excludes** `api.anthropic.com` (drop the `anthropic` block when forking `policy.yaml`). Mandate Cilium `toFQDNs`. Pure-WIF-direct variant is rejected (it needs the host open) — token exchange also goes through the broker. |
| 16 | Broker honoring **client-controlled routing/redirects** → SSRF/open-proxy to third parties | Y | M | Hardcode upstream `https://api.anthropic.com`; strip client Host/`X-Forwarded-*`/routing headers; don't follow redirects. Broker's OWN egress NetworkPolicy locked to `api.anthropic.com:443` + DB + DNS. |
| 17 | Tenant `statefulset patch` + `pods/exec` surfaces any **in-namespace Secret** (mount + exec read) | N | M | Deliver broker creds as a **short-lived projected SA token volume**, never a readable Secret; keep zero privileged secrets in any tenant ns. Kyverno denies pod specs mounting Secrets the SA can't read. Prefer RCON-over-TCP over `pods/exec`. Invariant: no privileged secret ever lands in a tenant ns. |
| 18 | **Recursive DNS via kube-dns** is an exfil/C2 tunnel that bypasses the FQDN allowlist | Y | H/M | Tenant namespaces use a **name-allowlisting resolver** (NodeLocal DNSCache / dedicated CoreDNS view / Cilium DNS proxy with `matchPattern`) that answers ONLY allowlisted FQDNs and refuses everything else — never a full recursive resolver. |
| 19 | Tenant agent **HTTP shim** accepts unauthenticated cross-namespace task injection + `callerRole` spoof | Y | H | Shim requires a **platform-issued signed token** (mTLS client cert / HMAC the tenant can't mint), verified server-side; never trust `callerRole`/`user` from the body. Per-tenant ingress NetworkPolicy: agent port only from the platform plane's pod identity (label+ns selector). Fail closed if auth absent. |
| 20 | **github.com** read-write egress = high-bandwidth exfil + supply-chain pivot | Y | M | Adopt the **in-namespace bare repo** (`file:///config-repo/world.git`) and **remove** github.com/codeload/objects.githubusercontent.com from the tenant egress allowlist entirely. If a GitHub repo is unavoidable, a git proxy enforcing one repo path + a per-repo deploy key. |
| 21 | **Slow-lane reply** from a compromised agent attacks the high-privilege router (SSRF/DoS/injection into garvis-system) | Y | C | Treat the agent reply as **opaque, size-capped, deadline-bounded untrusted bytes**; disable redirect-following; pin to the resolved Service ClusterIP, reject garvis-system targets. **Split the privileged kubectl-exec/RCON credential out of the process that talks to tenant agents.** Never parse the reply as commands. |
| 22 | Dispatch **shell-interpolates** untrusted Discord text → RCE on the router (holds all-ns exec) | Y | H | Hard invariant: untrusted text crosses to the agent ONLY via stdin or a non-shell **argv array** (as `runClaude` does today); forbid `sh -c`/template strings on the dispatch path. Prefer HTTP RPC to an in-ns shim over `kubectl exec`. Namespace comes from `guildId`, never the message body. Unit test asserts no interpolated user bytes in the command array. |
| 23 | **Fast-lane classifier on the platform's own key** → untrusted @mentions burn spend beyond any tenant cap | Y | H | Route the classifier through the **caller's tenant broker token** so spend counts against that tenant's cap and dies on revoke. Cheap deterministic prefilter (regex/keyword) before any LLM call. Cooldown keyed `${guildId}:${userId}` with per-guild ceiling in a shared store. |
| 24 | **Auto-provision on guildCreate** exhausts namespaces + the **100-workspace/org Anthropic ceiling** → platform-wide DoS | Y | H/M | Gate `/provision` behind an owner allowlist / signed invite / per-inviter quota **before** `status=provisioning`. Rate-limit + idempotent guildCreate. Reserve headroom, alarm + hard-stop near the cap, plan multi-org/non-1:1. Until gating exists, keep the bot invite **private**. |
| 25 | Shared single-process router + in-memory cooldown → one tenant degrades availability for all | Y | M | Per-guild concurrency caps + rate limits in a shared store; backpressure on slow-lane forward; isolate classifier credential per tenant; HA broker with per-tenant fairness; consider sharding the gateway. |
| 26 | Compromised agent reply post-processed/auto-fetched by the trusted bot (`@everyone`, embed fetch amplifier) | N | M | `allowedMentions: { parse: [] }` before posting; cap+rate-limit embed fetches per guild; keep `embeds.js` hardcoded-host + constrained-slug invariant (regression-tested). Never parse the reply as structured commands. |
| 27 | **No ephemeral-storage / PID / snapshot** quota → node-disk DoS evicts neighbors | Y | H | Add `requests/limits.ephemeral-storage` to ResourceQuota + LimitRange; require `emptyDir.sizeLimit` (admission); per-ns PID quota + kubelet `podPidsLimit`; cap container log size. Dedicated tenant nodepools. |
| 28 | **VolumeSnapshot create-without-delete** loop fills shared CSI storage → cluster-wide DoS | Y | H | ResourceQuota on `count/volumesnapshots.snapshot.storage.k8s.io` per ns (or make snapshotting a platform-mediated, rate-limited verb). Per-tenant snapshot backing pools. Platform GC runs on count-pressure, not just age. |
| 29 | Broker **budget TOCTOU**: concurrent requests pass stale preflight → owner billed past cap | Y | H | Atomic reservation (DB/Redis CAS) of `max_tokens` cost *before* forwarding; reject when `reserved+inflight ≥ cap`. Hard per-tenant concurrency + per-request `max_tokens` ceiling. Burst-rate kill-switch. |
| 30 | Broker meters **only Messages tokens** → tenant uses Files/Batches/server-tools to bill uncounted | Y | H | (Covered by #2's strict path allowlist) — Files/Batches/other paths → 403. Strip client beta headers / tool defs enabling priced server tools unless explicitly priced. Reconcile against authoritative cost report; hard-pause on drift. |
| 31 | **Shared offsite backup store** with prefix-by-convention → cross-tenant world-data read/overwrite | Y | H | Per-tenant creds IAM-scoped to exactly that prefix (no bucket-wide List, no cross-prefix Put), object-lock. Better: tenants hold **no** object-store creds — a platform-plane backup controller does the push. Verify policy at provision. |
| 32 | **Orchestrator GitOps generator** fed from a tenant-reachable source → arbitrary cluster-object creation under Argo's privileged identity | Y | C | Tenant list + template + ApplicationSet generator live in a **platform-only repo/credential** no tenant can reach or PR to. Constrain each generated Application to an allowlist of kinds + its own namespace. Kyverno backstop rejects cluster-scoped kinds / cross-ns objects from a tenant Application. |
| 33 | **Broker token forgery** (low entropy / guild-derived key) crosses tenants | Y | H | ≥256-bit random token with **no embedded guild id**; constant-time lookup by hash of the whole token; rotate per provision; derive workspace only from the authenticated row. |
| 34 | MC server exposed `0.0.0.0/0` abused as **UDP query reflection/amplification** | Y | M | `ENABLE_QUERY=false`; no UDP to `0.0.0.0/0`; ingress TCP 25565 only; front all worlds with the platform mc-router (rate-limit/absorb spoofed traffic); `services.loadbalancers: 0` + RBAC deny Service create. |

### 6.3 Residual risk (honest)

- **In-tenant breakage is unbounded and intended.** A friend (or their injected
  agent, or a malicious mod jar) can op a griefer, wipe their world, install junk,
  and burn their budget. We do **not** promise to stop this — only that it stays
  in that namespace.
- **SNI/DNS-name filtering is not payload inspection.** A hostile agent can still
  exfil *through* an allowed host (e.g. its own Modrinth interactions). Compensated
  by: the box holds no platform secret, the broker meters/caps spend, and (with
  the in-namespace repo) there is no GitHub channel.
- **Supply chain: mod jars are never content-inspected.** A malicious-but-stable
  jar deploys autonomously inside a tenant. Contained to the namespace by the
  egress fence + RBAC + PodSecurity; cannot phone home to arbitrary hosts or
  attack third parties. **Client modpacks are a sharper edge** — they run on
  *players'* PCs (third-party humans). Mitigation: generate + sign the client pack
  on the **platform plane**, restrict to Modrinth-hosted hash-pinned files only
  (no arbitrary jar URLs, no tenant-served packwiz auto-update), and add a "this
  group changed your mods" consent step.
- **The platform plane is the crown jewel.** The orchestrator (org:admin + broad
  cluster rights) and broker (upstream credential) are single high-value targets;
  their compromise is catastrophic. Accepted per locked decisions (platform is
  human-controlled); mitigated by minimizing the orchestrator to git-write+Argo,
  WIF upstream (no static master key in the hot path), and HA broker.
- **WIF revocation has a tail.** Already-minted `oat` tokens live until expiry;
  keep `token_lifetime_seconds ≤ 300` so revocation bites within minutes.
- **The whole k8s base is unvalidated** (`kubectl` not installed; several
  `values.yaml` fields `[ILLUSTRATIVE]`). The first provision is a real bring-up,
  not a copy. This is the largest greenfield surface.

---

## 7) Reuse vs refactor vs remove

### 7.1 Per-piece disposition

| Current path | Disposition | Notes |
|---|---|---|
| `apps/garvis-bot/src/moderation.js` | **REUSE** (strongest) | `VERBS`, validators, `parseClassification`, `catalogMenu`, `resolveAction` are pure/tenant-agnostic. Swap `rconExec()` transport (docker exec → network RCON) + `dockerRestart()` (→ rollout restart) + persist target. Verbs tenant-scoped; gating per-tenant. |
| `apps/garvis-bot/src/embeds.js` | **REUSE verbatim** | Stateless, tenant-agnostic. Keep hardcoded-host + constrained-slug invariant; add `allowedMentions:{parse:[]}` at post. |
| `apps/garvis-bot/src/index.js` | **REFACTOR** (heaviest) | Every module-scope tenant binding → per-`guildId` runtime lookup. Classify→validate→gate→execute pipeline kept; config resolution + execution target swapped. Global `maintChain`/`lastUse` → per-tenant. Slow-lane spawn → HTTP forward; drop `AGENT_DENY_TOOLS`. |
| `apps/garvis-bot/src/whitelist.js` | **REFACTOR** | Pure validators stay; `envChain` scoped per-path; persist target relocates off the single `apps/server/.env` (agent owns whitelist durability, or platform-SA edits the tenant ConfigMap). |
| `apps/garvis-bot/src/db.js` | **REFACTOR** | Add `guild_id`/`namespace` column; COALESCE upsert kept. |
| `apps/garvis-bot/src/register-commands.js` | **REFACTOR** | `applicationGuildCommands(ONE_GUILD)` → global `applicationCommands` + `guildCreate`/`guildDelete`. |
| `apps/server/docker-compose.yml` | **TEMPLATIZE** | → per-ns StatefulSet + sidecar. Drop `container_name`/`25565:25565` host binding. Env → ConfigMap/Secret. |
| `apps/server/.env(.example)` | **REFACTOR** | → per-tenant ConfigMap+Secret; **generate** RCON password per tenant; kill the `minecraft` default. |
| `apps/server/server-data/` | **REMOVE from repo model** | Already gitignored → per-tenant RWO PVC. Live world migrated once (Phase 2). |
| `apps/agent/claude/settings.json` deny list, `hooks/block-downloaders.sh`, `AGENT_DENY_TOOLS` | **REMOVE in-tenant** | Full autonomy is the point. |
| `apps/agent/claude/managed-settings.json` | **REFACTOR** | bypass/auto locks lose meaning; keep `allowManagedHooksOnly` + the delivery path to pin per-tenant identity the agent can't relax. |
| `apps/agent/config.yaml`, `cron-job.example.json`, `discord.env.example` | **TEMPLATIZE** | Hermes cron + `deliver:discord` = per-tenant scheduled tasks; render cwd/workspace/creds per ns. |
| `apps/agent/modlist.txt` | **TEMPLATIZE** | Seed copy; each tenant edits its own freely. |
| `scripts/build-client-mrpack.mjs` | **TEMPLATIZE + harden** | Parameterize `CLIENT_MODS`/`MODLIST`/`OUT_DIR`. **Generate + sign on the platform plane**, Modrinth-only hash-pinned (residual risk §6.3). |
| `infra/k8s/values.yaml` | **REFACTOR + TEMPLATIZE** | **Fix `MODRINTH_DOWNLOAD_DEPENDENCIES=none`.** `replicaCount:1` stays. Add the entire control surface (Namespace/NetworkPolicy/RBAC/Quota/LimitRange/limits/securityContext) — 0% built today. |
| `infra/k8s/service.yaml` | **REFACTOR** | ClusterIP + shared **mc-router** (SNI) instead of one LB per world. |
| `infra/openshell/policy.yaml`, `run.sh`, `Dockerfile` | **REFACTOR/blueprint** | Egress fence becomes k8s **NetworkPolicy**. **Remove `api.anthropic.com`, add broker.** **Delete the credential uploads (finding #1).** Keep `policy.yaml` as conceptual blueprint / optional host-dev defense-in-depth. |
| `infra/systemd/garvis-auto-deploy.{service,timer}`, `scripts/auto-deploy.sh` | **REMOVE for tenants** | No PRs to merge inside a tenant. The **boot-health rollback concept** relocates into `tenant-apply.sh`. Platform keeps a normal PR gate for its own code. |
| `infra/systemd/ops-tripwire.service`, `scripts/ops-tripwire.sh` | **REFACTOR** | Per-tenant audit/alarm following each namespace's server log. |
| `scripts/deploy.sh` | **REFACTOR (keep engine)** | `wait_for_ready()` + `MODRINTH_PROJECTS` revert/redeploy → per-tenant `tenant-apply.sh`, invoked by the agent after committing. |
| `docs/architecture.md`, `security.md`, `auto-deploy.md` | **REFACTOR** | Document the 3 boundaries + namespace-per-guild; note the "owner accepts risk" justification does **not** transfer. Correction 1 holds & widens; Correction 2's claim holds (replicas:1) but its assumption ("one world") is superseded — the platform IS the deferred mc-router fan-out. |
| `docs/backups.md`, `docs/windows-client-install.md` | **KEEP, generalize** | Per-tenant offsite target; per-tenant client pack URL. |
| `CLAUDE.md` | **SPLIT** | `tenant-template/CLAUDE.md` = full autonomy; new strict `platform/CLAUDE.md` for the control plane. |

### 7.2 Proposed repo restructure

```
platform/                  # CONTROL PLANE — human-PR-gated, tenant-unreachable
  bot/                     # refactor of apps/garvis-bot → multi-guild router
  orchestrator/            # NEW: guildCreate → namespace/workspace/sandbox lifecycle
  broker/                  # NEW: Anthropic credential broker (WIF upstream + per-tenant cap)
  charts/                  # NEW: ArgoCD ApplicationSet / Helmfile fan-out over the guild list
  CLAUDE.md                # STRICT: human approval; never touch tenant data
tenant-template/           # PER-TENANT BLUEPRINT — rendered per namespace, full autonomy inside
  server/                  # from apps/server (compose → StatefulSet values + mc-backup sidecar)
  agent/                   # from apps/agent (claude config WITH in-tenant deny rules removed)
  client/                  # from apps/client + build-client-mrpack.mjs (platform-signed)
  k8s/                     # namespace, statefulset, networkpolicy, rbac, quota, limitrange, psa
  egress-policy.yaml.tmpl  # from infra/openshell/policy.yaml (broker injected, anthropic removed)
  modlist.txt              # seed modlist
  CLAUDE.md                # FULL AUTONOMY: you own this world; no PRs
shared/                    # tenant-agnostic libs reused by both planes (embeds, VERBS, validators, fencedData)
scripts/                   # platform-plane scripts (tenant-apply.sh = per-tenant deploy.sh)
docs/                      # rewritten for multi-tenant; keep backups.md, windows-client-install.md
```

The currently-empty `neo-minecraft/` dir is the natural home for this scaffolding
(or rename to `platform/` + `tenant-template/`). Phase 0 moves files with a thin
compat path so the live world keeps deploying unchanged.

---

## 8) Phased implementation plan

Each phase **ends in a working, demoable state**, and the current single server
keeps running through Phase 3.

### Phase 0 — Restructure, zero behavior change
**Do:** move `apps/server`/`apps/agent`/`apps/client`/`infra` into
`tenant-template/`; create `platform/` + `shared/`; split `CLAUDE.md`. Point the
existing `scripts/deploy.sh`/compose at the new paths via a compat shim.
**Demo:** live `mc-neoforge` unchanged, CI green, git history clean.
**Exit gate:** no behavior change; players never notice.

### Phase 1 — Broker + WIF against the ONE existing agent (boundary #1 first)
**Do:** stand up `platform/broker/`; create one Anthropic Workspace + service
account + federation rule for "tenant zero"; flip the existing maintenance agent
to `ANTHROPIC_BASE_URL=broker` and **delete the `run.sh` credential uploads**.
Implement the strict path allowlist, pessimistic budget, incremental metering,
graceful cap, instant revoke.
**Demo:** the existing agent works with **no static key on its box**; archiving
the federation rule kills it within 300s; exceeding the cap returns a friendly
Discord message while the server keeps running.
**Exit gate / `[UNVERIFIED]`:** confirm the Claude Code harness honors
`ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`; confirm WIF exchange works.

### Phase 2 — One k8s namespace for tenant zero (boundaries #2/#3)
**Do:** provision a real cluster on a **DNS-aware CNI (Cilium)**; render
`tenant-template/k8s` for one namespace — StatefulSet + RWO PVC + mc-backup
sidecar + NetworkPolicy (default-deny + allowlist, **no api.anthropic.com**) +
namespaced RBAC + ResourceQuota/LimitRange + PodSecurity. **Fix the
`MODRINTH_DOWNLOAD_DEPENDENCIES` bug first.** Migrate the live world (host
bind-mount → PVC) in a maintenance window; run compose + k8s in parallel until
cutover.
**Demo:** tenant zero served from its namespace; egress fence verified (curl to
a non-allowlisted host fails; metadata blocked; cross-ns blocked); compose retired.
**Exit gate / `[UNVERIFIED]`:** real cluster + kubectl; CSI snapshot support; itzg
image passes PodSecurity (baseline fallback for the game pod if needed); kube-dns
label correct; data migration runbook tested.

### Phase 3 — Autonomous agent inside the namespace
**Do:** run the tenant agent as a namespace pod with the egress NetworkPolicy as
its sole wall; **remove** the in-tenant deny rules; give it namespace-scoped
kubectl RBAC + the in-namespace bare repo; let it commit to its own `main` and
self-deploy via `tenant-apply.sh` with boot-health rollback + snapshot loop.
Still only tenant zero. Apply admission policies (Kyverno) for image/scheduling/
RBAC backstops (findings #4-6, #9-11).
**Demo:** ask the agent (via Discord) to add a mod → it commits, snapshots,
deploys, health-checks, and rolls back a deliberately-broken mod — autonomously,
no human. Prove a prompt-injected "delete everything" stays in the namespace.
**Exit gate:** full autonomy proven contained for one tenant.

### Phase 4 — Router + orchestrator + mc-router (now N tenants)
**Do:** refactor `garvis-bot` → `platform/bot/` (multi-guild, `resolveTenant`,
global commands, fast-lane network RCON, slow-lane authenticated HTTP forward);
build `platform/orchestrator/` (admission-gated `guildCreate` → namespace +
workspace + WIF rule + clone-from-template; `guildDelete` → reap); add the shared
**mc-router** for many worlds behind one IP. Apply the slow-lane reply hardening
(findings #19, #21, #22) and per-guild rate limits (#23, #25).
**Demo:** a **second** guild provisions end-to-end and plays, fully isolated from
the first; a destructive action in guild A has zero effect on guild B.
**Exit gate / `[UNVERIFIED]`:** provisioning gate in place; 100-workspace headroom
alarm; reaper grace period.

### Phase 5 — Decommission single-tenant scaffolding
**Do:** remove `scripts/auto-deploy.sh` + `infra/systemd/garvis-auto-deploy.*`,
the single-tenant `.env` source-of-truth, the legacy single-guild registration.
Lock down `platform/CLAUDE.md`. Wire per-tenant offsite backups + the
platform-side backup controller (finding #31). Sign client packs on the platform
plane (§6.3).
**Demo:** clean platform; onboarding a new guild is a single gated action;
backups are offsite + restorable per tenant.
**Exit gate:** production posture for a small cohort.

**Deferred (note attach points):** open-vs-invite gating + quotas attach at the
orchestrator's `/provision` admission step (Phase 4); finances/budget attach at
the broker (Phase 1).

---

## 9) Open decisions for the owner

1. **CNI choice (hard gate).** Boundary #2's clean "Anthropic-only-via-broker"
   guarantee requires Cilium `toFQDNs` (or Calico DNS policy). The non-DNS
   fallback degrades to "any public 443 host" and is **not** a real boundary.
   Commit to Cilium at cluster build?
2. **Config repo location.** In-namespace bare repo (recommended — no GitHub
   creds on the box, nothing to scope) vs per-tenant GitHub repo (needs
   tenant-scoped creds + github.com egress, finding #20). Recommend in-namespace.
3. **Agent execution model.** Long-lived `garvis-agent` Deployment driven by an
   **authenticated HTTP shim** (warm sessions; recommended) vs `kubectl exec`
   from the router (router then holds all-ns exec — finding #21) vs Job-per-task
   (cleaner isolation, cold start).
4. **Broker build vs buy.** ~200-line custom proxy (full control) vs LiteLLM
   virtual-keys-with-budgets (faster, extra supply-chain/ops surface).
   `[UNVERIFIED: LiteLLM specifics not checked against Anthropic docs.]`
5. **Provisioning admission (security prerequisite, not finance).** Owner
   allowlist / signed invite / per-inviter quota before `status=provisioning`
   (finding #24). Until built, the bot invite **must stay private**.
6. **PVC deletion on guild-leave.** Grace period + retain policy + data-retention
   for likely-minor data before wiring auto-reap. How long, where, who can
   restore?
7. **Player-facing role-gating.** Keep Discord mod-role gating for **UX** even
   though it is no longer a security boundary inside a full-autonomy tenant?

### Items the broker research left genuinely uncertain (confirm before relying)
- **Static keys can't be minted via API** — we use WIF + Workspaces instead
  (confirmed). The `org:admin` OAuth bootstrap rule must be created once in the
  Console.
- **Per-workspace spend limits are Console-only/monthly**, and it is
  **unverified** whether hitting one **hard-pauses** requests or only alerts. The
  **broker provides the real-time cap regardless** — treat the native limit as a
  belt-and-suspenders backstop only.
- **No documented endpoint to kill an already-minted `oat` token** before expiry
  — keep `token_lifetime_seconds ≤ 300`.
- **100 workspaces per org is a hard ceiling** (archived excluded). Under 1
  tenant = 1 workspace this binds **first** at ~100 live tenants — plan multi-org
  or non-1:1 mapping; reap suspended tenants' workspaces promptly to free slots.
- **`ANTHROPIC_API_KEY`/`ANTHROPIC_PROFILE` shadow the broker path** — they must
  be unset/absent on every tenant box (env hygiene is soft; the NetworkPolicy
  excluding `api.anthropic.com` is the hard backstop).
- **Claude Platform on AWS caveat:** most Admin/Usage/WIF endpoints are
  unavailable there — do not run the platform plane on it.
- **Does the Garvis/Claude Code harness honor `ANTHROPIC_BASE_URL` identically to
  the SDK?** Validated in Phase 1 before any fan-out.

---

*This is a proposal for human review. Build incrementally; verify every
`[UNVERIFIED]` against the live system; never let a phase regress the running
world until its successor is proven.*
