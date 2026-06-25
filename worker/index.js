/* =====================================================================
   AURELIA — Cloudflare Worker (Telegram webhook → GitHub Actions)
   ─────────────────────────────────────────────────────────────────────
   The control plane. Receives Telegram updates, mutates config.json
   in the repo, dispatches workflow runs, and manages Gemini API keys
   as GitHub Actions secrets (libsodium sealed boxes).

   Environment variables (set in Cloudflare Worker settings):
     TELEGRAM_BOT_TOKEN   — from BotFather
     TELEGRAM_CHAT_ID     — owner's chat id (whitelist)
     GITHUB_PAT           — PAT with `repo` + secrets:write
     GITHUB_OWNER         — repo owner
     GITHUB_REPO          — repo name
     GITHUB_WORKFLOW      — workflow filename, e.g. "aurelia-cron.yml"
     GITHUB_REF           — e.g. "main"

   ===================================================================== */

import { seal as nacl_seal } from 'tweetsodium';

const GH_API = 'https://api.github.com';

const SYMBOL_CATALOG_FOREX = [
    'frxEURUSD','frxGBPUSD','frxUSDJPY','frxAUDUSD','frxUSDCAD','frxUSDCHF',
    'frxNZDUSD','frxEURJPY','frxEURGBP','frxGBPJPY','frxAUDJPY','frxEURAUD',
    'frxEURCAD','frxEURCHF',
];
const SYMBOL_CATALOG_SYN = [
    'R_10','R_25','R_50','R_75','R_100',
    '1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V',
];

export default {
    async fetch(request, env) {
        if (request.method !== 'POST') {
            return new Response('aurelia webhook ok', { status: 200 });
        }
        let update;
        try { update = await request.json(); }
        catch { return new Response('bad json', { status: 400 }); }
        try { await handleUpdate(update, env); }
        catch (e) { console.error('handler error', e); }
        return new Response('ok', { status: 200 });
    },
};

/* ─────────────────────────────────────────────────────────────────
   Whitelist + dispatch
   ───────────────────────────────────────────────────────────────── */
async function handleUpdate(update, env) {
    const chat = (update.message && update.message.chat && update.message.chat.id)
              || (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id);
    if (String(chat) !== String(env.TELEGRAM_CHAT_ID)) return;

    if (update.callback_query) return handleCallback(update.callback_query, env);
    if (update.message)        return handleMessage(update.message, env);
}

async function handleMessage(msg, env) {
    const text = String(msg.text || '').trim();
    if (!text) return;

    // /commands
    if (text.startsWith('/')) {
        const [cmd, ...rest] = text.split(/\s+/);
        return handleCommand(cmd.toLowerCase(), rest, env, msg);
    }
    // Default: show main menu
    return tgSend(env, renderMenu(await ghReadJSON(env, 'config.json'), await ghReadJSON(env, 'last-status.json')),
                  { reply_markup: KB.mainMenu() });
}

