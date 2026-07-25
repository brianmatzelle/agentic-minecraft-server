-- jumboplay — sanjuuni websocket stream -> jumbotron monitor faces, plus an
-- in-game channel picker for the ~8.5k-channel iptv-org catalog.
-- (stream protocol from sanjuuni's websocket-player.lua, CC0)
-- LIVE mode: "n" is a rolling head counter — chase it, skip when lagging.
-- Stop: q at the computer, or os.queueEvent("cc_stop").
--
-- The picker talks to stadiumcast's control API (channels.js on :8178) — it
-- never resolves stream URLs itself, so the container stays the only thing that
-- touches ffmpeg/ffprobe and a dead channel gets refused BEFORE the screen
-- flips. Two surfaces, same list:
--   * this computer's terminal — arrow keys, / to search the full catalog
--   * a "guide" monitor — tap a row to tune (see MONITORS below)
-- The video path degrades independently: if the control API is unreachable the
-- menu just says so and the faces keep playing.

local WS_URL  = "ws://stadiumcast:8177"
local CTL_URL = "http://stadiumcast:8178"
local FACES   = {}   -- empty -> auto-detect (see MONITORS)
local GUIDE   = nil  -- monitor name to force as the picker screen, or nil = auto

-- MONITORS: the 5 jumbotron faces are identical in size, so the modal size wins
-- and anything else attached is the guide. Place any monitor that ISN'T
-- 8x4-blocks-like next to computer 10 (or on its wired network) and it becomes
-- the channel board with no config change; with only the faces attached the
-- picker is keyboard-only and nothing else changes.
local function classifyMonitors()
  local mons = {}
  if #FACES > 0 then
    for _, n in ipairs(FACES) do
      local m = peripheral.wrap(n)
      if m then mons[#mons + 1] = { name = n, m = m } end
    end
  else
    for _, n in ipairs(peripheral.getNames()) do
      if peripheral.getType(n) == "monitor" then
        mons[#mons + 1] = { name = n, m = peripheral.wrap(n) }
      end
    end
  end
  for _, e in ipairs(mons) do
    e.m.setTextScale(0.5)
    local w, h = e.m.getSize()
    e.key, e.area = w .. "x" .. h, w * h
  end

  local groups, best = {}, nil
  for _, e in ipairs(mons) do
    groups[e.key] = groups[e.key] or {}
    table.insert(groups[e.key], e)
  end
  for key, g in pairs(groups) do
    -- Most monitors wins; ties break toward the physically bigger screen, which
    -- is the video wall by construction.
    if not best or #g > #groups[best] or (#g == #groups[best] and g[1].area > groups[best][1].area) then
      best = key
    end
  end

  local faces, guide = {}, nil
  for _, e in ipairs(mons) do
    if GUIDE then
      -- Explicit override wins outright, even if it's one of the faces.
      if e.name == GUIDE then guide = e else faces[#faces + 1] = e end
    elseif e.key == best then
      faces[#faces + 1] = e
    elseif not guide or e.area < guide.area then
      -- Smallest odd-sized monitor is the board. A second odd one is ignored
      -- rather than guessed at — set GUIDE above to pick deliberately.
      guide = e
    end
  end
  return faces, guide
end

local faceEntries, guideEntry = classifyMonitors()
local faces = {}
for _, e in ipairs(faceEntries) do faces[#faces + 1] = e.m end
if #faces == 0 then error("no monitor faces found") end

local guide = guideEntry and guideEntry.m or nil
if guide then
  -- A small board is unreadable at the faces' 0.5 scale; step up until the text
  -- is legible but the list still fits.
  guide.setTextScale(1)
  local gw = guide.getSize()
  if gw < 26 then guide.setTextScale(0.5) end
end

local stopped = false

-- Shared picker/stream state. Declared up here because play() reports into it —
-- the terminal is the menu now, so stream health shows in the header instead of
-- scrolling prints.
local ui = {
  list    = {},          -- { {id=, label=, sub=} ... }; sub = country code
  cursor  = 1,
  scroll  = 0,
  now     = "?",
  status  = "loading catalog...",
  busy    = false,
  total   = 0,
  stream  = "connecting",
}

-- --- video (unchanged protocol) ---------------------------------------------

local function drawFrame(chunk)
  local fn = load(chunk, "=frame", "t", {})
  if not fn then return end
  local ok, image, palette = pcall(fn)
  if not ok or not image then return end
  for _, m in ipairs(faces) do
    for i = 0, #palette do m.setPaletteColor(2 ^ i, table.unpack(palette[i])) end
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
    local ws = http.websocket(WS_URL)
    if not ws then
      -- Normal while the feed is parked by the leak guard (up to ~45s) or a
      -- tune is rebuilding the pipeline — keep retrying quietly.
      ui.stream = "waiting for feed"
      sleep(3)
    else
      local head, fps
      local okMeta = pcall(function()
        ws.send("n"); head = tonumber(ws.receive(5), 10)
        ws.send("f"); fps = tonumber(ws.receive(5), 10)
      end)
      if not (okMeta and head and fps) then
        ui.stream = "no metadata"
        pcall(ws.close)
        sleep(3)
      else
        local nextF = math.max(0, head - 1)
        local drawn, t0 = 0, os.epoch("utc")
        ui.stream = ("%dfps in"):format(fps)
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
            if drawn % 50 == 0 then
              local dt = (os.epoch("utc") - t0) / 1000
              if dt > 0 then ui.stream = ("%.1ffps"):format(drawn / dt) end
            end
          end
        end
        pcall(ws.close)
        ui.stream = "reconnecting"
        if not stopped then sleep(2) end
      end
    end
  end
end

-- --- control API ------------------------------------------------------------

local function api(path)
  local ok, res = pcall(http.get, CTL_URL .. path)
  if not ok or not res then return nil, "control API unreachable" end
  local body = res.readAll()
  res.close()
  local okJson, data = pcall(textutils.unserialiseJSON, body)
  if not okJson or type(data) ~= "table" then return nil, "bad response from control API" end
  if data.ok == false then return nil, data.error or (data.building and "catalog still building") or "refused" end
  return data
end

-- --- picker state -----------------------------------------------------------


local LIVE_ROW = { live = true, label = "Live world camera", sub = "cam" }

local function setStatus(s) ui.status = s end

local function loadCurated()
  ui.busy = true
  local data, err = api("/channels")
  ui.busy = false
  if not data then
    ui.list = { LIVE_ROW }
    ui.now = "?"
    setStatus(err)
    return
  end
  local list = { LIVE_ROW }
  for _, c in ipairs(data.curated or {}) do
    list[#list + 1] = { id = c.id, label = c.label, sub = string.lower(c.country or "") }
  end
  ui.list, ui.total = list, data.total or 0
  ui.now = (data.now and data.now.label) or "?"
  ui.cursor, ui.scroll = 1, 0
  setStatus(("%d curated - / to search %d channels"):format(#list - 1, ui.total))
end

local function doSearch(q)
  if not q or q == "" then return loadCurated() end
  ui.busy = true
  local data, err = api("/search?q=" .. textutils.urlEncode(q))
  ui.busy = false
  if not data then setStatus(err) return end
  local list = {}
  for _, c in ipairs(data.results or {}) do
    list[#list + 1] = { id = c.id, label = c.name, sub = string.lower(c.country or "") }
  end
  ui.list = list
  ui.cursor, ui.scroll = 1, 0
  if #list == 0 then
    ui.list = { LIVE_ROW }
    setStatus("nothing matched - esc for the curated grid")
  else
    setStatus(("%d hits - enter tunes, esc back"):format(#list))
  end
end

local function tune(row)
  if not row then return end
  ui.busy = true
  setStatus(("tuning %s..."):format(row.label))
  local path = row.live and "/tune?mode=live" or ("/tune?id=" .. textutils.urlEncode(row.id))
  local data, err = api(path)
  ui.busy = false
  if not data then
    setStatus("failed: " .. err)          -- source.sh refused; old channel still up
    return
  end
  ui.now = (data.now and data.now.label) or row.label
  setStatus(("on %s - faces relight in ~10s"):format(ui.now))
end

-- --- drawing ----------------------------------------------------------------

local function drawTo(t, touch)
  local w, h = t.getSize()
  local rows = h - 4                                  -- header, rule, status, help
  if rows < 1 then return end

  if ui.cursor < ui.scroll + 1 then ui.scroll = ui.cursor - 1 end
  if ui.cursor > ui.scroll + rows then ui.scroll = ui.cursor - rows end

  t.setBackgroundColor(colors.black)
  t.setTextColor(colors.white)
  t.clear()

  -- header: what's on, plus the measured face draw rate as a health badge
  local badge = ui.stream or ""
  t.setCursorPos(1, 1)
  t.setTextColor(colors.lime)
  t.write("ON AIR ")
  t.setTextColor(colors.white)
  local nowStr = ui.now or "?"
  local room = w - 7 - #badge - 1
  if #nowStr > room then nowStr = nowStr:sub(1, math.max(1, room)) end
  t.write(nowStr)
  if #badge > 0 and #badge < w then
    t.setCursorPos(w - #badge + 1, 1)
    t.setTextColor(colors.gray)
    t.write(badge)
  end

  t.setCursorPos(1, 2)
  t.setTextColor(colors.gray)
  t.write(("-"):rep(w))

  for i = 1, rows do
    local idx = ui.scroll + i
    local row = ui.list[idx]
    if not row then break end
    local sel = (idx == ui.cursor)
    t.setCursorPos(1, 2 + i)
    t.setBackgroundColor(sel and colors.gray or colors.black)
    t.setTextColor(row.live and colors.yellow or (sel and colors.white or colors.lightGray))
    local sub = row.sub or ""
    local label = row.label
    local room = w - 2 - #sub - 1
    if #label > room then label = label:sub(1, math.max(1, room - 1)) .. "." end
    local line = (sel and " >" or "  ") .. label
    t.write((line .. (" "):rep(math.max(0, w - #line - #sub)) .. sub):sub(1, w))
  end

  t.setBackgroundColor(colors.black)
  t.setCursorPos(1, h - 1)
  t.setTextColor(ui.busy and colors.yellow or colors.lightGray)
  local st = ui.status or ""
  if #st > w then st = st:sub(1, w) end
  t.write(st .. (" "):rep(math.max(0, w - #st)))

  t.setCursorPos(1, h)
  t.setTextColor(colors.gray)
  local help = touch and "tap a row - c camera" or "arrows +enter  / search  c cam  q quit"
  if #help > w then help = help:sub(1, w) end
  t.write(help)
end

local function redraw()
  drawTo(term, false)
  if guide then pcall(drawTo, guide, true) end
end

-- --- picker event loop ------------------------------------------------------

local function picker()
  loadCurated()
  redraw()
  -- Slow tick: refreshes the draw-rate badge, and picks up tunes that came from
  -- somewhere else (a player's "!g put X on the jumbotron", ops running
  -- source.sh) so the header never lies about what's on.
  local tick = os.startTimer(5)
  while not stopped do
    local e = { os.pullEvent() }
    local ev = e[1]

    if ev == "cc_stop" then stopped = true return end

    if ev == "timer" and e[2] == tick then
      local data = api("/now")
      if data and data.now and data.now.label then ui.now = data.now.label end
      tick = os.startTimer(5)
      redraw()
    end

    if ev == "key" then
      local k = e[2]
      if k == keys.q then stopped = true return
      elseif k == keys.down then ui.cursor = math.min(#ui.list, ui.cursor + 1)
      elseif k == keys.up   then ui.cursor = math.max(1, ui.cursor - 1)
      elseif k == keys.pageDown then ui.cursor = math.min(#ui.list, ui.cursor + 10)
      elseif k == keys.pageUp   then ui.cursor = math.max(1, ui.cursor - 10)
      elseif k == keys.enter then tune(ui.list[ui.cursor])
      elseif k == keys.r then loadCurated()
      elseif k == keys.escape then loadCurated()
      elseif k == keys.c then tune(LIVE_ROW)
      elseif k == keys.slash then
        -- Modal read on the computer only; the guide keeps showing the old list.
        local w, h = term.getSize()
        term.setBackgroundColor(colors.black)
        term.setTextColor(colors.white)
        term.setCursorPos(1, h - 1)
        term.write((" "):rep(w))
        term.setCursorPos(1, h - 1)
        term.setTextColor(colors.lime)
        term.write("search: ")
        term.setTextColor(colors.white)
        doSearch(read())
      end
      redraw()

    elseif ev == "monitor_touch" and guideEntry and e[2] == guideEntry.name then
      local y = e[4]
      local _, gh = guide.getSize()
      if y >= 3 and y <= gh - 2 then
        local idx = ui.scroll + (y - 2)
        if ui.list[idx] then
          ui.cursor = idx
          redraw()                                   -- show the selection first
          tune(ui.list[idx])
        end
      elseif y == gh then
        tune(LIVE_ROW)                               -- help row doubles as "camera"
      elseif y <= 2 then
        loadCurated()
      end
      redraw()

    elseif ev == "term_resize" or ev == "monitor_resize" then
      redraw()
    end
  end
end

parallel.waitForAny(play, picker)

for _, m in ipairs(faces) do
  for i = 0, 15 do m.setPaletteColor(2 ^ i, term.nativePaletteColor(2 ^ i)) end
  m.setBackgroundColor(colors.black); m.setTextColor(colors.white)
  m.clear(); m.setCursorPos(2, 2); m.write("jumbotron idle")
end
if guide then
  guide.setBackgroundColor(colors.black); guide.setTextColor(colors.gray)
  guide.clear(); guide.setCursorPos(2, 2); guide.write("picker offline")
end
term.setBackgroundColor(colors.black)
term.setTextColor(colors.white)
term.clear()
term.setCursorPos(1, 1)
print("stopped.")
