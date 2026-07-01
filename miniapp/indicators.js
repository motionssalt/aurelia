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

    /* ------------------------------------------------------------
       MACD — Moving Average Convergence Divergence.
       Returns { macd, signal, histogram } arrays aligned to input.
       macd    = EMA(fast) - EMA(slow)
       signal  = EMA(signalPeriod) of the macd line
       histogram = macd - signal
       ------------------------------------------------------------ */
    function macd(closes, fast, slow, signalPeriod) {
        fast = fast || 12; slow = slow || 26; signalPeriod = signalPeriod || 9;
        const emaFast = ema(closes, fast);
        const emaSlow = ema(closes, slow);
        const macdLine = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (emaFast[i] != null && emaSlow[i] != null) {
                macdLine[i] = emaFast[i] - emaSlow[i];
            }
        }
        // EMA of the macd line, but only over its defined (non-null) span.
        const firstIdx = macdLine.findIndex(v => v != null);
        const signal = new Array(closes.length).fill(null);
        if (firstIdx !== -1) {
            const dense = macdLine.slice(firstIdx).map(v => (v == null ? 0 : v));
            const sig = ema(dense, signalPeriod);
            for (let i = 0; i < sig.length; i++) {
                if (sig[i] != null) signal[firstIdx + i] = sig[i];
            }
        }
        const histogram = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (macdLine[i] != null && signal[i] != null) {
                histogram[i] = macdLine[i] - signal[i];
            }
        }
        return { macd: macdLine, signal, histogram };
    }

    /* ------------------------------------------------------------
       Stochastic Oscillator.
       %K = 100 * (close - lowestLow) / (highestHigh - lowestLow)
            over `kPeriod`, then smoothed by `smoothK` (SMA).
       %D = SMA(%K, dPeriod).
       Returns { k, d } arrays (0-100 | null).
       ------------------------------------------------------------ */
    function stochastic(candles, kPeriod, dPeriod, smoothK) {
        kPeriod = kPeriod || 14; dPeriod = dPeriod || 3; smoothK = smoothK || 3;
        const n = candles.length;
        const rawK = new Array(n).fill(null);
        for (let i = kPeriod - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - kPeriod + 1; j <= i; j++) {
                if (candles[j].high > hh) hh = candles[j].high;
                if (candles[j].low  < ll) ll = candles[j].low;
            }
            const range = hh - ll;
            rawK[i] = range === 0 ? 100 : (100 * (candles[i].close - ll) / range);
        }
        // Smooth over the DEFINED span only (avoids NaN propagation through
        // the rolling-sum SMA during the warm-up period).
        const k = smoothOverDefined(rawK, smoothK);
        const d = smoothOverDefined(k, dPeriod);
        return { k, d };
    }

    /* Apply an SMA of `period` over the contiguous non-null tail of `arr`,
       returning a full-length array with nulls preserved in the warm-up. */
    function smoothOverDefined(arr, period) {
        const n = arr.length;
        const out = new Array(n).fill(null);
        const first = arr.findIndex(v => v != null && Number.isFinite(v));
        if (first === -1) return out;
        const dense = arr.slice(first).map(v => (v == null ? 0 : v));
        const sm = sma(dense, period);
        for (let i = 0; i < sm.length; i++) {
            if (sm[i] != null && Number.isFinite(sm[i])) out[first + i] = sm[i];
        }
        return out;
    }

    /* ------------------------------------------------------------
       ADX — Average Directional Index, with +DI and -DI.
       Uses Wilder's smoothing. Returns { adx, plusDI, minusDI }.
       ------------------------------------------------------------ */
    function adx(candles, period) {
        period = period || 14;
        const n = candles.length;
        const adxArr = new Array(n).fill(null);
        const plusDI = new Array(n).fill(null);
        const minusDI = new Array(n).fill(null);
        if (n < period * 2) return { adx: adxArr, plusDI, minusDI };

        const tr = new Array(n).fill(0);
        const plusDM = new Array(n).fill(0);
        const minusDM = new Array(n).fill(0);
        for (let i = 1; i < n; i++) {
            const up   = candles[i].high - candles[i - 1].high;
            const down = candles[i - 1].low - candles[i].low;
            plusDM[i]  = (up > down && up > 0) ? up : 0;
            minusDM[i] = (down > up && down > 0) ? down : 0;
            const pc = candles[i - 1].close;
            tr[i] = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - pc),
                Math.abs(candles[i].low - pc)
            );
        }
        // Wilder smoothing seeds (sum of first `period` TR/DM, indices 1..period).
        let trS = 0, pS = 0, mS = 0;
        for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
        const dx = new Array(n).fill(null);
        function computeDX(idx) {
            const pDI = trS === 0 ? 0 : 100 * (pS / trS);
            const mDI = trS === 0 ? 0 : 100 * (mS / trS);
            plusDI[idx] = pDI;
            minusDI[idx] = mDI;
            const sum = pDI + mDI;
            dx[idx] = sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum;
        }
        computeDX(period);
        for (let i = period + 1; i < n; i++) {
            trS = trS - trS / period + tr[i];
            pS  = pS  - pS  / period + plusDM[i];
            mS  = mS  - mS  / period + minusDM[i];
            computeDX(i);
        }
        // ADX = Wilder-smoothed average of DX. First ADX at index period*2-1.
        const firstAdxIdx = period * 2 - 1;
        if (firstAdxIdx < n) {
            let sum = 0;
            for (let i = period; i <= firstAdxIdx; i++) sum += dx[i];
            let prev = sum / period;
            adxArr[firstAdxIdx] = prev;
            for (let i = firstAdxIdx + 1; i < n; i++) {
                prev = (prev * (period - 1) + dx[i]) / period;
                adxArr[i] = prev;
            }
        }
        return { adx: adxArr, plusDI, minusDI };
    }

    /* ------------------------------------------------------------
       Donchian Channels. Highest high / lowest low over `period`.
       Returns { upper, middle, lower }.
       ------------------------------------------------------------ */
    function donchian(candles, period) {
        period = period || 20;
        const n = candles.length;
        const upper = new Array(n).fill(null);
        const lower = new Array(n).fill(null);
        const middle = new Array(n).fill(null);
        for (let i = period - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - period + 1; j <= i; j++) {
                if (candles[j].high > hh) hh = candles[j].high;
                if (candles[j].low  < ll) ll = candles[j].low;
            }
            upper[i] = hh; lower[i] = ll; middle[i] = (hh + ll) / 2;
        }
        return { upper, middle, lower };
    }

    /* ------------------------------------------------------------
       Williams %R.  -100 * (highestHigh - close) / (highestHigh - lowestLow)
       Range: -100 (oversold) .. 0 (overbought). Returns (number|null)[].
       ------------------------------------------------------------ */
    function williamsR(candles, period) {
        period = period || 14;
        const n = candles.length;
        const out = new Array(n).fill(null);
        for (let i = period - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - period + 1; j <= i; j++) {
                if (candles[j].high > hh) hh = candles[j].high;
                if (candles[j].low  < ll) ll = candles[j].low;
            }
            const range = hh - ll;
            out[i] = range === 0 ? 0 : (-100 * (hh - candles[i].close) / range);
        }
        return out;
    }

    /* ------------------------------------------------------------
       CCI — Commodity Channel Index.
       typical = (high + low + close) / 3
       CCI = (typical - SMA(typical)) / (0.015 * meanDeviation)
       Returns (number|null)[].
       ------------------------------------------------------------ */
    function cci(candles, period) {
        period = period || 20;
        const n = candles.length;
        const tp = candles.map(c => (c.high + c.low + c.close) / 3);
        const out = new Array(n).fill(null);
        for (let i = period - 1; i < n; i++) {
            let mean = 0;
            for (let j = i - period + 1; j <= i; j++) mean += tp[j];
            mean /= period;
            let md = 0;
            for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - mean);
            md /= period;
            out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
        }
        return out;
    }

    /* ------------------------------------------------------------
       Parabolic SAR (overlay). Standard Wilder algorithm.
       step = acceleration increment, max = acceleration cap.
       Returns (number|null)[] aligned to candles.
       ------------------------------------------------------------ */
    function parabolicSar(candles, step, max) {
        step = step || 0.02; max = max || 0.2;
        const n = candles.length;
        const out = new Array(n).fill(null);
        if (n < 2) return out;
        let uptrend = candles[1].close >= candles[0].close;
        let af = step;
        let ep = uptrend ? candles[0].high : candles[0].low;
        let sar = uptrend ? candles[0].low : candles[0].high;
        out[0] = sar;
        for (let i = 1; i < n; i++) {
            sar = sar + af * (ep - sar);
            if (uptrend) {
                // SAR can't be above the prior two lows.
                sar = Math.min(sar, candles[i - 1].low, i >= 2 ? candles[i - 2].low : candles[i - 1].low);
                if (candles[i].high > ep) { ep = candles[i].high; af = Math.min(af + step, max); }
                if (candles[i].low < sar) {
                    // Flip to downtrend.
                    uptrend = false; sar = ep; ep = candles[i].low; af = step;
                }
            } else {
                sar = Math.max(sar, candles[i - 1].high, i >= 2 ? candles[i - 2].high : candles[i - 1].high);
                if (candles[i].low < ep) { ep = candles[i].low; af = Math.min(af + step, max); }
                if (candles[i].high > sar) {
                    uptrend = true; sar = ep; ep = candles[i].high; af = step;
                }
            }
            out[i] = sar;
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

    /* Helper: map an aligned array to histogram data [{time, value, color}]
       for lightweight-charts histogram series (used by MACD histogram). */
    function toHistData(candles, arr, upColor, downColor) {
        const data = [];
        for (let i = 0; i < candles.length; i++) {
            if (arr[i] != null && Number.isFinite(arr[i])) {
                data.push({
                    time: candles[i].time,
                    value: arr[i],
                    color: arr[i] >= 0 ? upColor : downColor,
                });
            }
        }
        return data;
    }

    root.Indicators = {
        sma, ema, rollingStd, bollinger,
        trueRange, atr, keltner, rsi,
        macd, stochastic, adx, donchian, williamsR, cci, parabolicSar,
        toLineData, toHistData,
    };
})(window);
