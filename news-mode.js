/* =====================================================================
   AURELIA — news-mode.js
   ─────────────────────────────────────────────────────────────────────
   News Mode trading engine.

   News Mode is an independent event-driven trading path: on each
   tick, check for an upcoming economic news event, run AI analysis
   on the affected symbol(s), and place a trade ~5 minutes before the
   event fires. When both News Mode and the normal cycle are enabled,
   both paths may run on the same tick with per-symbol overlap guards.

   ── BUG FIXES (this revision) ────────────────────────────────────
   1) Missing news events
      Previously we called Calendar.findQualifyingEvent (singular)
      with a 2-10 min window. With a 5-min cron cadence this dropped
      any event landing in the [0,2) min bucket on a given tick.
      We now use Calendar.findQualifyingEvents (plural) which uses a
      wider 0.5-15 min window — every event is visible on at least
      two consecutive ticks.
   2) Multiple simultaneous events (e.g. NFP + Unemployment Rate +
      Avg Hourly Earnings at the same 12:30 UTC release) were being
      collapsed to a single event, hiding critical context from the
      AI. We now group same-timestamp events into a "bundle" and
      pass the ENTIRE bundle to the AI so its inference is based
      on all releases, not just one.
   ─────────────────────────────────────────────────────────────────

   Public surface:
     runNewsMode(ws, config, state, connOpts, deps)  → ws | undefined
       deps = { placeAndSettle, checkPayoutThreshold }
     buildNewsDecisionPrompt(payload, eventsOrEvent) → string
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
   Normalise the second argument of buildNewsDecisionPrompt to an
   array. Old call sites pass a single event object; new call sites
   pass an array (bundle) of events. Either shape works.
   ───────────────────────────────────────────────────────────────── */
function _asEventArray(eventsOrEvent) {
    if (!eventsOrEvent) return [];
    if (Array.isArray(eventsOrEvent)) return eventsOrEvent.filter(Boolean);
    return [eventsOrEvent];
}

/* ─────────────────────────────────────────────────────────────────
   Prompt builder — same shape as the normal decision prompt but
   prepends explicit news-event context (single event OR a bundle
   of simultaneous events) and requires the rationale to reference
   at least one event by name.
   ───────────────────────────────────────────────────────────────── */
