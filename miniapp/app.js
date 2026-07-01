/* ============================================================
   AURELIA Mini App — vanilla JS.
   No build step, no bundler; ships as a plain static file.

   Depends on globals injected by <script> tags:
     • Telegram.WebApp                    (telegram-web-app.js)
     • LightweightCharts                  (lightweight-charts UMD)

   Config:
     • window.AURELIA_API_BASE  can be set before this script loads to
       point at the Cloudflare Worker (e.g. "https://aurelia.example.workers.dev").
       If unset, we assume the Mini App is served from the same origin
       as the API and use relative URLs.
   ============================================================ */

'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
const API_BASE = (window.AURELIA_API_BASE || '').replace(/\/+$/, '');
const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

// initData source of truth — set once at boot.
let INIT_DATA = '';
try { INIT_DATA = (tg && tg.initData) || ''; } catch (_) {}

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
}
if (tg) {
    try { tg.ready(); tg.expand(); } catch (_) {}
    applyTheme();
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
        // Preferred: dedicated header. Auth header kept as fallback.
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
    ws: null,
    wsPingTimer: null,
    subscriptionId: null,
    tickSubId: null,
    currentSymbol: null,
    currentTfSec: 300,
    candles: [], // { epoch, open, high, low, close }
    priceLine: null,
    overlayTimer: null,
};

/* ── Tab switching ────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        const t = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === btn));
        document.querySelectorAll('.tab-body').forEach(x => x.classList.toggle('active', x.id === 'tab-' + t));
        if (t === 'trades') refreshTrades();
        if (t === 'settings') renderSettings();
        if (t === 'chart') queueOverlayRefresh();
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
   Reuses the exact ticks_history request shape from deriv.js.
   ============================================================ */
function derivConnect() {
    if (state.ws) {
        try { state.ws.close(); } catch (_) {}
    }
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
    ws.addEventListener('close', () => {
        setChartStatus('closed', 'err');
    });
    ws.addEventListener('error', () => {
        setChartStatus('ws error', 'err');
    });
}

