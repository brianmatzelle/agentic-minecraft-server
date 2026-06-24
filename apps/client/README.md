# apps/client — the player-facing client modpack

What friends import to join **mc.starting.cc** without a mod mismatch.

| File | What it is |
|------|------------|
| `starting-cc-client.mrpack` | The importable [Modrinth modpack](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack). One-click import in **Prism Launcher** (*Add Instance → Import*) or the **Modrinth App**. Installs NeoForge 1.21.1 + every client mod pinned to the server's exact version & hash. |
| `modrinth.index.json` | The pack's manifest, committed **uncompressed** so PRs show exactly which mods/versions/hashes/URLs changed. It's the same JSON that lives inside the `.mrpack` zip. |

Players download the `.mrpack` straight from GitHub:
<https://github.com/brianmatzelle/agentic-minecraft-server/raw/main/apps/client/starting-cc-client.mrpack>
(Garvis hands friends this link.) The install walkthrough is
[`docs/windows-client-install.md`](../../docs/windows-client-install.md).

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
   `starting-cc-client.mrpack`.
4. Update the version table in `docs/windows-client-install.md` if you want the
   doc's numbers fresh (the pack itself is always authoritative).

Both the server (itzg) and this pack track **latest compatible NeoForge
1.21.1**, so regenerating right after a modlist change keeps client and server
byte-identical. Server-only perf mods (Lithium, FerriteCore, ModernFix, spark,
Chunky, Noisium) are intentionally excluded.
