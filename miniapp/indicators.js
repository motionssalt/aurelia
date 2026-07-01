/* ============================================================
   AURELIA — indicators.js
   Self-contained, dependency-free technical-indicator math.
   All functions take arrays of numbers (or candle objects) and
   return arrays aligned to the input length. Positions where the
   indicator is not yet defined (warm-up period) are returned as
   `null` so callers can skip them when building chart series.

   Exposed on window.Indicators.
   ============================================================ */
(function (root) {
    'use strict';

    /* Simple Moving Average.
       values: number[]  period: int  -> (number|null)[] */
    function sma(values, period) {
        const out = new Array(values.length).fill(null);
        if (period <= 0) return out;
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i];
            if (i >= period) sum -= values[i - period];
            if (i >= period - 1) out[i] = sum / period;
        }
        return out;
    }

    /* Exponential Moving Average.
       Seeded with the SMA of the first `period` values (standard TA-Lib style). */
    function ema(values, period) {
        const out = new Array(values.length).fill(null);
        if (period <= 0 || values.length < period) return out;
        const k = 2 / (period + 1);
        // seed = SMA of first `period`
        let seed = 0;
        for (let i = 0; i < period; i++) seed += values[i];
        seed /= period;
        out[period - 1] = seed;
        let prev = seed;
        for (let i = period; i < values.length; i++) {
            prev = values[i] * k + prev * (1 - k);
            out[i] = prev;
        }
        return out;
    }

    /* Standard deviation (population) over a rolling window, aligned to input. */
    function rollingStd(values, period) {
        const out = new Array(values.length).fill(null);
        if (period <= 0) return out;
        for (let i = period - 1; i < values.length; i++) {
            let mean = 0;
            for (let j = i - period + 1; j <= i; j++) mean += values[j];
            mean /= period;
            let variance = 0;
            for (let j = i - period + 1; j <= i; j++) {
                const d = values[j] - mean;
                variance += d * d;
            }
            out[i] = Math.sqrt(variance / period);
        }
        return out;
    }

    /* Bollinger Bands. Returns { upper, middle, lower } arrays. */
    function bollinger(closes, period, mult) {
        const middle = sma(closes, period);
        const std = rollingStd(closes, period);
        const upper = new Array(closes.length).fill(null);
        const lower = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (middle[i] != null && std[i] != null) {
                upper[i] = middle[i] + mult * std[i];
                lower[i] = middle[i] - mult * std[i];
            }
        }
        return { upper, middle, lower };
    }

    /* True Range series from candles [{high,low,close}]. */
    function trueRange(candles) {
        const out = new Array(candles.length).fill(null);
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (i === 0) { out[i] = c.high - c.low; continue; }
            const pc = candles[i - 1].close;
            out[i] = Math.max(
                c.high - c.low,
                Math.abs(c.high - pc),
                Math.abs(c.low - pc)
            );
        }
        return out;
    }

    /* Average True Range using Wilder's smoothing. */
    function atr(candles, period) {
        const tr = trueRange(candles);
        const out = new Array(candles.length).fill(null);
        if (candles.length < period || period <= 0) return out;
        // First ATR = simple average of first `period` TR values.
        let sum = 0;
        for (let i = 0; i < period; i++) sum += tr[i];
        let prev = sum / period;
        out[period - 1] = prev;
        for (let i = period; i < candles.length; i++) {
            prev = (prev * (period - 1) + tr[i]) / period;
            out[i] = prev;
        }
        return out;
    }

    /* Keltner Channel: middle = EMA(close), band = middle ± mult * ATR. */
    function keltner(candles, emaPeriod, atrPeriod, mult) {
        const closes = candles.map(c => c.close);
        const mid = ema(closes, emaPeriod);
        const a = atr(candles, atrPeriod);
        const upper = new Array(candles.length).fill(null);
        const lower = new Array(candles.length).fill(null);
        for (let i = 0; i < candles.length; i++) {
            if (mid[i] != null && a[i] != null) {
                upper[i] = mid[i] + mult * a[i];
                lower[i] = mid[i] - mult * a[i];
            }
        }
        return { upper, middle: mid, lower };
    }

    /* RSI using Wilder's smoothing. Returns (0-100 | null)[]. */
    function rsi(closes, period) {
        const out = new Array(closes.length).fill(null);
        if (closes.length <= period || period <= 0) return out;
        let gain = 0, loss = 0;
        for (let i = 1; i <= period; i++) {
            const ch = closes[i] - closes[i - 1];
            if (ch >= 0) gain += ch; else loss -= ch;
        }
        let avgGain = gain / period;
        let avgLoss = loss / period;
        out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        for (let i = period + 1; i < closes.length; i++) {
            const ch = closes[i] - closes[i - 1];
            const g = ch > 0 ? ch : 0;
            const l = ch < 0 ? -ch : 0;
            avgGain = (avgGain * (period - 1) + g) / period;
            avgLoss = (avgLoss * (period - 1) + l) / period;
            out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
        return out;
    }

    /* Helper: map an aligned indicator array to lightweight-charts
       line data [{time, value}], skipping null warm-up points. */
    function toLineData(candles, arr) {
        const data = [];
        for (let i = 0; i < candles.length; i++) {
            if (arr[i] != null && Number.isFinite(arr[i])) {
                data.push({ time: candles[i].time, value: arr[i] });
            }
        }
        return data;
    }

    root.Indicators = {
        sma, ema, rollingStd, bollinger,
        trueRange, atr, keltner, rsi, toLineData,
    };
})(window);
