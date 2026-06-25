# AURELIA

AI-driven Deriv binary-options trading bot. **Gemini decides; deterministic
code executes.** Built on the `motionsalt-headless` serverless foundation
(GitHub Actions cron + Cloudflare Worker + Telegram) — same proven
infrastructure, very different brain.

---

## How it works

```
┌──────────────────────┐    Telegram     ┌──────────────────────┐
│  You (Telegram chat) │ ◀──────────────▶ │  Cloudflare Worker   │
└──────────────────────┘                  │  (control plane)     │
                                          └──────────┬───────────┘
                          workflow_dispatch          │  config.json
                                                     ▼  edits via API
                                          ┌──────────────────────┐
                                          │   GitHub Actions      │
                                          │   runs runner.js      │
                                          │   on every tick       │
                                          └──────────┬────────────┘
                                                     │
                       ┌─────────────────────────────┴──────────────────────────┐
                       ▼                                                        ▼
              ┌─────────────────┐                                       ┌────────────────┐
              │ payload-builder │  M5/M10/M15 candles + indicators      │   Gemini API   │
              │ (deterministic) │ ──────────────────────────────────▶   │ (decides only) │
              └─────────────────┘                                       └────────┬───────┘
                                                                                 │ JSON
                                                                                 ▼
                                                              { action, symbol, direction,
                                                                expiry, stake, confidence,
                                                                rationale }
                                                                                 │
                                                                                 ▼
                                                                        ┌────────────────┐
                                                                        │   risk.js      │
                                                                        │   clamps it    │
                                                                        └────────┬───────┘
                                                                                 ▼
                                                                        ┌────────────────┐
                                                                        │  Deriv API     │
                                                                        │  places trade  │
                                                                        └────────────────┘
```

The AI **never** sees raw chart images, **never** calls the Deriv API
directly, and **never** enforces session limits. It only consumes a
structured payload and returns a structured decision. Everything else —
indicator computation, expiry clamping (≥ 15 min for forex intraday),
stake clamping, TP/SL enforcement, GitHub state persistence — happens in
deterministic code that you can audit line by line.

---

## Two independent trading paths

| Path        | Trigger                                  | Position lock | TP/SL session | Recorded in              |
|-------------|------------------------------------------|---------------|---------------|--------------------------|
| **Cycle**   | Fires `interval_seconds` after the previous cycle trade *settles* | One open at a time | Yes — `cycle_session.capital/take_profit/stop_loss` | `trade_history_cycle` |
| **Manual**  | `/scan` or 🤖 button — runs immediately  | None — can fire while a cycle trade is open | No — stateless w.r.t. cycle | `trade_history_manual` |

A cycle session is defined by **capital / take-profit / stop-loss**, set
in config or via Telegram. The instant `pnl >= take_profit` or
`pnl <= -stop_loss`, the cycle halts. **The AI cannot override this.**

---

## What the AI gets per call

Per enabled symbol, for each of M5, M10, M15:

- Last ~40 OHLC candles (5+ hours coverage at the timeframe)
- Full indicator pack: RSI, EMA(20/50), MACD, BollingerBands, ATR, ADX,
  Stochastic, Keltner, Donchian, Ichimoku
- Support/resistance pivot levels (last 3 each)
- Candlestick pattern flags (doji, hammer, engulfing, morning/evening star)
- Volatility proxy (M5 ATR14)

Plus session context (capped to last 12 trades by default):

- Running W/L, streaks, P/L, capital remaining
- Distance to TP and to SL
- Each prior trade's rationale **and** the AI's own one-sentence
  retrospective (`ai_outcome_note`) captured at settlement

**No raw tick data is sent.** **No chart images are sent.** The screenshot
attached to Telegram trade notifications is generated *after* the AI's
decision, purely for your audit trail.

---

## Synthetic indices (SYN toggle)

Off by default. Toggle from Telegram (`/syn on`) or the menu button. When
on, the synthetic pool (`R_10`, `R_25`, ..., `1HZ100V`) is added to the
symbols the AI can pick from. Crypto symbols are intentionally left out —
flip them on by editing `config.symbols` if you want them back.

---

## Multi-key Gemini failover

You can register an arbitrary number of Gemini API keys via Telegram:

```
/addkey alpha AIza...XYZ
/addkey backup AIza...ABC
/listkeys
/removekey alpha
```

Each key is stored as a GitHub Actions secret (libsodium sealed-box
encrypted, never readable back), and its **name** is appended to
`config.ai.key_registry`. On every Gemini call the runner tries keys in
order; a key that errors or hits quota is benched for 2 hours
(configurable via `config.ai.bench_minutes`). Bench state lives in
`last-status.json -> ai_keys_bench` so it survives between ticks.

---

## Demo first, real on purpose

`config.account.mode = "demo"` by default. Switch to real explicitly via
`/mode real` or the inline button. The badge in every Telegram message
makes the active account unmistakable (🟡 DEMO / 🔴 REAL).

---

## Repo layout

```
aurelia/
├── runner.js              # tick state machine (cycle / manual / settle_only)
├── ai-client.js           # Gemini wrapper + multi-key failover + benching
├── payload-builder.js     # builds the per-cycle AI payload
├── indicators.js          # RSI, EMA, MACD, BB, ATR, ADX, S/R, patterns…
├── deriv.js               # Deriv OAuth → OTP → WebSocket (carried from old bot)
├── chart.js               # puppeteer chart screenshots (carried from old bot)
├── telegram.js            # outbound TG client + templates (carried)
├── logger.js              # structured logger + ring buffer (carried)
├── risk.js                # stake/expiry sanity clamp (does NOT compute stake)
├── config.json            # toggles, session params, key registry
├── last-status.json       # state file, committed by CI every tick
├── worker/
│   ├── index.js           # Cloudflare Worker — Telegram webhook + GH API
│   ├── package.json
│   └── wrangler.toml
└── .github/workflows/
    └── aurelia-cron.yml   # GH Actions cron + workflow_dispatch
```

See [`SETUP.md`](./SETUP.md) for first-time deployment instructions.
