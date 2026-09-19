# Sounds

Drop `new-order.mp3` in here.

That is the whole contract: `web/src/platform/web.ts` maps the `newOrder` clip
to `/sounds/new-order.mp3`, and `web/public/` is served as-is, so a file placed
here is live on the next reload with no import and no build step.

A few things worth knowing before choosing one.

- **It is played on the cashier's till and nowhere else.** Waiter tablets are
  carried between tables and stay silent; the till sits at a counter where
  somebody needs to know an order went to the kitchen without watching the
  board.
- **Short.** Half a second to a second. It fires once per round sent, which on
  a busy Friday is every minute or two, and anything with a tail becomes
  irritating by nine o'clock — which is how a till ends up with its speaker
  unplugged.
- **Mid-range and dry.** A dining room is full of soft furnishings and talking;
  a low boom disappears into it and a long reverb smears. A short dry blip
  carries.
- **`.mp3`.** Every browser these tablets could run plays it. If you would
  rather ship `.ogg` or `.wav`, change the one line in `SOUND_SOURCES` — the
  extension is not assumed anywhere else.

If the file is missing, nothing breaks: the play is a rejected promise nobody
sees, and the till is simply quiet. The Sound on/off control at the top of the
cashier screen is remembered per device.
