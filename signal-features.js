/* =====================================================================
   AURELIA — signal-features.js
   ─────────────────────────────────────────────────────────────────────
   Derived, interpretable features layered on top of the raw indicator
   pack produced by indicators.js. Sits BETWEEN indicators.js and
   payload-builder.js — reads the indicator pack + candle patterns +
   latest close, produces compact labels/zones/regimes the AI can
   reason over directly instead of re-deriving from raw numbers.

   Contract (per timeframe, per symbol):
     {
       slopes: {
         ema_20: { slope, slope_norm, label },
         ema_50: { slope, slope_norm, label },
         rsi_14: { slope, slope_norm, label },
         atr_14: { slope, slope_norm, label },
       },
       rsi_state: { zone, direction, label },
       bb_position: { zone, percentile },
       atr_regime: { label, atr_ratio },
       ema_cross: { label, above, gap_trend },
       signals: [ ... compact fired-condition strings ... ],
     }

   Design notes:
     • Slope is computed via least-squares linear regression over the
       trailing series (typically 12 points) — much more stable than
       first-vs-last and robust to a single noisy tail sample.
     • "flat" thresholds are relative to each series' own scale
       (standard deviation of the window) so RSI, EMA-on-price, and ATR
       all get sensible flat bands without hard-coded constants.
     • Signals array follows the same convention as
       computeCandlePatterns: only fired/true conditions are included,
       false ones are omitted to keep the payload lean.
     • This module is additive — indicators.js output is untouched.
   ===================================================================== */

'use strict';

function _num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(6)) : null; }
function _isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/* ─────────────────────────────────────────────────────────────────
   Extract the numeric-only tail of a series. The indicator pack
   front-pads with nulls during warmup — regression needs to skip
   those. Returns { ys, xs } where xs are 0..n-1 for the kept points.
   ───────────────────────────────────────────────────────────────── */
function _cleanSeries(series) {
    if (!Array.isArray(series)) return { ys: [], xs: [] };
    const ys = [];
    const xs = [];
    let idx = 0;
    for (const v of series) {
        if (_isNum(v)) { ys.push(v); xs.push(idx); }
        idx++;
    }
    return { ys, xs };
}

/* ─────────────────────────────────────────────────────────────────
   Least-squares linear regression slope for y over x.
   Returns null if fewer than 2 usable points.
   ───────────────────────────────────────────────────────────────── */
function _linRegSlope(xs, ys) {
    const n = ys.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        sx  += xs[i];
        sy  += ys[i];
        sxx += xs[i] * xs[i];
        sxy += xs[i] * ys[i];
    }
    const denom = n * sxx - sx * sx;
    if (!denom) return null;
    return (n * sxy - sx * sy) / denom;
}

/* ─────────────────────────────────────────────────────────────────
   Population standard deviation of a numeric array.
   ───────────────────────────────────────────────────────────────── */
function _stddev(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    let sum = 0;
    for (const v of ys) sum += v;
    const mean = sum / n;
    let acc = 0;
    for (const v of ys) acc += (v - mean) * (v - mean);
    return Math.sqrt(acc / n);
}

function _mean(ys) {
    if (!ys.length) return 0;
    let s = 0;
    for (const v of ys) s += v;
    return s / ys.length;
}

/* ─────────────────────────────────────────────────────────────────
   Slope pack for one series. Classifies the raw slope into
   rising / falling / flat using a threshold proportional to the
   series' own volatility (stddev / window length) — this gives each
   series (RSI 0-100, EMA on price, ATR on price-diff) its own
   sensible "flat" band without hard-coded magic numbers.
   ───────────────────────────────────────────────────────────────── */
function _slopePack(series) {
    const { ys, xs } = _cleanSeries(series);
    if (ys.length < 2) {
        return { slope: null, slope_norm: null, label: 'flat' };
    }
    const slope = _linRegSlope(xs, ys);
    if (slope === null) return { slope: null, slope_norm: null, label: 'flat' };

    const sd = _stddev(ys);
    // Flat threshold: slope must move the series by less than ~15% of
    // its own stddev per step to count as flat. Empirically stable
    // across RSI / EMA / ATR scales.
    const flatBand = (sd / Math.max(ys.length, 1)) * 0.15 || Math.abs(_mean(ys)) * 1e-5;
    // Normalise slope by stddev so different-scale series are comparable.
    const slopeNorm = sd > 0 ? slope / sd : 0;

    let label = 'flat';
    if (slope >  flatBand) label = 'rising';
    else if (slope < -flatBand) label = 'falling';

    return { slope: _num(slope), slope_norm: _num(slopeNorm), label };
}

