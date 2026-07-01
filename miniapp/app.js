/* ============================================================
   AURELIA Mini App — vanilla JS.
   No build step, no bundler; ships as a plain static file.

   Depends on globals injected by <script> tags:
     • Telegram.WebApp                    (telegram-web-app.js)
     • LightweightCharts                  (lightweight-charts UMD)
     • Indicators                         (indicators.js)

   Config:
     • window.AURELIA_API_BASE  can be set before this script loads to
       point at the Cloudflare Worker. If unset we use relative URLs.
   ============================================================ */

'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
const API_BASE = (window.AURELIA_API_BASE || '').replace(/\/+$/, '');
const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const LS_KEY = 'aurelia.indicators.v1';

// initData source of truth — set once at boot.
let INIT_DATA = '';
try { INIT_DATA = (tg && tg.initData) || ''; } catch (_) {}

/* ── Shared colour tokens (mirror CSS variables) ──────────── */
const COLORS = {
    bull: '#26c281',
    bear: '#ff5470',
    accent: '#5aa9ff',
    ema: ['#ffb020', '#8b7bff', '#00c2d1', '#ff7ac6'],
    sma: ['#6ec1ff', '#f6c945', '#a0e57c', '#ff9a6c'],
    bb: '#c7a3ff',
    kc: '#ffcf6b',
    rsi: '#5aa9ff',
    atr: '#ffb020',
};

/* ── Telegram SDK bootstrap ───────────────────────────────── */
function applyTheme() {
    if (!tg || !tg.themeParams) return;
    const t = tg.themeParams;
    const set = (v, val) => { if (val) document.documentElement.style.setProperty(v, val); };
    set('--tg-bg',          t.bg_color);
    set('--tg-text',        t.text_color);
    set('--tg-hint',        t.hint_color);
    set('--tg-link',        t.link_color);
    set('--tg-button',      t.button_color);
    set('--tg-button-text', t.button_text_color);
    set('--tg-secondary',   t.secondary_bg_color);
    set('--tg-header',      t.header_bg_color || t.secondary_bg_color);
    set('--tg-section',     t.section_bg_color);
    set('--tg-accent',      t.accent_text_color);
    set('--tg-destructive', t.destructive_text_color);
    // Re-tint chart to match new theme without a rebuild.
    retintChart();
}
if (tg) {
    try { tg.ready(); tg.expand(); } catch (_) {}
    // NOTE: the first applyTheme() is invoked from boot() (after `state`
    // is initialized) to avoid a temporal-dead-zone reference via
    // retintChart(). We only register the live theme listener here.
    tg.onEvent && tg.onEvent('themeChanged', applyTheme);
}

/* ── Toast helper ─────────────────────────────────────────── */
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, kind) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + (kind || '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.add('hidden'); }, 2600);
}

/* ── API client ───────────────────────────────────────────── */
async function api(path, opts = {}) {
    const headers = Object.assign({
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': INIT_DATA || '',
    }, opts.headers || {});
    const r = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.status = r.status;
        err.body = data;
        throw err;
    }
    return data;
}

/* ── Indicator config (persisted to localStorage) ─────────── */
function defaultIndicatorConfig() {
    return {
        emas: [{ period: 20, on: true }, { period: 50, on: true }],
        smas: [],
        bb:  { on: false, period: 20, mult: 2 },
        kc:  { on: false, period: 20, atr: 10, mult: 1.5 },
        rsi: { on: false, period: 14 },
        atr: { on: false, period: 14 },
    };
}
function loadIndicatorConfig() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return defaultIndicatorConfig();
        const parsed = JSON.parse(raw);
        // Merge with defaults so newly-added fields don't break older saves.
        const def = defaultIndicatorConfig();
        return {
            emas: Array.isArray(parsed.emas) ? parsed.emas : def.emas,
            smas: Array.isArray(parsed.smas) ? parsed.smas : def.smas,
            bb:  Object.assign(def.bb,  parsed.bb  || {}),
            kc:  Object.assign(def.kc,  parsed.kc  || {}),
            rsi: Object.assign(def.rsi, parsed.rsi || {}),
            atr: Object.assign(def.atr, parsed.atr || {}),
        };
    } catch (_) { return defaultIndicatorConfig(); }
}
function saveIndicatorConfig() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.ind)); } catch (_) {}
}

/* ── Global state cache ───────────────────────────────────── */
const state = {
    config: null,
    catalog: null,
    timeframes: ['1m', '5m', '15m', '30m', '1h'],
    status: null,
    activeTrades: [],
    historyOffset: 0,
    historyLimit: 20,
    historyTotal: 0,
    chart: null,
    series: null,
    rsiChart: null,
    rsiSeries: null,
    atrChart: null,
    atrSeries: null,
    ws: null,
    wsPingTimer: null,
    subscriptionId: null,
    currentSymbol: null,
    currentTfSec: 300,
    candles: [], // { time, open, high, low, close }
    priceLine: null,
    priceLineSeries: null, // series the price line is actually attached to
    overlayTimer: null,
    ind: loadIndicatorConfig(),
    // Map of overlay line series currently on the main chart:
    //   key -> LineSeries
    overlaySeries: {},
    syncing: false,
};

/* ── Tab switching ────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        const t = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === btn));
        document.querySelectorAll('.tab-body').forEach(x => x.classList.toggle('active', x.id === 'tab-' + t));
        if (t === 'trades') refreshTrades();
        if (t === 'settings') renderSettings();
        if (t === 'chart') {
            queueOverlayRefresh();
            // The chart may have been laid out at 0px while hidden; re-fit now.
            requestAnimationFrame(fitCharts);
        }
    });
});

/* ============================================================
   TIMEFRAME UTILITIES
   ============================================================ */
function tfToSeconds(tf) {
    const m = /^(\d+)([smhd])$/.exec(String(tf));
    if (!m) return 300;
    const n = Number(m[1]); const u = m[2];
    return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[u] || 60);
}

