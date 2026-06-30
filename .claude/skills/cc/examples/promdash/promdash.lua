-- promdash.lua — live Minecraft server-performance dashboard for CraftOS.
--
-- Source: the Prometheus metrics sidecar (the SAME data behind the Grafana
-- "Server Performance" dashboard) via its JSON query API. Grafana itself is a
-- React web app and can't render in CraftOS, so we query Prometheus directly
-- and redraw the panels natively in 16 colors.
--
-- RESPONSIVE: on a monitor it auto-picks a text scale targeting ~TARGET_COLS
-- characters wide (so the board fills with big, readable content regardless of
-- how many monitor blocks you wired up), and the whole layout is proportional
-- to the screen. Hot-pluggable — attach/remove monitors while it runs. Use
-- ADVANCED (gold) monitors for color. Falls back to this computer's terminal.
--
-- Requires an http allow-rule for host "prometheus" ABOVE the "$private" deny in
-- computercraft-server.toml (see README). Until then the dashboard shows a
-- banner explaining the fix instead of data.
--
-- Stop: press q in-game, or from the host:
--   apps/server/garvtunnel/cc 'os.queueEvent("cc_stop")'

local PROM        = "http://prometheus:9090"
local REFRESH     = 5    -- seconds between scrapes
local TARGET_COLS = 50   -- desired dashboard width on a monitor; LOWER = bigger text/fewer cols

------------------------------------------------------------------ screen (responsive + hot-plug)
local prev = term.current()                 -- this computer's own terminal (stable)
local W, H

local function selectScreen()
  local mon = peripheral.find("monitor")    -- any side, or any monitor on a wired network
  if mon then
    -- pick the text scale whose resulting width is closest to TARGET_COLS
    local best, bestDiff = 1
    for _, s in ipairs({ 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5 }) do
      mon.setTextScale(s)
      local w = mon.getSize()
      local diff = math.abs(w - TARGET_COLS)
      if not bestDiff or diff < bestDiff then best, bestDiff = s, diff end
    end
    mon.setTextScale(best)
  end
  term.redirect(mon or prev)
  W, H = term.getSize()
end

------------------------------------------------------------------ prometheus IO
local function fetch(promql)
  local url = PROM .. "/api/v1/query?query=" .. textutils.urlEncode(promql)
  local ok, resp, err = pcall(http.get, url)
  if not ok then return nil, tostring(resp) end          -- threw
  if not resp then return nil, tostring(err) end          -- nil + reason (e.g. Domain not permitted)
  local body = resp.readAll(); resp.close()
  local data = textutils.unserializeJSON(body)
  if type(data) ~= "table" or data.status ~= "success" then return nil, "bad response" end
  return data.data.result
end

local function scalar(promql)
  local r, err = fetch(promql)
  if not r then return nil, err end
  local e = r[1]
  if not e or not e.value then return nil end
  return tonumber(e.value[2])
end

local Q = {
  tps     = "clamp_max(1 / (rate(mc_server_tick_seconds_sum[1m]) / rate(mc_server_tick_seconds_count[1m])), 20)",
  mspt    = "rate(mc_server_tick_seconds_sum[1m]) / rate(mc_server_tick_seconds_count[1m]) * 1000",
  players = "count(mc_player_list) or vector(0)",
  heap    = "100 * sum(jvm_memory_bytes_used{area=\"heap\"}) / sum(jvm_memory_bytes_max{area=\"heap\"})",
  ping    = "mc_player_ping_seconds",
}

------------------------------------------------------------------ draw helpers
local function fill(x, y, w, bg)
  if w <= 0 then return end
  term.setBackgroundColor(bg); term.setCursorPos(x, y); term.write((" "):rep(w))
end
local function at(x, y, s, fg, bg)
  if bg then term.setBackgroundColor(bg) end
  if fg then term.setTextColor(fg) end
  term.setCursorPos(x, y); term.write(s)
end
local function clamp(v, a, b) if v < a then return a elseif v > b then return b else return v end end
local function rnd(v) return math.floor(v + 0.5) end

-- health color: higherBetter true => >=g1 lime, >=g2 yellow, else red; false mirrors it
local function health(v, g1, g2, higherBetter)
  if v == nil then return colors.gray end
  if higherBetter then
    if v >= g1 then return colors.lime elseif v >= g2 then return colors.yellow else return colors.red end
  else
    if v <= g1 then return colors.lime elseif v <= g2 then return colors.yellow else return colors.red end
  end
end

local tpsHist = {}  -- rolling TPS history for the bar chart
local function fmt(v, dp) if v == nil then return "--" end return string.format("%." .. dp .. "f", v) end

