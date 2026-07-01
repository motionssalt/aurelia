# Aurelia mini-app — entry-line + UI hardening fix

## Files in this bundle (drop straight into your repo root, replacing existing)
- `miniapp/app.js`
- `miniapp/style.css`
- `runner.js`
- `worker/index.js`

## Bug 1 — "entry pending" forever, no horizontal line

**Root cause.** Deriv's `buy` response doesn't contain the entry spot;
the entry only appears on the subsequent `proposal_open_contract`
snapshot. The old code:

- In `runner.js › placeAndSettle`, `entry` was assigned **only** when
  the contract was already terminal (`is_sold`). For open contracts we
  wrote `entry: undefined` on the trade-history record, so the mini-app
  had nothing to draw.
- In `runner.js › settlePending`, the return value only included
  `entry` when the poll came back sold. While the contract stayed open
  we never captured the entry, even though POC already knew it.
- Consequently the worker's `/api/trades/active` returned
  `entry_price: null` for the entire life of the trade — the mini-app
  correctly showed "entry pending" and skipped `createPriceLine`.

**Fix.**
1. `placeAndSettle` now also inspects the non-terminal POC snapshot
   (`entry_spot`, `entry_tick`, and their `_display_value` twins) and
   writes the number onto the record if Deriv already knows it.
2. `settlePending` returns `entry` on **every** poll — settled or not
   — using the same key hunt.
3. `settleAllPending` patches `rec.entry` back onto the pending
   trade-history record as soon as the entry is known, so the mini-app
   sees it on the next `/api/trades/active` fetch.
4. `worker/index.js › buildActiveTrades` now hunts across
   `rec.entry`, `rec.entry_price`, `p.entry`, `p.entry_price`, coerces
   with `Number()`, and only exposes finite values.
5. `miniapp/app.js › queueOverlayRefresh` now schedules a 3-second
   one-shot re-poll while an active position has no entry yet, so the
   line snaps in the moment Deriv reports the entry — instead of
   waiting for the full 15 s heartbeat.

Net effect: horizontal dashed price line (green for CALL, red for PUT)
is drawn at the exact entry tick as soon as the first post-buy tick
arrives from Deriv, with the "ENTRY CALL/PUT" axis label.

## Bug 2 — UI messed up (indicator sheet spilling inline below the chart)

**Root cause.** `.sheet.hidden { display: none }` was defeatable by
specificity, and `.sheet { position: fixed; inset: 0 }` alone was not
robust across all Telegram viewer contexts (Desktop, mobile browser
preview). In some contexts the sheet fell back to static positioning
and its contents rendered inline as normal page flow, right below the
chart — which is exactly what the screenshot shows. To make matters
worse, only `body` had `overflow: hidden`; the `html` element could
still scroll, turning the whole app into a single long column.

**Fix (in `miniapp/style.css`):**
- `html { overflow: hidden }` — no more accidental page-level scroll.
- `body { position: relative }` — anchors the fixed sheet.
- `.sheet` uses both `top/right/bottom/left: 0` and `inset: 0`, plus
  `overflow: hidden`, so even if a rare containing-block quirk
  cancelled `position: fixed`, the sheet still can't visually spill.
- `.sheet.hidden { display: none !important }` — un-overridable hide.
- `.tab-body { display: none !important }` / `.tab-body.active { display: flex !important }`
  — the same specificity fix for the tab bodies, defensive.
- `.sheet-head { position: relative }` — so its drag-handle pseudo-
  element (`::before`) anchors to the head, not to the panel/window.
- `.sheet-panel { overflow: hidden; color: var(--tg-text) }` — belt-
  and-braces containment plus a text-color guarantee for viewers that
  don't inherit Telegram theme params.

After this, the "Indicators" button opens a real bottom sheet that
overlays the chart (with a dimmed backdrop and slide-up animation),
and NEVER renders inline as page content again.

## How to deploy
This bundle mirrors your repo layout, so:

```
unzip aurelia-fix.zip -d <your-repo-root>
git add miniapp/app.js miniapp/style.css runner.js worker/index.js
git commit -m "fix: draw entry line on open contracts + harden indicator sheet"
git push
```

The Cloudflare Worker will pick up `worker/index.js` on next
`wrangler deploy`. The mini-app is a static bundle, so pushing the
new `miniapp/*` files is enough for Telegram to pull them on next
open (add a cache-buster if you serve behind a CDN).
