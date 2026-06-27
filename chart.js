/* =====================================================================
   AURELIA — chart.js
   ─────────────────────────────────────────────────────────────────────
   Generates a candlestick chart screenshot using Puppeteer + Chart.js
   (CDN, no TradingView). Returns a PNG Buffer ready for Telegram.

   v2 indicator overlay:
     • EMA 9  + EMA 21 over the candlestick price panel
     • RSI(14) sub-panel
     • MACD(12,26,9) sub-panel (macd line, signal line, histogram bars)
     • NO trade markers — chart is purely informational

   Series are computed in Node using the `technicalindicators` package
   (already a dependency via indicators.js) so the browser-side render
   only deals with arrays of {x, y}. No new npm dependencies.

   Public surface:
     generateChart(ws, symbol, tf, opts?) → Buffer (PNG)

   tf values: '1m' | '5m' | '15m' | '30m' | '1h'
   ===================================================================== */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const ti        = require('technicalindicators');
const Deriv     = require('./deriv');
const Logger    = require('./logger');

function ensureChromium() {
    try {
        puppeteer.executablePath();
        return;
    } catch (e) {
        Logger.info('[chart] no cached Chromium found - installing now (first chart request)');
        execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    }
}

/* Map human tf string → Deriv granularity in seconds + candle count */
const TF_MAP = {
    '1m':  { gran: 60,   count: 120 },
    '5m':  { gran: 300,  count: 120 },
    '15m': { gran: 900,  count: 100 },
    '30m': { gran: 1800, count: 100 },
    '1h':  { gran: 3600, count: 80  },
};

/* ─────────────────────────────────────────────────────────────────
   Indicator series — computed in Node, then serialised into the page.
   technicalindicators returns arrays shorter than the input (warmup
   period skipped); we right-align them onto candle timestamps.
   ───────────────────────────────────────────────────────────────── */
function _alignSeries(timestamps, values) {
    // values is shorter than timestamps by (warmup - 1). Right-align.
    const pad = timestamps.length - values.length;
    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
        const v = (i < pad) ? null : values[i - pad];
        out.push({ x: timestamps[i], y: (v == null || !Number.isFinite(v)) ? null : Number(v) });
    }
    return out;
}

