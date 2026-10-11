# Twenty Forty-Wait design

Keeps attention from wandering off while waiting for Claude Code's answer.

1. **Productivity first, and fun.** The mod exists to cut the time lost to
   waiting. The game should be fun, but it serves that goal.
2. **Never in the way.** Claude Code works exactly as it does without the
   mod. Its output can be followed while a turn runs, input can be typed and
   sent mid-turn, and its own keys and dialogs behave as usual.
3. **The game is optional, and switching is explicit.** Attention is the
   person's to share between the game, Claude's output and the prompt.
   Moving between game and input is a clear, explicit toggle, with several
   easy ways to do it.
4. **Always clear which mode is on: game or input.** It is never ambiguous
   whether the next key moves tiles or types.
5. **Stay in the session.** The game holds attention inside Claude Code, so
   the time Claude spends waiting for input stays short.
6. **Light, not tiring.** One calm, turn-based game. Nothing moves without a
   key press, and nothing asks for constant attention.
7. **Easy to stop and continue.** The game can be dropped at any moment to
   get back to Claude, and picked up again exactly where it was in the same
   session.
8. **A fast way back.** When Claude stops, a short summary of the turn and the
   next step makes getting back into the session quicker.

Rules that always hold:

- Every stop hands the turn back, after at most a brief grace period to
  finish a move.
- The mode changes only by an explicit action, never by itself.
- The board takes only game keys. Letters typed at it are ignored, and it
  shows how to get back to typing.
- No sounds, no pop-ups, and off until turned on.
- The game sits directly above the prompt.