function subscribeCandles() {
    if (!state.ws || state.ws.readyState !== 1) return;
    const symbol = state.currentSymbol;
    const gran   = state.currentTfSec;
    if (!symbol) return;
    // Same shape used in deriv.js (ticksHistory) — with subscribe=1 so
    // the WS keeps streaming updates for the last candle.
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
    } else if (msg.msg_type === 'ohlc') {
        // Streamed update for the current candle
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
function initChart() {
    if (state.chart) return;
    const el = document.getElementById('chart');
    const styles = getComputedStyle(document.documentElement);
    const bg   = styles.getPropertyValue('--tg-secondary').trim() || '#232e3c';
    const text = styles.getPropertyValue('--tg-text').trim() || '#f5f5f5';
    const grid = 'rgba(255,255,255,0.05)';
    state.chart = LightweightCharts.createChart(el, {
        width:  el.clientWidth,
        height: el.clientHeight,
        layout: { background: { color: bg }, textColor: text },
        grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
    });
    state.series = state.chart.addCandlestickSeries({
        upColor:      '#2ecc71',
        downColor:    '#ff595a',
        borderUpColor:'#2ecc71',
        borderDownColor:'#ff595a',
        wickUpColor:  '#2ecc71',
        wickDownColor:'#ff595a',
    });
    // Resize on viewport changes
    const ro = new ResizeObserver(() => {
        if (!state.chart) return;
        state.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
}

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
   ============================================================ */
function clearOverlay() {
    document.getElementById('chartOverlay').classList.add('hidden');
    if (state.priceLine && state.series) {
        try { state.series.removePriceLine(state.priceLine); } catch (_) {}
    }
    state.priceLine = null;
    if (state.overlayTimer) { clearInterval(state.overlayTimer); state.overlayTimer = null; }
}

function applyOverlayFor(active) {
    // active = matching entry from GET /api/trades/active
    if (!state.series) return;
    clearOverlay();
    if (!active) return;
    const box = document.getElementById('chartOverlay');
    box.classList.remove('hidden');
    document.getElementById('ovlDir').textContent = (active.direction || '?').toUpperCase();
    document.getElementById('ovlDir').className   = 'ovl-dir ' + (active.direction || '');
    document.getElementById('ovlEntry').textContent =
        active.entry_price != null ? ('entry ' + active.entry_price) : 'entry pending';
    document.getElementById('ovlMeta').textContent =
        '#' + active.contract_id + ' • ' + (active.path || '') +
        (active.stake != null ? (' • $' + active.stake) : '');

    // Native price-line — dashed, green for call, red for put
    if (active.entry_price != null) {
        state.priceLine = state.series.createPriceLine({
            price: Number(active.entry_price),
            color: active.direction === 'put' ? '#ff595a' : '#2ecc71',
            lineWidth: 2,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: 'ENTRY ' + (active.direction || '').toUpperCase(),
        });
    }

    // Countdown — recomputed each second from expiry_ms
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
    // Re-derive from state.activeTrades cache; refresh silently.
    const list = state.activeTrades || [];
    const match = list.find(a => a.symbol === state.currentSymbol);
    applyOverlayFor(match || null);
}

/* ============================================================
   Chart tab wiring
   ============================================================ */
function populatePickers() {
    const symSel = document.getElementById('symbolPicker');
    const tfSel  = document.getElementById('tfPicker');

    // Enabled symbols only (respecting master gates)
    const cfg = state.config || {};
    const list = [];
    const fx  = (cfg.symbols && cfg.symbols.forex)      || {};
    const syn = (cfg.symbols && cfg.symbols.synthetics) || {};
    if (cfg.frx_enabled !== false) {
        Object.keys(fx).forEach(k => fx[k] && list.push(k));
    }
    if (cfg.syn_enabled) {
        Object.keys(syn).forEach(k => syn[k] && list.push(k));
    }
    const pool = list.length ? list : ['frxEURUSD'];
    symSel.innerHTML = pool.map(s => `<option value="${s}">${s}</option>`).join('');

    tfSel.innerHTML = state.timeframes
        .map(t => `<option value="${t}">${t}</option>`).join('');

    // Default: first enabled symbol, 5m
    state.currentSymbol = pool[0];
    symSel.value = state.currentSymbol;
    tfSel.value  = '5m';
    state.currentTfSec = tfToSeconds('5m');
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
    subscribeCandles();
    queueOverlayRefresh();
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
        const dirClass = a.direction || '';
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
            const dirClass = t.direction || '';
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
    // Cycle
    const cs = (cfg.cycle && cfg.cycle.session) || {};
    document.getElementById('fCapital').value  = cs.capital     ?? 100;
    document.getElementById('fTP').value       = cs.take_profit ?? 20;
    document.getElementById('fSL').value       = cs.stop_loss   ?? 20;
    document.getElementById('fInterval').value = (cfg.cycle && cfg.cycle.interval_seconds) ?? 60;
    // Account
    const mode = (cfg.account && cfg.account.mode) || 'demo';
    document.getElementById('fMode').checked = mode === 'real';
    document.getElementById('fModeLabel').textContent = mode === 'real' ? '🔴 REAL' : '🟡 DEMO';
    // Gates
    document.getElementById('fFrxGate').checked = cfg.frx_enabled !== false;
    document.getElementById('fSynGate').checked = !!cfg.syn_enabled;
    // Payout
    const p = cfg.payout || {};
    document.getElementById('fPayoutEnabled').checked = p.enabled !== false;
    document.getElementById('fPayoutMin').value = p.min_threshold ?? 0.7;
    // Stake
    const s = cfg.stake || {};
    document.getElementById('fStakeMin').value = s.absolute_min ?? 0.35;
    document.getElementById('fStakeMax').value = s.absolute_max ?? 10000;
    // Daily
    const d = cfg.daily_summary || {};
    document.getElementById('fDailyEnabled').checked = d.enabled !== false;
    document.getElementById('fDailyReset').checked = d.reset_on_send !== false;
    // AI
    const a = cfg.ai || {};
    document.getElementById('fAiConf').value  = a.min_confidence ?? 0.55;
    document.getElementById('fAiHist').value  = a.max_history_entries ?? 12;
    document.getElementById('fAiBench').value = a.bench_minutes ?? 150;

    renderSymbolGrid('symListFx', 'forex');
    renderSymbolGrid('symListSyn', 'synthetics');
    renderOverrides();
    renderAiProviders();

    // Diagnostics
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
    // Refresh cached config+status+trades; UI panels re-render.
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
    // If the current visible tab is Settings, re-render its fields.
    if (document.getElementById('tab-settings').classList.contains('active')) renderSettings();
    queueOverlayRefresh();
}

async function boot() {
    if (!INIT_DATA) {
        // Still allow local dev: show a clear diagnostic instead of a silent 401 loop.
        toast('No Telegram initData — open this via the bot Menu Button.', 'err');
    }
    try {
        await bootstrapReload();
        populatePickers();
        initChart();
        derivConnect();
        // Kick off periodic status polling — trades and status refresh every 15s
        // (config we can leave until user visits Settings again).
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
