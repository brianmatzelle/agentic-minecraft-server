#!/bin/bash
# Shared yt-dlp flags (sourced by entrypoint.sh + source.sh, never executed).
#
# Two things modern YouTube needs beyond a plain yt-dlp (lesson ported from the
# owner's termtv app, ~/projects/active/tv/ytdlp.py):
#   1. a JS runtime to solve the "n challenge" signature — without it the format
#      list comes back empty ("n challenge solving failed"). node is in the image.
#   2. cookies, once YouTube's bot detection trips on an IP ("Sign in to confirm
#      you're not a bot"). There is no browser in here, so it's opt-in: drop a
#      Netscape-format jar at stadiumcast/media/cookies.txt (bind-mounted) and it
#      gets used automatically.
yt_args() {
  local a=""
  if command -v node >/dev/null 2>&1 && yt-dlp --help 2>/dev/null | grep -q -- '--js-runtimes'; then
    a="--js-runtimes node"
  fi
  [ -f /media/cookies.txt ] && a="$a --cookies /media/cookies.txt"
  printf '%s' "$a"
}