async function handleCommand(cmd, args, env, msg) {
    switch (cmd) {
        case '/start':
        case '/menu':
            return tgSend(env, '⚡ <b>AURELIA</b>', { reply_markup: KB.mainMenu() });

        case '/status': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json');
            return tgSend(env, renderStatus(cfg, st), { reply_markup: KB.statusScreen() });
        }

        case '/scan':           // manual AI trade — alias for the button
            return dispatchManual(env, { action: 'trade_now' }, 'Manual scan triggered.');

        case '/syn': {
            const v = (args[0] || '').toLowerCase();
            const cfg = await ghReadJSON(env, 'config.json');
            if (v === 'on')  cfg.syn_enabled = true;
            else if (v === 'off') cfg.syn_enabled = false;
            else return tgSend(env, 'Usage: /syn on|off');
            await ghWriteJSON(env, 'config.json', cfg, `bot: SYN ${v}`);
            return tgSend(env, `Synthetics ${v === 'on' ? '✅ ON' : '⛔ OFF'}.`);
        }

        case '/startcycle': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json');
            const cap = Number(cfg.cycle.session.capital);
            cfg.cycle.running = true;
            st.cycle_session = {
                active: true,
                started_at: new Date().toISOString(),
                capital_start: cap,
                capital_remaining: cap,
                take_profit: Number(cfg.cycle.session.take_profit) || 0,
                stop_loss:   Number(cfg.cycle.session.stop_loss) || 0,
                trades: 0, wins: 0, losses: 0, pnl: 0,
                win_streak: 0, loss_streak: 0,
                halted: false, halt_reason: null,
            };
            st.cycle_open_position = null;
            st.next_cycle_eligible_at = 0;
            await ghWriteJSON(env, 'config.json',      cfg, 'bot: start cycle');
            await ghWriteJSON(env, 'last-status.json', st,  'bot: open cycle session');
            await dispatchWorkflow(env, { task: 'cycle' });
            return tgSend(env, `▶️ Cycle started — capital $${cap}, TP $${st.cycle_session.take_profit}, SL $${st.cycle_session.stop_loss}.`);
        }

        case '/pausecycle': {
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.cycle.running = false;
            await ghWriteJSON(env, 'config.json', cfg, 'bot: pause cycle');
            return tgSend(env, '⏸️ Cycle paused.');
        }

        case '/setcapital':
        case '/settp':
        case '/setsl':
        case '/setinterval': {
            const v = Number(args[0]);
            if (!Number.isFinite(v) || v < 0) return tgSend(env, `Usage: ${cmd} <number>`);
            const cfg = await ghReadJSON(env, 'config.json');
            if (cmd === '/setcapital') cfg.cycle.session.capital     = v;
            if (cmd === '/settp')      cfg.cycle.session.take_profit = v;
            if (cmd === '/setsl')      cfg.cycle.session.stop_loss   = v;
            if (cmd === '/setinterval')cfg.cycle.interval_seconds    = Math.max(10, Math.floor(v));
            await ghWriteJSON(env, 'config.json', cfg, `bot: ${cmd} ${v}`);
            return tgSend(env, `✅ ${cmd} = ${v}`);
        }

        case '/addkey': {
            // /addkey <name> <value>
            const name = (args[0] || '').trim();
            const value = args.slice(1).join(' ').trim();
            if (!name || !value) return tgSend(env, 'Usage: /addkey <NAME> <VALUE>');
            const secretName = name.startsWith('GEMINI_KEY_') ? name : `GEMINI_KEY_${name.toUpperCase()}`;
            try {
                await ghPutSecret(env, secretName, value);
                const cfg = await ghReadJSON(env, 'config.json');
                cfg.ai = cfg.ai || {};
                cfg.ai.key_registry = cfg.ai.key_registry || [];
                if (!cfg.ai.key_registry.includes(secretName)) cfg.ai.key_registry.push(secretName);
                await ghWriteJSON(env, 'config.json', cfg, `bot: register key ${secretName}`);
                return tgSend(env, `🔑 Key <code>${escapeHtml(secretName)}</code> stored and registered.`);
            } catch (e) {
                return tgSend(env, `❌ addkey failed: <code>${escapeHtml(e.message)}</code>`);
            }
        }

        case '/removekey': {
            const name = (args[0] || '').trim();
            if (!name) return tgSend(env, 'Usage: /removekey <NAME>');
            const secretName = name.startsWith('GEMINI_KEY_') ? name : `GEMINI_KEY_${name.toUpperCase()}`;
            try {
                await ghDeleteSecret(env, secretName);
                const cfg = await ghReadJSON(env, 'config.json');
                cfg.ai.key_registry = (cfg.ai.key_registry || []).filter(k => k !== secretName);
                await ghWriteJSON(env, 'config.json', cfg, `bot: deregister key ${secretName}`);
                return tgSend(env, `🗑️ Key <code>${escapeHtml(secretName)}</code> removed.`);
            } catch (e) {
                return tgSend(env, `❌ removekey failed: <code>${escapeHtml(e.message)}</code>`);
            }
        }

        case '/listkeys': {
            const cfg = await ghReadJSON(env, 'config.json');
            const st  = await ghReadJSON(env, 'last-status.json');
            const list = cfg.ai.key_registry || [];
            if (!list.length) return tgSend(env, 'No keys registered. Use /addkey.');
            const now = Date.now();
            const lines = list.map(k => {
                const until = (st.ai_keys_bench || {})[k] || 0;
                const benched = until > now;
                return benched
                    ? `🟠 ${escapeHtml(k)} — benched until ${new Date(until).toISOString()}`
                    : `🟢 ${escapeHtml(k)}`;
            });
            return tgSend(env, `<b>Gemini keys</b>\n${lines.join('\n')}`);
        }

        case '/logs': {
            const st = await ghReadJSON(env, 'last-status.json');
            return tgSend(env, renderLogs(st, 1, 'all'), { reply_markup: KB.logs(1, 'all') });
        }

        case '/chart': {
            const symbol = (args[0] || 'frxEURUSD').trim();
            const tf     = (args[1] || '5m').trim();
            return dispatchManual(env, { action: 'chart', symbol, tf }, `📈 Chart ${symbol} ${tf} queued.`);
        }

        case '/mode': {
            const v = (args[0] || '').toLowerCase();
            if (!['demo','real'].includes(v)) return tgSend(env, 'Usage: /mode demo|real');
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.account.mode = v;
            await ghWriteJSON(env, 'config.json', cfg, `bot: account ${v}`);
            return tgSend(env, v === 'real' ? '🔴 Switched to <b>REAL</b>.' : '🟡 Switched to <b>DEMO</b>.');
        }

        default:
            return tgSend(env,
                'Commands:\n' +
                '/menu /status /logs /chart\n' +
                '/scan — manual AI trade\n' +
                '/startcycle /pausecycle\n' +
                '/setcapital N /settp N /setsl N /setinterval N\n' +
                '/syn on|off\n' +
                '/addkey NAME VALUE  /removekey NAME  /listkeys\n' +
                '/mode demo|real');
    }
}

