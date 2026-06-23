# Installing the modded client (the @Garvis guide)

This is the friendly, copy-pasteable guide @Garvis gives friends who want to
join. Target: **NeoForge 1.21.1** (matches the server). No prior modding
experience needed. Steps are written for Windows; on macOS/Linux the idea is the
same — ask Garvis and he'll tailor it to your OS.

> Your mods must match the server. When in doubt, ask Garvis: **“what client mods
> do I need?”** Adding the wrong/old mods is the #1 reason joining fails.

## Required client mods for THIS server
Two of our mods must be installed on **your** computer too (not just the server),
or you won't be able to connect. A third is a dependency they pull in:

| Mod | Modrinth | Version (NeoForge 1.21.1) | Why |
|-----|----------|---------------------------|-----|
| **CC: Tweaked** | <https://modrinth.com/mod/cc-tweaked> | `1.120.0` | ComputerCraft computers/turtles |
| **Cobblemon** | <https://modrinth.com/mod/cobblemon> | `1.7.3` | Pokémon |
| **Kotlin for Forge** | <https://modrinth.com/mod/kotlin-for-forge> | `5.11.0` | required by Cobblemon |

The server also runs performance mods (Lithium, FerriteCore, ModernFix, spark,
Chunky, Noisium) — **you do NOT need those on the client.** Only the three above.

> Easiest path: use a launcher that resolves dependencies for you (the
> **[Modrinth App](https://modrinth.com/app)** or **[Prism Launcher](https://prismlauncher.org/)**).
> Add CC: Tweaked and Cobblemon and it pulls in Kotlin for Forge automatically.

## 1. Install Minecraft Java Edition
- Own **Minecraft: Java Edition** and install the official launcher from
  <https://www.minecraft.net/download>. (Java Edition — *not* Bedrock.)
- Launch it once, sign in, and run version **1.21.1** a single time so the files
  generate. The launcher bundles its own Java.

## 2. Install NeoForge (the mod loader)
- Go to <https://neoforged.net/> → download the **installer** for **1.21.1**.
- Double-click the downloaded `.jar`. If it won't open, install **Adoptium
  Temurin 21** from <https://adoptium.net/> and try again.
- In the installer window, choose **Install client** → OK.

## 3. Add the mods
- Press `Win+R`, type `%appdata%\.minecraft`, press Enter.
- Open the **`mods`** folder (create it if missing).
- Put the **three client `.jar` files** there (download from the Modrinth links
  above, choosing the **NeoForge 1.21.1** file for each):
  - `cc-tweaked-1.21.1-forge-1.120.0.jar`
  - `Cobblemon-neoforge-1.7.3+1.21.1.jar`
  - `kotlinforforge-5.11.0-all.jar`
- Keep the folder to exactly that set — extra/old mods cause crashes. (If you used
  the Modrinth App / Prism, it already placed these for you.)

## 4. Launch the modded profile
- Open the Minecraft launcher → version dropdown (bottom-left) → pick the
  **NeoForge 1.21.1** profile → **Play**.

## 5. Connect to the server
- **Multiplayer → Add Server** → Server Address: `SERVER_IP:25565`
  (ask Garvis for the current address) → Done → Join.
- Note: the server uses a **whitelist** — ask the owner to add your exact
  Minecraft username, or you'll be turned away at the door.

## Troubleshooting (ask Garvis)
- *“Outdated client/server” / failed handshake* → your mod versions don't match.
  Get the current versions from the table above, or ask Garvis.
- *Crash on startup* → remove any mods you added beyond the three above.
- *“You are not white-listed on this server”* → ask the owner to whitelist your
  username.
- *Installer won't open* → install Temurin 21 (step 2).
- *Can't find the address* → ask Garvis: “what's the server IP?”
