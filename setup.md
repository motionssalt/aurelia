# AURELIA Mini App — Setup Guide

This adds a **Telegram Mini App** (chart viewer, trades list, and a full
settings panel) on top of the existing Aurelia bot. It reuses the same
`config.json` / `last-status.json` in the repo — **no database**, no new
infra.

The bot's Telegram-side commands and keyboards are unchanged. The Mini
App calls a new `/api/*` layer on the same Cloudflare Worker, and every
`/api/*` call is authenticated via Telegram Mini App `initData` (HMAC
signed with your `TELEGRAM_BOT_TOKEN`).

---

## What's in the zip

Unpack `aurelia-miniapp.zip` into your existing local clone of
`aurelia`:

```
aurelia-miniapp.zip
├── worker/
│   └── index.js           ← replaces existing (adds /api/* routes)
├── miniapp/
│   ├── index.html         ← NEW
│   ├── app.js             ← NEW
│   └── style.css          ← NEW
└── setup.md               ← this file (also in repo root)
```

From your repo root:

```bash
unzip -o aurelia-miniapp.zip
git status   # sanity-check the modified/new files
```

Then commit and push at your discretion — nothing in the zip requires
a commit before it works, because the Worker is deployed by paste and
`miniapp/` is deployed as static files.

---

## Deploy the updated Worker

The existing `worker/index.js` is pasted into the Cloudflare dashboard;
there's no build step and no `wrangler deploy` in this repo. Same flow
applies to the update:

1. Cloudflare Dashboard → **Workers & Pages** → your `aurelia` Worker →
   **Edit code**.
2. Open `worker/index.js` (the new one) in your editor, **copy the
   whole file**, and paste over the existing code in Cloudflare's
   inline editor.
3. Click **Save and Deploy**.
4. Confirm existing environment variables are still there:
   - `TELEGRAM_BOT_TOKEN`  — reused for initData verification (no new
     variable required)
   - `TELEGRAM_CHAT_ID`    — owner whitelist (reused; the API rejects
     any Mini App user whose ID doesn't match)
   - `GITHUB_PAT`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_WORKFLOW`,
     `GITHUB_REF`

**No new env vars are required.**

5. Quick smoke check — the Worker URL should still respond to a plain
   GET (Telegram webhook returns `aurelia webhook ok`):

```bash
curl -s https://YOUR-WORKER.workers.dev/          # → aurelia webhook ok
curl -si https://YOUR-WORKER.workers.dev/api/config | head -1  # → HTTP/1.1 401
```

The `401` on `/api/config` is the correct answer — the endpoint refuses
unauthenticated calls before touching GitHub.

---

## Host the static Mini App files

I chose **Cloudflare Pages** for the `miniapp/` static files. That's a
standalone hop from the Worker so the Worker's code stays a single file
you can paste, unchanged, and the Mini App has its own URL you plug
into BotFather.

### One-off deploy with `wrangler`

```bash
# from the repo root (after unzipping):
npx wrangler pages deploy miniapp --project-name aurelia-miniapp
```

Wrangler will print a URL like `https://aurelia-miniapp.pages.dev` (or
a deployment-specific URL). Note it — that's your Mini App URL.

> The first run may prompt you to log into Cloudflare and pick an
> account. Subsequent deploys reuse the project.

### Point the Mini App at the Worker

The Mini App uses **same-origin fetches by default**. Since Pages and
the Worker are on different origins, either:

- **Recommended:** add a single line to `miniapp/index.html` (right
  before the `app.js` include) telling the Mini App where the Worker
  lives:

  ```html
  <script>window.AURELIA_API_BASE = 'https://YOUR-WORKER.workers.dev';</script>
  <script src="./app.js"></script>
  ```

  Redeploy Pages: `npx wrangler pages deploy miniapp --project-name aurelia-miniapp`.

- **Or** point a custom domain at the Worker and use the Cloudflare
  **Pages → Functions → Routes** to proxy `/api/*` to the Worker. That
  works but is one more moving part.

### Alternative: serve `miniapp/` from the same Worker

If you'd rather keep it single-origin, you can add a static-asset
binding to the Worker (`wrangler.toml` → `[assets]`, directory
`./miniapp`) and skip Pages entirely. This repo intentionally does
**not** do that so the copy-paste deploy stays intact; the Pages
approach is simpler with your current flow.

---

## Register the Mini App with BotFather

1. Open Telegram, message **@BotFather**.
2. Send `/mybots` → tap your bot → **Bot Settings** → **Menu Button** →
   **Configure Menu Button**.