/* ─────────────────────────────────────────────────────────────────
   Inline button callbacks
   ───────────────────────────────────────────────────────────────── */
async function handleCallback(cb, env) {
    const data = cb.data || '';
    await tgAnswerCallback(env, cb.id);
    const cfg = await ghReadJSON(env, 'config.json');
    const st  = await ghReadJSON(env, 'last-status.json');

    if (data === 'menu')   return tgEdit(env, cb, renderMenu(cfg, st), KB.mainMenu());
    if (data === 'status') return tgEdit(env, cb, renderStatus(cfg, st), KB.statusScreen());

    if (data === 'scan_now') {
        await dispatchManual(env, { action: 'trade_now' });
        return tgEdit(env, cb, '🤖 Manual AI scan queued — watch the chat.', KB.mainMenu());
    }
    if (data === 'cycle_start') {
        cfg.cycle.running = true;
        const cap = Number(cfg.cycle.session.capital);
        st.cycle_session = {
            active: true, started_at: new Date().toISOString(),
            capital_start: cap, capital_remaining: cap,
            take_profit: Number(cfg.cycle.session.take_profit) || 0,
            stop_loss:   Number(cfg.cycle.session.stop_loss) || 0,
            trades:0, wins:0, losses:0, pnl:0,
            win_streak:0, loss_streak:0, halted:false, halt_reason:null,
        };
        st.cycle_open_position = null;
        st.next_cycle_eligible_at = 0;
        await ghWriteJSON(env, 'config.json',      cfg, 'bot: start cycle');
        await ghWriteJSON(env, 'last-status.json', st,  'bot: open cycle session');
        await dispatchWorkflow(env, { task: 'cycle' });
        return tgEdit(env, cb, '▶️ Cycle started.', KB.mainMenu());
    }
    if (data === 'cycle_pause') {
        cfg.cycle.running = false;
        await ghWriteJSON(env, 'config.json', cfg, 'bot: pause cycle');
        return tgEdit(env, cb, '⏸️ Cycle paused.', KB.mainMenu());
    }
    if (data === 'syn_toggle') {
        cfg.syn_enabled = !cfg.syn_enabled;
        await ghWriteJSON(env, 'config.json', cfg, `bot: SYN ${cfg.syn_enabled}`);
        return tgEdit(env, cb, `Synthetics: <b>${cfg.syn_enabled ? 'ON' : 'OFF'}</b>`, KB.mainMenu());
    }
    if (data === 'mode_toggle') {
        cfg.account.mode = (cfg.account.mode === 'real') ? 'demo' : 'real';
        await ghWriteJSON(env, 'config.json', cfg, `bot: mode ${cfg.account.mode}`);
        return tgEdit(env, cb, cfg.account.mode === 'real' ? '🔴 REAL' : '🟡 DEMO', KB.mainMenu());
    }
    if (data.startsWith('logs:')) {
        const [, page, filter] = data.split(':');
        return tgEdit(env, cb,
            renderLogs(st, Number(page) || 1, filter || 'all'),
            KB.logs(Number(page) || 1, filter || 'all'));
    }
    return tgEdit(env, cb, renderMenu(cfg, st), KB.mainMenu());
}

