# Aurelia Mini App UI Overhaul

## Project name, goals, and main features
Aurelia is a Telegram Mini App for monitoring automated trading cycles, active trades, historical outcomes, charts, indicators, and bot configuration. This static front-end connects to the existing Aurelia Cloudflare Worker API and Deriv websocket data source.

## Currently completed features
- Full UI overhaul for `miniapp/index.html`, `miniapp/style.css`, and targeted non-indicator UI code in `miniapp/app.js`.
- Redesigned top bar with grouped brand/status and account/balance hierarchy.
- Redesigned pill-style tab navigation with explicit text-decoration suppression for default, active, hover, focus, and pressed states.
- Theme-token audit and migration for UI components, including chart overlay, badges, status dot, buttons, inputs, toggles, cards, trade rows, bottom sheet, and toast states.
- Redesigned chart active-trade overlay with direction badge, entry stat, countdown stat, and metadata hierarchy.
- Redesigned trade cards with header, meta, and rationale sections for better scannability.
- Redesigned settings cards, controls, toggles, symbol chips, and button hierarchy.
- Chart grid colors now read from CSS theme tokens instead of using a fixed dark-theme assumption.
- Light-mode verification was performed with a temporary preview page: tab text-decoration resolved to `none`, and the chart overlay rendered with adaptive light-theme surface/text colors.

## Functional entry URIs
- `miniapp/index.html` — Telegram Mini App entry point.
- API base configured in page script: `https://aurelia-bot.motionssalt.workers.dev`.
- API endpoints used by the client include:
  - `/api/config`
  - `/api/status`
  - `/api/trades/active`
  - `/api/trades/history?limit={limit}&offset={offset}`
  - `/api/cycle/start`
  - `/api/cycle/pause`
  - `/api/scan`
  - `/api/daily/run`
- Realtime chart data: `wss://ws.derivws.com/websockets/v3?app_id=1089`.

## Data models, structures, and storage services used
- No local database was added.
- Indicator settings continue to use browser `localStorage` key `aurelia.indicators.v2`.
- Runtime state remains in the existing client-side `state` object in `miniapp/app.js`.
- Trading/configuration data remains provided by the existing Aurelia Worker API.

## Features not yet implemented
- No new backend/API functionality was added.
- No changes were made to `indicators.js` or indicator calculation logic.
- No authentication flow was added for local browser preview; the Mini App remains designed to run inside Telegram with valid init data.

## Recommended next steps
- Copy the modified `miniapp/index.html`, `miniapp/app.js`, and `miniapp/style.css` into the upstream repository and test inside Telegram on both light and dark themes.
- Verify real active-trade overlay data against live API responses inside Telegram.
- Consider adding screenshot-based visual regression tests for light/dark theme token coverage.

## Public URLs
- Production Mini App/API host referenced by the frontend: `https://aurelia-bot.motionssalt.workers.dev`.
- No new public deployment URL was created in this workspace.
