-- jumboaudio — TV sound for the jumbotron. Pulls 1-second DFPWM chunks from
-- stadiumcast's castaudio.js (:8179) and plays them through every speaker
-- attached to this computer.
-- Stop: q at the computer, or os.queueEvent("cc_stop").
--
-- THIS IS NO LONGER REQUIRED — termtv.lua on computer 10 drives the speakers
-- itself, and they ARE audible at the seats (owner confirmed 2026-07-26). Keep
-- this program for a speaker-only computer: spreading sound around the seating, or
-- any set whose /tv.conf says audio=off.
--
-- It exists because of a wrong call. Computer 10's blocks really sit ~(20481030,
-- 133, 20485130) — 20M blocks out in the plain overworld — because the jumbotron
-- hangs from a Create rope, making it a Sable moving structure; Sable keeps the
-- blocks out there and simulates the structure at the stadium. That projection
-- carries SOUND as well as rendering. The "proof" that it didn't was computer 10's
-- player detector seeing 0 players within 64 while someone stood at the stadium —
-- but the detector is asking about the empty far region, so it can never see a
-- visitor, and it says nothing about audio.
--
-- Speaker audio follows normal Minecraft falloff scaled by volume (max 3.0), so
-- coverage is limited: wire up several speakers around the seating (directly
-- adjacent, or anywhere on a wired modem network) and they all play in step.
--
-- DFPWM is 1 bit/sample mono at 48kHz — 6KB/s, and deliberately lo-fi. It sounds
-- like a stadium PA, which is the idea.

local WS_URL  = "ws://stadiumcast:8179"
local CTL_URL = "http://stadiumcast:8178"

local dfpwm = require("cc.audio.dfpwm")

local stopped = false