/* ─────────────────────────────────────────────────────────────────
   GitHub Contents API helpers (config.json / last-status.json edits)
   ───────────────────────────────────────────────────────────────── */
function ghHeaders(env) {
    return {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'aurelia-worker',
    };
}
async function ghReadFile(env, path) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${env.GITHUB_REF || 'main'}`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`ghReadFile ${path}: ${r.status}`);
    const j = await r.json();
    return { content: atob(j.content.replace(/\n/g, '')), sha: j.sha };
}
async function ghReadJSON(env, path) {
    const { content } = await ghReadFile(env, path);
    return JSON.parse(content);
}
async function ghPutFile(env, path, content, message) {
    let sha = undefined;
    try { sha = (await ghReadFile(env, path)).sha; } catch (_) {}
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const body = {
        message: message || `bot: update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        branch:  env.GITHUB_REF || 'main',
        sha,
    };
    const r = await fetch(url, { method: 'PUT', headers: ghHeaders(env), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`ghPutFile ${path}: ${r.status} ${(await r.text()).slice(0,200)}`);
}
async function ghWriteJSON(env, path, obj, message) {
    return ghPutFile(env, path, JSON.stringify(obj, null, 2) + '\n', message);
}

/* ─────────────────────────────────────────────────────────────────
   GitHub Actions Secrets API — libsodium sealed-box encryption
   ───────────────────────────────────────────────────────────────── */
async function ghGetPublicKey(env) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/public-key`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`public-key: ${r.status}`);
    return r.json();   // { key_id, key (base64) }
}

// libsodium sealed-box (X25519 + xsalsa20-poly1305) via `tweetsodium`.
// Bundled at build time by wrangler — see worker/package.json.
function sealedBoxEncrypt(publicKeyB64, plaintext) {
    const recipientPk = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0));
    const msg = new TextEncoder().encode(plaintext);
    const sealed = nacl_seal(Buffer.from(msg), Buffer.from(recipientPk));
    let bin = '';
    for (const b of sealed) bin += String.fromCharCode(b);
    return btoa(bin);
}

async function ghPutSecret(env, secretName, secretValue) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(secretName)) {
        throw new Error(`secret name "${secretName}" invalid (A-Z, 0-9, _ only)`);
    }
    const pub = await ghGetPublicKey(env);
    const encrypted = sealedBoxEncrypt(pub.key, secretValue);
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/${encodeURIComponent(secretName)}`;
    const r = await fetch(url, {
        method: 'PUT',
        headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: encrypted, key_id: pub.key_id }),
    });
    if (!r.ok && r.status !== 201 && r.status !== 204) {
        throw new Error(`putSecret ${secretName}: ${r.status} ${(await r.text()).slice(0,200)}`);
    }
}
async function ghDeleteSecret(env, secretName) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/secrets/${encodeURIComponent(secretName)}`;
    const r = await fetch(url, { method: 'DELETE', headers: ghHeaders(env) });
    if (!r.ok && r.status !== 204) throw new Error(`deleteSecret: ${r.status}`);
}

/* ─────────────────────────────────────────────────────────────────
   workflow_dispatch
   ───────────────────────────────────────────────────────────────── */
async function dispatchWorkflow(env, inputs = {}) {
    const wf = env.GITHUB_WORKFLOW || 'aurelia-cron.yml';
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(wf)}/dispatches`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs }),
    });
    if (!r.ok) throw new Error(`dispatch ${wf}: ${r.status}`);
}

async function dispatchManual(env, payload, replyText) {
    try {
        await dispatchWorkflow(env, { task: 'manual', payload: JSON.stringify(payload) });
        if (replyText) await tgSend(env, replyText);
    } catch (e) {
        await tgSend(env, `❌ dispatch failed: <code>${escapeHtml(e.message)}</code>`);
    }
}

/* ─────────────────────────────────────────────────────────────────
   Telegram
   ───────────────────────────────────────────────────────────────── */
