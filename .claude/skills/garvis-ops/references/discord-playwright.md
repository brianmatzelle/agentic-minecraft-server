# Driving Garvis in Discord via Playwright — the @mention dance

Garvis only reads a message that **directly @mentions the bot user** (no privileged
MESSAGE_CONTENT intent). You must insert a real mention *pill*, not the literal text
`@garvis`. This is the single fiddliest part of the workflow.

## Tools
Load via ToolSearch: `mcp__playwright-extension__browser_navigate`, `browser_snapshot`,
`browser_type`, `browser_press_key`. (Discord must already be logged in.)

## Procedure (do this exactly)
1. **Navigate** to the ops thread, then `browser_snapshot` (save to `.playwright-mcp/x.md`).
   Find the composer ref: `grep -nE 'textbox "Message' <snapshot>` → e.g. `[ref=e1208]`.
2. **Type the handle slowly** so Discord's autocomplete fires:
   `browser_type(target=<composer ref>, text="@garvis", slowly=true)`
   - `slowly:true` → `pressSequentially` (per-key, triggers the popup).
   - **NEVER** type without `slowly:true` — plain `browser_type` uses `fill()` which
     **replaces the whole box and wipes any pill you inserted.** This is the #1 gotcha.
3. **Snapshot** and confirm the popup: `grep 'option "garvis garvis#8962" \[selected\]'`.
   You want the **USER** `garvis#8962` (selected), **not** the `@garvis` *role*.
4. **Press Enter** to insert the mention pill: `browser_press_key("Enter")`.
   (Enter while the autocomplete popup is open selects the highlighted entry; it does
   NOT send.)
5. **Type the rest of the message with `slowly:true`** so it appends after the pill:
   `browser_type(target=<composer ref>, text=" can you add cobblemon?", slowly=true)`.
6. **Verify** before sending: snapshot, then
   `grep -cE 'button "@garvis"' <snapshot>` (>0 means the pill survived) and confirm
   your text is present.
7. **Arm a journal Monitor** (so you catch `[claude] start/ok/fail`), then **send**:
   `browser_press_key("Enter")`.
8. The monitor should report `[claude] start … resume=…` within a few seconds — that
   confirms the mention registered and the agent spawned. If nothing fires in ~10s, the
   mention didn't take (you typed literal text, or picked the role) — clear and redo.

## If the field has stale text / a half-typed pill
Clear it first: focus composer → `browser_press_key("Control+a")` → `browser_press_key("Backspace")`, then restart at step 2.

## Reading Garvis's reply / a PR he opened
- His reply posts in the thread with the PR link; the "🛠️ on it…" message auto-deletes.
- Faster than parsing the snapshot: `gh pr list --state open` and `gh pr diff <n>`.

## Notes
- The thread is a tracked Garvis session (persisted in `apps/garvis-bot/garvis.sqlite`).
  Follow-ups resume it (`resume=yes` in the log). To start a *fresh* session in that
  thread, delete its row from `thread_sessions` (the bot restart won't clear it).
- Per-user cooldown is 60s (`GARVIS_COOLDOWN_MS`). Space out rapid requests.
- Only allow-listed users (`DISCORD_ALLOWED_USERS`) trigger installs; everyone gets Q&A.