/* ============================================================
   DERIV WS — direct browser subscription
   ============================================================ */
function derivConnect() {
    if (state.ws) { try { state.ws.close(); } catch (_) {} }
    if (state.wsPingTimer) { clearInterval(state.wsPingTimer); state.wsPingTimer = null; }
    setChartStatus('connecting', '');
    const ws = new WebSocket(DERIV_WS);
    state.ws = ws;
    ws.addEventListener('open', () => {
        setChartStatus('live', 'ok');
        subscribeCandles();
        state.wsPingTimer = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ ping: 1 }));
        }, 30000);
    });
    ws.addEventListener('message', ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        handleDerivMessage(msg);
    });
    ws.addEventListener('close', () => setChartStatus('closed', 'err'));
    ws.addEventListener('error', () => setChartStatus('ws error', 'err'));
}

function subscribeCandles() {
    if (!state.ws || state.ws.readyState !== 1) return;
    const symbol = state.currentSymbol;
    const gran   = state.currentTfSec;
    if (!symbol) return;
    state.ws.send(JSON.stringify({
        ticks_history:     symbol,
        end:               'latest',
        count:             300,
        style:             'candles',
        granularity:       gran,
        adjust_start_time: 1,
        subscribe:         1,
    }));
}

function handleDerivMessage(msg) {
    if (msg.error) {
        console.warn('Deriv error', msg.error);
        setChartStatus('deriv: ' + (msg.error.message || 'error'), 'err');
        return;
    }
    if (msg.msg_type === 'candles') {
        const arr = (msg.candles || []).map(c => ({
            time:  Number(c.epoch),
            open:  Number(c.open),
            high:  Number(c.high),
            low:   Number(c.low),
            close: Number(c.close),
        })).sort((a, b) => a.time - b.time);
        state.candles = arr;
        if (state.series) state.series.setData(arr);
        updateCandleCount();
        updateLastPrice(arr.length ? arr[arr.length - 1].close : null);
        state.subscriptionId = msg.subscription && msg.subscription.id;
        // Data is now present on THIS series — safe to (re)draw indicators
        // and the entry price line onto the correct, current series.
        recomputeIndicators();
        queueOverlayRefresh();
    } else if (msg.msg_type === 'ohlc') {
        const c = msg.ohlc || {};
        const cand = {
            time:  Number(c.open_time),
            open:  Number(c.open),
            high:  Number(c.high),
            low:   Number(c.low),
            close: Number(c.close),
        };
        if (!Number.isFinite(cand.time)) return;
        if (!state.candles.length || cand.time > state.candles[state.candles.length - 1].time) {
            state.candles.push(cand);
        } else {
            state.candles[state.candles.length - 1] = cand;
        }
        if (state.series) state.series.update(cand);
        updateLastPrice(cand.close);
        recomputeIndicators(); // live-update overlays with the streaming candle
    }
}

function derivUnsubscribe() {
    if (!state.ws || state.ws.readyState !== 1) return;
    if (state.subscriptionId) {
        state.ws.send(JSON.stringify({ forget: state.subscriptionId }));
        state.subscriptionId = null;
    }
}

/* ============================================================
   CHART setup — lightweight-charts
   ============================================================ */
function chartThemeOptions() {
    const styles = getComputedStyle(document.documentElement);
    const bg   = styles.getPropertyValue('--surface').trim()
              || styles.getPropertyValue('--tg-secondary').trim() || '#1b2330';
    const text = styles.getPropertyValue('--tg-text').trim() || '#f5f5f5';
    const grid = 'rgba(255,255,255,0.05)';
    return { bg, text, grid };
}

function initChart() {
    if (state.chart) return;
    const el = document.getElementById('chart');
    const { bg, text, grid } = chartThemeOptions();
    state.chart = LightweightCharts.createChart(el, {
        width:  el.clientWidth,
        height: el.clientHeight,
        layout: { background: { color: bg }, textColor: text, fontSize: 11 },
        grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        handleScale: { axisPressedMouseMove: true },
    });
    state.series = state.chart.addCandlestickSeries({
        upColor:      COLORS.bull,
        downColor:    COLORS.bear,
        borderUpColor:COLORS.bull,
        borderDownColor:COLORS.bear,
        wickUpColor:  COLORS.bull,
        wickDownColor:COLORS.bear,
    });

    // Keep sub-panes time-scale in sync with main chart.
    state.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (state.syncing || !range) return;
        state.syncing = true;
        try {
            if (state.rsiChart) state.rsiChart.timeScale().setVisibleLogicalRange(range);
            if (state.atrChart) state.atrChart.timeScale().setVisibleLogicalRange(range);
        } catch (_) {}
        state.syncing = false;
    });
}

function ensureSubChart(which) {
    // which = 'rsi' | 'atr'
    const wrapId   = which + 'Wrap';
    const chartId  = which + 'Chart';
    const wrap = document.getElementById(wrapId);
    wrap.classList.remove('hidden');
    if (state[which + 'Chart']) return;
    const el = document.getElementById(chartId);
    const { bg, text, grid } = chartThemeOptions();
    const c = LightweightCharts.createChart(el, {
        width: el.clientWidth,
        height: el.clientHeight,
        layout: { background: { color: bg }, textColor: text, fontSize: 10 },
        grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
    });
    if (which === 'rsi') {
        state.rsiChart = c;
        state.rsiSeries = c.addLineSeries({ color: COLORS.rsi, lineWidth: 2 });
        // 30 / 70 guide lines
        state.rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,84,112,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' });
        state.rsiSeries.createPriceLine({ price: 30, color: 'rgba(38,194,129,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' });
    } else {
        state.atrChart = c;
        state.atrSeries = c.addLineSeries({ color: COLORS.atr, lineWidth: 2 });
    }
    // Sync main chart to reflect new pane immediately.
    fitCharts();
}

