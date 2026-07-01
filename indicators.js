/* =====================================================================
   AURELIA — indicators.js
   ─────────────────────────────────────────────────────────────────────
   Indicator catalogue — trimmed to the essentials so the AI has room
   to reason without being buried under a dozen overlapping oscillators.

   Kept:
     • Moving Averages     — EMA 20, EMA 50   (trend structure)
     • Bollinger Bands     — 20 / 2σ          (volatility envelope)
     • RSI 14                                  (momentum companion)
     • ATR 14                                  (volatility proxy, used
                                                by runner + payload)
     • Support / Resistance (pivot-based)
     • Candlestick patterns (final 1–3 candles)

   Removed (previously over-loaded the prompt): MACD, ADX, Stochastic,
   Keltner Channels, Donchian Channels, Ichimoku Cloud.

   The AI NEVER computes indicators — this module hands it precomputed
   numbers. Callers pass candles[] (chronological, oldest first) and get
   back a compact { rsi_14, ema_20, ema_50, bb, atr_14 } object that
   fits in a JSON payload.
   ===================================================================== */

'use strict';

const ti = require('technicalindicators');

function _last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function _num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(6)) : null; }

function _closes(candles) { return candles.map(c => c.close); }
function _highs(candles)  { return candles.map(c => c.high);  }
function _lows(candles)   { return candles.map(c => c.low);   }

/* ─────────────────────────────────────────────────────────────────
   Per-timeframe indicator pack (essentials only)
   ───────────────────────────────────────────────────────────────── */
function computeIndicatorPack(candles) {
    if (!Array.isArray(candles) || candles.length < 30) {
        return { error: 'insufficient_candles', count: candles ? candles.length : 0 };
    }
    const close = _closes(candles);
    const high  = _highs(candles);
    const low   = _lows(candles);

    const rsi14  = _last(ti.RSI.calculate({ values: close, period: 14 }));
    const ema20  = _last(ti.EMA.calculate({ values: close, period: 20 }));
    const ema50  = _last(ti.EMA.calculate({ values: close, period: 50 }));
    const bbArr  = ti.BollingerBands.calculate({ values: close, period: 20, stdDev: 2 });
    const bb     = _last(bbArr) || {};
    const atrArr = ti.ATR.calculate({ high, low, close, period: 14 });
    const atr    = _last(atrArr);

    return {
        last_close: _num(_last(close)),
        rsi_14:    _num(rsi14),
        ema_20:    _num(ema20),
        ema_50:    _num(ema50),
        bb:        { lower: _num(bb.lower), middle: _num(bb.middle), upper: _num(bb.upper) },
        atr_14:    _num(atr),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Support / resistance (pivot-based, simple)
   ───────────────────────────────────────────────────────────────── */
function computeSupportResistance(candles, lookback = 50) {
    if (!Array.isArray(candles) || candles.length < 10) return { supports: [], resistances: [] };
    const slice = candles.slice(-lookback);
    const supports = [];
    const resistances = [];
    for (let i = 2; i < slice.length - 2; i++) {
        const c = slice[i];
        const l2 = slice[i-2].low, l1 = slice[i-1].low, r1 = slice[i+1].low, r2 = slice[i+2].low;
        const h2 = slice[i-2].high, h1 = slice[i-1].high, rh1 = slice[i+1].high, rh2 = slice[i+2].high;
        if (c.low  < l2 && c.low  < l1 && c.low  < r1 && c.low  < r2)  supports.push(_num(c.low));
        if (c.high > h2 && c.high > h1 && c.high > rh1 && c.high > rh2) resistances.push(_num(c.high));
    }
    return {
        supports:    supports.slice(-3),
        resistances: resistances.slice(-3),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Candlestick patterns (boolean flags on the final 1–3 candles)
   ───────────────────────────────────────────────────────────────── */
function _bodySize(c) { return Math.abs(c.close - c.open); }
function _range(c)    { return c.high - c.low; }
function _upperWick(c){ return c.high - Math.max(c.open, c.close); }
function _lowerWick(c){ return Math.min(c.open, c.close) - c.low; }
function _isBull(c)   { return c.close > c.open; }
function _isBear(c)   { return c.close < c.open; }

function computeCandlePatterns(candles) {
    if (!Array.isArray(candles) || candles.length < 3) return {};
    const n = candles.length;
    const c  = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    const r  = _range(c) || 1e-9;
    const body = _bodySize(c);
    const uw = _upperWick(c);
    const lw = _lowerWick(c);

    const doji         = body / r < 0.1;
    const hammer       = lw > 2 * body && uw < body && _isBull(c);
    const shootingStar = uw > 2 * body && lw < body && _isBear(c);
    const bullEngulf   = _isBear(c1) && _isBull(c) && c.close > c1.open && c.open < c1.close;
    const bearEngulf   = _isBull(c1) && _isBear(c) && c.open > c1.close && c.close < c1.open;
    const morningStar  = _isBear(c2) && _bodySize(c1) / (_range(c1) || 1e-9) < 0.3 && _isBull(c) && c.close > (c2.open + c2.close) / 2;
    const eveningStar  = _isBull(c2) && _bodySize(c1) / (_range(c1) || 1e-9) < 0.3 && _isBear(c) && c.close < (c2.open + c2.close) / 2;

    const out = {};
    if (doji)         out.doji = true;
    if (hammer)       out.hammer = true;
    if (shootingStar) out.shooting_star = true;
    if (bullEngulf)   out.bullish_engulfing = true;
    if (bearEngulf)   out.bearish_engulfing = true;
    if (morningStar)  out.morning_star = true;
    if (eveningStar)  out.evening_star = true;
    return out;
}

module.exports = {
    computeIndicatorPack,
    computeSupportResistance,
    computeCandlePatterns,
};
