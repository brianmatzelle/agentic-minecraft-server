-- garvtunnel client — runs on an in-game CraftOS 1.9 (CC: Tweaked) computer.
-- Dials OUT to the garvtunnel sidecar, then loops: receive a Lua chunk, run it,
-- ship back captured output / return values / errors. Reconnects forever.
--
-- Bootstrap (the bridge injects the token when it serves this file, so no arg needed):
--   wget run http://garvtunnel:8176/
-- You can still override the token / ws-url explicitly as arguments:
--   wget run http://garvtunnel:8176/client.lua <TOKEN> [ws-url]
--
-- Auto-start on every reboot: install it as a startup file once —
--   wget http://garvtunnel:8176/client.lua startup.lua
-- (the injected token rides along) — then it reconnects automatically on boot.

local args = { ... }
-- The bridge replaces TUNNEL_TOKEN_PLACEHOLDER with the real token on serve.
local BAKED_TOKEN = "TUNNEL_TOKEN_PLACEHOLDER"
local TOKEN = (args[1] and args[1] ~= "") and args[1] or BAKED_TOKEN
local URL   = args[2] or "ws://garvtunnel:8176/agent"

local LABEL = os.getComputerLabel() or ("computer-" .. os.getComputerID())

-- Run one chunk of Lua in a sandbox that captures print/write output but still
-- exposes every real CraftOS API (fs, redstone, peripheral, turtle, ...) via _ENV.
local function runChunk(code)
  local buf = {}
  local function capture(...)
    local n = select('#', ...)
    local parts = {}
    for i = 1, n do parts[i] = tostring(select(i, ...)) end
    buf[#buf + 1] = table.concat(parts, "\t")
  end

  local env = setmetatable({
    print = capture,
    write = function(s) buf[#buf + 1] = tostring(s) end,
  }, { __index = _ENV })

  local fn, cerr = load(code, "agent", "t", env)
  if not fn then
    return { ok = false, error = "compile: " .. tostring(cerr), output = "" }
  end

  local res = { pcall(fn) }
  local ok = table.remove(res, 1)
  local output = table.concat(buf, "\n")

  if not ok then
    return { ok = false, error = tostring(res[1]), output = output }
  end

  local returns = {}
  for i = 1, #res do
    local good, s = pcall(textutils.serialize, res[i])
    returns[i] = good and s or tostring(res[i])
  end
  return { ok = true, output = output, returns = returns }
end

local function connect()
  local ws, err = http.websocket(URL, { ["X-Tunnel-Token"] = TOKEN })
  if not ws then return nil, err end
  ws.send(textutils.serializeJSON({
    type  = "hello",
    id    = tostring(os.getComputerID()),
    label = LABEL,
  }))
  return ws
end

print("garvtunnel: connecting to " .. URL .. " as " .. LABEL)
while true do
  local ws, err = connect()
  if ws then
    print("garvtunnel: connected")
    local _, loopErr = pcall(function()
      while true do
        local raw = ws.receive()
        if raw == nil then error("connection closed", 0) end
        local msg = textutils.unserializeJSON(raw)
        if msg and msg.type == "exec" then
          local result = runChunk(msg.code)
          result.type = "result"
          result.jobId = msg.jobId
          ws.send(textutils.serializeJSON(result))
        end
      end
    end)
    pcall(function() ws.close() end)
    print("garvtunnel: disconnected (" .. tostring(loopErr) .. "), retrying in 5s")
  else
    print("garvtunnel: connect failed (" .. tostring(err) .. "), retrying in 5s")
  end
  sleep(5)
end
