-- follow : roaming turtle that chases the target using positions broadcast by
-- follow-host. Dead-reckons its own position, seeded from /follow.cfg and then
-- continuously persisted there after every move (self-heals across reboots /
-- chunk reloads — see save()). The "funny snail" follower. 🐌
-- Backgrounded in a multishell tab; honors q / cc_stop to exit.

local PROTO       = "follow"
local CFG         = "/follow.cfg"
local STEP_PERIOD = 0.5   -- seconds per step (snail pace, on purpose)
local REACH       = 2     -- stop closing when within this many blocks (horizontal)

-- ---- load calibration ---------------------------------------------------
if not fs.exists(CFG) then error("not calibrated: " .. CFG .. " missing", 0) end
local fh = fs.open(CFG, "r"); local cfg = textutils.unserialize(fh.readAll()); fh.close()
if type(cfg) ~= "table" or not cfg.x then error("bad " .. CFG, 0) end

-- dead-reckoned state. dir: 0=north(-Z) 1=east(+X) 2=south(+Z) 3=west(-X)
local pos = { x = cfg.x, y = cfg.y, z = cfg.z }
local dir = cfg.dir or 0
local DV  = { [0] = { x = 0, z = -1 }, [1] = { x = 1, z = 0 },
              [2] = { x = 0, z = 1 },  [3] = { x = -1, z = 0 } }

-- persist pos+dir after every in-world action so the snail self-heals across
-- reboots / chunk reloads: an unloaded turtle never moves, so the last block we
-- saved IS its true block when the chunk reloads → it resumes with no recalibration.
local function save()
  local f = fs.open(CFG, "w")
  f.write(textutils.serialize({ x = pos.x, y = pos.y, z = pos.z, dir = dir }))
  f.close()
end

-- ---- movement helpers (keep pos/dir in sync + persisted, only on success) ----
local function tr() if turtle.turnRight() then dir = (dir + 1) % 4; save() end end
local function tl() if turtle.turnLeft()  then dir = (dir + 3) % 4; save() end end
local function fwd()
  if turtle.forward() then pos.x = pos.x + DV[dir].x; pos.z = pos.z + DV[dir].z; save(); return true end
  return false
end
local function up()   if turtle.up()   then pos.y = pos.y + 1; save(); return true end return false end
local function down() if turtle.down() then pos.y = pos.y - 1; save(); return true end return false end

local function face(want)               -- rotate to cardinal `want` with minimal turns
  local diff = (want - dir) % 4
  if     diff == 1 then tr()
  elseif diff == 3 then tl()
  elseif diff == 2 then tr(); tr() end
end

-- ---- modem / rednet -----------------------------------------------------
-- prefer a WIRELESS modem (a wired one can't talk to the stationary host).
local modem
for _, n in ipairs(peripheral.getNames()) do
  if peripheral.getType(n) == "modem" then
    if peripheral.call(n, "isWireless") then modem = n break end
    modem = modem or n   -- remember a wired modem only as a last resort
  end
end
if not modem then error("no modem equipped on the turtle", 0) end
rednet.open(modem)

local W, H = term.getSize()
local function status(s) term.setCursorPos(1, H); term.clearLine(); term.write(s:sub(1, W)) end

term.clear(); term.setCursorPos(1, 1)
print("follow: chasing the player. q / cc_stop to stop.")
print(("start @ %d,%d,%d  dir=%d  fuel=%s"):format(pos.x, pos.y, pos.z, dir, tostring(turtle.getFuelLevel())))

-- top up fuel from any inventory slot when we run low. turtle.refuel() with no
-- arg burns the whole stack in the selected slot (coal/charcoal/lava bucket all
-- work; a lava bucket leaves an empty bucket behind). Fuel is just a number, so
-- burning early wastes nothing. Returns true if we have any fuel to move on.
local FUEL_MIN = 20
local function ensureFuel()
  local lvl = turtle.getFuelLevel()
  if lvl == "unlimited" or lvl >= FUEL_MIN then return true end
  local keep = turtle.getSelectedSlot()
  for s = 1, 16 do turtle.select(s); turtle.refuel() end
  turtle.select(keep)
  return turtle.getFuelLevel() > 0
end

local target = nil   -- last position heard from the host

local function stepToward()
  if not target then status("waiting for a position...") return end
  if not ensureFuel() then status("OUT OF FUEL — give me coal/charcoal or a lava bucket") return end

  local dx, dz = target.x - pos.x, target.z - pos.z
  local dist = math.abs(dx) + math.abs(dz)
  if dist <= REACH then status(("caught up (d=%d), waiting"):format(dist)) return end

  -- aim along the larger horizontal gap
  local want
  if math.abs(dx) >= math.abs(dz) then want = (dx > 0) and 1 or 3
  else                                 want = (dz > 0) and 2 or 0 end
  face(want)

  if not fwd() then up() end          -- blocked? try to climb a 1-block step (never dig)
  -- drop back down toward the player's level when there's open air below
  if target.y and pos.y > target.y and not turtle.detectDown() then down() end

  status(("me %d,%d,%d -> %d,%d,%d  d=%d"):format(
    pos.x, pos.y, pos.z, target.x, target.y or 0, target.z, dist))
end

local tick = os.startTimer(STEP_PERIOD)
while true do
  local e = { os.pullEvent() }
  if e[1] == "timer" and e[2] == tick then
    stepToward()
    tick = os.startTimer(STEP_PERIOD)
  elseif e[1] == "rednet_message" then
    local msg, proto = e[3], e[4]
    if proto == PROTO and type(msg) == "table" and msg.x then
      target = { x = math.floor(msg.x), y = math.floor(msg.y), z = math.floor(msg.z), dim = msg.dim }
    end
  elseif e[1] == "key" and e[2] == keys.q then break
  elseif e[1] == "cc_stop" then break
  end
end
rednet.close(modem)
term.setBackgroundColor(colors.black); term.setTextColor(colors.white)
term.clear(); term.setCursorPos(1, 1)
print("follow: stopped.")
