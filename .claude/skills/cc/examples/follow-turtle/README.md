# follow-turtle — a player-following turtle ("the snail") 🐌

A worked `/cc` example: a turtle that crawls after a player, using **Advanced
Peripherals' Player Detector** + **rednet** + **dead-reckoning**. Built & verified
live 2026-06-30. Vanilla CC can't read a player's position — this needs the
`advancedperipherals` mod (LIVE on the server as of PR #53).

## Architecture (two devices)

```
 ┌─ computer-2 (host, id 2) ──────────────┐        rednet            ┌─ turtle (id 1) ─────────┐
 │ player_detector (side "left")          │  proto "follow"          │ wireless modem ("left") │
 │ wireless modem   (side "right")        │ ───{x,y,z,dim,yaw}──────▶│ runs follow.lua         │
 │ runs host.lua:                         │   every 0.4s             │ dead-reckons own pos    │
 │   getPlayerPos("DubstepCow_") → bcast  │                          │ from /follow.cfg, steps │
 └────────────────────────────────────────┘                          │ toward the player       │
                                                                      └─────────────────────────┘
```

The detector is a **stationary block**, so a roaming turtle can't carry it — the
host relays the player's absolute coords wirelessly, and the turtle tracks its own
position by counting every move from a calibrated origin.

- **`host.lua`** → deployed to `computer-2` as `/host.lua`. Reads the Player
  Detector, broadcasts the target's position on rednet protocol `follow`.
- **`follow.lua`** → deployed to the turtle as `/follow.lua`. Loads `/follow.cfg`
  (`{x,y,z,dir}`), receives broadcasts, faces + steps toward the player. Never digs;
  climbs 1-block steps; stops within 2 blocks. `dir`: `0=N(-Z) 1=E(+X) 2=S(+Z) 3=W(-X)`.

## Gotchas baked in here

- AP peripheral **type is `player_detector`** (underscore) — `peripheral.find("playerDetector")` returns nil.
- `getPlayerPos`/`getPlayer` return **integer block coords** (x,y,z) + float yaw/pitch/dimension.
- Yaw → cardinal: `[315,45)=S`, `[45,135)=W`, `[135,225)=N`, `[225,315)=E`.
- Both loops **yield forever → must run in background tabs** (`ccdeploy`), never inline.

## Redeploy / restart (run from repo root)

```bash
# confirm both devices are on the tunnel
apps/server/garvtunnel/cc -s

# host broadcaster (background, don't steal the desktop screen)
CCDEPLOY_ID=2 CCDEPLOY_NOFOCUS=1 .claude/skills/cc/scripts/ccdeploy \
  .claude/skills/cc/examples/follow-turtle/host.lua /host.lua host

# RECALIBRATE first (position resets on reboot / drifts if stuck): stand on the
# turtle facing its front, then write /follow.cfg to its TRUE current block:
#   tx = playerX, ty = playerY-1, tz = playerZ, dir = (player yaw → cardinal)
apps/server/garvtunnel/cc -i 1 'local f=fs.open("/follow.cfg","w"); f.write(textutils.serialize({x=TX,y=TY,z=TZ,dir=DIR})); f.close()'

# launch the follower
CCDEPLOY_ID=1 .claude/skills/cc/scripts/ccdeploy \
  .claude/skills/cc/examples/follow-turtle/follow.lua /follow.lua follow
```

## Stop

```bash
apps/server/garvtunnel/cc -i 1 'os.queueEvent("cc_stop")'   # stop the turtle
apps/server/garvtunnel/cc -i 2 'os.queueEvent("cc_stop")'   # stop the host
```

## Limits (v1)

- **Fuel** ≈ a few hundred blocks of travel; drop coal/charcoal in its inventory to refuel.
- **Dead-reckoning drift**: getting shoved/stuck desyncs its mental map → recalibrate.
- **Reboot/chunk-unload** stops the chase and forgets position (files persist; relaunch + recalibrate).
- Slow ground crawler — can't follow through portals, deep water, or big cliffs reliably.

Robust upgrade path: a 4-computer **GPS constellation** so the turtle reads its own
absolute position (no drift, no calibration) instead of dead-reckoning.
