-- termtv — a TV set in the world: video on the screen(s), sound on the speakers,
-- channel remote on the computer's own terminal.
--
-- ONE program drives both sets, because they only differ in wiring:
--   * the small TV  (computer 12): one monitor + one speaker, leg :8182/:8183
--   * the jumbotron (computer 10): four mirrored faces + speaker, leg :8177/:8179
-- Per-set differences live in /tv.conf on that computer's own disk (see cfg
-- below), so the same file ships to every set and a brand-new one needs no
-- config at all.
--
-- Services (stadiumcast/entrypoint.sh runs cast_loop once per screen size):
--   ws   <video>   sanjuuni -T, one frame per request      -> the screen(s)
--   ws   <audio>   castaudio.js, DFPWM 6KB/s = 1s a chunk  -> the speakers
--   http :8178     channels.js catalog + tune API          -> the terminal remote
-- The video legs are independent (own ffmpeg, own sanjuuni, own park cycle), so a
-- viewer at one screen can never stall the other. What IS shared is the tuned
-- channel — /media/source is one global "what's on", so tuning here changes the
-- other screen too. That is deliberate: one world, one channel.
--
-- Stop: q at the computer, or os.queueEvent("cc_stop").

local cfg = {
  video = "ws://stadiumcast:8182",
  audio = "ws://stadiumcast:8183",   -- "off" = leave the sound to another computer
  ctl   = "http://stadiumcast:8178",
  scale = 0.5,
  guide = nil,                        -- force a monitor as the channel board
}

-- /tv.conf — plain key=value lines, # comments. The jumbotron's is two lines:
--   video=ws://stadiumcast:8177
--   audio=ws://stadiumcast:8179
do
  local SETTABLE = { video = true, audio = true, ctl = true, scale = true, guide = true }
  local f = fs.open("/tv.conf", "r")
  if f then
    local body = f.readAll()
    f.close()
    for line in body:gmatch("[^\r\n]+") do
      if not line:match("^%s*#") then
        local k, v = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
        if k and v and v ~= "" and SETTABLE[k] then cfg[k] = tonumber(v) or v end
      end
    end
  end
end

local dfpwm = require("cc.audio.dfpwm")

-- --- hardware ---------------------------------------------------------------
-- Auto-detected so a set can be built anywhere: EVERY monitor plays the video,
-- and every speaker in reach is the PA. All screens show the SAME frame — the
-- jumbotron is the sides of one cube, not a tiled picture.
--
-- Screens are deliberately NOT classified by size any more. The stadium's faces
-- look identical and needn't be: before the 2026-07-26 rebuild they were three
-- different sizes (271x138 x2, 228x138 x2, 228x152). Under "the modal size is the
-- video wall, anything else is the guide", the 271x138 pair won the tiebreak and
-- became the whole wall, one 228x138 ended up as the channel board, and the other
-- two were dropped from the draw loop entirely — so the jumbotron played on two
-- faces and nobody noticed until the owner asked why. A monitor is the touch guide
-- only when /tv.conf names it (`guide=monitor_7`); guessing it from geometry is
-- what broke the wall. Rebuilds change the peripheral NAMES too (the four faces
-- are monitor_12..15 now), which is the other reason not to hard-code any of this.

local wall, guide, speakers = {}, nil, {}