function computeOverlays(candles) {
    const ts    = candles.map(c => c.epoch * 1000);
    const close = candles.map(c => c.close);

    const ema9  = ti.EMA.calculate({ values: close, period: 9 });
    const ema21 = ti.EMA.calculate({ values: close, period: 21 });

    const rsi14 = ti.RSI.calculate({ values: close, period: 14 });

    const macdArr = ti.MACD.calculate({
        values: close,
        fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const macdLine    = macdArr.map(m => (m && Number.isFinite(m.MACD))      ? m.MACD      : null);
    const signalLine  = macdArr.map(m => (m && Number.isFinite(m.signal))    ? m.signal    : null);
    const histogram   = macdArr.map(m => (m && Number.isFinite(m.histogram)) ? m.histogram : null);

    return {
        ema9:      _alignSeries(ts, ema9),
        ema21:     _alignSeries(ts, ema21),
        rsi14:     _alignSeries(ts, rsi14),
        macdLine:  _alignSeries(ts, macdLine),
        signal:    _alignSeries(ts, signalLine),
        histogram: _alignSeries(ts, histogram),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Build self-contained HTML with Chart.js CDN candlestick chart +
   line overlays + two sub-panels (RSI, MACD).
   ───────────────────────────────────────────────────────────────── */
function buildHtml(candles, symbol, tf, overlays) {
    /* Convert candles → chartjs-chart-financial OHLC objects */
    const data = candles.map(c => ({
        x: c.epoch * 1000,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
    }));

    /* Price range for Y axis padding */
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const yMin   = (Math.min(...lows)  * 0.9995).toFixed(5);
    const yMax   = (Math.max(...highs) * 1.0005).toFixed(5);

    const lastPrice  = candles[candles.length - 1].close.toFixed(5);
    const firstPrice = candles[0].open;
    const change     = candles[candles.length - 1].close - firstPrice;
    const changePct  = ((change / firstPrice) * 100).toFixed(2);
    const changeStr  = `${change >= 0 ? '+' : ''}${change.toFixed(5)} (${changePct}%)`;
    const headerColor = change >= 0 ? '#26d07c' : '#ff4d6b';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0d0d10;
    font-family: 'Segoe UI', system-ui, sans-serif;
    width: 900px;
    height: 760px;
    overflow: hidden;
  }
  #header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 14px 24px 6px;
  }
  #symbol { font-size: 18px; font-weight: 700; color: #f0f0f5; letter-spacing: 0.5px; }
  #tf-badge {
    font-size: 11px; font-weight: 600; color: #888;
    background: #1a1a22; border-radius: 4px; padding: 2px 7px;
    letter-spacing: 1px; text-transform: uppercase;
  }
  #price  { font-size: 22px; font-weight: 700; color: #f0f0f5; margin-left: auto; }
  #change { font-size: 13px; font-weight: 600; color: ${headerColor}; }
  #watermark {
    position: absolute; bottom: 8px; right: 20px;
    font-size: 11px; color: #2a2a35; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
  }
  .panel { padding: 0 12px; }
  .panel.price { height: 420px; }
  .panel.rsi   { height: 130px; padding-top: 4px; }
  .panel.macd  { height: 150px; padding-top: 4px; padding-bottom: 10px; }
  .panel-label {
    font-size: 10px; color: #888; font-weight: 600;
    letter-spacing: 1px; text-transform: uppercase;
    padding-left: 14px;
  }
  canvas { display: block; }
</style>
</head>
<body>
<div id="header">
  <span id="symbol">${symbol}</span>
  <span id="tf-badge">${tf}</span>
  <span id="price">${lastPrice}</span>
  <span id="change">${changeStr}</span>
</div>

<div class="panel price">
  <canvas id="chartPrice"></canvas>
</div>
<div class="panel-label">RSI (14)</div>
<div class="panel rsi">
  <canvas id="chartRsi"></canvas>
</div>
<div class="panel-label">MACD (12, 26, 9)</div>
<div class="panel macd">
  <canvas id="chartMacd"></canvas>
</div>

<div id="watermark">AURELIA</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.1.1/dist/chartjs-chart-financial.min.js"></script>
<script>
const data      = ${JSON.stringify(data)};
const ema9      = ${JSON.stringify(overlays.ema9)};
const ema21     = ${JSON.stringify(overlays.ema21)};
const rsi14     = ${JSON.stringify(overlays.rsi14)};
const macdLine  = ${JSON.stringify(overlays.macdLine)};
const signal    = ${JSON.stringify(overlays.signal)};
const histogram = ${JSON.stringify(overlays.histogram)};

function sizeCanvas(id) {
  const el = document.getElementById(id);
  const w  = el.parentElement.clientWidth;
  const h  = el.parentElement.clientHeight;
  el.width = w; el.height = h;
  return el.getContext('2d');
}

const axisGrid   = { color: '#1a1a22', drawBorder: false };
const axisTicks  = { color: '#555', maxTicksLimit: 8, font: { size: 10 } };
const xAxis = {
  type: 'timeseries',
  time: { unit: 'minute' },
  grid: axisGrid,
  ticks: { ...axisTicks, maxTicksLimit: 8 },
  border: { color: '#1a1a22' },
};

/* ── Price panel: candles + EMA9 + EMA21 ───────────────────────── */
new Chart(sizeCanvas('chartPrice'), {
  data: {
    datasets: [
      {
        type: 'candlestick',
        label: '${symbol}',
        data,
        color: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
        borderColor: { up: '#26d07c', down: '#ff4d6b', unchanged: '#888888' },
      },
      {
        type: 'line', label: 'EMA 9', data: ema9,
        borderColor: '#f5a524', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'EMA 21', data: ema21,
        borderColor: '#6aa9ff', borderWidth: 1.4,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: {
      legend: {
        display: true, position: 'top', align: 'start',
        labels: { color: '#888', font: { size: 10 }, boxWidth: 14, padding: 6,
          filter: (it) => it.text !== '${symbol}' },
      },
      tooltip: { enabled: false },
    },
    scales: {
      x: xAxis,
      y: {
        position: 'right',
        min: ${yMin}, max: ${yMax},
        grid: axisGrid,
        ticks: { ...axisTicks, maxTicksLimit: 6, callback: v => v.toFixed(5) },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── RSI panel ─────────────────────────────────────────────────── */
new Chart(sizeCanvas('chartRsi'), {
  type: 'line',
  data: {
    datasets: [{
      label: 'RSI 14', data: rsi14,
      borderColor: '#c084fc', borderWidth: 1.4,
      pointRadius: 0, tension: 0.15, spanGaps: true,
    }],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { ...xAxis, ticks: { ...axisTicks, display: false }, grid: axisGrid },
      y: {
        position: 'right', min: 0, max: 100,
        grid: { color: (ctx) => {
          const v = ctx.tick && ctx.tick.value;
          if (v === 30 || v === 70) return '#3a3a4a';
          return '#1a1a22';
        }, drawBorder: false },
        ticks: { ...axisTicks, stepSize: 30, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});

/* ── MACD panel (line + signal + histogram bars) ──────────────── */
new Chart(sizeCanvas('chartMacd'), {
  data: {
    datasets: [
      {
        type: 'bar', label: 'Histogram', data: histogram,
        backgroundColor: (ctx) => {
          const v = ctx.raw && ctx.raw.y;
          if (v == null) return 'rgba(0,0,0,0)';
          return v >= 0 ? 'rgba(38,208,124,0.55)' : 'rgba(255,77,107,0.55)';
        },
        borderWidth: 0, barPercentage: 0.9, categoryPercentage: 1.0,
      },
      {
        type: 'line', label: 'MACD', data: macdLine,
        borderColor: '#f0f0f5', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
      {
        type: 'line', label: 'Signal', data: signal,
        borderColor: '#f5a524', borderWidth: 1.3,
        pointRadius: 0, tension: 0.15, spanGaps: true,
      },
    ],
  },
  options: {
    responsive: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { ...xAxis, type: 'timeseries', offset: false },
      y: {
        position: 'right',
        grid: { color: (ctx) => ctx.tick && ctx.tick.value === 0 ? '#3a3a4a' : '#1a1a22', drawBorder: false },
        ticks: { ...axisTicks, maxTicksLimit: 4 },
        border: { color: '#1a1a22' },
      },
    },
  },
});
</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────
   Main export
   ───────────────────────────────────────────────────────────────── */
async function generateChart(ws, symbol, tf = '1m') {
    const tfCfg = TF_MAP[tf] || TF_MAP['1m'];
    Logger.info(`[chart] fetching ${tfCfg.count} candles for ${symbol} @ ${tf}`);

    const candles = await Deriv.ticksHistory(ws, symbol, tfCfg.gran, tfCfg.count);
    if (!candles || candles.length < 5) {
        throw new Error(`Not enough candle data for ${symbol} (got ${candles ? candles.length : 0})`);
    }

    const overlays = computeOverlays(candles);
    const html = buildHtml(candles, symbol, tf, overlays);

    ensureChromium();

    Logger.info('[chart] launching Puppeteer');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });

        /* Give Chart.js a tick to finish rendering */
        await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        Logger.info('[chart] screenshot captured');
        return buffer;
    } finally {
        await browser.close();
    }
}

module.exports = { generateChart, TF_MAP, computeOverlays };