-- a stat "card": gray box, label top-left, value centered big in the box
local function card(x, y, w, h, label, valStr, color)
  for dy = 0, h - 1 do fill(x, y + dy, w, colors.gray) end
  at(x + 1, y, label:sub(1, w - 2), colors.lightGray, colors.gray)
  local vx = x + math.max(1, math.floor((w - #valStr) / 2))
  local vy = y + math.floor(h / 2)
  at(vx, vy, valStr:sub(1, w - 1), color, colors.gray)
end

local function draw(data, err)
  term.setBackgroundColor(colors.black); term.clear()

  -- header
  fill(1, 1, W, colors.blue)
  at(2, 1, "MINECRAFT SERVER PERFORMANCE", colors.white, colors.blue)
  local clock = textutils.formatTime(os.time(), true)
  at(W - #clock, 1, clock, colors.white, colors.blue)

  if err then
    fill(1, 3, W, colors.red)
    at(2, 3, "Prometheus unreachable", colors.white, colors.red)
    at(2, 5, err:sub(1, W - 2), colors.white, colors.black)
    if err:lower():find("permit") then
      at(2, 7, "Add an http allow-rule for host 'prometheus'", colors.yellow, colors.black)
      at(2, 8, "above the $private deny in the CC:T server",    colors.yellow, colors.black)
      at(2, 9, "config (see this example's README).",           colors.yellow, colors.black)
    end
    fill(1, H, W, colors.gray)
    at(2, H, "retry " .. REFRESH .. "s  -  q to quit", colors.lightGray, colors.gray)
    term.setBackgroundColor(colors.black)
    return
  end

  -- proportional regions
  local avail   = H - 3                                   -- below header, above footer
  local tileH   = clamp(rnd(avail * 0.30), 3, 9)
  local bandH   = clamp(rnd(avail * 0.24), 2, 10)
  local tileY   = 3
  local bandLbl = tileY + tileH + 1
  local bandTop = bandLbl + 1
  local bandBot = bandTop + bandH - 1
  local pingLbl = bandBot + 2
  local pingTop = pingLbl + 1

  -- stat cards (mirror the four Grafana stat panels)
  local tw = math.floor(W / 4)
  card((0) * tw + 1, tileY, tw - 1, tileH, "TPS",     fmt(data.tps, 1),               health(data.tps, 19.5, 15, true))
  card((1) * tw + 1, tileY, tw - 1, tileH, "MSPT",    fmt(data.mspt, 1) .. "ms",      health(data.mspt, 40, 50, false))
  card((2) * tw + 1, tileY, tw - 1, tileH, "PLAYERS", data.players and string.format("%d", data.players) or "--", colors.white)
  card((3) * tw + 1, tileY, tw - 1, tileH, "HEAP",    fmt(data.heap, 0) .. "%",       health(data.heap, 70, 85, false))

  -- TPS history bar chart (fills bandH rows; bar height = TPS/20)
  at(2, bandLbl, "TPS HISTORY (0-20)", colors.lightGray, colors.black)
  local cols   = W - 2
  local n      = #tpsHist
  local startI = math.max(1, n - cols + 1)
  local x      = 2
  for i = startI, n do
    local v  = clamp(tpsHist[i] or 0, 0, 20)
    local bh = clamp(rnd((v / 20) * bandH), 0, bandH)
    local c  = health(tpsHist[i], 19.5, 15, true)
    for k = 0, bh - 1 do fill(x, bandBot - k, 1, c) end
    x = x + 1
  end

  -- per-player ping (fills the remaining height)
  at(2, pingLbl, "PLAYER PING (round-trip)", colors.lightGray, colors.black)
  local pings = data.pings or {}
  if #pings == 0 then
    at(2, pingTop, "(no players online)", colors.gray, colors.black)
  else
    table.sort(pings, function(a, b) return a.ms < b.ms end)
    local barBase = 18
    local barMax  = W - barBase - 8
    local row     = pingTop
    for _, p in ipairs(pings) do
      if row > H - 1 then break end
      at(2, row, p.name:sub(1, 14), colors.white, colors.black)
      local c   = health(p.ms, 80, 200, false)
      local len = clamp(math.floor((p.ms / 300) * barMax), 0, barMax)
      fill(barBase, row, len, c)
      local msStr = string.format("%dms", p.ms)
      at(W - #msStr, row, msStr, c, colors.black)
      row = row + 1
    end
  end

  -- footer
  fill(1, H, W, colors.gray)
  at(2, H, ("refresh %ds  -  q to quit  -  %dx%d"):format(REFRESH, W, H), colors.lightGray, colors.gray)
  term.setBackgroundColor(colors.black)
end

------------------------------------------------------------------ data refresh
local function refresh()
  local tps, err = scalar(Q.tps)
  if err then return nil, err end                          -- first query gates connectivity
  local d = { tps = tps, mspt = scalar(Q.mspt), players = scalar(Q.players), heap = scalar(Q.heap), pings = {} }
  local pr = fetch(Q.ping)
  if pr then
    for _, e in ipairs(pr) do
      local m  = e.metric or {}
      local nm = m.player or m.name or m.username or m.uuid or m.id or "?"
      d.pings[#d.pings + 1] = { name = nm, ms = math.floor((tonumber(e.value[2]) or 0) * 1000 + 0.5) }
    end
  end
  if d.tps then tpsHist[#tpsHist + 1] = d.tps end
  while #tpsHist > W do table.remove(tpsHist, 1) end
  return d
end

local function tick()
  local d, err = refresh()
  local ok, e = pcall(draw, d, err)
  if not ok then
    term.setBackgroundColor(colors.black); term.clear(); term.setCursorPos(1, 1)
    print("draw error: " .. tostring(e))
  end
end

------------------------------------------------------------------ event loop
selectScreen()
tick()
local timer = os.startTimer(REFRESH)
while true do
  local ev = { os.pullEvent() }
  if ev[1] == "timer" and ev[2] == timer then
    tick(); timer = os.startTimer(REFRESH)
  elseif ev[1] == "key" and ev[2] == keys.q then
    break
  elseif ev[1] == "cc_stop" then
    break
  elseif ev[1] == "peripheral" or ev[1] == "peripheral_detach" then
    selectScreen(); tick()                                 -- monitor plugged in / pulled out
  elseif ev[1] == "monitor_resize" or ev[1] == "term_resize" then
    W, H = term.getSize(); tick()
  end
end

term.redirect(prev)
term.setBackgroundColor(colors.black); term.setTextColor(colors.white); term.clear(); term.setCursorPos(1, 1)
print("promdash stopped.")