3. Paste the Pages URL you got above (e.g.
   `https://aurelia-miniapp.pages.dev`).
4. Give it a button label (e.g. `AURELIA`).
5. Save.

Now open a chat with your bot in Telegram. A blue **AURELIA** button
appears next to the message box — tap it and the Mini App loads.

> If you use the direct Web App links (`t.me/YOURBOT/app`), you can
> also register a web app via `/newapp` and get a shareable
> `t.me/YOURBOT/appname` link. The Menu Button route is enough for
> personal use.

---

## Verification checklist

Run these after deploying:

1. **401 without initData** — the API refuses unauthenticated hits.

   ```bash
   curl -si https://YOUR-WORKER.workers.dev/api/config
   # HTTP/1.1 401 Unauthorized
   # {"error":"unauthorized","reason":"missing initData"}
   ```

2. **401 with a bogus initData** — HMAC verification actually runs.

   ```bash
   curl -si https://YOUR-WORKER.workers.dev/api/config \
        -H 'X-Telegram-Init-Data: user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef'
   # HTTP/1.1 401
   # {"error":"unauthorized","reason":"bad hash"}
   ```

3. **Open the Mini App via the bot's Menu Button.** In the Chart tab
   you should see:
   - the symbol dropdown populated from your enabled forex/synthetic
     symbols
   - candles for `frxEURUSD` @ `5m` by default
   - live updates (the last candle's high/low/close changes without
     reloading)
   - if you currently have an open position on the viewed symbol, a
     dashed green (call) or red (put) horizontal line at entry price
     plus a `MM:SS` countdown top-left that ticks every second and
     flips to `EXPIRED` at zero

4. **Trades tab**
   - Active list shows your open contracts (with time-left).
   - History list is paginated (20/page by default) and matches the
     `trade_history_cycle` + `trade_history_manual` you can see in
     `last-status.json`.

5. **Settings tab**
   - Toggle a forex symbol off → check the commit landed in the repo
     (`config.json` shows `false`), and the symbol disappears from the
     Chart tab's dropdown.
   - Save Cycle → check the commit message `miniapp: config patch`.
   - Start/Pause Cycle → check the corresponding commit + the GitHub
     Actions workflow_dispatch run (for Start).
   - Scan Now → check the workflow_dispatch run.

---

## New HTTP routes

All accept **X-Telegram-Init-Data** header (or `Authorization: tma <initData>`).

| Method | Path                    | Purpose                                     |
|--------|-------------------------|---------------------------------------------|
| GET    | `/api/config`           | Sanitized config.json + symbol catalog + timeframes |
| GET    | `/api/status`           | last-status.json (logs stripped for size)   |
| GET    | `/api/trades/active`    | Open positions + pending contracts, correlated with the matching trade_history record so `direction` / `entry_price` / `expiry_ms` are available |
| GET    | `/api/trades/history?limit&offset` | Paginated closed (settled) trades, newest first |
| POST   | `/api/config`           | Partial config patch (validated + bounded)  |
| POST   | `/api/cycle/start`      | Same as Telegram `/startcycle`              |
| POST   | `/api/cycle/pause`      | Same as Telegram `/pausecycle`              |
| POST   | `/api/scan`             | Same as Telegram `/scan` (dispatchManual)   |
| POST   | `/api/daily/run`        | Same as Telegram `daily:run` (run summary now) |

---

## Assumptions made from inspecting `last-status.json`

These are documented here because the field shapes weren't specified up
front — I read the actual current file rather than guessing:

- **Open positions live in two spots.** `state.cycle_open_position` is
  a summary object `{contract_id, symbol, placed_at}` for the current
  cycle-path trade only. **All** open trades (cycle *and* manual) live
  in `state.pending_contracts[]` as `{contract_id, path, symbol,
  placed_at, expiry_sec}`. `/api/trades/active` uses
  `pending_contracts` as the source of truth so manual trades show up
  too.

- **Direction / entry price are NOT on the open-position record.**
  They're on the matching row in `state.trade_history_cycle[]` /
  `state.trade_history_manual[]` (correlated by `contract_id`). The
  API joins them so the Mini App can draw the price line and colour it
  correctly. `entry` is stored as a string on settled rows — the API
  coerces it to a number.

- **Entry price may be null while the trade is still pending.** The
  `trade_history_*` row is created before `entry_spot` is available;
  it gets stamped only on settlement. In that case the overlay shows
  `entry pending` and skips drawing the price line — it does not
  fabricate one.

