/* =====================================================================
   AURELIA — news-mode.js
   ─────────────────────────────────────────────────────────────────────
   News Mode trading engine.

   When News Mode is enabled, the normal cycle-trading logic is
   replaced by event-driven trading: on each tick, check for an
   upcoming economic news event, run AI analysis on the affected
   symbol(s), and place a trade ~5 minutes before the event fires.

   Public surface:
     runNewsMode(ws, config, state, connOpts, deps)  → ws | undefined
       deps = { placeAndSettle, checkPayoutThreshold }
     buildNewsDecisionPrompt(payload, event)          → string
   ===================================================================== */

'use strict';

const Logger       = require('./logger');
const Calendar     = require('./calendar');
const Payload      = require('./payload-builder');
const AIClient     = require('./ai-client');
const Risk         = require('./risk');
const Telegram     = require('./telegram');

/* Window (minutes) within which we consider a scheduled intent "due"
   and should fire the trade. Must be >= the cron interval so we don't
   miss intents between ticks. */
const INTENT_DUE_WINDOW_MIN = 3;

/* ─────────────────────────────────────────────────────────────────
   Prompt builder — same shape as the normal decision prompt but
   prepends explicit news-event context and requires the rationale
   to reference the news event by name.
   ───────────────────────────────────────────────────────────────── */