function destroySubChart(which) {
    const wrap = document.getElementById(which + 'Wrap');
    if (state[which + 'Chart']) {
        try { state[which + 'Chart'].remove(); } catch (_) {}
        state[which + 'Chart'] = null;
        state[which + 'Series'] = null;
    }
    if (wrap) wrap.classList.add('hidden');
    fitCharts();
}

function retintChart() {
    if (!state.chart) return;
    const { bg, text, grid } = chartThemeOptions();
    const opts = {
        layout: { background: { color: bg }, textColor: text },
        grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid },
    };
    try {
        state.chart.applyOptions(opts);
        if (state.rsiChart) state.rsiChart.applyOptions(opts);
        if (state.atrChart) state.atrChart.applyOptions(opts);
    } catch (_) {}
}

/* Resize all charts to their containers. Called on resize/orientation
   change and whenever a sub-pane is toggled. */
function fitCharts() {
    const fit = (chart, elId) => {
        if (!chart) return;
        const el = document.getElementById(elId);
        if (!el) return;
        const w = el.clientWidth, h = el.clientHeight;
        if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
    };
    fit(state.chart, 'chart');
    fit(state.rsiChart, 'rsiChart');
    fit(state.atrChart, 'atrChart');
}
window.addEventListener('resize', () => requestAnimationFrame(fitCharts));
window.addEventListener('orientationchange', () => setTimeout(fitCharts, 250));

