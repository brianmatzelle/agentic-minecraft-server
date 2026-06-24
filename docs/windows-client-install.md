# Installing the modded client (the @Garvis guide)

This is the friendly, copy-pasteable guide @Garvis gives friends who want to
join **mc.starting.cc**. Target: **NeoForge 1.21.1** (matches the server). No
prior modding experience needed. Steps are written for Windows; on macOS/Linux
the idea is identical — the one-click modpack below works the same everywhere.

> Your mods must match the server. The server runs **21 client-side mods** now
> (Cobblemon + a stack of add-ons, Waystones, Sophisticated Backpacks, Farmer's
> Delight, Create…). Installing the wrong/old/missing mods is the #1 reason
> joining fails — so **don't hand-pick them, import the modpack.**

## ⭐ Easiest path — import the modpack (one click)

We ship a **Modrinth modpack** (`.mrpack`) that pins every client mod to the
exact version the server runs. Importing it installs NeoForge 1.21.1, the right
Java, and all 21 mods at once — no mismatch possible.

1. **Install a launcher that imports modpacks:**
   - **[Prism Launcher](https://prismlauncher.org/)** (recommended), or
   - the **[Modrinth App](https://modrinth.com/app)**.
2. **Download the pack** (save the file somewhere you can find it):
   **<https://github.com/brianmatzelle/agentic-minecraft-server/raw/main/apps/client/starting-cc-client.mrpack>**
3. **Import it:**
   - **Prism Launcher:** **Add Instance → Import → Local file** → pick
     `starting-cc-client.mrpack` → **OK**. (If Prism asks about Java, let it
     download **Java 21**.)
   - **Modrinth App:** **File → Import / Import from file** (or just drag the
     `.mrpack` onto the window) → select the instance to create.
4. **Launch the instance once** (the ▶ button) so it downloads the mods.
5. **Add the server:** in-game **Multiplayer → Add Server** → address
   `mc.starting.cc` → **Done**.
6. **Get whitelisted** (see *Whitelist* below), then **Join**.

> The pack marks **Create, JEI and Jade** as *optional* — they're included and
> installed by default for the full experience, but you can untick them on
> import if you want a leaner client. Everything else is required to connect.
>
> *Want more FPS?* Add **Sodium** (NeoForge 1.21.1) to the instance afterward —
> it's client-only and safe to add on top of the pack.

## What's in the pack

These are the versions pinned in the modpack (matching the live server). The
**modpack is the source of truth** — if a version ever looks off, just re-import
it, or ask Garvis: *"what client mods do I need?"*

| Mod | Version (NeoForge 1.21.1) | Role |
|-----|---------------------------|------|
| **Cobblemon** | `1.7.3` | catch & battle Pokémon (the core) |
| **Radical Cobblemon Trainers** | `0.18.1-beta` | NPC trainers to battle |
| **Cobblemon: Mega Showdown** | `1.8.4+1.7.3+1.21.1` | Mega Evolution, Dynamax, Z-moves |
| **SimpleTMs** | `2.3.3` | TMs & TRs to teach moves |
| **CobbleDollars** | `2.0.0+Beta-5.1` | in-game currency / shops |
| **Cobblepedia** | `0.7.1-neoforge` | in-game Pokédex |
| **CC: Tweaked** | `1.120.0` | programmable computers/turtles |
| **Waystones** | `21.1.34+neoforge-1.21.1` | fast-travel network |
| **Sophisticated Backpacks** | `1.21.1-3.25.64.1919` | upgradable backpacks |
| **Farmer's Delight** | `1.21.1-1.3.2` | cooking & farming |
| **Create** *(optional)* | `6.0.10+mc1.21.1` | mechanical contraptions |
| **JEI** *(optional)* | `19.27.0.343` | recipe viewer |
| **Jade** *(optional)* | `15.10.5+neoforge` | "what am I looking at" tooltips |
| *libraries* | — | Kotlin for Forge, Architectury, Accessories, oωo-lib, Patchouli, Balm, Sophisticated Core, Radical Trainers API |

The server also runs performance mods (**Lithium, FerriteCore, ModernFix,
spark, Chunky, Noisium**) — these are **server-only; do NOT install them on the
client.** The modpack already leaves them out.

## Whitelist

The server only admits listed players. Give the owner your **exact,
case-sensitive** Minecraft name — watch for trailing characters (e.g. `Name`
vs `Name_`); a one-character mismatch is rejected at the door.

---

## Manual install (fallback, no modpack)

Prefer not to use the `.mrpack`? Use a launcher's built-in Modrinth browser so
dependencies resolve automatically — adding 21 mods by hand is error-prone.

1. **Create the instance** — in **Prism Launcher**, **Add Instance →
   Minecraft 1.21.1**, choose **NeoForge** (take the suggested 1.21.1 build),
   name it, **OK**. Let Prism download **Java 21** if it asks.
2. **Add the mods** — select the instance → **Edit → Mods → Download mods** (the
   built-in Modrinth browser). Add every mod in the table above, confirming each
   says **NeoForge / 1.21.1**. The launcher pulls in the libraries
   (Kotlin for Forge, Architectury, Accessories, oωo-lib, Patchouli, Balm,
   Sophisticated Core, RCT API) automatically — just check they landed.
3. **Launch** once (▶) so it downloads everything.
4. **Add the server** — **Multiplayer → Add Server** → `mc.starting.cc` → Done.
5. **Get whitelisted**, then **Join**.

### Official-launcher route (no third-party launcher)
Only if you can't use Prism/Modrinth App. This is the hard way for a 21-mod set.

1. Own **Minecraft: Java Edition** (not Bedrock); install the launcher from
   <https://www.minecraft.net/download> and run **1.21.1** once.
2. Install **NeoForge 1.21.1** from <https://neoforged.net/> → **Install client**.
   (If the `.jar` won't open, install **Adoptium Temurin 21** from
   <https://adoptium.net/> first.)
3. Press `Win+R`, type `%appdata%\.minecraft`, open the **`mods`** folder
   (create it if missing), and drop in the **NeoForge 1.21.1** `.jar` for every
   mod in the table above **plus its libraries**. Keep the folder to exactly
   that set — extra/old mods cause crashes.
4. Launcher → version dropdown → **NeoForge 1.21.1** → **Play**.
5. **Multiplayer → Add Server** → `mc.starting.cc` → Done → Join (after whitelist).

## Troubleshooting (ask Garvis)
- *"Outdated client/server" / failed handshake* → your mods don't match. Easiest
  fix: re-import the latest `.mrpack` (link above). Or ask Garvis for the
  current versions.
- *Crash on startup* → you have a mod the server doesn't, or a wrong version.
  Re-import the pack into a fresh instance.
- *"You are not white-listed on this server"* → the whitelisted name doesn't
  exactly match your account. Send the owner your **exact** in-game name (mind
  capitalization and any trailing `_`) and have them re-add it.
- *Installer won't open* (manual route) → install Temurin 21.
- *Can't find the address* → it's `mc.starting.cc`. Or ask Garvis:
  "what's the server address?"
