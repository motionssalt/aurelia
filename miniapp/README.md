# AURELIA — Telegram Mini App

Vanilla HTML/CSS/JS Telegram Mini App for the AURELIA trading bot. No build
step, no bundler, no UI framework. Ships as plain static files served next to
the Cloudflare Worker API.

## Files

| File            | Role |
|-----------------|------|
| `index.html`    | Markup: top bar, tab nav, chart / trades / settings tabs, indicator bottom-sheet. |
| `style.css`     | Design tokens + all styling. Dark theme, Telegram `--tg-*` integration. |
| `app.js`        | App logic: Telegram SDK, Deriv WebSocket, lightweight-charts, indicator rendering, settings CRUD. |
| `indicators.js` | Self-contained, dependency-free technical-indicator math (`window.Indicators`). |

## Indicator library (`indicators.js`)

Pure functions. Inputs are arrays of numbers or candle objects
`{time, open, high, low, close}`. Outputs are arrays aligned to input length,
with `null` for warm-up periods. Exposed on `window.Indicators`.

**Overlay-type** (rendered directly on the price chart):

- `sma(values, period)`
- `ema(values, period)` — SMA-seeded
- `bollinger(closes, period, mult)` → `{upper, middle, lower}`
- `keltner(candles, emaPeriod, atrPeriod, mult)` → `{upper, middle, lower}`
- `donchian(candles, period)` → `{upper, middle, lower}` **(new)**
- `parabolicSar(candles, step, max)` **(new)**

**Oscillator-type** (rendered in dedicated sub-panes below the price chart):

- `rsi(closes, period)` — Wilder smoothing
- `atr(candles, period)` — Wilder smoothing
- `macd(closes, fast, slow, signal)` → `{macd, signal, histogram}` **(new)**
- `stochastic(candles, kPeriod, dPeriod, smoothK)` → `{k, d}` **(new)**
- `adx(candles, period)` → `{adx, plusDI, minusDI}` **(new)**
- `williamsR(candles, period)` **(new)**
- `cci(candles, period)` **(new)**

Helpers: `trueRange`, `rollingStd`, `toLineData`, `toHistData`.

Each indicator is independently toggleable from the indicator picker and each
oscillator renders in its own synced lightweight-charts sub-pane. Default line
colors are read live from CSS tokens (`--bull`, `--bear`, `--accent`,
`--ind-a … --ind-h`) — no chart color is hardcoded outside `:root`.

## UI

- **Design tokens** consolidated in `:root`: a 4px spacing scale (`--sp-1…6`),
  a small radius scale (`--r-sm/md/lg/pill`), a clear type scale
  (`--fs-2xs…2xl`), and font-weight tokens.
- **Tab nav** uses an animated underline active-state.
- **Indicator picker** is a scannable bottom-sheet grouped into **Overlay** and
  **Oscillator** categories, each row with a color swatch, toggle, and inline
  parameters. Enabled rows get an active-state treatment.
- **Micro-interactions**: 170ms ease transitions on tab switches, toggles,
  button presses, sub-pane mount, and toasts — subtle, non-bouncy.
- Preserves the dark theme and live Telegram `--tg-*` theme-token integration
  (`app.js applyTheme` → `retintChart` → `refreshColors`).

## Functional entry points

Static app served at the Mini App root. Talks to the Worker API
(`window.AURELIA_API_BASE`) with the Telegram `initData` header:

- `GET  /api/config`, `POST /api/config`
- `GET  /api/status`
- `GET  /api/trades/active`, `GET /api/trades/history?limit&offset`
- `POST /api/cycle/start`, `/api/cycle/pause`, `/api/scan`, `/api/daily/run`

Live candles stream directly from Deriv over WebSocket
(`wss://ws.derivws.com/websockets/v3?app_id=1089`).

## Data / storage

- Indicator config persists to `localStorage` under `aurelia.indicators.v2`
  (schema-merged with defaults so older saves upgrade cleanly).
- All trading/account config lives server-side (Cloudflare Worker); the app
  only reads/patches it via the API above.

## Verified

Loads with no code errors; all 13 indicator functions compute correctly and
all overlay + oscillator indicators toggle on/off and render (verified via a
lightweight-charts render smoke test and a full app-boot toggle harness).

## Not implemented / next steps

- Per-indicator custom color pickers (currently token-driven defaults).
- Draggable sub-pane reordering (order is currently canonical/fixed).
- Persisting indicator config server-side (currently local only).

## Scope note

Data flow, WebSocket logic, and trade-execution logic in `app.js` are
unchanged — this pass only extended the indicator library, added indicator
toggle wiring/rendering, and modernized the UI.