function setChartStatus(text, cls) {
    const el = document.getElementById('chartStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'chart-status ' + (cls || '');
}
function updateCandleCount() {
    const el = document.getElementById('candleCount');
    if (el) el.textContent = state.candles.length + ' candles';
}
function updateLastPrice(p) {
    const el = document.getElementById('lastPrice');
    if (el) el.textContent = p == null ? 'last —' : ('last ' + p);
}

/* ============================================================
   ACTIVE-POSITION OVERLAY (price line + countdown)

   Bug-1 fix notes:
   • The price line is now always (re)created on the CURRENT
     `state.series`, and we remember which series it was attached
     to (`state.priceLineSeries`) so removal never targets a
     stale/disposed series after a symbol/timeframe switch.
   • It is re-applied every time fresh candle data lands on the
     current series (see handleDerivMessage 'candles' branch), so
     it can never end up orphaned on a torn-down series.
   • entry_price is coerced with Number() to guard against the API
     sending it as a string, which would otherwise silently no-op.
   ============================================================ */
function clearOverlay() {
    const box = document.getElementById('chartOverlay');
    if (box) box.classList.add('hidden');
    if (state.priceLine && state.priceLineSeries) {
        try { state.priceLineSeries.removePriceLine(state.priceLine); } catch (_) {}
    }
    state.priceLine = null;
    state.priceLineSeries = null;
    if (state.overlayTimer) { clearInterval(state.overlayTimer); state.overlayTimer = null; }
}

function applyOverlayFor(active) {
    if (!state.series) return;
    clearOverlay();
    if (!active) return;

    const box = document.getElementById('chartOverlay');
    box.classList.remove('hidden');
    const dir = (active.direction || '').toLowerCase();
    document.getElementById('ovlDir').textContent = (dir || '?').toUpperCase();
    document.getElementById('ovlDir').className    = 'ovl-dir ' + dir;
    const entryNum = active.entry_price != null ? Number(active.entry_price) : NaN;
    document.getElementById('ovlEntry').textContent =
        Number.isFinite(entryNum) ? ('entry ' + entryNum) : 'entry pending';
    document.getElementById('ovlMeta').textContent =
        '#' + active.contract_id + ' • ' + (active.path || '') +
        (active.stake != null ? (' • $' + active.stake) : '');

    // Native price-line — dashed, green for call, red for put.
    if (Number.isFinite(entryNum)) {
        const isPut = dir === 'put';
        state.priceLineSeries = state.series;
        state.priceLine = state.series.createPriceLine({
            price: entryNum,
            color: isPut ? COLORS.bear : COLORS.bull,
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle
                ? LightweightCharts.LineStyle.Dashed : 2,
            axisLabelVisible: true,
            title: 'ENTRY ' + (dir || '').toUpperCase(),
        });
    }

    // Countdown — recomputed each second from expiry_ms.
    const timerEl = document.getElementById('ovlTimer');
    function tick() {
        const now = Date.now();
        const remain = active.expiry_ms - now;
        if (remain <= 0) {
            timerEl.textContent = 'EXPIRED';
            timerEl.classList.add('expired');
            return;
        }
        timerEl.classList.remove('expired');
        const s = Math.floor(remain / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        timerEl.textContent = (h > 0 ? (h + ':' + String(m).padStart(2, '0')) : String(m)) +
                              ':' + String(sec).padStart(2, '0');
    }
    tick();
    state.overlayTimer = setInterval(tick, 1000);
}

function queueOverlayRefresh() {
    const list = state.activeTrades || [];
    const match = list.find(a => a.symbol === state.currentSymbol);
    // Debug aid: expose the raw match so it's easy to inspect in console.
    try { window.__aureliaActiveMatch = match || null; } catch (_) {}
    applyOverlayFor(match || null);
}

/* ============================================================
   INDICATORS — client-side, incremental overlay management
   ============================================================ */
function overlayKey(kind, i, sub) {
    return sub ? `${kind}${i}_${sub}` : `${kind}${i}`;
}

function removeOverlay(key) {
    const s = state.overlaySeries[key];
    if (s && state.chart) { try { state.chart.removeSeries(s); } catch (_) {} }
    delete state.overlaySeries[key];
}

function removeAllPriceOverlays() {
    Object.keys(state.overlaySeries).forEach(removeOverlay);
}

function ensureOverlaySeries(key, color, opts) {
    if (state.overlaySeries[key]) return state.overlaySeries[key];
    const s = state.chart.addLineSeries(Object.assign({
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
    }, opts || {}));
    state.overlaySeries[key] = s;
    return s;
}

/* Recompute every enabled indicator from the current candle set and
   push updated data into their (existing) series. Does NOT tear down
   the main chart. Adds/removes only individual line series. */
function recomputeIndicators() {
    if (!state.chart || !state.series) return;
    const I = window.Indicators;
    const candles = state.candles;
    const closes = candles.map(c => c.close);
    const cfg = state.ind;
    const wanted = new Set();

    // EMA lines
    cfg.emas.forEach((e, i) => {
        if (!e.on) return;
        const key = overlayKey('ema', i);
        wanted.add(key);
        const color = COLORS.ema[i % COLORS.ema.length];
        const s = ensureOverlaySeries(key, color);
        s.applyOptions({ color });
        s.setData(I.toLineData(candles, I.ema(closes, Number(e.period) || 1)));
    });
    // SMA lines
    cfg.smas.forEach((e, i) => {
        if (!e.on) return;
        const key = overlayKey('sma', i);
        wanted.add(key);
        const color = COLORS.sma[i % COLORS.sma.length];
        const s = ensureOverlaySeries(key, color);
        s.applyOptions({ color });
        s.setData(I.toLineData(candles, I.sma(closes, Number(e.period) || 1)));
    });
    // Bollinger Bands
    if (cfg.bb.on) {
        const bb = I.bollinger(closes, Number(cfg.bb.period) || 20, Number(cfg.bb.mult) || 2);
        [['bb_u', bb.upper, { lineStyle: 2 }], ['bb_m', bb.middle, {}], ['bb_l', bb.lower, { lineStyle: 2 }]]
            .forEach(([key, arr, extra]) => {
                wanted.add(key);
                const s = ensureOverlaySeries(key, COLORS.bb, Object.assign({ lineWidth: 1 }, extra));
                s.setData(I.toLineData(candles, arr));
            });
    }
    // Keltner Channel
    if (cfg.kc.on) {
        const kc = I.keltner(candles, Number(cfg.kc.period) || 20, Number(cfg.kc.atr) || 10, Number(cfg.kc.mult) || 1.5);
        [['kc_u', kc.upper, { lineStyle: 2 }], ['kc_m', kc.middle, {}], ['kc_l', kc.lower, { lineStyle: 2 }]]
            .forEach(([key, arr, extra]) => {
                wanted.add(key);
                const s = ensureOverlaySeries(key, COLORS.kc, Object.assign({ lineWidth: 1 }, extra));
                s.setData(I.toLineData(candles, arr));
            });
    }

    // Remove any price-overlay series no longer wanted.
    Object.keys(state.overlaySeries).forEach(key => {
        if (!wanted.has(key)) removeOverlay(key);
    });

    // RSI sub-pane
    if (cfg.rsi.on) {
        ensureSubChart('rsi');
        if (state.rsiSeries) {
            state.rsiSeries.setData(I.toLineData(candles, I.rsi(closes, Number(cfg.rsi.period) || 14)));
        }
    } else {
        destroySubChart('rsi');
    }
    // ATR sub-pane
    if (cfg.atr.on) {
        ensureSubChart('atr');
        if (state.atrSeries) {
            state.atrSeries.setData(I.toLineData(candles, I.atr(candles, Number(cfg.atr.period) || 14)));
        }
    } else {
        destroySubChart('atr');
    }
}

/* ── Indicator sheet UI ───────────────────────────────────── */
const sheet = document.getElementById('indicatorSheet');
document.getElementById('btnIndicators').addEventListener('click', () => {
    renderIndicatorSheet();
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
});
sheet.querySelectorAll('[data-close-sheet]').forEach(el => {
    el.addEventListener('click', () => {
        sheet.classList.add('hidden');
        sheet.setAttribute('aria-hidden', 'true');
    });
});

function maRowHtml(kind, i, item) {
    return `
        <div class="ma-row" data-kind="${kind}" data-idx="${i}">
            <label class="switch">
                <input type="checkbox" class="ma-on" ${item.on ? 'checked' : ''} />
                <span class="slider"></span>
            </label>
            <input type="number" class="ma-period" min="1" step="1" value="${item.period}" />
            <button class="mini-btn danger ma-del" aria-label="Remove">✕</button>
        </div>`;
}

function renderIndicatorSheet() {
    const cfg = state.ind;
    // Moving-average lists
    document.getElementById('emaList').innerHTML =
        cfg.emas.map((e, i) => maRowHtml('ema', i, e)).join('');
    document.getElementById('smaList').innerHTML =
        cfg.smas.map((e, i) => maRowHtml('sma', i, e)).join('');
    // Static toggles / params
    document.getElementById('bbOn').checked = cfg.bb.on;
    document.getElementById('bbPeriod').value = cfg.bb.period;
    document.getElementById('bbMult').value = cfg.bb.mult;
    document.getElementById('kcOn').checked = cfg.kc.on;
    document.getElementById('kcPeriod').value = cfg.kc.period;
    document.getElementById('kcMult').value = cfg.kc.mult;
    document.getElementById('kcAtr').value = cfg.kc.atr;
    document.getElementById('rsiOn').checked = cfg.rsi.on;
    document.getElementById('rsiPeriod').value = cfg.rsi.period;
    document.getElementById('atrOn').checked = cfg.atr.on;
    document.getElementById('atrPeriod').value = cfg.atr.period;
    wireMaRows();
}

function wireMaRows() {
    document.querySelectorAll('.ma-row').forEach(row => {
        const kind = row.dataset.kind;
        const idx  = Number(row.dataset.idx);
        const list = kind === 'ema' ? state.ind.emas : state.ind.smas;
        row.querySelector('.ma-on').addEventListener('change', e => {
            list[idx].on = e.target.checked;
            persistAndRecompute();
        });
        row.querySelector('.ma-period').addEventListener('change', e => {
            const v = Math.max(1, Math.round(Number(e.target.value) || 1));
            list[idx].period = v;
            e.target.value = v;
            persistAndRecompute();
        });
        row.querySelector('.ma-del').addEventListener('click', () => {
            // Remove this line's series first, then splice config.
            removeOverlay(overlayKey(kind, idx));
            list.splice(idx, 1);
            persistAndRecompute();
            renderIndicatorSheet();
        });
    });
}

document.getElementById('addEma').addEventListener('click', () => {
    state.ind.emas.push({ period: 100, on: true });
    persistAndRecompute();
    renderIndicatorSheet();
});
document.getElementById('addSma').addEventListener('click', () => {
    state.ind.smas.push({ period: 20, on: true });
    persistAndRecompute();
    renderIndicatorSheet();
});

// Static indicator param wiring
function bindStatic(id, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.type === 'checkbox' ? 'change' : 'change';
    el.addEventListener(ev, () => { apply(el); persistAndRecompute(); });
}
bindStatic('bbOn',     el => state.ind.bb.on = el.checked);
bindStatic('bbPeriod', el => state.ind.bb.period = Math.max(1, Math.round(Number(el.value) || 20)));
bindStatic('bbMult',   el => state.ind.bb.mult = Math.max(0.1, Number(el.value) || 2));
bindStatic('kcOn',     el => state.ind.kc.on = el.checked);
bindStatic('kcPeriod', el => state.ind.kc.period = Math.max(1, Math.round(Number(el.value) || 20)));
bindStatic('kcMult',   el => state.ind.kc.mult = Math.max(0.1, Number(el.value) || 1.5));
bindStatic('kcAtr',    el => state.ind.kc.atr = Math.max(1, Math.round(Number(el.value) || 10)));
bindStatic('rsiOn',    el => state.ind.rsi.on = el.checked);
bindStatic('rsiPeriod',el => state.ind.rsi.period = Math.max(1, Math.round(Number(el.value) || 14)));
bindStatic('atrOn',    el => state.ind.atr.on = el.checked);
bindStatic('atrPeriod',el => state.ind.atr.period = Math.max(1, Math.round(Number(el.value) || 14)));

function persistAndRecompute() {
    saveIndicatorConfig();
    recomputeIndicators();
    requestAnimationFrame(fitCharts);
}

/* ============================================================
   Chart tab wiring
   ============================================================ */
function populatePickers() {
    const symSel = document.getElementById('symbolPicker');
    const tfSel  = document.getElementById('tfPicker');
    const prevSym = state.currentSymbol;

    const cfg = state.config || {};
    const list = [];
    const fx  = (cfg.symbols && cfg.symbols.forex)      || {};
    const syn = (cfg.symbols && cfg.symbols.synthetics) || {};
    if (cfg.frx_enabled !== false) Object.keys(fx).forEach(k => fx[k] && list.push(k));
    if (cfg.syn_enabled) Object.keys(syn).forEach(k => syn[k] && list.push(k));
    const pool = list.length ? list : ['frxEURUSD'];
    symSel.innerHTML = pool.map(s => `<option value="${s}">${s}</option>`).join('');

    tfSel.innerHTML = state.timeframes.map(t => `<option value="${t}">${t}</option>`).join('');

    // Preserve current selection if still valid.
    if (prevSym && pool.includes(prevSym)) {
        state.currentSymbol = prevSym;
    } else {
        state.currentSymbol = pool[0];
    }
    symSel.value = state.currentSymbol;
    if (!tfSel.value) { tfSel.value = '5m'; state.currentTfSec = tfToSeconds('5m'); }
    else tfSel.value = tfSel.value;
    if (!state.currentTfSec) state.currentTfSec = tfToSeconds('5m');
}

document.getElementById('symbolPicker').addEventListener('change', e => {
    state.currentSymbol = e.target.value;
    resubscribe();
});
document.getElementById('tfPicker').addEventListener('change', e => {
    state.currentTfSec = tfToSeconds(e.target.value);
    resubscribe();
});

function resubscribe() {
    derivUnsubscribe();
    state.candles = [];
    if (state.series) state.series.setData([]);
    // Clear indicator series data (they'll refill when candles land).
    Object.values(state.overlaySeries).forEach(s => { try { s.setData([]); } catch (_) {} });
    if (state.rsiSeries) { try { state.rsiSeries.setData([]); } catch (_) {} }
    if (state.atrSeries) { try { state.atrSeries.setData([]); } catch (_) {} }
    // Tear down the entry line from the previous symbol immediately so it
    // never lingers when switching AWAY from a symbol that had a position.
    clearOverlay();
    subscribeCandles();
    // Overlay + indicators re-drawn once fresh candles arrive.
}

/* ============================================================
   TRADES tab
   ============================================================ */
async function refreshTrades() {
    try {
        const [act, hist] = await Promise.all([
            api('/api/trades/active'),
            api('/api/trades/history?limit=' + state.historyLimit + '&offset=' + state.historyOffset),
        ]);
        // Debug aid for Bug-1 verification.
        try { console.debug('[aurelia] /api/trades/active raw:', act); } catch (_) {}
        state.activeTrades = act.active || [];
        state.historyTotal = hist.total || 0;
        renderActive();
        renderHistory(hist.trades || []);
        queueOverlayRefresh();
    } catch (e) {
        renderTradesError(e);
    }
}

function renderActive() {
    const box = document.getElementById('activeList');
    const list = state.activeTrades || [];
    if (!list.length) {
        box.innerHTML = '<div class="empty">No open positions.</div>';
        return;
    }
    box.innerHTML = list.map(a => {
        const dirClass = (a.direction || '').toLowerCase();
        const dir = (a.direction || '?').toUpperCase();
        const stake = a.stake != null ? ('$' + a.stake) : '—';
        const conf  = a.confidence != null ? (Math.round(a.confidence * 100) + '%') : '';
        const entry = a.entry_price != null ? ('@ ' + a.entry_price) : '(entry pending)';
        const remainSec = Math.max(0, Math.floor((a.expiry_ms - Date.now()) / 1000));
        const rem = remainSec > 0 ? (Math.floor(remainSec / 60) + 'm ' + (remainSec % 60) + 's left') : 'EXPIRED';
        return `
            <div class="trade" data-cid="${a.contract_id}">
                <span class="sym">${a.symbol || ''}</span>
                <span class="dir ${dirClass}">${dir}</span>
                <span class="pnl">${rem}</span>
                <span class="meta">#${a.contract_id} • ${a.path} • ${stake} ${conf ? '• ' + conf : ''} • ${entry}</span>
                ${a.rationale ? `<span class="rat">${escapeHtml(a.rationale).slice(0, 220)}</span>` : ''}
            </div>`;
    }).join('');
}

function renderHistory(trades) {
    const box = document.getElementById('historyList');
    if (!trades || !trades.length) {
        box.innerHTML = '<div class="empty">No settled trades yet.</div>';
    } else {
        box.innerHTML = trades.map(t => {
            const dirClass = (t.direction || '').toLowerCase();
            const dir = (t.direction || '?').toUpperCase();
            const pnl = Number(t.pnl || 0);
            const pnlClass = pnl > 0 ? 'win' : (pnl < 0 ? 'loss' : '');
            const pnlText = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
            const when = (t.ts || '').replace('T', ' ').slice(0, 16);
            const outcome = t.outcome || (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat');
            const entry = t.entry != null ? (' entry ' + t.entry) : '';
            return `
                <div class="trade">
                    <span class="sym">${t.symbol || ''}</span>
                    <span class="dir ${dirClass}">${dir}</span>
                    <span class="pnl ${pnlClass}">${pnlText}</span>
                    <span class="meta">${when} • ${t.path || ''} • ${outcome} • $${Number(t.stake || 0).toFixed(2)}${entry}</span>
                    ${t.ai_outcome_note ? `<span class="rat">${escapeHtml(t.ai_outcome_note).slice(0, 220)}</span>` : ''}
                </div>`;
        }).join('');
    }
    const pageEl = document.getElementById('histPage');
    const countEl = document.getElementById('historyCount');
    const total = state.historyTotal || 0;
    const page = Math.floor(state.historyOffset / state.historyLimit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / state.historyLimit));
    pageEl.textContent = 'page ' + page + ' / ' + totalPages;
    countEl.textContent = '(' + total + ')';
    document.getElementById('histPrev').disabled = state.historyOffset <= 0;
    document.getElementById('histNext').disabled = state.historyOffset + state.historyLimit >= total;
}

function renderTradesError(e) {
    document.getElementById('activeList').innerHTML =
        '<div class="empty">Error: ' + escapeHtml(e.message) + '</div>';
    document.getElementById('historyList').innerHTML = '';
}

document.getElementById('histPrev').addEventListener('click', () => {
    state.historyOffset = Math.max(0, state.historyOffset - state.historyLimit);
    refreshTrades();
});
document.getElementById('histNext').addEventListener('click', () => {
    state.historyOffset += state.historyLimit;
    refreshTrades();
});

/* ============================================================
   SETTINGS tab
   ============================================================ */
function renderSettings() {
    const cfg = state.config || {};
    const cs = (cfg.cycle && cfg.cycle.session) || {};
    document.getElementById('fCapital').value  = cs.capital     ?? 100;
    document.getElementById('fTP').value       = cs.take_profit ?? 20;
    document.getElementById('fSL').value       = cs.stop_loss   ?? 20;
    document.getElementById('fInterval').value = (cfg.cycle && cfg.cycle.interval_seconds) ?? 60;
    const mode = (cfg.account && cfg.account.mode) || 'demo';
    document.getElementById('fMode').checked = mode === 'real';
    document.getElementById('fModeLabel').textContent = mode === 'real' ? '🔴 REAL' : '🟡 DEMO';
    document.getElementById('fFrxGate').checked = cfg.frx_enabled !== false;
    document.getElementById('fSynGate').checked = !!cfg.syn_enabled;
    const p = cfg.payout || {};
    document.getElementById('fPayoutEnabled').checked = p.enabled !== false;
    document.getElementById('fPayoutMin').value = p.min_threshold ?? 0.7;
    const s = cfg.stake || {};
    document.getElementById('fStakeMin').value = s.absolute_min ?? 0.35;
    document.getElementById('fStakeMax').value = s.absolute_max ?? 10000;
    const d = cfg.daily_summary || {};
    document.getElementById('fDailyEnabled').checked = d.enabled !== false;
    document.getElementById('fDailyReset').checked = d.reset_on_send !== false;
    const a = cfg.ai || {};
    document.getElementById('fAiConf').value  = a.min_confidence ?? 0.55;
    document.getElementById('fAiHist').value  = a.max_history_entries ?? 12;
    document.getElementById('fAiBench').value = a.bench_minutes ?? 150;

    renderSymbolGrid('symListFx', 'forex');
    renderSymbolGrid('symListSyn', 'synthetics');
    renderOverrides();
    renderAiProviders();

    const st = state.status || {};
    const diag = [
        'account_mode  : ' + (st.account_mode || (cfg.account && cfg.account.mode) || '—'),
        'balance       : ' + (st.balance ?? '—') + ' ' + (st.currency || ''),
        'last_cycle    : ' + (st.last_cycle || '—'),
        'cycle running : ' + (cfg.cycle && cfg.cycle.running ? 'yes' : 'no'),
        'open position : ' + (st.cycle_open_position
            ? (st.cycle_open_position.symbol + ' #' + st.cycle_open_position.contract_id)
            : '—'),
        'init_data len : ' + (INIT_DATA ? INIT_DATA.length : 0),
    ].join('\n');
    document.getElementById('diagBox').textContent = diag;
}

function renderSymbolGrid(elId, pool) {
    const el = document.getElementById(elId);
    const map = (state.config.symbols && state.config.symbols[pool]) || {};
    const keys = Object.keys(map).sort();
    if (!keys.length) { el.innerHTML = '<div class="empty">(none)</div>'; return; }
    el.innerHTML = keys.map(sym => {
        const on = !!map[sym];
        return `
            <div class="sym-chip ${on ? 'on' : 'off'}" data-pool="${pool}" data-sym="${sym}">
                <span class="marker"></span>
                <span class="lbl">${sym}</span>
            </div>`;
    }).join('');
    el.querySelectorAll('.sym-chip').forEach(chip => {
        chip.addEventListener('click', () => toggleSymbol(pool, chip.dataset.sym));
    });
}

async function toggleSymbol(pool, sym) {
    const cur = state.config.symbols[pool][sym];
    const patch = { symbols: { [pool]: { [sym]: !cur } } };
    try {
        const r = await api('/api/config', { method: 'POST', body: patch });
        state.config = r.config;
        renderSymbolGrid(pool === 'forex' ? 'symListFx' : 'symListSyn', pool);
        toast(sym + ' ' + (!cur ? 'ON' : 'OFF'), 'ok');
        populatePickers();
    } catch (e) { toast('Toggle failed: ' + e.message, 'err'); }
}

function renderOverrides() {
    const box = document.getElementById('overrideList');
    const cnt = document.getElementById('overrideCount');
    const overrides = (state.config.payout && state.config.payout.per_symbol) || {};
    const entries = Object.entries(overrides);
    cnt.textContent = String(entries.length);
    if (!entries.length) { box.innerHTML = '<div class="empty small">(none)</div>'; return; }
    box.innerHTML = entries.map(([sym, v]) => `
        <div class="row">
            <span><code>${sym}</code> → <b>${Math.round(v * 100)}%</b></span>
            <button data-sym="${sym}" class="clr-ov">🗑 Clear</button>
        </div>`).join('');
    box.querySelectorAll('.clr-ov').forEach(b => {
        b.addEventListener('click', async () => {
            try {
                const r = await api('/api/config', {
                    method: 'POST',
                    body: { payout: { per_symbol: { [b.dataset.sym]: null } } },
                });
                state.config = r.config;
                renderOverrides();
                toast('Override cleared', 'ok');
            } catch (e) { toast('Failed: ' + e.message, 'err'); }
        });
    });
}

function renderAiProviders() {
    const el = document.getElementById('aiProviders');
    const provs = (state.config.ai && Array.isArray(state.config.ai.providers))
        ? state.config.ai.providers : [];
    if (!provs.length) { el.innerHTML = '<div class="empty">(none)</div>'; return; }
    el.innerHTML = provs.map(p => `
        <div class="sym-chip ${p.enabled === false ? 'off' : 'on'}" data-p="${p.name}">
            <span class="marker"></span>
            <span class="lbl">${p.name}</span>
        </div>`).join('');
    el.querySelectorAll('.sym-chip').forEach(chip => {
        chip.addEventListener('click', async () => {
            const name = chip.dataset.p;
            const cur = provs.find(x => x.name === name);
            const patch = { ai: { providers: [{ name, enabled: !(cur && cur.enabled !== false) }] } };
            try {
                const r = await api('/api/config', { method: 'POST', body: patch });
                state.config = r.config;
                renderAiProviders();
                toast(name + ' toggled', 'ok');
            } catch (e) { toast('Failed: ' + e.message, 'err'); }
        });
    });
}

/* ── Settings button wiring ──────────────────────────────── */
document.getElementById('btnStart').addEventListener('click', async () => {
    try { await api('/api/cycle/start', { method: 'POST' }); toast('Cycle started', 'ok'); await bootstrapReload(); }
    catch (e) { toast('Start failed: ' + e.message, 'err'); }
});
document.getElementById('btnPause').addEventListener('click', async () => {
    try { await api('/api/cycle/pause', { method: 'POST' }); toast('Cycle paused', 'ok'); await bootstrapReload(); }
    catch (e) { toast('Pause failed: ' + e.message, 'err'); }
});
document.getElementById('btnScan').addEventListener('click', async () => {
    try { await api('/api/scan', { method: 'POST' }); toast('Scan dispatched', 'ok'); }
    catch (e) { toast('Scan failed: ' + e.message, 'err'); }
});
document.getElementById('btnDailyRun').addEventListener('click', async () => {
    try { await api('/api/daily/run', { method: 'POST' }); toast('Daily summary queued', 'ok'); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
});

document.getElementById('btnSaveCycle').addEventListener('click', async () => {
    const patch = {
        cycle: {
            interval_seconds: Number(document.getElementById('fInterval').value),
            session: {
                capital:     Number(document.getElementById('fCapital').value),
                take_profit: Number(document.getElementById('fTP').value),
                stop_loss:   Number(document.getElementById('fSL').value),
            },
        },
    };
    try {
        const r = await api('/api/config', { method: 'POST', body: patch });
        state.config = r.config; toast('Cycle saved', 'ok');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
});
document.getElementById('btnSavePayout').addEventListener('click', async () => {
    const patch = {
        payout: {
            enabled:       document.getElementById('fPayoutEnabled').checked,
            min_threshold: Number(document.getElementById('fPayoutMin').value),
        },
    };
    try {
        const r = await api('/api/config', { method: 'POST', body: patch });
        state.config = r.config; toast('Payout saved', 'ok');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
});
document.getElementById('btnSaveStake').addEventListener('click', async () => {
    const patch = {
        stake: {
            absolute_min: Number(document.getElementById('fStakeMin').value),
            absolute_max: Number(document.getElementById('fStakeMax').value),
        },
    };
    try {
        const r = await api('/api/config', { method: 'POST', body: patch });
        state.config = r.config; toast('Stake saved', 'ok');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
});
document.getElementById('btnSaveAi').addEventListener('click', async () => {
    const patch = {
        ai: {
            min_confidence:      Number(document.getElementById('fAiConf').value),
            max_history_entries: Number(document.getElementById('fAiHist').value),
            bench_minutes:       Number(document.getElementById('fAiBench').value),
        },
    };
    try {
        const r = await api('/api/config', { method: 'POST', body: patch });
        state.config = r.config; toast('AI saved', 'ok');
    } catch (e) { toast('Save failed: ' + e.message, 'err'); }
});
document.getElementById('fMode').addEventListener('change', async e => {
    const mode = e.target.checked ? 'real' : 'demo';
    if (mode === 'real' && !confirm('Switch to REAL account? Real money will be traded.')) {
        e.target.checked = false; return;
    }
    try {
        const r = await api('/api/config', { method: 'POST', body: { account: { mode } } });
        state.config = r.config;
        document.getElementById('fModeLabel').textContent = mode === 'real' ? '🔴 REAL' : '🟡 DEMO';
        updateModeBadge();
        toast('Mode: ' + mode.toUpperCase(), 'ok');
    } catch (err) { toast('Failed: ' + err.message, 'err'); e.target.checked = !e.target.checked; }
});
document.getElementById('fFrxGate').addEventListener('change', async e => {
    try {
        const r = await api('/api/config', { method: 'POST', body: { frx_enabled: e.target.checked } });
        state.config = r.config; toast('FRX gate ' + (e.target.checked ? 'ON' : 'OFF'), 'ok');
        populatePickers();
    } catch (err) { toast('Failed: ' + err.message, 'err'); e.target.checked = !e.target.checked; }
});
document.getElementById('fSynGate').addEventListener('change', async e => {
    try {
        const r = await api('/api/config', { method: 'POST', body: { syn_enabled: e.target.checked } });
        state.config = r.config; toast('SYN gate ' + (e.target.checked ? 'ON' : 'OFF'), 'ok');
        populatePickers();
    } catch (err) { toast('Failed: ' + err.message, 'err'); e.target.checked = !e.target.checked; }
});
document.getElementById('fDailyEnabled').addEventListener('change', async e => {
    try {
        const r = await api('/api/config', { method: 'POST',
            body: { daily_summary: { enabled: e.target.checked } } });
        state.config = r.config; toast('Daily auto-send ' + (e.target.checked ? 'ON' : 'OFF'), 'ok');
    } catch (err) { toast('Failed: ' + err.message, 'err'); e.target.checked = !e.target.checked; }
});
document.getElementById('fDailyReset').addEventListener('change', async e => {
    try {
        const r = await api('/api/config', { method: 'POST',
            body: { daily_summary: { reset_on_send: e.target.checked } } });
        state.config = r.config; toast('Daily reset ' + (e.target.checked ? 'ON' : 'OFF'), 'ok');
    } catch (err) { toast('Failed: ' + err.message, 'err'); e.target.checked = !e.target.checked; }
});

/* ============================================================
   HEADER updates
   ============================================================ */
function updateModeBadge() {
    const mode = (state.config && state.config.account && state.config.account.mode) || 'demo';
    const el = document.getElementById('modeBadge');
    el.className = 'badge ' + mode;
    el.textContent = mode === 'real' ? '🔴 REAL' : '🟡 DEMO';
}
function updateBalance() {
    const st = state.status || {};
    const el = document.getElementById('balance');
    if (st.balance == null) { el.textContent = '—'; return; }
    el.textContent = '$' + Number(st.balance).toFixed(2) + ' ' + (st.currency || '');
}
function updateStatusDot() {
    const dot = document.getElementById('statusDot');
    const st = state.status || {};
    if (!st.last_cycle) { dot.className = 'dot'; return; }
    const age = Date.now() - Date.parse(st.last_cycle);
    dot.className = 'dot ' + (age < 15 * 60 * 1000 ? 'ok' : 'err');
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */
async function bootstrapReload() {
    const [cfgR, stR, actR] = await Promise.all([
        api('/api/config'),
        api('/api/status'),
        api('/api/trades/active'),
    ]);
    state.config = cfgR.config;
    state.catalog = cfgR.catalog;
    state.timeframes = cfgR.timeframes || state.timeframes;
    state.status = stR.status;
    state.activeTrades = actR.active || [];
    updateModeBadge();
    updateBalance();
    updateStatusDot();
    if (document.getElementById('tab-settings').classList.contains('active')) renderSettings();
    queueOverlayRefresh();
}

async function boot() {
    // Safe to apply the theme now — `state` is fully initialized.
    applyTheme();
    if (!INIT_DATA) {
        toast('No Telegram initData — open this via the bot Menu Button.', 'err');
    }
    try {
        await bootstrapReload();
        populatePickers();
        initChart();
        // Draw any indicators enabled from a previous session immediately
        // (they'll refill with data as soon as candles arrive).
        recomputeIndicators();
        derivConnect();
        requestAnimationFrame(fitCharts);
        setInterval(async () => {
            try {
                const [stR, actR] = await Promise.all([
                    api('/api/status'),
                    api('/api/trades/active'),
                ]);
                state.status = stR.status;
                state.activeTrades = actR.active || [];
                updateBalance();
                updateStatusDot();
                if (document.getElementById('tab-trades').classList.contains('active')) {
                    renderActive();
                }
                queueOverlayRefresh();
            } catch (_) {}
        }, 15000);
    } catch (e) {
        toast('Boot failed: ' + e.message, 'err');
        console.error(e);
    }
}

/* ── util ─────────────────────────────────────────────────── */
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

boot();
