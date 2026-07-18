# World backups — local snapshots of the live server

The live world (`apps/server/server-data/`) is snapshotted on a schedule by two small
sidecar containers so a crash, a bad update, or a fat-fingered command can't lose everyone's
progress:

- **`backups`** — local `.tgz` archives on the same host. Fast, simple, the everyday
  rollback (griefing, bad deploy, "I deleted the wrong thing").
- **`backups-offsite`** — an encrypted [restic](https://restic.net) repo in AWS S3. The
  **disaster-recovery** copy that survives the host disk dying. See
  [Offsite copies](#offsite-copies-encrypted-s3).

Both mount the world **read-only** and flush it over RCON first, so every snapshot is
consistent, not a mid-write copy.

## What runs

A `backups` service in `apps/server/docker-compose.yml`, using
[`itzg/mc-backup`](https://github.com/itzg/docker-mc-backup) — the same author as the
server image. It shares the compose network with the `minecraft` service and:

1. Connects to the server over **RCON** (internal port 25575, never published off-host).
2. Runs `save-off` + `save-all` so the world is flushed and quiesced.
3. Tars `server-data/` into a timestamped `.tgz`.
4. Runs `save-on` to resume normal saving.
5. Prunes archives older than the retention window.

Because saves are paused for step 3, each archive is a **consistent** snapshot, not a
copy of a world mid-write.

## Where backups go

Host directory **`apps/server/backups/`** (bind-mounted to `/backups` in the container,
and gitignored — never committed). Files look like `world-20260626-030000.tgz`.

## Schedule & retention (defaults)

| Setting | Default | `.env` var | Notes |
|---|---|---|---|
| Interval | `24h` | `BACKUP_INTERVAL` | daily; matches `infra/k8s/values.yaml` |
| Retention | `7` days | `BACKUP_PRUNE_DAYS` | older archives are deleted |
| Skip when empty | on | — | `PAUSE_IF_NO_PLAYERS=true`; no snapshot if nobody's online |
| Method | `tar` | — | plain `.tgz`; restore = extract over `/data` |

Tune the interval/retention by setting the vars in `apps/server/.env` (see
`.env.example`). A backup runs ~`INITIAL_DELAY` after the server is healthy and then every
interval; a daily cadence means at most ~24h of progress is at risk.

## RCON note

RCON is enabled by default on the itzg server image (it's how `rcon-cli` works). The
backup sidecar needs the network RCON password to match, so both the `minecraft` and
`backups` services read `RCON_PASSWORD` from `.env`. The default is `minecraft` for
back-compat; **set a strong value** — though the port is internal to the compose network
and never exposed. This does **not** affect `docker compose exec minecraft rcon-cli` or
Garvis' whitelist/moderation, which use the in-container socket, not the network password.

## Restore (manual, deliberate)

Restoring is intentionally a hands-on, owner-only operation — there is no auto-restore.

```sh
cd apps/server
docker compose stop minecraft            # stop the server so nothing writes mid-restore
mv server-data/world server-data/world.broken   # keep the bad world aside, don't delete it
tar xzf backups/world-YYYYMMDD-HHMMSS.tgz -C server-data/   # extract the chosen archive
docker compose start minecraft
```

Adjust paths to whatever the archive contains (inspect with `tar tzf <archive> | head`).
Verify the world loads before discarding `world.broken`.

## Offsite copies (encrypted S3)

Local backups protect against software faults but **not** host loss — a dead disk takes
the world *and* the local `.tgz` archives with it. The `backups-offsite` sidecar closes
that gap by pushing an encrypted, deduplicated [restic](https://restic.net) repo to AWS
S3, off the box entirely.

**What runs:** a second `itzg/mc-backup` container (`mc-backup-offsite`) with
`BACKUP_METHOD: restic`. Same RCON flush as the local one, then restic reads the world,
encrypts it **client-side**, and uploads only changed blocks — so the first run ships the
whole ~11 GB world and every run after is tiny.

**Where it goes:** S3 bucket `garvis-mc-backups-430842105371` (region `us-east-2`, AWS
account `430842105371`). The bucket blocks all public access and has default AES256
encryption; restic adds its own client-side encryption on top. Repo path: `world/`.

**Credentials** (all in `apps/server/.env`, gitignored):

| Var | What it is |
|---|---|
| `AWS_BACKUP_ACCESS_KEY_ID` / `AWS_BACKUP_SECRET_ACCESS_KEY` | IAM user `garvis-mc-backup`, an inline policy scoped to **only** this bucket (list + get/put/delete objects). Nothing else in the account. |
| `RESTIC_BACKUP_PASSWORD` | restic's encryption key. **If this is lost the offsite repo is unrecoverable** — it's saved off-host (password manager) as well as in `.env`. |
| `RESTIC_S3_BUCKET` / `AWS_BACKUP_REGION` | assemble the repo URL `s3:s3.<region>.amazonaws.com/<bucket>/world`. |

**Retention:** `PRUNE_RESTIC_RETENTION="--keep-daily 7 --keep-weekly 5 --keep-monthly 6"`,
applied by `restic forget --prune` after each run — longer history than the local 7-day
window, and dedup keeps it cheap (a few dollars/month at this world size).

The **SSO `starting` profile is not used by the sidecar** — SSO issues short-lived tokens
that a 24/7 container can't refresh. It only administers the account where the long-lived
IAM key lives. (`aws sso login --profile starting` is still how a human provisions/inspects.)

### Restore from the offsite repo

Needs `RESTIC_BACKUP_PASSWORD` + the AWS key. No restic install required on the host — run
it through the same image:

```sh
cd apps/server
docker compose stop minecraft
mv server-data/world server-data/world.broken     # keep the bad world aside

# list available snapshots
docker compose run --rm --entrypoint restic backups-offsite snapshots

# restore the latest (or a specific <snapshot-id>) into a staging dir
docker compose run --rm --entrypoint restic \
  -v "$PWD/server-data:/data" backups-offsite \
  restore latest --target /data-restore

# the world sits under /data-restore/data/world — move it into place, then start
docker compose start minecraft
```

restic snapshots store absolute paths (`/data/...`), so inspect the restore target and
move `world/` into `server-data/` before starting. Verify the world loads before discarding
`world.broken`.

## Scope / ops notes

- This is a **compose change**, so per `CLAUDE.md` it ships in its own PR and **always
  requires human approval** — it is *not* auto-deploy-eligible (that path only covers
  mod-list / client-pack diffs).
- `docker compose up -d` now brings up three backup-relevant containers alongside the
  server: `mc-neoforge` (server), `mc-backup` (local tar), `mc-backup-offsite` (restic→S3).
- Both sidecars mount the world **read-only** (`./server-data:/data:ro`) — they can never
  modify the live world, only read it to make archives.
- The offsite sidecar's `.env` block was added 2026-07-17; `.env.example` documents the
  vars without real values.