local state = {
  vol      = 3.0,     -- 0.0-3.0; volume also sets range, so a PA wants it high
  muted    = false,
  -- Seconds of audio held back to line up with the faces. Only a fallback: the
  -- real value is the server's (CAST_AUDIO_DELAY), adopted on connect, because it
  -- also has to clear the HLS segment period or playback stutters. [ and ] here
  -- override it live for sync tuning.
  delay    = 8,
  delayUser = false,  -- true once someone has tuned it by hand
  chunks   = 0,
  gaps     = 0,       -- server had nothing buffered (parked feed, or we're early)
  stalls   = 0,       -- a speaker's buffer went quiet without draining
  status   = "starting",
  now      = "?",
  speakers = {},
}

-- --- speakers ---------------------------------------------------------------

-- Names are kept alongside the wrapped peripheral because speaker_audio_empty
-- reports which speaker drained, and waiting on the wrong one would stall.
local function findSpeakers()
  local out = {}
  for _, n in ipairs(peripheral.getNames()) do
    if peripheral.getType(n) == "speaker" then
      out[#out + 1] = { name = n, p = peripheral.wrap(n) }
    end
  end
  state.speakers = out
  return #out
end

-- Feed one chunk to every speaker. playAudio returns false when a speaker's
-- buffer is full, and that backpressure IS our clock: the crowd hears one second
-- per second, so we ask the server for the next chunk exactly as fast as the
-- speakers drain. (Pattern lifted from sanjuuni's own generated player.)
--
-- The drain wait is bounded by a timer, and it has to be: speaker.stop() (which
-- the m key calls) discards the queued audio whose hand-off fires
-- speaker_audio_empty, so an unbounded wait here parks this coroutine for good
-- the moment someone mutes — the exact bug found in termtv.lua on 2026-07-26,
-- where mute worked and unmute never came back.
local WAIT_TICK = 0.5      -- re-check muted/stopped this often while blocked
local WAIT_GIVEUP = 6      -- no drain event for this long = stuck, not full

local function playAll(pcm)
  for _, sp in ipairs(state.speakers) do
    local waited = 0
    while not sp.p.playAudio(pcm, state.vol) do
      local timer, woke = os.startTimer(WAIT_TICK), false
      repeat
        local ev, a = os.pullEvent()
        if ev == "speaker_audio_empty" and a == sp.name then waited = 0 break end
        woke = (ev == "timer" and a == timer)
      until woke
      if stopped or state.muted then return end
      if woke then
        waited = waited + WAIT_TICK
        if waited >= WAIT_GIVEUP then
          pcall(sp.p.stop)
          state.stalls = state.stalls + 1
          return
        end
      end
    end
  end
end

-- --- audio ------------------------------------------------------------------

local function audio()
  while not stopped do
    local ws = http.websocket(WS_URL)
    state.ws = ws
    if not ws then
      -- Normal while stadiumcast is restarting; the container side is long-lived
      -- but the pipeline it follows duty-cycles.
      state.status = "no audio server"
      sleep(3)
    else
      state.status = "connected"
      -- Adopt the server's depth unless someone has tuned it here, so compose's
      -- CAST_AUDIO_DELAY stays the single source of truth.
      if not state.delayUser then
        pcall(function()
          ws.send("s")
          local st = ws.receive(2)
          local d = st and textutils.unserializeJSON(st)
          if type(d) == "table" and tonumber(d.target) then
            state.delay = tonumber(d.target)
          end
        end)
        state.delayDirty = false
      else
        state.delayDirty = true
      end
      local dec = dfpwm.make_decoder()
      while not stopped do
        -- Tell the server our A/V offset, so it holds audio back to match the
        -- faces instead of running ahead of them. Re-sent whenever [ or ] moves
        -- it, which is how the sync gets tuned in-game with no rebuild.
        if state.delayDirty then
          state.delayDirty = false
          pcall(function() ws.send("d" .. math.floor(state.delay)); ws.receive(2) end)
        end
        local ok = pcall(ws.send, "a")
        if not ok then break end
        local msg = ws.receive(5)
        if not msg then break end                  -- stalled -> reconnect
        if msg == "!" then
          -- Nothing buffered: the feed is parked (nobody watching the faces) or
          -- the buffer is still filling to the target depth.
          state.status = "waiting for feed"
          state.gaps = state.gaps + 1
          sleep(1)
        elseif #msg < 16 then
          -- "ok 3", "?" and friends — a stray reply, not audio.
          sleep(0.2)
        else
          state.status = "playing"
          state.chunks = state.chunks + 1
          if state.muted or #state.speakers == 0 then
            -- Still draining the server so we don't build a backlog, just not
            -- making noise. Pace it by hand since the speakers aren't clocking us.
            sleep(1)
          else
            local decoded, pcm = pcall(dec, msg)
            if decoded and pcm then
              if not pcall(playAll, pcm) then
                -- A speaker was broken/removed mid-play.
                findSpeakers()
              end
            end
          end
        end
      end
      pcall(ws.close)
      state.ws = nil
      if not stopped then
        state.status = "reconnecting"
        sleep(2)
      end
    end
  end
end

-- --- ui ---------------------------------------------------------------------

local function fetchNow()
  local h = http.get(CTL_URL .. "/now")
  if not h then return end
  local body = h.readAll()
  h.close()
  local ok, data = pcall(textutils.unserializeJSON, body)
  if ok and type(data) == "table" and data.now and data.now ~= "" then
    state.now = data.now
  end
end

local function draw()
  local w, h = term.getSize()
  term.setBackgroundColor(colors.black)
  term.clear()

  term.setCursorPos(1, 1)
  term.setTextColor(colors.lime)
  term.write("JUMBOTRON AUDIO")
  local tag = state.muted and "MUTED" or state.status
  term.setCursorPos(math.max(1, w - #tag + 1), 1)
  term.setTextColor(state.muted and colors.red or colors.white)
  term.write(tag)

  term.setTextColor(colors.lightGray)
  term.setCursorPos(1, 3)
  term.write(("on air: %s"):format(state.now):sub(1, w))
  term.setCursorPos(1, 4)
  term.write(("speakers %d   vol %.1f   delay %ds"):format(
    #state.speakers, state.vol, state.delay):sub(1, w))
  term.setCursorPos(1, 5)
  term.write(("chunks %d   gaps %d   stalls %d"):format(
    state.chunks, state.gaps, state.stalls):sub(1, w))

  if #state.speakers == 0 then
    term.setCursorPos(1, 7)
    term.setTextColor(colors.red)
    term.write("no speakers attached")
    term.setCursorPos(1, 8)
    term.setTextColor(colors.lightGray)
    term.write("place speakers next to this")
    term.setCursorPos(1, 9)
    term.write("computer, then press r")
  end

  term.setCursorPos(1, h)
  term.setTextColor(colors.gray)
  term.write(("m mute  -/+ vol  [/] sync  r  q"):sub(1, w))
end

local function ui()
  findSpeakers()
  pcall(fetchNow)
  draw()
  local tick = os.startTimer(1)
  local slow = 0
  while not stopped do
    local ev, p1 = os.pullEvent()
    if ev == "timer" and p1 == tick then
      tick = os.startTimer(1)
      slow = slow + 1
      if slow % 5 == 0 then
        pcall(fetchNow)
        findSpeakers()
      end
      draw()
    elseif ev == "cc_stop" then
      stopped = true
    elseif ev == "key" then
      if p1 == keys.q then
        stopped = true
      elseif p1 == keys.m then
        state.muted = not state.muted
        -- Drop what's already queued so unmuting doesn't replay stale audio.
        for _, sp in ipairs(state.speakers) do pcall(sp.p.stop) end
        draw()
      elseif p1 == keys.minus then
        state.vol = math.max(0, state.vol - 0.5); draw()
      elseif p1 == keys.equals then
        state.vol = math.min(3, state.vol + 0.5); draw()
      elseif p1 == keys.leftBracket then
        state.delay = math.max(0, state.delay - 1)
        state.delayUser, state.delayDirty = true, true; draw()
      elseif p1 == keys.rightBracket then
        state.delay = math.min(20, state.delay + 1)
        state.delayUser, state.delayDirty = true, true; draw()
      elseif p1 == keys.r then
        findSpeakers(); pcall(fetchNow); draw()
      end
    end
  end
end

parallel.waitForAny(audio, ui)

-- Close the socket by hand. waitForAny returns the instant the ui coroutine ends
-- (q / cc_stop), so audio() never gets to run its own close — and CC does NOT
-- reap a program's websockets on exit: verified by watching ESTABLISHED
-- connections to :8179 survive a stopped program. With max_websockets = 4 per
-- computer, four stop/start cycles would lock this computer out of the feed
-- entirely until it was rebooted.
if state.ws then pcall(state.ws.close) end
for _, sp in ipairs(state.speakers) do pcall(sp.p.stop) end
term.setBackgroundColor(colors.black)
term.setTextColor(colors.white)
term.clear()
term.setCursorPos(1, 1)
print("jumboaudio stopped")
