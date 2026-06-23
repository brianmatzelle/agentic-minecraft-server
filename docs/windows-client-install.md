# Installing the modded client on Windows (the @Garvis guide)

This is the friendly, copy-pasteable guide @Garvis gives friends who want to
join. Target: **NeoForge 1.21.x** (matches the server). No prior modding
experience needed.

> Your mods must match the server. When in doubt, ask Garvis for the current
> client mod bundle — adding the wrong/old mods is the #1 reason joining fails.

## 1. Install Minecraft Java Edition
- Buy/own **Minecraft: Java Edition** and install the official launcher from
  <https://www.minecraft.net/download>. (Java Edition — *not* Bedrock.)
- Launch it once, sign in, and run version **1.21.1** a single time so the files
  generate. The launcher bundles its own Java, so you usually don't install Java
  separately.

## 2. Install NeoForge (the mod loader)
- Go to <https://neoforged.net/> → download the **installer** for **1.21.1**.
- Double-click the downloaded `.jar`. If it won't open, you need Java — install
  **Adoptium Temurin 21** from <https://adoptium.net/> and try again.
- In the installer window, choose **Install client** → OK.

## 3. Add the mods
- Press `Win+R`, type `%appdata%\.minecraft`, press Enter.
- Open the **`mods`** folder (create it if missing).
- Drop in the **client mod `.jar` files** Garvis gives you. (Keep the folder to
  exactly that set — extra/old mods cause crashes.)

## 4. Launch the modded profile
- Open the Minecraft launcher → the version dropdown (bottom-left) → pick the
  **NeoForge 1.21.1** profile → **Play**.

## 5. Connect to the server
- **Multiplayer → Add Server** → Server Address: `SERVER_IP:25565`
  (Garvis will give you the current address) → Done → Join.

## Troubleshooting (ask Garvis)
- *"Outdated client/server" / failed handshake* → your mod versions don't match
  the server. Get the latest bundle from Garvis.
- *Crash on startup* → remove mods you added manually; use only Garvis's bundle.
- *Installer won't open* → install Temurin 21 (step 2).
- *Can't find the address* → ask Garvis: "what's the server IP?"
