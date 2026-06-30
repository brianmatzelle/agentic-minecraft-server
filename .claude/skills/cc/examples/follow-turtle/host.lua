-- follow-host : runs on the desktop (computer-2).
-- Reads the target player's live position from the Player Detector and
-- broadcasts it over rednet so the roaming turtle can chase it.
-- Backgrounded in a multishell tab; honors q / cc_stop to exit.

local TARGET = "DubstepCow_"
local PROTO  = "follow"
local PERIOD = 0.4               -- seconds between position broadcasts

local det = peripheral.find("player_detector")
if not det then error("no player_detector attached", 0) end

-- prefer a WIRELESS modem: a wired one can't reach the roaming turtle. computer-2
-- has both (a wired modem on the network + a wireless one), and grabbing the first
-- modem found silently opened the wired one → broadcasts never reached the snail.
local modem
for _, n in ipairs(peripheral.getNames()) do
  if peripheral.getType(n) == "modem" then
    if peripheral.call(n, "isWireless") then modem = n break end
    modem = modem or n   -- remember a wired modem only as a last resort
  end
end
if not modem then error("no modem attached", 0) end
rednet.open(modem)

term.clear(); term.setCursorPos(1, 1)
print("follow-host: tracking " .. TARGET)
print("broadcasting on rednet '" .. PROTO .. "' every " .. PERIOD .. "s")
print("(q or cc_stop to stop)")

local sent = 0
local timer = os.startTimer(PERIOD)
while true do
  local e = { os.pullEvent() }
  if e[1] == "timer" and e[2] == timer then
    local ok, p = pcall(det.getPlayerPos, TARGET)
    if ok and type(p) == "table" and p.x then
      rednet.broadcast({ x = p.x, y = p.y, z = p.z, dim = p.dimension, yaw = p.yaw }, PROTO)
      sent = sent + 1
      local _, h = term.getSize()
      term.setCursorPos(1, h)
      term.clearLine()
      term.write(("#%d  player @ %d,%d,%d"):format(sent, p.x, p.y, p.z))
    end
    timer = os.startTimer(PERIOD)
  elseif e[1] == "cc_stop" then break
  elseif e[1] == "key" and e[2] == keys.q then break
  end
end
rednet.close(modem)
print("\nfollow-host: stopped.")