function buildNewsDecisionPrompt(payload, event) {
    const eventDesc = Calendar.describeEvent(event);
    const schemaHint = JSON.stringify({
        action: '"trade" | "skip"',
        symbol: 'string (one of the symbols in payload.symbols that matches the event currency)',
        direction: '"call" | "put"',
        expiry_seconds: 'integer >= 900 (15m Deriv forex floor)',
        stake: 'number',
        confidence: 'number 0.0-1.0',
        rationale: 'short string that EXPLICITLY names the news event and explains why you expect it to move price in the chosen direction',
    }, null, 2);

    return [
        'You are AURELIA in NEWS MODE. You are trading ahead of an upcoming economic news event.',
        'You are given a structured market snapshot for multiple symbols across M5/M10/M15,',
        'plus session context and the details of the upcoming news event.',
        '',
        '=== UPCOMING NEWS EVENT ===',
        eventDesc,
        '=== END NEWS EVENT ===',
        '',
        'Hard rules you MUST obey:',
        '  • Pick AT MOST ONE best setup, or skip.',
        '  • expiry_seconds MUST be >= 900 (15 minutes — Deriv forex intraday floor).',
        '  • stake MUST be between meta.stake_floor and meta.stake_ceiling, max 2 decimals.',
        '  • direction is "call" (price up) or "put" (price down).',
        '  • CRITICAL: Your rationale MUST explicitly name the news event (title) and explain',
        '    why you expect it to move price in the chosen direction. Do NOT just describe',
        '    technical/candlestick conditions — this is a news-driven trade and the rationale',
        '    must reference the specific event being reacted to.',
        '  • If the event does not offer a clear directional edge, return {"action":"skip"}.',
        '',
        'Return STRICT JSON only (no markdown fences):',
        schemaHint,
        '',
        'Market + session payload:',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────
   Validate a news-mode AI decision (same shape as normal cycle,
   but rationale must reference the event title).
   ───────────────────────────────────────────────────────────────── */
function validateNewsDecision(d, config, state, event) {
    const errs = [];
    if (!d || typeof d !== 'object') return { ok: false, errs: ['decision not object'] };
    if (d.action === 'skip') return { ok: true, skip: true };
    if (d.action !== 'trade') errs.push(`action must be "trade" or "skip" (got ${d.action})`);
    if (typeof d.symbol !== 'string' || !d.symbol) errs.push('symbol missing');
    const dir = String(d.direction || '').toLowerCase();
    if (!['call', 'put'].includes(dir)) errs.push(`direction invalid (${d.direction})`);
    if (errs.length) return { ok: false, errs };

    /* Check that rationale references the news event */
    const rationale = String(d.rationale || '');
    const eventTitle = String(event.title || '').toLowerCase();
    if (eventTitle && !rationale.toLowerCase().includes(eventTitle)) {
        /* Be lenient — if the title is very long, a partial match is ok */
        const titleWords = eventTitle.split(/\s+/).filter(w => w.length > 3);
        const hasPartial = titleWords.some(w => rationale.toLowerCase().includes(w));
        if (!hasPartial) {
            Logger.warn('News Mode rationale does not reference event title', {
                event: event.title, rationale: rationale.slice(0, 120),
            });
            /* We don't reject — just warn. The user review requirement is
               that the rationale should reference the event, but a weak
               rationale is still better than silently overriding the AI. */
        }
    }

    const expiry = Risk.clampExpirySeconds(d.expiry_seconds, config);
    const minConf = (config.ai && config.ai.min_confidence) || 0;
    if (Number(d.confidence) < minConf) {
        return { ok: true, skip: true, reason: `confidence ${d.confidence} < ${minConf}` };
    }

    /* Symbol enable check — must be a forex symbol (news mode only trades forex) */
    const fx = (config.symbols && config.symbols.forex) || {};
    if (!fx[d.symbol]) {
        return { ok: true, skip: true, reason: `symbol ${d.symbol} not in forex pool` };
    }
    if (config.frx_enabled === false) {
        return { ok: true, skip: true, reason: 'FRX master gate disabled' };
    }

    const stakeOpts = {
        cycleSessionRemaining: (state.cycle_session && state.cycle_session.capital_remaining),
    };
    const stake = Risk.clampStake(d.stake, config, stakeOpts);

    return {
        ok: true,
        skip: false,
        normalised: {
            symbol:     d.symbol,
            direction:  dir,
            expirySec:  expiry,
            stake,
            confidence: Number(d.confidence) || 0,
            rationale:  rationale,
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
   Main news-mode tick.

   Flow:
    1. Check for due scheduled intents → fire if target time reached.
    2. Look for a qualifying upcoming event in the calendar.
    3. If event found → build AI payload with news context → ask AI.
    4. Validate decision → check payout → place trade.
    5. Record trade as 'news' path (separate from cycle/manual).

   deps = { placeAndSettle(ws, norm, config, state, opts), checkPayoutThreshold(ws, norm, config) }
   ───────────────────────────────────────────────────────────────── */
async function runNewsMode(ws, config, state, connOpts, deps) {
    deps = deps || {};
    const placeAndSettle = deps.placeAndSettle;
    const checkPayoutThreshold = deps.checkPayoutThreshold;

    if (!placeAndSettle) {
        Logger.error('News Mode: placeAndSettle not provided in deps');
        return ws;
    }

    /* ── 1. Process due scheduled intents (bot-side timing fallback) ── */
    const firedIntents = await processDueIntents(ws, config, state, connOpts, placeAndSettle);
    if (firedIntents > 0) {
        Logger.info(`News Mode: fired ${firedIntents} scheduled intent(s)`);
    }

    /* ── 2. If a news position is already open → wait ── */
    if (state.news_open_position) {
        Logger.info('News Mode: position open — waiting for settlement', state.news_open_position);
        return ws;
    }

    /* ── 3. Find qualifying upcoming event ── */
    const calendar = state.calendar_data || [];
    if (!Array.isArray(calendar) || calendar.length === 0) {
        Logger.info('News Mode: no calendar data available');
        return ws;
    }

    const event = Calendar.findQualifyingEvent(calendar);
    if (!event) {
        Logger.info('News Mode: no qualifying upcoming event this tick');
        return ws;
    }

    const minsToEvent = Calendar.minutesUntil(event);
    Logger.info('News Mode: qualifying event detected', {
        title: event.title, country: event.country,
        impact: event.impact, minutes_until: Math.round(minsToEvent),
    });

    /* ── 4. Build AI payload for the affected symbol(s) ── */
    const affectedSymbols = Calendar.eventToSymbols(event);
    if (affectedSymbols.length === 0) {
        Logger.info(`News Mode: no symbol mapping for currency ${event.country}`);
        return ws;
    }

    /* Build a focused payload: only the affected symbols, not the whole pool.
       This keeps the prompt lean and relevant. */
    let payload;
    try {
        payload = await buildNewsPayload(ws, config, state, affectedSymbols);
    } catch (e) {
        Logger.error('News Mode: payload build failed', { error: e.message });
        return ws;
    }

    /* ── 5. Ask AI with news-aware prompt ── */
    let decision, keyUsed;
    try {
        const prompt = buildNewsDecisionPrompt(payload, event);
        const r = await AIClient.askDecision({ payload, config, state, prompt });
        decision = r.decision; keyUsed = r.keyUsed;
    } catch (e) {
        Logger.error('News Mode: AI decision failed', { error: e.message });
        await Telegram.send(`⚠️ <b>AURELIA</b> — News Mode AI failed: <code>${String(e.message).slice(0,180)}</code>`);
        return ws;
    }

    /* ── 6. Validate decision ── */
    const v = validateNewsDecision(decision, config, state, event);
    if (!v.ok) {
        Logger.warn('News Mode: invalid AI decision', { errs: v.errs });
        return ws;
    }
    if (v.skip) {
        Logger.info('News Mode: AI chose to skip', { reason: v.reason || decision.rationale });
        return ws;
    }

    /* ── 7. Payout-threshold filter (same as cycle) ── */
    if (checkPayoutThreshold) {
        const pay = await checkPayoutThreshold(ws, v.normalised, config);
        if (!pay.ok) {
            const msg = `payout ${(pay.ratio * 100).toFixed(1)}% < threshold ${(pay.threshold * 100).toFixed(0)}%`;
            Logger.info('News Mode: trade blocked by payout filter', { symbol: v.normalised.symbol, ratio: pay.ratio, threshold: pay.threshold });
            try {
                await Telegram.send(`🛑 <b>News Mode</b> — skipped (<code>${v.normalised.symbol}</code>): ${msg}`);
            } catch (_) {}
            return ws;
        }
    }

    /* ── 8. Place trade ── */
    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: false, connOpts });
    ws = freshWs || ws;

    /* Store in news-specific history */
    state.trade_history_news = state.trade_history_news || [];
    state.trade_history_news.push(record);

    /* ── 9. Handle settlement / pending ── */
    if (record.settled) {
        applyNewsSettlement(state, record);
    } else if (record.contract_id) {
        state.news_open_position = {
            contract_id: record.contract_id,
            symbol:      record.symbol,
            placed_at:   record.ts,
            event_title: event.title,
        };
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path:        'news',
            symbol:      record.symbol,
            placed_at:   record.ts,
            expiry_sec:  record.expiry_sec,
        });
    }

    return ws;
}

/* ─────────────────────────────────────────────────────────────────
   Build a focused payload for news-mode: only the affected symbols.
   ───────────────────────────────────────────────────────────────── */
async function buildNewsPayload(ws, config, state, symbols) {
    const slices = [];
    for (const sym of symbols) {
        slices.push(await Payload.buildSymbolSlice(ws, sym));
    }

    return {
        meta: {
            generated_at: new Date().toISOString(),
            account_mode: state.account_mode || config.account.mode,
            frx_enabled:  config.frx_enabled !== false,
            syn_enabled:  false, /* news mode never trades synthetics */
            min_expiry_seconds: (config.expiry && config.expiry.min_seconds) || 900,
            stake_floor:   (config.stake && config.stake.absolute_min) || 0.35,
            stake_ceiling: (config.stake && config.stake.absolute_max) || 10000,
        },
        symbols: slices,
        session: Payload.buildSessionContext(state, config),
    };
}

/* ─────────────────────────────────────────────────────────────────
   Scheduled intents — bot-side timing for news events.

   Since Deriv's forex binary contracts (CALL/PUT) do not support
   true pending/scheduled entries at a future timestamp (confirmed
   via API inspection — no `date_start` parameter in the `buy`
   request), bot-side cron-driven timing is the sole mechanism.

   Intent shape:
     { id, symbol, direction, stake, expirySec, targetMs, eventTitle,
       createdAt, rationale }
   ───────────────────────────────────────────────────────────────── */

function scheduleIntent(state, intent) {
    state.news_scheduled_intents = state.news_scheduled_intents || [];
    state.news_scheduled_intents.push(intent);
    Logger.info('News Mode: scheduled intent', {
        symbol: intent.symbol, target: new Date(intent.targetMs).toISOString(),
        event: intent.eventTitle,
    });
}

/* Process any scheduled intents whose target time has arrived.
   Returns the count of intents that were fired. */
async function processDueIntents(ws, config, state, connOpts, placeAndSettle) {
    if (!placeAndSettle) return 0;
    const intents = state.news_scheduled_intents || [];
    if (intents.length === 0) return 0;

    const now = Date.now();
    const due = [];
    const remaining = [];

    for (const intent of intents) {
        if (now >= intent.targetMs || (now >= intent.targetMs - INTENT_DUE_WINDOW_MIN * 60000)) {
            due.push(intent);
        } else {
            remaining.push(intent);
        }
    }

    if (due.length === 0) {
        state.news_scheduled_intents = remaining;
        return 0;
    }

    /* Fire each due intent */
    for (const intent of due) {
        Logger.info('News Mode: firing scheduled intent', {
            symbol: intent.symbol, event: intent.eventTitle,
        });
        try {
            const norm = {
                symbol:     intent.symbol,
                direction:  intent.direction,
                expirySec:  intent.expirySec,
                stake:      intent.stake,
                confidence: intent.confidence || 0.6,
                rationale:  `[News Mode — scheduled] ${intent.rationale} (event: ${intent.eventTitle})`,
            };
            const { record } = await placeAndSettle(ws, norm, config, state, { cycle: false, connOpts });

            state.trade_history_news = state.trade_history_news || [];
            state.trade_history_news.push(record);

            if (record.settled) {
                applyNewsSettlement(state, record);
            } else if (record.contract_id) {
                state.pending_contracts.push({
                    contract_id: record.contract_id,
                    path:        'news',
                    symbol:      record.symbol,
                    placed_at:   record.ts,
                    expiry_sec:  record.expiry_sec,
                });
            }
        } catch (e) {
            Logger.error('News Mode: scheduled intent failed', {
                error: e.message, intent: intent.id,
            });
            await Telegram.send(`⚠️ <b>News Mode</b> — scheduled intent failed for <code>${intent.symbol}</code>: <code>${String(e.message).slice(0,120)}</code>`);
        }
    }

    state.news_scheduled_intents = remaining;
    return due.length;
}

/* ─────────────────────────────────────────────────────────────────
   Settlement tracking for news-mode trades.
   Uses the same session envelope as cycle trades (capital_remaining,
   P/L, etc.) so TP/SL and daily stats still apply correctly.
   ───────────────────────────────────────────────────────────────── */
function applyNewsSettlement(state, record) {
    /* News trades contribute to the same cycle session counters so
       TP/SL and daily stats apply seamlessly. */
    const sess = state.cycle_session;
    if (!sess) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    sess.capital_remaining = Number(
        ((sess.capital_remaining || 0) + Number(record.stake || 0) + pnl).toFixed(2)
    );
    if (record.outcome === 'win') {
        sess.wins = (sess.wins || 0) + 1;
        sess.win_streak = (sess.win_streak || 0) + 1;
        sess.loss_streak = 0;
    } else if (record.outcome === 'loss') {
        sess.losses = (sess.losses || 0) + 1;
        sess.loss_streak = (sess.loss_streak || 0) + 1;
        sess.win_streak = 0;
    }
    /* TP/SL enforcement */
    if (sess.take_profit > 0 && sess.pnl >= sess.take_profit) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `take_profit reached (+${sess.pnl})`;
    }
    if (sess.stop_loss > 0 && sess.pnl <= -sess.stop_loss) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `stop_loss reached (${sess.pnl})`;
    }
    if (sess.capital_remaining <= 0) {
        sess.active = false;
        sess.halted = true;
        sess.halt_reason = `capital exhausted`;
    }
}

module.exports = {
    runNewsMode,
    buildNewsDecisionPrompt,
    validateNewsDecision,
    buildNewsPayload,
    scheduleIntent,
    processDueIntents,
    applyNewsSettlement,
};
