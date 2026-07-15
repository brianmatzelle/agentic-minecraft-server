-- jumboplay — sanjuuni websocket stream -> jumbotron monitor faces
-- (protocol from sanjuuni's websocket-player.lua, CC0)
-- LIVE mode: "n" is a rolling head counter — chase it, skip when lagging.
-- Stop: q at the computer, or os.queueEvent("cc_stop").

local URL   = "ws://stadiumcast:8177"
local FACES = {}   -- empty -> auto-detect every attached monitor

local faces = {}
if #FACES > 0 then
  for _,n in ipairs(FACES) do
    local m = peripheral.wrap(n)
    if m then faces[#faces+1] = m end
  end
else
  for _,n in ipairs(peripheral.getNames()) do
    if peripheral.getType(n) == "monitor" then faces[#faces+1] = peripheral.wrap(n) end
  end
end
if #faces == 0 then error("no monitor faces found") end
for _,m in ipairs(faces) do m.setTextScale(0.5) end

local stopped = false

local function drawFrame(chunk)
  local fn = load(chunk, "=frame", "t", {})
  if not fn then return end
  local ok, image, palette = pcall(fn)
  if not ok or not image then return end
  for _,m in ipairs(faces) do
    for i = 0, #palette do m.setPaletteColor(2^i, table.unpack(palette[i])) end
    for y, r in ipairs(image) do
      m.setCursorPos(1, y)
      m.blit(table.unpack(r))
    end
  end
end

local function recvFrame(ws)
  local frame = ws.receive(5)
  if not frame then return nil end
  while #frame % 65535 == 0 do
    local more = ws.receive(5)
    if not more then break end
    frame = frame .. more
  end
  return frame
end

local function play()
  while not stopped do
    local ws, err = http.websocket(URL)
    if not ws then
      print("connect failed (" .. tostring(err) .. "), retry in 3s")
      sleep(3)
    else
      local head, fps
      local okMeta = pcall(function()
        ws.send("n"); head = tonumber(ws.receive(5), 10)
        ws.send("f"); fps = tonumber(ws.receive(5), 10)
      end)
      if not (okMeta and head and fps) then
        print("no stream metadata, retry in 3s")
        pcall(ws.close)
        sleep(3)
      else
        print(("live @ %dfps, head=%d, %d face(s)"):format(fps, head, #faces))
        local nextF = math.max(0, head - 1)
        local drawn, t0 = 0, os.epoch("utc")
        while not stopped do
          if nextF >= head then
            sleep(1 / fps)                          -- caught up: wait for new frames
            local okN = pcall(function() ws.send("n"); head = tonumber(ws.receive(5), 10) or head end)
            if not okN then break end
          else
            if head - nextF > 2 * fps then nextF = head - 1 end   -- too far behind: jump to live
            ws.send("v" .. nextF)
            local frame = recvFrame(ws)
            if not frame then break end             -- stalled -> reconnect
            drawFrame(frame)
            nextF = nextF + 1
            drawn = drawn + 1
            if drawn % 100 == 0 then
              local dt = (os.epoch("utc") - t0) / 1000
              print(("%d frames, %.1f fps actual"):format(drawn, drawn / dt))
            end
          end
        end
        pcall(ws.close)
        if not stopped then print("stream ended, reconnecting"); sleep(2) end
      end
    end
  end
end

local function stopWatcher()
  while true do
    local e = { os.pullEvent() }
    if e[1] == "cc_stop" then stopped = true return end
    if e[1] == "key" and e[2] == keys.q then stopped = true return end
  end
end

parallel.waitForAny(play, stopWatcher)

for _,m in ipairs(faces) do
  for i = 0, 15 do m.setPaletteColor(2^i, term.nativePaletteColor(2^i)) end
  m.setBackgroundColor(colors.black); m.setTextColor(colors.white)
  m.clear(); m.setCursorPos(2, 2); m.write("jumbotron idle")
end
print("stopped.")
