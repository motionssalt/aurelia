/* =====================================================================
   AURELIA — payload-builder.js
   ─────────────────────────────────────────────────────────────────────
   Assembles the JSON payload sent to the AI on every cycle tick.

   Contract:
     Per enabled symbol, per timeframe (M5/M10/M15) — NO raw OHLC in the
     outbound payload; the AI works from pre-computed signals only:
       • essential indicator pack (EMA 20/50, Bollinger Bands, RSI 14, ATR 14)
         — each as a trailing 12-value series (see indicators.js)
       • support/resistance levels
       • candlestick pattern flags
       • derived_signals: compact labels/zones/regimes + fired-condition
         signals array, derived from the raw indicator pack by
         signal-features.js (slopes, RSI zone+direction, BB position,
         ATR regime, EMA cross state, combined signals array).
       • spread/volatility context (atr_14 as volatility proxy)
     Plus session context (summarised, capped):
       • running W/L, streaks, P/L, capital remaining, distance to TP/SL
       • last N trades (capped) with rationale + ai_outcome_note — NOT raw candles

   Candles are still FETCHED internally (needed to compute the indicators,
   S/R and pattern flags) but they are NEVER attached to the payload the
   AI sees. This keeps the prompt lean so the model has room to reason.

   Fetch vs report — staggered horizon design:
     We deliberately FETCH more candles than we REPORT. The fetch count
     per TF (TF_CANDLE_COUNT below) is sized as a warmup FLOOR: enough
     history for 50-EMA and 20-BB to have stabilised BEFORE the reported
     window begins. The REPORT window is fixed at 12 candles per TF (see
     indicators.REPORT_WINDOW), giving a deliberate staggered-horizon
     structure across timeframes rather than uneven wall-clock coverage:
       • M5  → 12 × 5m  = 1h  (immediate structure)
       • M10 → 12 × 10m = 2h  (short trend)
       • M15 → 12 × 15m = 3h  (broader context)
     12 points is also the minimum needed for signal-features.js to run
     a numerically stable regression slope over each series.
   ===================================================================== */

'use strict';

const Deriv          = require('./deriv');
const Indicators     = require('./indicators');
const SignalFeatures = require('./signal-features');
const Logger         = require('./logger');

// Granularity (seconds) per timeframe label.
const TF = {
    M5:  300,
    M10: 600,
    M15: 900,
};

// How many candles to FETCH per TF. This is the warmup floor — sized
// so 50-EMA / 20-BB have fully stabilised before the trailing 12-value
// window that indicators.js actually REPORTS. The reported horizon is
// controlled by indicators.REPORT_WINDOW (=12), not by these numbers:
//   M5  reported =  12 × 5m  = 1h   (fetch  ~8.3h for warmup headroom)
//   M10 reported =  12 × 10m = 2h   (fetch  10h  for warmup headroom)
//   M15 reported =  12 × 15m = 3h   (fetch  15h  for warmup headroom)
const TF_CANDLE_COUNT = {
    M5:  100,   // fetch 100 × 5m  → report last 12 (→1h)
    M10: 60,    // fetch  60 × 10m → report last 12 (→2h)
    M15: 60,    // fetch  60 × 15m → report last 12 (→3h)
};

/* ─────────────────────────────────────────────────────────────────
   Enumerate the symbol pool: forex always, synthetics if syn_enabled.
   ───────────────────────────────────────────────────────────────── */
function enabledSymbols(config) {
    const out = [];
    const fx = (config.symbols && config.symbols.forex) || {};
    for (const [s, on] of Object.entries(fx)) if (on) out.push(s);
    if (config.syn_enabled) {
        const sy = (config.symbols && config.symbols.synthetics) || {};
        for (const [s, on] of Object.entries(sy)) if (on) out.push(s);
    }
    return out;
}

/* ─────────────────────────────────────────────────────────────────
   Build the full per-symbol slice (all 3 TFs + indicators + S/R + patterns)
   ───────────────────────────────────────────────────────────────── */