local function scanSpeakers()
  local found = {}
  for _, name in ipairs(peripheral.getNames()) do
    if peripheral.getType(name) == "speaker" then
      found[#found + 1] = { name = name, p = peripheral.wrap(name) }
    end
  end
  speakers = found
end

do
  for _, name in ipairs(peripheral.getNames()) do
    if peripheral.getType(name) == "monitor" then
      local m = peripheral.wrap(name)
      if cfg.guide == name then
        -- A board at the wall's 0.5 scale is unreadable; step up until the text
        -- is legible but the list still fits.
        m.setTextScale(1)
        if (m.getSize()) < 26 then m.setTextScale(0.5) end
        guide = { name = name, m = m }
      else
        m.setTextScale(cfg.scale)
        local w, h = m.getSize()
        wall[#wall + 1] = { name = name, m = m, w = w, h = h }
      end
    end
  end
  scanSpeakers()
end
if #wall == 0 then error("termtv: no monitor attached", 0) end

local stopped = false

local state = {
  -- picker
  list = {}, cursor = 1, scroll = 0, now = "?", status = "loading catalog...",
  busy = false, total = 0,
  -- video
  video = "connecting", fit = nil,
  -- audio
  vol = 3.0, muted = false, delay = 8, delayUser = false, delayDirty = false,
  audio = "connecting", chunks = 0, gaps = 0, stalls = 0,
}

-- --- video ------------------------------------------------------------------

local function drawFrame(chunk)
  local fn = load(chunk, "=frame", "t", {})
  if not fn then return end
  local ok, image, palette = pcall(fn)
  if not ok or not image or not image[1] then return end
  local fh, fw = #image, #image[1][1]

  if not state.fit then
    -- One-time geometry report. Left to itself CC just clips at the screen edge,
    -- which reads as a mysteriously off-centre picture, so say what happened and
    -- name the fix (W/H for this leg in compose, sized to the BIGGEST screen).
    state.fit = ("%dx%d"):format(fw, fh)
    local odd = 0
    for _, e in ipairs(wall) do
      if e.w ~= fw or e.h ~= fh then odd = odd + 1 end
      if e.w > fw or e.h > fh then
        -- Letterboxed: paint the margins once so they don't keep whatever was on
        -- the screen before.
        e.m.setBackgroundColor(colors.black)
        e.m.clear()
      end
    end
    if odd > 0 then
      state.status = ("feed %dx%d - %d/%d screens differ, centred"):format(fw, fh, odd, #wall)
    end
  end

  for _, e in ipairs(wall) do
    local m = e.m
    for i = 0, #palette do m.setPaletteColor(2 ^ i, table.unpack(palette[i])) end
    -- The screens are NOT all the same size (see the hardware note above), so
    -- each one shows the CENTRE of the frame: crop what doesn't fit, letterbox
    -- what falls short. blit needs strings exactly as wide as it draws, hence
    -- the per-row slice; on a screen that matches the feed this is one sub() per
    -- row and the fast path below skips even that.
    local xo, yo = math.floor((fw - e.w) / 2), math.floor((fh - e.h) / 2)
    if xo == 0 and yo == 0 then
      for y, row in ipairs(image) do
        m.setCursorPos(1, y)
        m.blit(row[1], row[2], row[3])
      end
    else
      local x1, x2 = xo + 1, xo + e.w
      for y = 1, e.h do
        local row = image[y + yo]
        if row then
          if xo >= 0 then
            m.setCursorPos(1, y)
            m.blit(row[1]:sub(x1, x2), row[2]:sub(x1, x2), row[3]:sub(x1, x2))
          else
            m.setCursorPos(1 - xo, y)
            m.blit(row[1], row[2], row[3])
          end
        end
      end
    end
  end
end

-- How long to wait for a frame. It has to clear the feed's SEGMENT period, not
-- the frame interval: HLS arrives one segment at a time (~6s typically, ~10s on
-- Bloomberg), so once this screen has drained a segment it waits on the encoder
-- for the whole of the next one. At the old 5s, that wait timed out — and the
-- cost was not a dropped frame but the entire pipeline: closing the socket makes
-- single-client sanjuuni exit, ffmpeg then dies on a broken FIFO, and the
-- supervisor rebuilds the leg (`[jumbo] pipeline (channel) exited, restarting`
-- in live.log, three times in five minutes, each one a blank-and-relight on the
-- faces plus an audio re-prime).
local RECV_TIMEOUT = 20

local function recvFrame(ws)
  local frame = ws.receive(RECV_TIMEOUT)
  if not frame then return nil end
  -- sanjuuni splits anything at a 65535-byte boundary across messages.
  while #frame % 65535 == 0 do
    local more = ws.receive(RECV_TIMEOUT)
    if not more then break end
    frame = frame .. more
  end
  return frame
end

local function video()
  while not stopped do
    local ws = http.websocket(cfg.video)
    state.vws = ws or nil
    if not ws then
      -- Normal while this leg is parked by the leak guard or a tune is rebuilding
      -- the pipeline. Keep knocking; it latches onto the next probe window.
      state.video = "waiting for feed"
      sleep(3)
    else
      local head, fps
      local okMeta = pcall(function()
        -- Same generous timeout: even the handshake steps the encoder, so it can
        -- block for a whole segment on a feed that has just been rebuilt.
        ws.send("n"); head = tonumber(ws.receive(RECV_TIMEOUT), 10)
        ws.send("f"); fps = tonumber(ws.receive(RECV_TIMEOUT), 10)
      end)
      if not (okMeta and head and fps) then
        state.video = "no metadata"
        pcall(ws.close)
        state.vws = nil
        sleep(3)
      else
        local nextF = math.max(0, head - 1)
        local drawn, t0 = 0, os.epoch("utc")
        state.video = ("%dfps in"):format(fps)
        while not stopped do
          -- ONE round trip per frame. sanjuuni's -T mode encodes ON DEMAND: a
          -- request for a frame past the head counter is accepted and blocks
          -- until that frame exists (measured 100.1ms/frame against a 10fps
          -- source — it paces itself exactly), so the old "poll n, then ask for
          -- the frame" dance spent an extra tick-bound round trip per frame for
          -- nothing. Dropping it took the small TV from 5.6fps to 8.9fps.
          if not pcall(ws.send, "v" .. nextF) then break end
          local frame = recvFrame(ws)
          if not frame then break end            -- stalled (or parked) -> reconnect
          drawFrame(frame)
          nextF = nextF + 1
          drawn = drawn + 1

          -- NO periodic "n" poll, and none is possible without making things
          -- worse. sanjuuni's -T encoder is driven ENTIRELY by this socket: every
          -- message we send — v, n, f, anything — wakes it for exactly one more
          -- frame (sanjuuni.cpp:266-270), and only a `v` hands one back and frees
          -- it (`frameStorage[frame] = ""`, :277). So the head advances only
          -- because we asked it to: walking one frame per request keeps the gap
          -- CONSTANT and the client can never "fall behind" the encoder.
          -- A poll is not free — it encodes a frame we don't take, so the gap
          -- grows by one every time. That is measurable: the 2s resync this loop
          -- briefly had reported behind=65 after 66 polls, exactly one frame
          -- each, ~14s of pure A/V lag bought for no information at all.
          -- What CAN drift is wall-clock lag behind the live edge, when the feed
          -- is encoded faster than this screen draws — and `n` cannot see that.
          -- The fix for it lives in compose: pace CHANNEL_FPS/TERMTV_FPS just
          -- under the measured draw rate below.
          local now = os.epoch("utc")
          if drawn % 20 == 0 then
            local dt = (now - t0) / 1000
            if dt > 0 then
              state.video = ("%.1ffps"):format(drawn / dt)
              -- Publish what the screen is really doing. Nothing in-container can
              -- see it (sanjuuni's own counter is the ENCODE rate, which is the
              -- feed, not the blit), and reading a tab's screen over the tunnel
              -- is impossible — so ops asks the computer instead:
              --   cc -i 10 'local f=fs.open("/tv.stat","r") local s=f.readAll() f.close() return s'
              local st = fs.open("/tv.stat", "w")
              if st then
                -- feed=WxH face=WxH: whether this leg's compose W/H still matches
                -- the wall. They drift apart whenever the screens are rebuilt, and
                -- the only symptom is a black band or a crop nobody can see from
                -- the container.
                st.write(("%s fps=%.2f drawn=%d screens=%d feed=%s face=%dx%d audio=%s gaps=%d vol=%.1f sync=%d\n"):format(
                  state.now or "?", drawn / dt, drawn, #wall,
                  state.fit or "?", wall[1].w, wall[1].h,
                  state.audio, state.gaps, state.vol, state.delay))
                st.close()
              end
            end
          end
        end
        pcall(ws.close)
        state.vws = nil
        state.video = "reconnecting"
        if not stopped then sleep(2) end
      end
    end
  end
end

-- --- audio ------------------------------------------------------------------

-- Push one second of PCM into every speaker. playAudio returns false when that
-- speaker's buffer is full, and the retry has to wait for THAT speaker's own
-- speaker_audio_empty (the event names which one), or two speakers deadlock each
-- other. The wait is also what paces this whole coroutine: the speakers consume
-- in real time, so the loop can't outrun the sound.
--
-- That wait must never be INDEFINITE, and that was the mute bug (fixed
-- 2026-07-26). speaker.stop() throws away the queued audio whose hand-off is the
-- very thing that fires speaker_audio_empty — so a stop() landing while this loop
-- sat in os.pullEvent("speaker_audio_empty") meant the event never came. The
-- audio coroutine parked here for good, still holding its socket: mute worked,
-- then unmute flipped state.muted back with nothing left running to read it. And
-- since the m key calls stop() on every speaker, and this wait is where the loop
-- spends nearly all of its time, muting was very nearly guaranteed to wedge the
-- sound until the program was restarted. Signature from the container side:
-- castaudio's /health shows `served` frozen while `clients` is still 1 and
-- `queued` climbs to RING_MAX — the socket is up, nobody is asking for chunks.
local WAIT_TICK = 0.5      -- re-check muted/stopped this often while blocked
local WAIT_GIVEUP = 6      -- no drain event for this long = stuck, not full

local function playAll(pcm)
  for _, sp in ipairs(speakers) do
    local waited = 0
    while not sp.p.playAudio(pcm, state.vol) do
      local timer, woke = os.startTimer(WAIT_TICK), false
      repeat
        local ev, a = os.pullEvent()
        if ev == "speaker_audio_empty" and a == sp.name then waited = 0 break end
        woke = (ev == "timer" and a == timer)
      until woke
      -- Re-read the world on every wake: this is what makes mute and q instant.
      if stopped or state.muted then return end
      if woke then
        waited = waited + WAIT_TICK
        if waited >= WAIT_GIVEUP then
          -- Six seconds without a single drain event: this speaker's buffer is
          -- stuck rather than full (a stop() from anywhere else does it too).
          -- Clear it and drop the chunk — one click beats a dead PA.
          pcall(sp.p.stop)
          state.stalls = state.stalls + 1
          return
        end
      end
    end
  end
end

local function audio()
  while not stopped do
    -- castaudio.js serves each chunk to ONE client (it pops a shared ring), so a
    -- second set connected to the same leg would halve both. A computer with no
    -- speaker attached must therefore not hold the socket open at all, and a set
    -- that has handed the sound to another computer sets audio=off in /tv.conf.
    if cfg.audio == "off" then
      state.audio = "off (handed over)"
      sleep(2)
    elseif #speakers == 0 then
      state.audio = "no speaker"
      sleep(2)
    else
      local ws = http.websocket(cfg.audio)
      state.aws = ws or nil
      if not ws then
        state.audio = "waiting"
        sleep(3)
      else
        -- Adopt whatever depth the server was tuned to, unless someone has been
        -- using [ / ] here — the server's value is the measured-safe one.
        local okStatus = pcall(function()
          ws.send("s")
          local reply = ws.receive(3)
          local data = reply and textutils.unserialiseJSON(reply)
          if data and data.target and not state.delayUser then state.delay = data.target end
        end)
        if okStatus and state.delayUser then state.delayDirty = true end
        local decoder = dfpwm.make_decoder()
        state.audio = "playing"
        while not stopped do
          if state.delayDirty then
            state.delayDirty = false
            pcall(function() ws.send("d" .. math.floor(state.delay)); ws.receive(3) end)
          end
          local okSend = pcall(ws.send, "a")
          if not okSend then break end
          local chunk, isBinary = ws.receive(5)
          if not chunk then break end
          if not isBinary then
            -- "!" means the server has nothing buffered (parked, starting, or
            -- refilling after an underrun). Not an error.
            if chunk == "!" then
              state.gaps = state.gaps + 1
              state.audio = "buffering"
            end
            sleep(0.5)
          else
            state.chunks = state.chunks + 1
            state.audio = state.muted and "muted" or "playing"
            if state.muted or #speakers == 0 then
              sleep(1)                             -- keep draining at 1x, silently
            else
              playAll(decoder(chunk))
            end
          end
        end
        pcall(ws.close)
        state.aws = nil
        state.audio = "reconnecting"
        if not stopped then sleep(2) end
      end
    end
  end
end

-- --- control API ------------------------------------------------------------

local function api(path)
  local ok, res = pcall(http.get, cfg.ctl .. path)
  if not ok or not res then return nil, "control API unreachable" end
  local body = res.readAll()
  res.close()
  local okJson, data = pcall(textutils.unserialiseJSON, body)
  if not okJson or type(data) ~= "table" then return nil, "bad response from control API" end
  if data.ok == false then return nil, data.error or (data.building and "catalog still building") or "refused" end
  return data
end

local LIVE_ROW = { live = true, label = "Live world camera", sub = "cam" }

local function loadCurated()
  state.busy = true
  local data, err = api("/channels")
  state.busy = false
  if not data then
    state.list = { LIVE_ROW }
    state.status = err
    return
  end
  local list = { LIVE_ROW }
  for _, c in ipairs(data.curated or {}) do
    list[#list + 1] = { id = c.id, label = c.label, sub = string.lower(c.country or "") }
  end
  state.list, state.total = list, data.total or 0
  state.now = (data.now and data.now.label) or "?"
  state.cursor, state.scroll = 1, 0
  state.status = ("%d curated - / searches %d"):format(#list - 1, state.total)
end

local function doSearch(q)
  if not q or q == "" then return loadCurated() end
  state.busy = true
  local data, err = api("/search?q=" .. textutils.urlEncode(q))
  state.busy = false
  if not data then state.status = err return end
  local list = {}
  for _, c in ipairs(data.results or {}) do
    list[#list + 1] = { id = c.id, label = c.name, sub = string.lower(c.country or "") }
  end
  state.list, state.cursor, state.scroll = list, 1, 0
  if #list == 0 then
    state.list = { LIVE_ROW }
    state.status = "nothing matched - esc for the grid"
  else
    state.status = ("%d hits - enter tunes, esc back"):format(#list)
  end
end

local function tune(row)
  if not row then return end
  state.busy = true
  state.status = ("tuning %s..."):format(row.label)
  local path = row.live and "/tune?mode=live" or ("/tune?id=" .. textutils.urlEncode(row.id))
  local data, err = api(path)
  state.busy = false
  if not data then
    state.status = "failed: " .. err          -- refused; the old channel stays up
    return
  end
  state.now = (data.now and data.now.label) or row.label
  state.status = ("on %s - relights in ~10s"):format(state.now)
end

-- --- the remote (this computer's terminal, and any guide monitor) ------------

local function drawTo(t, touch)
  local w, h = t.getSize()
  local rows = h - 5                             -- on-air, audio, rule, status, help
  if rows < 1 then return end

  if state.cursor < state.scroll + 1 then state.scroll = state.cursor - 1 end
  if state.cursor > state.scroll + rows then state.scroll = state.cursor - rows end

  t.setBackgroundColor(colors.black)
  t.setTextColor(colors.white)
  t.clear()

  t.setCursorPos(1, 1)
  t.setTextColor(colors.lime)
  t.write("ON AIR ")
  t.setTextColor(colors.white)
  local badge = state.video or ""
  local nowStr = state.now or "?"
  local room = w - 7 - #badge - 1
  if #nowStr > room then nowStr = nowStr:sub(1, math.max(1, room)) end
  t.write(nowStr)
  if #badge > 0 and #badge < w then
    t.setCursorPos(w - #badge + 1, 1)
    t.setTextColor(colors.gray)
    t.write(badge)
  end

  -- Audio line: the speakers are the thing you can't see from the screen.
  t.setCursorPos(1, 2)
  t.setTextColor(state.muted and colors.red or colors.cyan)
  local snd
  if cfg.audio == "off" then
    snd = "sound: another computer"
  elseif #speakers == 0 then
    snd = "NO SPEAKER"
  else
    snd = ("%s vol %.1f  sync %ds  %s"):format(
      state.muted and "MUTED" or "SOUND", state.vol, state.delay, state.audio)
    if state.gaps > 0 then snd = snd .. (" (%d gaps)"):format(state.gaps) end
    if state.stalls > 0 then snd = snd .. (" %d spk-stall"):format(state.stalls) end
  end
  t.write(snd:sub(1, w))

  t.setCursorPos(1, 3)
  t.setTextColor(colors.gray)
  t.write(("-"):rep(w))

  for i = 1, rows do
    local idx = state.scroll + i
    local row = state.list[idx]
    if not row then break end
    local sel = (idx == state.cursor)
    t.setCursorPos(1, 3 + i)
    t.setBackgroundColor(sel and colors.gray or colors.black)
    t.setTextColor(row.live and colors.yellow or (sel and colors.white or colors.lightGray))
    local sub, label = row.sub or "", row.label
    local space = w - 2 - #sub - 1
    if #label > space then label = label:sub(1, math.max(1, space - 1)) .. "." end
    local line = (sel and " >" or "  ") .. label
    t.write((line .. (" "):rep(math.max(0, w - #line - #sub)) .. sub):sub(1, w))
  end

  t.setBackgroundColor(colors.black)
  t.setCursorPos(1, h - 1)
  t.setTextColor(state.busy and colors.yellow or colors.lightGray)
  local st = (state.status or ""):sub(1, w)
  t.write(st .. (" "):rep(math.max(0, w - #st)))

  t.setCursorPos(1, h)
  t.setTextColor(colors.gray)
  local help = touch and "tap a row - bottom row = camera"
    or "enter tune  / find  c cam  m mute -/= vol [/] sync  q"
  t.write(help:sub(1, w))
end

local function redraw()
  drawTo(term, false)
  if guide then pcall(drawTo, guide.m, true) end
end

local function remote()
  loadCurated()
  redraw()
  local tick = os.startTimer(2)
  while not stopped do
    local e = { os.pullEvent() }
    local ev = e[1]

    if ev == "cc_stop" then stopped = true return end

    if ev == "timer" and e[2] == tick then
      -- Keeps the badges honest and picks up tunes made elsewhere (the other
      -- screen, a player's "!g put X on the jumbotron", ops running source.sh).
      local data = api("/now")
      if data and data.now and data.now.label then state.now = data.now.label end
      tick = os.startTimer(2)
      redraw()

    elseif ev == "key" then
      local k = e[2]
      if k == keys.q then stopped = true return
      elseif k == keys.down then state.cursor = math.min(#state.list, state.cursor + 1)
      elseif k == keys.up then state.cursor = math.max(1, state.cursor - 1)
      elseif k == keys.pageDown then state.cursor = math.min(#state.list, state.cursor + 10)
      elseif k == keys.pageUp then state.cursor = math.max(1, state.cursor - 10)
      elseif k == keys.enter then tune(state.list[state.cursor])
      elseif k == keys.c then tune(LIVE_ROW)
      elseif k == keys.r then scanSpeakers() loadCurated()
      elseif k == keys.escape then loadCurated()
      elseif k == keys.m then
        -- stop() is what makes mute instant (a speaker holds a second or two of
        -- already-queued sound), and it is only safe because playAll's wait is
        -- bounded — see the note there. Nothing to undo on unmute: the audio
        -- coroutine notices state.muted within WAIT_TICK and resumes on the next
        -- chunk it pulls.
        state.muted = not state.muted
        if state.muted then for _, sp in ipairs(speakers) do pcall(sp.p.stop) end end
      elseif k == keys.minus then state.vol = math.max(0, state.vol - 0.25)
      elseif k == keys.equals then state.vol = math.min(3.0, state.vol + 0.25)
      elseif k == keys.leftBracket or k == keys.rightBracket then
        -- A/V sync: how many seconds of audio the server holds back. Video runs
        -- some seconds behind live, so this is what lines the two up.
        local d = state.delay + (k == keys.rightBracket and 1 or -1)
        state.delay = math.max(0, math.min(40, d))
        state.delayUser, state.delayDirty = true, true
        state.status = ("sync -> %ds (takes a few seconds)"):format(state.delay)
      elseif k == keys.slash then
        -- Modal read on the computer only; a guide keeps showing the old list.
        local w, h = term.getSize()
        term.setCursorPos(1, h - 1)
        term.setBackgroundColor(colors.black)
        term.write((" "):rep(w))
        term.setCursorPos(1, h - 1)
        term.setTextColor(colors.lime)
        term.write("search: ")
        term.setTextColor(colors.white)
        doSearch(read())
      end
      redraw()

    elseif ev == "monitor_touch" and guide and e[2] == guide.name then
      local y = e[4]
      local _, gh = guide.m.getSize()
      if y >= 4 and y <= gh - 2 then
        local idx = state.scroll + (y - 3)
        if state.list[idx] then
          state.cursor = idx
          redraw()                                   -- show the selection first
          tune(state.list[idx])
        end
      elseif y == gh then
        tune(LIVE_ROW)                               -- help row doubles as "camera"
      elseif y <= 3 then
        loadCurated()
      end
      redraw()

    elseif ev == "peripheral" or ev == "peripheral_detach" then
      scanSpeakers()
      redraw()

    elseif ev == "term_resize" or ev == "monitor_resize" then
      -- Someone added or broke a monitor block: re-measure every screen so the
      -- centring maths and the one-time letterbox clear are recomputed.
      for _, e in ipairs(wall) do
        e.m.setTextScale(cfg.scale)
        e.w, e.h = e.m.getSize()
      end
      state.fit = nil
      redraw()
    end
  end
end

-- --- run --------------------------------------------------------------------

parallel.waitForAny(video, audio, remote)

-- waitForAny returns the instant ANY of the three ends, so the other two never
-- reach their own cleanup — do it here. CC does not reap a program's websockets
-- on exit (max_websockets is 4 per computer, so leaking two per run locks a set
-- out of its own feed after two restarts).
stopped = true
if state.vws then pcall(state.vws.close) end
if state.aws then pcall(state.aws.close) end
for _, sp in ipairs(speakers) do pcall(sp.p.stop) end
for _, e in ipairs(wall) do
  local m = e.m
  for i = 0, 15 do m.setPaletteColor(2 ^ i, term.nativePaletteColor(2 ^ i)) end
  m.setBackgroundColor(colors.black)
  m.setTextColor(colors.gray)
  m.clear()
  m.setCursorPos(2, 2)
  m.write("tv off")
end
if guide then
  guide.m.setBackgroundColor(colors.black)
  guide.m.setTextColor(colors.gray)
  guide.m.clear()
  guide.m.setCursorPos(2, 2)
  guide.m.write("remote offline")
end
term.setBackgroundColor(colors.black)
term.setTextColor(colors.white)
term.clear()
term.setCursorPos(1, 1)
print("termtv stopped.")