/* ─────────────────────────────────────────────────────────────────
   RSI zone + direction combined label.
   ───────────────────────────────────────────────────────────────── */
function _rsiState(rsiSeries, rsiSlopeLabel) {
    const { ys } = _cleanSeries(rsiSeries);
    const last = ys.length ? ys[ys.length - 1] : null;
    if (!_isNum(last)) return { zone: null, direction: rsiSlopeLabel, label: null };

    let zone = 'neutral';
    if (last >= 70) zone = 'overbought';
    else if (last <= 30) zone = 'oversold';

    return {
        zone,
        direction: rsiSlopeLabel,
        label: `${zone}_${rsiSlopeLabel}`,
    };
}

/* ─────────────────────────────────────────────────────────────────
   Bollinger Band position for the latest close.
   percentile: 0 = at lower band, 1 = at upper band. Can go <0 or >1
   when price breaks the envelope. Zone label buckets it into human-
   readable regions.
   ───────────────────────────────────────────────────────────────── */
function _bbPosition(bb, lastClose) {
    if (!bb || !_isNum(lastClose)) return { zone: null, percentile: null };
    const lowerArr = _cleanSeries(bb.lower).ys;
    const upperArr = _cleanSeries(bb.upper).ys;
    const lower = lowerArr.length ? lowerArr[lowerArr.length - 1] : null;
    const upper = upperArr.length ? upperArr[upperArr.length - 1] : null;
    if (!_isNum(lower) || !_isNum(upper) || upper <= lower) {
        return { zone: null, percentile: null };
    }

    const pct = (lastClose - lower) / (upper - lower);

    let zone;
    if (pct < 0)         zone = 'outside_lower';
    else if (pct > 1)    zone = 'outside_upper';
    else if (pct < 1/3)  zone = 'lower_third';
    else if (pct < 2/3)  zone = 'middle_third';
    else                 zone = 'upper_third';

    return { zone, percentile: _num(pct) };
}

/* ─────────────────────────────────────────────────────────────────
   ATR / volatility regime: slope-derived label + ratio of latest ATR
   to the mean of its trailing window. Ratio > 1 = current volatility
   is above recent average (potential spike / breakout timing signal).
   ───────────────────────────────────────────────────────────────── */
function _atrRegime(atrSeries, atrSlopeLabel) {
    const { ys } = _cleanSeries(atrSeries);
    if (!ys.length) return { label: 'stable', atr_ratio: null };

    const last = ys[ys.length - 1];
    const avg  = _mean(ys);
    const ratio = avg > 0 ? last / avg : null;

    // Map slope label onto volatility vocabulary.
    let label = 'stable';
    if (atrSlopeLabel === 'rising')  label = 'expanding';
    else if (atrSlopeLabel === 'falling') label = 'contracting';

    return { label, atr_ratio: _num(ratio) };
}

/* ─────────────────────────────────────────────────────────────────
   EMA20 vs EMA50 cross state. Reports which is currently above and
   whether the absolute gap is widening or narrowing over the trailing
   window (regression slope on |ema20 - ema50|).
   ───────────────────────────────────────────────────────────────── */
function _emaCross(ema20Series, ema50Series) {
    const a = _cleanSeries(ema20Series).ys;
    const b = _cleanSeries(ema50Series).ys;
    const n = Math.min(a.length, b.length);
    if (n < 2) return { label: null, above: null, gap_trend: null };

    const a2 = a.slice(-n);
    const b2 = b.slice(-n);
    const lastA = a2[n - 1];
    const lastB = b2[n - 1];
    const above = lastA >= lastB ? '20' : '50';

    // Signed gap series (ema20 - ema50). Slope of the ABS gap tells us
    // widening vs narrowing regardless of which side is on top.
    const absGap = new Array(n);
    for (let i = 0; i < n; i++) absGap[i] = Math.abs(a2[i] - b2[i]);
    const xs = absGap.map((_, i) => i);
    const slope = _linRegSlope(xs, absGap);

    const sd = _stddev(absGap);
    const flatBand = (sd / Math.max(n, 1)) * 0.15 || Math.abs(_mean(absGap)) * 1e-5;

    let gapTrend = 'stable';
    if (slope !== null) {
        if (slope > flatBand)      gapTrend = 'widening';
        else if (slope < -flatBand) gapTrend = 'narrowing';
    }

    const label = above === '20'
        ? `20_above_50_${gapTrend}`
        : `50_above_20_${gapTrend}`;

    return { label, above, gap_trend: gapTrend };
}