function buildNewsDecisionPrompt(payload, eventsOrEvent) {
    const events = _asEventArray(eventsOrEvent);
    const isBundle = events.length > 1;
    const eventDesc = isBundle
        ? Calendar.describeEvents(events)
        : Calendar.describeEvent(events[0]);

    const schemaHint = JSON.stringify({
        action: '"trade" | "skip"',
        symbol: 'string (one of the symbols in payload.symbols that matches one of the event currencies)',
        direction: '"call" | "put"',
        expiry_seconds: 'integer >= 900 (15m Deriv forex floor)',
        stake: 'number',
        confidence: 'number 0.0-1.0',
        rationale: 'short string that EXPLICITLY names the news event(s) being reacted to and explains why you expect price to move in the chosen direction',
    }, null, 2);

    const bundleGuidance = isBundle
        ? [
            'IMPORTANT — SIMULTANEOUS RELEASE:',
            `  ${events.length} events fire at the same time. You MUST reason about the`,
            '  net effect of ALL of them combined (not just one). Consider whether the',
            '  releases reinforce each other or conflict. If they conflict and there is',
            '  no clear net directional edge, return {"action":"skip"}.',
            '',
        ]
        : [];

    return [
        'You are AURELIA in NEWS MODE. You are trading ahead of an upcoming economic news event.',
        'You are given a structured market snapshot for multiple symbols across M5/M10/M15,',
        'plus session context and the details of the upcoming news event(s).',
        '',
        '=== UPCOMING NEWS EVENT(S) ===',
        eventDesc,
        '=== END NEWS EVENT(S) ===',
        '',
        ...bundleGuidance,
        'Hard rules you MUST obey:',
        '  • Pick AT MOST ONE best setup, or skip.',
        '  • expiry_seconds MUST be >= 900 (15 minutes — Deriv forex intraday floor).',
        '  • stake MUST be between meta.stake_floor and meta.stake_ceiling, max 2 decimals.',
        '  • direction is "call" (price up) or "put" (price down).',
        '  • CRITICAL: Your rationale MUST explicitly name at least one of the news events',
        '    (by title) and explain why you expect it to move price in the chosen direction.',
        '    Do NOT just describe technical/candlestick conditions — this is a news-driven',
        '    trade and the rationale must reference the specific event(s) being reacted to.',
        '  • If the event(s) do not offer a clear directional edge, return {"action":"skip"}.',
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
   but rationale must reference at least one event title in the
   bundle).
   ───────────────────────────────────────────────────────────────── */
function validateNewsDecision(d, config, state, eventsOrEvent) {
    const events = _asEventArray(eventsOrEvent);
    const primaryEvent = events[0] || {};

    const errs = [];
    if (!d || typeof d !== 'object') return { ok: false, errs: ['decision not object'] };
    if (d.action === 'skip') return { ok: true, skip: true };
    if (d.action !== 'trade') errs.push(`action must be "trade" or "skip" (got ${d.action})`);
    if (typeof d.symbol !== 'string' || !d.symbol) errs.push('symbol missing');
    const dir = String(d.direction || '').toLowerCase();
    if (!['call', 'put'].includes(dir)) errs.push(`direction invalid (${d.direction})`);
    if (errs.length) return { ok: false, errs };

    /* Check that rationale references AT LEAST ONE event title in the bundle. */
    const rationale = String(d.rationale || '').toLowerCase();
    let referencesSome = false;
    for (const ev of events) {
        const t = String(ev.title || '').toLowerCase();
        if (!t) continue;
        if (rationale.includes(t)) { referencesSome = true; break; }
        const titleWords = t.split(/\s+/).filter(w => w.length > 3);
        if (titleWords.some(w => rationale.includes(w))) {
            referencesSome = true; break;
        }
    }
    if (!referencesSome && events.length > 0) {
        Logger.warn('News Mode rationale does not reference any event title in bundle', {
            events: events.map(e => e.title),
            rationale: rationale.slice(0, 120),
        });
        /* We don't reject — just warn. A weak rationale is still
           better than silently overriding the AI. */
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

    /* eventTitle used for logging / record — pick the highest-impact
       event in the bundle, or fall back to the primary. */
    const impactRank = { high: 3, medium: 2, low: 1 };
    const chosenEvent = events.slice().sort((a, b) =>
        (impactRank[String(b.impact || '').toLowerCase()] || 0) -
        (impactRank[String(a.impact || '').toLowerCase()] || 0)
    )[0] || primaryEvent;

    return {
        ok: true,
        skip: false,
        normalised: {
            symbol:     d.symbol,
            direction:  dir,
            expirySec:  expiry,
            stake,
            confidence: Number(d.confidence) || 0,
            rationale:  String(d.rationale || ''),
        },
        chosenEvent,
    };
}

/* ─────────────────────────────────────────────────────────────────
   Main news-mode tick.

   Flow:
    1. Check for due scheduled intents → fire if target time reached.
    2. Look for ALL qualifying upcoming events in the calendar.
    3. Group them by fire-time. Take the earliest bucket (soonest
       release) as the bundle to trade on — that's the release the
       market will react to next.
    4. Build AI payload spanning the union of symbols affected by
       every event in the bundle, and pass the full bundle context.
    5. Validate decision → check payout → place trade.
    6. Record trade as 'news' path (separate from cycle/manual).

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
    const firedIntents = await processDueIntents(ws, config, state, connOpts, placeAndSettle, deps);
    if (firedIntents > 0) {
        Logger.info(`News Mode: fired ${firedIntents} scheduled intent(s)`);
    }

    /* ── 2. If a news position is already open → wait ── */
    if (state.news_open_position) {
        Logger.info('News Mode: position open — waiting for settlement', state.news_open_position);
        return ws;
    }

    /* ── 3. Find ALL qualifying upcoming events ── */
    const calendar = state.calendar_data || [];
    if (!Array.isArray(calendar) || calendar.length === 0) {
        Logger.info('News Mode: no calendar data available');
        return ws;
    }

    const qualifyingEvents = Calendar.findQualifyingEvents(calendar);
    if (!qualifyingEvents || qualifyingEvents.length === 0) {
        Logger.info('News Mode: no qualifying upcoming event this tick');
        return ws;
    }

    /* Group by fire-time and pick the earliest bucket. That's the
       release the market is about to react to; later buckets will
       be picked up on subsequent ticks. */
    const timeBuckets = Calendar.groupEventsByTime(qualifyingEvents);
    if (!timeBuckets.length) {
        Logger.info('News Mode: no qualifying upcoming event this tick (post-group)');
        return ws;
    }
    /* groupEventsByTime returns buckets sorted by time ascending →
       first bucket = soonest release. */
    const bundle = timeBuckets[0];

    /* Anchor "closest event" for logging — soonest one in bundle. */
    const primaryEvent = bundle
        .slice()
        .sort((a, b) => Calendar.minutesUntil(a) - Calendar.minutesUntil(b))[0];
    const minsToEvent = Calendar.minutesUntil(primaryEvent);

    Logger.info('News Mode: qualifying event bundle detected', {
        bundle_size: bundle.length,
        titles: bundle.map(e => e.title),
        countries: Array.from(new Set(bundle.map(e => e.country))),
        impacts: bundle.map(e => e.impact),
        minutes_until: Math.round(minsToEvent),
    });

    /* ── 4. Build AI payload for the union of affected symbols ── */
    const affectedSet = new Set();
    for (const ev of bundle) {
        for (const sym of Calendar.eventToSymbols(ev)) affectedSet.add(sym);
    }
    const affectedSymbols = Array.from(affectedSet);
    if (affectedSymbols.length === 0) {
        Logger.info('News Mode: no symbol mapping for any event in bundle', {
            countries: bundle.map(e => e.country),
        });
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

    /* ── 5. Ask AI with news-aware prompt (bundle-aware) ── */
    let decision, keyUsed;
    try {
        const prompt = buildNewsDecisionPrompt(payload, bundle);
        const r = await AIClient.askDecision({ payload, config, state, prompt });
        decision = r.decision; keyUsed = r.keyUsed;
    } catch (e) {
        Logger.error('News Mode: AI decision failed', { error: e.message });
        await Telegram.send(`⚠️ <b>AURELIA</b> — News Mode AI failed: <code>${String(e.message).slice(0,180)}</code>`);
        return ws;
    }

    /* ── 6. Validate decision (bundle-aware) ── */
    const v = validateNewsDecision(decision, config, state, bundle);
    if (!v.ok) {
        Logger.warn('News Mode: invalid AI decision', { errs: v.errs });
        return ws;
    }
    if (v.skip) {
        Logger.info('News Mode: AI chose to skip', { reason: v.reason || decision.rationale });
        return ws;
    }

    const conflict = deps.getSymbolConflict ? deps.getSymbolConflict(v.normalised.symbol) : null;
    if (conflict) {
        Logger.info('News Mode: trade blocked by symbol conflict', {
            symbol: v.normalised.symbol,
            conflict_kind: conflict.kind,
            conflict_by: conflict.by,
        });
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
    if (deps.claimSymbol) deps.claimSymbol(v.normalised.symbol, 'news');

    /* eventTitle used downstream is the chosen (highest-impact)
       event from the bundle; also include the full bundle titles
       so records/telegram show all simultaneous events. */
    const bundleTitles = bundle.map(e => e.title);
    const eventTitleForRecord = (v.chosenEvent && v.chosenEvent.title) || primaryEvent.title;

    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, {
            cycle: false,
            path: 'news',
            connOpts,
            eventTitle: eventTitleForRecord,
            eventBundle: bundleTitles,
            minutesUntil: minsToEvent,
        });
    ws = freshWs || ws;

    /* Store in news-specific history */
    record.event_title  = eventTitleForRecord;
    record.event_bundle = bundleTitles;
    state.trade_history_news = state.trade_history_news || [];
    state.trade_history_news.push(record);

    /* ── 9. Handle settlement / pending ── */
    if (record.settled) {
        applyNewsSettlement(state, record);
        if (deps.applyDailyStat) deps.applyDailyStat(state, record);
    } else if (record.contract_id) {
        state.news_open_position = {
            contract_id: record.contract_id,
            symbol:      record.symbol,
            placed_at:   record.ts,
            event_title: eventTitleForRecord,
            event_bundle: bundleTitles,
        };
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path:        'news',
            symbol:      record.symbol,
            placed_at:   record.ts,
            expiry_sec:  record.expiry_sec,
            event_title: eventTitleForRecord,
            event_bundle: bundleTitles,
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
async function processDueIntents(ws, config, state, connOpts, placeAndSettle, deps) {
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
    let firedCount = 0;
    for (const intent of due) {
        Logger.info('News Mode: firing scheduled intent', {
            symbol: intent.symbol, event: intent.eventTitle,
        });
        try {
            const conflict = deps && deps.getSymbolConflict ? deps.getSymbolConflict(intent.symbol) : null;
            if (conflict) {
                Logger.info('News Mode: scheduled intent blocked by symbol conflict', {
                    symbol: intent.symbol,
                    conflict_kind: conflict.kind,
                    conflict_by: conflict.by,
                });
                continue;
            }
            const norm = {
                symbol:     intent.symbol,
                direction:  intent.direction,
                expirySec:  intent.expirySec,
                stake:      intent.stake,
                confidence: intent.confidence || 0.6,
                rationale:  `[News Mode — scheduled] ${intent.rationale} (event: ${intent.eventTitle})`,
            };
            if (deps && deps.claimSymbol) deps.claimSymbol(intent.symbol, 'news');
            const { record } = await placeAndSettle(ws, norm, config, state, {
                cycle: false,
                path: 'news',
                connOpts,
                eventTitle: intent.eventTitle,
                minutesUntil: 0,
            });

            state.trade_history_news = state.trade_history_news || [];
            record.event_title = intent.eventTitle;
            state.trade_history_news.push(record);
            firedCount += 1;

            if (record.settled) {
                applyNewsSettlement(state, record);
                if (deps && deps.applyDailyStat) deps.applyDailyStat(state, record);
            } else if (record.contract_id) {
                state.news_open_position = {
                    contract_id: record.contract_id,
                    symbol:      record.symbol,
                    placed_at:   record.ts,
                    event_title: intent.eventTitle,
                };
                state.pending_contracts.push({
                    contract_id: record.contract_id,
                    path:        'news',
                    symbol:      record.symbol,
                    placed_at:   record.ts,
                    expiry_sec:  record.expiry_sec,
                    event_title: intent.eventTitle,
                });
            }
        } catch (e) {
            if (deps && deps.releaseSymbol) deps.releaseSymbol(intent.symbol);
            Logger.error('News Mode: scheduled intent failed', {
                error: e.message, intent: intent.id,
            });
            await Telegram.send(`⚠️ <b>News Mode</b> — scheduled intent failed for <code>${intent.symbol}</code>: <code>${String(e.message).slice(0,120)}</code>`);
        }
    }

    state.news_scheduled_intents = remaining;
    return firedCount;
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
