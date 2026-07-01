# AURELIA Mini App — Frontend

Telegram Mini App (WebView) for the AURELIA trading bot. Zero build step —
plain HTML/CSS/JS loaded via `<script>`/`<link>` tags.

Live: https://aurelia-miniapp.pages.dev
API base: `https://aurelia-bot.motionssalt.workers.dev` (wired via
`window.AURELIA_API_BASE` in `index.html`).

## Files

| File | Concern |
|------|---------|
| `index.html`   | Markup, tab structure, indicator bottom-sheet, CDN includes |
| `app.js`       | All app logic: API client, Deriv WS, chart, overlays, indicators wiring, settings |
| `indicators.js`| Self-contained TA math (EMA/SMA/BB/Keltner/ATR/RSI). No dependencies |
| `style.css`    | Mobile-first styling, theme tokens, flex layout, sheet, tokens |

`indicators.js` is a new file — kept as its own concern (loaded via a plain
`<script>` before `app.js`), consistent with the existing zero-tooling approach.
No bundler/framework introduced.

## What changed in this pass

### Bug 1 — Entry price line not rendering (fixed)
Root cause was **stale-series orphaning + timing**, not the `createPriceLine`
call itself:
- The overlay was applied right after `state.series.setData([])` on a symbol
  switch (empty series) and was **never re-applied once fresh candles landed**,
  so the line was effectively drawn against an empty/undrawn series.
- Removal referenced whatever `state.series` currently was, which could be a
  different series after a switch.

Fixes:
- Price line is now (re)drawn **every time fresh candle data lands on the
  current series** (`handleDerivMessage` `candles` branch → `queueOverlayRefresh`).
- We track the exact series the line is attached to (`state.priceLineSeries`)
  and always remove from *that* reference — never a stale one.
- On symbol/timeframe switch, `resubscribe()` calls `clearOverlay()`
  immediately so a line from a previous symbol reliably disappears (including
  when switching AWAY from a symbol that had an open position).
- `entry_price` is coerced with `Number()` to guard against string values that
  would silently no-op.
- Uses `LightweightCharts.LineStyle.Dashed`, color-coded `--bull` (call) /
  `--bear` (put), labeled with the entry price.
- Added `console.debug('[aurelia] /api/trades/active raw:', act)` and
  `window.__aureliaActiveMatch` for inspection.

### Bug 2 — Whitespace below chart (fixed)
- Body/main/tab-body are now a **flex column**; `#chartArea` / `#chartWrap`
  use `flex: 1 1 auto` so the chart fills the space between the picker row and
  the bottom of the viewport across all phone heights (no fixed pixel height).
- `fitCharts()` re-applies `{width,height}` on `resize`, `orientationchange`,
  tab activation, and sub-pane toggles.

### Indicators (new)
Accessible via the **layers icon** next to the pickers → opens a bottom sheet
(chart state is preserved; you never leave the chart screen).

- **EMA / SMA** — add/remove any number of lines, each with its own editable
  period and on/off toggle.
- **Bollinger Bands** — period + std-dev multiplier, 3 overlay lines.
- **Keltner Channel** — EMA period + ATR length + ATR multiplier, 3 lines.
- **RSI** — separate sub-pane below the chart, 0–100 with 30/70 guides.
- **ATR** — separate sub-pane below the chart.

All computed **client-side** from the streamed candle data (no new endpoints).
Toggling an indicator adds/removes only that line series — the main chart is
never torn down. Selections + periods persist in `localStorage`
(`aurelia.indicators.v1`).

### UI redesign
- Live Telegram theme via `themeParams` → CSS custom properties (light/dark
  native); chart re-tints on `themeChanged` without a rebuild.
- Shared color tokens: `--bull`, `--bear`, `--accent`, `--surface`,
  `--surface-2` used everywhere (candles, entry line, P&L, indicators).
- Tighter spacing, clearer type scale (`--fs-xs`…`--fs-xl`), SVG tab icons,
  44px touch targets, larger toggles, bottom-sheet with grab handle.

## API endpoints consumed (unchanged, read/POST only)
- `GET /api/config`, `POST /api/config`
- `GET /api/status`
- `GET /api/trades/active`, `GET /api/trades/history?limit&offset`
- `POST /api/cycle/start`, `/api/cycle/pause`, `/api/scan`, `/api/daily/run`

Candle data streams directly from Deriv WS
(`wss://ws.derivws.com/websockets/v3?app_id=1089`) as before — no backend
routes added.

## Design decisions (where ambiguous)
- ATR uses Wilder smoothing; RSI uses Wilder smoothing; BB std-dev is
  population. These match common charting conventions.
- RSI & ATR rendered as separate lightweight-charts instances stacked below
  the main chart (v4 has no built-in multi-pane API), with their time scales
  kept in sync with the main chart. Chosen over a text readout for clarity.
- New EMA defaults to period 100 when "Add" is pressed; SMA to 20.
- Hand-rolled math (each function < 20 lines) — no charting/TA library pulled in.

## Not implemented / next steps
- Indicator crosshair value legend on the sub-panes.
- Drag-to-reorder EMA/SMA lines.
- Per-indicator color pickers (colors currently auto-assigned from a palette).