async function buildSymbolSlice(ws, symbol) {
    const slice = { symbol, timeframes: {} };
    for (const [label, gran] of Object.entries(TF)) {
        try {
            const candles = await Deriv.ticksHistory(ws, symbol, gran, TF_CANDLE_COUNT[label]);
            // Candles are used ONLY to compute the indicator/S-R/pattern
            // signals below — they are intentionally NOT attached to the
            // outbound slice. The AI should never see raw OHLC.
            const indicators     = Indicators.computeIndicatorPack(candles);
            const supportResist  = Indicators.computeSupportResistance(candles, 50);
            const candlePatterns = Indicators.computeCandlePatterns(candles);
            // Layered on top of the raw indicator pack: interpretable
            // slope labels, RSI zone+direction, BB position, ATR regime,
            // EMA cross state, and a compact fired-signals array.
            const derivedSignals = SignalFeatures.computeDerivedSignals(indicators, candlePatterns);
            slice.timeframes[label] = {
                granularity_seconds: gran,
                indicators:         indicators,
                support_resistance: supportResist,
                candle_patterns:    candlePatterns,
                derived_signals:    derivedSignals,
            };
        } catch (e) {
            Logger.warn(`Failed to fetch ${symbol} ${label}`, { error: e.message });
            slice.timeframes[label] = { error: e.message };
        }
    }
    // Volatility context: use M5 ATR as a coarse spread/vol proxy.
    // atr_14 is now a trailing 5-value series (see indicators.js) — pick
    // the most recent (last) element so this proxy remains a scalar.
    const m5 = slice.timeframes.M5;
    const atrSeries = m5 && m5.indicators && m5.indicators.atr_14;
    slice.volatility_proxy_atr14_m5 = Array.isArray(atrSeries)
        ? atrSeries[atrSeries.length - 1]
        : (atrSeries || null);
    return slice;
}

/* ─────────────────────────────────────────────────────────────────
   Summarise session for the AI. Caps history.
   ───────────────────────────────────────────────────────────────── */
function buildSessionContext(state, config) {
    const s = state.cycle_session || {};
    const tp = Number(s.take_profit || 0);
    const sl = Number(s.stop_loss   || 0);
    const pnl = Number(s.pnl || 0);
    const cap = Number(s.capital_remaining || 0);

    const maxHist = (config.ai && config.ai.max_history_entries) || 12;
    const hist = (state.trade_history_cycle || []).slice(-maxHist).map(t => ({
        ts: t.ts,
        symbol: t.symbol,
        direction: t.direction,
        stake: t.stake,
        outcome: t.outcome,
        pnl: t.pnl,
        rationale_at_entry: t.rationale,
        ai_outcome_note: t.ai_outcome_note || null,
    }));

    return {
        active:               !!s.active,
        capital_remaining:    cap,
        running_pnl:          pnl,
        wins:                 Number(s.wins || 0),
        losses:               Number(s.losses || 0),
        win_streak:           Number(s.win_streak || 0),
        loss_streak:          Number(s.loss_streak || 0),
        take_profit_target:   tp,
        stop_loss_threshold:  sl,
        distance_to_tp:       (tp > 0) ? Math.max(0, tp - pnl) : null,
        distance_to_sl:       (sl > 0) ? Math.max(0, sl + pnl) : null,
        recent_trades:        hist,
    };
}

/* ─────────────────────────────────────────────────────────────────
   Main: build the full AI payload (one call per cycle).
   ───────────────────────────────────────────────────────────────── */
async function buildDecisionPayload(ws, config, state) {
    const symbols = enabledSymbols(config);
    if (!symbols.length) throw new Error('No enabled symbols to scan');

    const slices = [];
    for (const sym of symbols) {
        slices.push(await buildSymbolSlice(ws, sym));
    }

    // stake_ceiling is the ABSOLUTE per-trade cap, not the session
    // budget. Session capital_remaining is tracked separately in the
    // `session` block so the AI knows the envelope, but must NOT be
    // treated as a single-trade ceiling — that caused stake-sizing
    // bugs where the AI tried to bet the entire remaining envelope
    // on one trade.
    return {
        meta: {
            generated_at: new Date().toISOString(),
            account_mode: state.account_mode || config.account.mode,
            frx_enabled:  config.frx_enabled !== false,
            syn_enabled:  !!config.syn_enabled,
            min_expiry_seconds: (config.expiry && config.expiry.min_seconds) || 900,
            stake_floor:   (config.stake && config.stake.absolute_min) || 0.35,
            stake_ceiling: (config.stake && config.stake.absolute_max) || 10000,
        },
        symbols: slices,
        session: buildSessionContext(state, config),
    };
}

module.exports = {
    TF,
    enabledSymbols,
    buildDecisionPayload,
    buildSymbolSlice,
    buildSessionContext,
};
