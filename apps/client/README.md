# apps/client — the player-facing client modpack

What friends import to join **mc.starting.cc** without a mod mismatch.

| File | What it is |
|------|------------|
| `starting-cc-client.mrpack` | The importable [Modrinth modpack](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack). One-click import in **Prism Launcher** (*Add Instance → Import*) or the **Modrinth App**. Installs NeoForge 1.21.1 + every client mod pinned to the server's exact version & hash. **This is the first-time installer.** |
| `modrinth.index.json` | The pack's manifest, committed **uncompressed** so PRs show exactly which mods/versions/hashes/URLs changed. It's the same JSON that lives inside the `.mrpack` zip. |
| `pack/` | The **same mods in [packwiz](https://packwiz.infra.link/) format** (`pack.toml` + `index.toml` + `mods/*.pw.toml`). Served over the raw GitHub URL so a tiny client (`packwiz-installer`) can re-sync mods **on every launch** — the auto-update path that means players never re-import after the first time. See [Auto-updating clients](#auto-updating-clients-packwiz) below. |

Players download the `.mrpack` straight from GitHub:
<https://github.com/brianmatzelle/agentic-minecraft-server/raw/main/apps/client/starting-cc-client.mrpack>
(Garvis hands friends this link.) The install walkthrough is
[`docs/windows-client-install.md`](../../docs/windows-client-install.md).

## Auto-updating clients (packwiz)

The `.mrpack` is a one-time snapshot — change the mod list and everyone has to
re-import. The `pack/` folder fixes that. [`packwiz-installer`](https://github.com/packwiz/packwiz-installer)
is a ~200 KB Java client that, on **every launch**, fetches `pack/pack.toml`
from the raw GitHub URL, diffs it against the instance, and downloads only what
changed (verifying each `sha512`). Set it up once as a Prism **pre-launch
command** and modlist changes land on the next launch — no re-import.

**Raw URL for the pack** (point the installer here):
```
https://raw.githubusercontent.com/brianmatzelle/agentic-minecraft-server/main/apps/client/pack/pack.toml
```

**One-time client setup** (after the `.mrpack` import gives them the NeoForge
1.21.1 instance — packwiz does *not* install the loader):

1. Download [`packwiz-installer-bootstrap.jar`](https://github.com/packwiz/packwiz-installer/releases/latest)
   into the instance's `.minecraft` folder (Prism: right-click instance →
   *Folder*).
2. Prism → instance → *Edit* → *Settings* → **Custom Commands** → enable, set
   **Pre-launch command** to:
   ```
   "$INST_JAVA" -jar packwiz-installer-bootstrap.jar -g -s client https://raw.githubusercontent.com/brianmatzelle/agentic-minecraft-server/main/apps/client/pack/pack.toml
   ```
   (`-g` shows a small GUI with the optional-mod toggles; drop it for a silent
   sync. `-s client` installs client + `both` mods and skips any server-only
   ones.)

That's it — every launch now self-updates from this repo. The optional mods
(JEI, Jade) appear as deselectable toggles, matching the `.mrpack`.

> **Zero-friction alternative:** export a ready-made Prism instance (NeoForge +
> the bootstrap jar + pre-launch command already set) via *Export Instance* and
> hand players that `.zip` instead — then even step 1–2 are done for them.

Auto-update is the convenient half; **adding a mod still goes through the
human-approved PR/merge gate** (see `CLAUDE.md` — a mod jar can run install
code, so no unreviewed jar should reach players' machines on next launch).
Garvis proposes → a human merges → clients auto-sync.

## Regenerating (do this in the SAME PR that changes the mod list)

The pack is generated from Modrinth by [`scripts/build-client-mrpack.mjs`](../../scripts/build-client-mrpack.mjs):

```bash
node scripts/build-client-mrpack.mjs           # versionId defaults to today's date
PACK_VERSION_ID=2026-06-24 node scripts/build-client-mrpack.mjs   # or pin it
```

The script is the **source of truth for what ships to clients** (its
`CLIENT_MODS` list), and reconciles against `apps/agent/modlist.txt` (the server
list): it **errors** if a client mod isn't on the server and **warns** if a
server mod is left unclassified — so the bundle can't silently drift.

When you add/remove/bump a mod:
1. Edit `apps/agent/modlist.txt` (server) as usual.
2. If the mod is client-side, add/remove it in `CLIENT_MODS` (or `SERVER_ONLY`)
   in the build script.
3. Re-run the script, commit the regenerated `modrinth.index.json` +
   `starting-cc-client.mrpack` **and the `pack/` folder** (the packwiz output —
   this is what auto-updating clients actually pull).
4. Update the version table in `docs/windows-client-install.md` if you want the
   doc's numbers fresh (the pack itself is always authoritative).

Both the server (itzg) and this pack track **latest compatible NeoForge
1.21.1**, so regenerating right after a modlist change keeps client and server
byte-identical. Server-only perf mods (Lithium, FerriteCore, ModernFix, spark,
Chunky, Noisium) are intentionally excluded.
