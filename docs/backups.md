# World backups — local snapshots of the live server

The live world (`apps/server/server-data/`) is now snapshotted on a schedule by a small
sidecar container so a crash, a bad update, or a fat-fingered command can't lose everyone's
progress. This is **local-only** today (archives sit on the same host as the world) — see
[Offsite copies](#offsite-copies-todo) for the next step.

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

## Offsite copies (TODO)

Local backups protect against software faults (bad mod, corruption, accidental deletion)
but **not** host loss — disk failure or losing the box takes the backups with it. The next
step is pushing `apps/server/backups/` offsite (rclone/restic to object storage, or an
rsync to another machine). `itzg/mc-backup` also supports `rclone`/`restic` backup methods
directly. Track this separately.

## Scope / ops notes

- This is a **compose change**, so per `CLAUDE.md` it ships in its own PR and **always
  requires human approval** — it is *not* auto-deploy-eligible (that path only covers
  mod-list / client-pack diffs).
- `docker compose up -d` now brings up two containers (`mc-neoforge`, `mc-backup`).
- The sidecar mounts the world **read-only** (`./server-data:/data:ro`) — it can never
  modify the live world, only read it to make archives.