/* ─────────────────────────────────────────────────────────────────
   Compact "signals" array — only fired/true conditions. Mirrors the
   omit-when-false convention used by computeCandlePatterns.
   ───────────────────────────────────────────────────────────────── */
function _buildSignalsArray({ slopes, rsiState, bbPos, atrRegime, emaCross, candlePatterns }) {
    const out = [];

    // EMA cross state — always meaningful when we have it.
    if (emaCross && emaCross.label) out.push(`ema${emaCross.above}_above_ema${emaCross.above === '20' ? '50' : '20'}_${emaCross.gap_trend}`);

    // EMA slope directions (only fire on non-flat).
    if (slopes.ema_20 && slopes.ema_20.label && slopes.ema_20.label !== 'flat') {
        out.push(`ema20_${slopes.ema_20.label}`);
    }
    if (slopes.ema_50 && slopes.ema_50.label && slopes.ema_50.label !== 'flat') {
        out.push(`ema50_${slopes.ema_50.label}`);
    }

    // RSI zone + direction combo — only fire when in an extreme zone
    // OR when direction is not flat, to avoid noise like "neutral_flat".
    if (rsiState && rsiState.zone) {
        if (rsiState.zone === 'overbought' || rsiState.zone === 'oversold') {
            out.push(`rsi_${rsiState.label}`);
        } else if (rsiState.direction && rsiState.direction !== 'flat') {
            out.push(`rsi_${rsiState.label}`);
        }
    }

    // Bollinger position — always report the zone if we have one; each
    // zone is a distinct, actionable state (upper_third != middle_third).
    if (bbPos && bbPos.zone) {
        out.push(`price_${bbPos.zone}_bb`);
    }

    // ATR regime — only fire on expansion/contraction (stable is the
    // uninteresting default).
    if (atrRegime && atrRegime.label && atrRegime.label !== 'stable') {
        out.push(`atr_${atrRegime.label}`);
    }
    // Volatility spike flag — configurable threshold, 1.5x recent avg.
    if (atrRegime && _isNum(atrRegime.atr_ratio) && atrRegime.atr_ratio >= 1.5) {
        out.push('atr_spike');
    }

    // Candle patterns — pass through the flags already computed by
    // computeCandlePatterns (keys are pattern names, values are true).
    if (candlePatterns && typeof candlePatterns === 'object') {
        for (const [k, v] of Object.entries(candlePatterns)) {
            if (v === true) out.push(k);
        }
    }

    return out;
}

/* ─────────────────────────────────────────────────────────────────
   Main entry — derive the full feature block for one timeframe.
   Accepts the indicator pack (as produced by computeIndicatorPack)
   and the candle patterns object (as produced by
   computeCandlePatterns). Returns null-safe defaults when the
   indicator pack is in its error/warmup state.
   ───────────────────────────────────────────────────────────────── */
function computeDerivedSignals(indicatorPack, candlePatterns) {
    if (!indicatorPack || indicatorPack.error) {
        return {
            slopes: {},
            rsi_state: { zone: null, direction: null, label: null },
            bb_position: { zone: null, percentile: null },
            atr_regime: { label: 'stable', atr_ratio: null },
            ema_cross: { label: null, above: null, gap_trend: null },
            signals: [],
        };
    }

    const slopes = {
        ema_20: _slopePack(indicatorPack.ema_20),
        ema_50: _slopePack(indicatorPack.ema_50),
        rsi_14: _slopePack(indicatorPack.rsi_14),
        atr_14: _slopePack(indicatorPack.atr_14),
    };

    const rsiState  = _rsiState(indicatorPack.rsi_14, slopes.rsi_14.label);
    const bbPos     = _bbPosition(indicatorPack.bb, indicatorPack.last_close);
    const atrRegime = _atrRegime(indicatorPack.atr_14, slopes.atr_14.label);
    const emaCross  = _emaCross(indicatorPack.ema_20, indicatorPack.ema_50);

    const signals = _buildSignalsArray({
        slopes,
        rsiState,
        bbPos,
        atrRegime,
        emaCross,
        candlePatterns,
    });

    return {
        slopes,
        rsi_state: rsiState,
        bb_position: bbPos,
        atr_regime: atrRegime,
        ema_cross: emaCross,
        signals,
    };
}

module.exports = {
    computeDerivedSignals,
};