- **`expiry_timestamp` is not stored directly.** Deriv doesn't stamp
  it into the state file. The API computes it as
  `Date.parse(placed_at) + expiry_sec*1000` and exposes it as
  `expiry_ms`. The Mini App countdown ticks purely from this on the
  client side — no server polling required.

- **Closed vs open.** A row in `trade_history_*` with `settled === true`
  is closed and goes into history. Anything else (including
  `outcome === "pending"`) is treated as still-open — same logic runner.js
  uses.

- **`trade-history.json` was NOT created.** The existing state file
  already holds everything needed; adding a separate history file
  would just double-write on every settle. Per the brief this is the
  preferred choice.

- **Secrets stripped.** `config.ai.providers[].keys[]` is masked
  (`****last4`) and `config.ai.providers[].key_accounts` values are
  fully masked. `config.ai.key_registry` and `config.ai.providers[].key_registry`
  are intentionally NOT masked — they are lists of secret **names**,
  not values, and are visible in the Telegram Settings screen already.

---

## Troubleshooting

**Mini App is a blank screen inside Telegram**
- Open the Mini App URL in a normal browser tab. If the Mini App HTML
  is blank there, your `miniapp/` deploy is broken. Check
  `wrangler pages deployment list --project-name aurelia-miniapp`.
- If it renders but immediately toasts *"No Telegram initData — open
  this via the bot Menu Button."*, you're not inside Telegram —
  that's expected. Open it from the bot's menu button in Telegram.

**Every API call is 401**
- The Worker doesn't have `TELEGRAM_BOT_TOKEN` set (or has the wrong
  one). Verify in Cloudflare → Worker → Settings → Variables.
- The `initData` is stale (>24h old). Close and reopen the Mini App
  inside Telegram — that forces a fresh signed payload.
- Your Telegram user ID doesn't match `TELEGRAM_CHAT_ID`. This will
  return **403** (`{"error":"forbidden","reason":"not owner"}`), not
  401 — that's the owner whitelist.

**Chart is empty / "deriv: error"**
- Deriv's WS is public and takes no auth for ticks_history + candles,
  so the failure is almost always symbol-related. Confirm the symbol
  really is a valid Deriv symbol (`frxEURUSD`, `R_100`, etc.). Try
  another symbol from the picker.
- On mobile the Telegram WebView sometimes throttles background WS
  sockets — switch tabs and back to the Chart tab to force a
  reconnect (`resubscribe()`).

**Chart shows candles but doesn't tick**
- The subscription initial payload arrived (`msg_type === "candles"`)
  but streaming updates (`msg_type === "ohlc"`) aren't landing. This
  usually means the tab is backgrounded — Telegram's WebView pauses
  timers. Focus the tab and it resumes.

**Settings don't persist**
- Every POST /api/config returns the updated config in the response.
  If the toast says "saved" but a reload shows the old value, the
  commit failed on GitHub — check the Worker's live-log tail in the
  Cloudflare dashboard for a `ghPutFile ... 4xx/5xx` line. Common
  cause: `GITHUB_PAT` scope missing `repo` or expired.

**Active position line doesn't show**
- Symbol mismatch. The overlay is only drawn when a pending contract
  in `last-status.json` has the same `symbol` as the currently viewed
  chart. Switch the Chart's symbol picker to your open contract's
  symbol.
- The trade hasn't settled its `entry_spot` yet — the overlay will
  show `entry pending` and no price line. The line appears on the
  next active-trades refresh (every 15s) after the entry price is
  written to `trade_history_*`.

---

## Security notes

- **initData HMAC is the security boundary.** CORS is intentionally
  permissive (`Access-Control-Allow-Origin: *`) because that's the
  standard shape for a Mini App loaded inside Telegram's WebView.
  Every `/api/*` route rejects any request whose initData doesn't
  HMAC-verify against `TELEGRAM_BOT_TOKEN` *before* reading or
  writing anything to GitHub.
- The API also enforces the owner whitelist (`TELEGRAM_CHAT_ID`) —
  even if some other Telegram user somehow got a valid initData for
  your bot, the API returns 403.
- No secrets are exposed to the client: `ai.providers[].keys[]` are
  masked to `****last4` and `ai.providers[].key_accounts` values are
  fully redacted. The client cannot write to those fields either —
  `applyConfigPatch()` only accepts an allow-listed subset (cycle,
  session, symbols[toggle-only], account.mode, payout, stake,
  daily_summary, ai.{min_confidence,max_history_entries,bench_minutes,providers[].enabled}).