async function tgApi(env, method, payload) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return r.json().catch(() => ({}));
}
async function tgSend(env, text, opts = {}) {
    return tgApi(env, 'sendMessage', {
        chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: opts.reply_markup,
    });
}
async function tgEdit(env, cb, text, replyMarkup) {
    return tgApi(env, 'editMessageText', {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id,
        text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: replyMarkup,
    });
}
async function tgAnswerCallback(env, id, text) {
    return tgApi(env, 'answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

/* ─────────────────────────────────────────────────────────────────
   Render helpers + keyboards
   ───────────────────────────────────────────────────────────────── */
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmt2(n) { return (Number(n) || 0).toFixed(2); }
function badge(cfg) {
    return (cfg && cfg.account && cfg.account.mode === 'real') ? '🔴 REAL' : '🟡 DEMO';
}
function renderMenu(cfg, st) {
    const synOn = cfg && cfg.syn_enabled;
    const cycle = cfg && cfg.cycle && cfg.cycle.running;
    return [
        `⚡ <b>AURELIA</b> ${badge(cfg)}`,
        `Balance: <b>$${fmt2(st && st.balance)}</b>`,
        `Cycle: ${cycle ? '▶️ running' : '⏸️ paused'}    SYN: ${synOn ? '✅' : '⛔'}`,
    ].join('\n');
}
function renderStatus(cfg, st) {
    if (!st) return `${badge(cfg)} (no state)`;
    const s = (st.cycle_session) || {};
    const sign = (s.pnl || 0) >= 0 ? '+' : '';
    return [
        `📊 <b>Status</b> ${badge(cfg)}`,
        '',
        `Balance         : <b>$${fmt2(st.balance)}</b>`,
        `Last tick       : <code>${escapeHtml(st.last_cycle || '—')}</code>`,
        '',
        `<b>Cycle session</b>`,
        `Active          : ${s.active ? '✅' : '⛔'}${s.halted ? ' (halted: ' + escapeHtml(s.halt_reason || '') + ')' : ''}`,
        `Capital left    : $${fmt2(s.capital_remaining)} / $${fmt2(s.capital_start)}`,
        `P/L             : ${sign}$${fmt2(s.pnl || 0)}`,
        `Trades / W / L  : ${s.trades || 0} / ${s.wins || 0} / ${s.losses || 0}`,
        `Streak (W/L)    : ${s.win_streak || 0} / ${s.loss_streak || 0}`,
        `TP / SL         : $${fmt2(s.take_profit)} / $${fmt2(s.stop_loss)}`,
        `Open position   : ${st.cycle_open_position ? escapeHtml(st.cycle_open_position.symbol + ' #' + st.cycle_open_position.contract_id) : '—'}`,
    ].join('\n');
}
function renderLogs(st, page = 1, filter = 'all') {
    if (!st || !Array.isArray(st.logs)) return '📋 No logs.';
    const pageSize = 10;
    let logs = st.logs.slice().reverse();
    if (filter === 'trades')  logs = logs.filter(l => l.level === 'trade');
    if (filter === 'errors')  logs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((page - 1) * pageSize, page * pageSize);
    const lines = slice.map(l => {
        const t = (l.ts || '').slice(11, 16);
        const lvl = (l.level || '').padEnd(7);
        return `${t} ${lvl} ${escapeHtml(l.msg).slice(0, 80)}`;
    });
    return [
        `📋 <b>Logs — ${filter} (Page ${page}/${totalPages})</b>`, '',
        '<code>' + (lines.join('\n') || '(empty)') + '</code>',
    ].join('\n');
}

function kb(rows) {
    return { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) };
}
const KB = {
    mainMenu: () => kb([
        [{ text: '📊 Status',     data: 'status' },     { text: '🤖 Scan Now',    data: 'scan_now' }],
        [{ text: '▶️ Start Cycle', data: 'cycle_start' },{ text: '⏸️ Pause Cycle', data: 'cycle_pause' }],
        [{ text: '🎛️ SYN toggle', data: 'syn_toggle' }, { text: '🔄 Mode toggle', data: 'mode_toggle' }],
        [{ text: '📋 Logs',        data: 'logs:1:all' }],
    ]),
    statusScreen: () => kb([[{ text: '🔄 Refresh', data: 'status' }, { text: '🏠 Menu', data: 'menu' }]]),
    logs: (page, filter) => kb([
        [{ text: '⬅️', data: `logs:${Math.max(1, page-1)}:${filter}` },
         { text: '➡️', data: `logs:${page+1}:${filter}` }],
        [{ text: 'All',    data: `logs:1:all` },
         { text: 'Trades', data: `logs:1:trades` },
         { text: 'Errors', data: `logs:1:errors` }],
        [{ text: '🏠 Menu', data: 'menu' }],
    ]),
};
