-- /startup.lua for a termtv set — the same file on every set (computer 12's TV
-- and computer 10's jumbotron both run it).
--
-- A TV out in the world sits in a chunk that unloads the moment nobody is
-- nearby, and a reloaded chunk reboots the computer — so anything the set needs
-- has to come back on its own, or the TV is dead until someone types at it.
-- (A `wget run` bootstrap lives in RAM and does NOT survive that reboot, which
-- is how computer 12 fell off the tunnel entirely on 2026-07-25.)
--
-- Order matters: the garvtunnel client goes in a BACKGROUND tab so the set stays
-- maintainable remotely, and termtv takes the focused one, so walking up to the
-- computer shows the channel remote with no keystrokes.
if multishell then
  shell.openTab("/garvtunnel.lua")
  if fs.exists("/termtv.lua") then
    local tab = shell.openTab("/termtv.lua")
    if tab then multishell.setFocus(tab) end
  end
else
  -- A basic (non-advanced) computer has no multishell, so only one program can
  -- run: the TV is the point of the set, so it wins.
  shell.run(fs.exists("/termtv.lua") and "/termtv.lua" or "/garvtunnel.lua")
end
