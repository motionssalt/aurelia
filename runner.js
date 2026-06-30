/* =====================================================================
   AURELIA — runner.js
   ─────────────────────────────────────────────────────────────────────
   One serverless invocation = one tick of work. Four task modes,
   selected by INPUT_TASK (see .github/workflows/aurelia-cron.yml):

     • task=cycle         (default) → tick the AI cycle state machine
     • task=manual                  → fire one immediate AI trade outside the cycle
     • task=settle_only             → just settle any pending contracts (cheap)
     • task=daily_summary           → emit today's stats + reset daily_stats

   Cycle state machine (REBUILD_PROMPT §2A):
     1. Load config + last-status
     2. Settle any pending contracts (cycle + manual)
     3. If a cycle position is OPEN and unsettled → do nothing else this tick
     4. If cycle paused (config.cycle.running=false) → skip
     5. If session.halted → skip
     6. If now < next_cycle_eligible_at (post-settlement cooldown) → skip
     7. Build AI payload, ask Gemini for decision
     8. Validate, clamp (stake + expiry), per-symbol enable check,
        payout-threshold check, then place trade
     9. Record as cycle trade; set next_cycle_eligible_at after settlement

   Session TP/SL is enforced HERE, in code, not by the AI.

   Manual path (REBUILD_PROMPT §2B):
     • Reads INPUT_PAYLOAD for {action:"scan"|"trade_now", ...}
     • Ignores cycle_open_position lock
     • Does NOT touch cycle_session counters
     • Logged into trade_history_manual

   Daily summary (NEW):
     • cron-job.org POSTs {task:"daily_summary"} at 00:00 UTC
     • Reads state.daily_stats (accumulated by applyDailyStat() on every
       settled trade), emits the Telegram dailySummary message,
       optionally resets the counter to a fresh day.
   ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const Logger      = require('./logger');
const Deriv       = require('./deriv');
const Telegram    = require('./telegram');
const Chart       = require('./chart');
const Risk        = require('./risk');
const AIClient    = require('./ai-client');
const Payload     = require('./payload-builder');

const CFG_PATH   = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'last-status.json');

const HARD_BUDGET_MS = 55000;

/* ─────────────────────────────────────────────────────────────────
   IO
   ───────────────────────────────────────────────────────────────── */
function readJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJSON(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function detectTask() {
    const t = (process.env.INPUT_TASK || 'cycle').toLowerCase();
    if (['cycle', 'manual', 'settle_only', 'daily_summary'].includes(t)) return t;
    return 'cycle';
}

/* ─────────────────────────────────────────────────────────────────
   Symbol helpers — handle the {forex:{...}, synthetics:{...}} schema
   ───────────────────────────────────────────────────────────────── */
function isSyntheticSymbol(sym) {
    return /^R_\d+$|^1HZ\d+V$|^BOOM|^CRASH|^JD\d+$|^stpRNG/.test(sym);
}
function isSymbolEnabled(sym, config) {
    if (!sym || !config || !config.symbols) return false;
    const fx  = config.symbols.forex      || {};
    const syn = config.symbols.synthetics || {};
    if (isSyntheticSymbol(sym)) {
        if (!config.syn_enabled) return false;
        return !!syn[sym];
    }
    // FRX (forex) master gate — defaults to true if not explicitly set
    if (config.frx_enabled === false) return false;
    return !!fx[sym];
}

/* ─────────────────────────────────────────────────────────────────
   Payout filter — fetch a Deriv proposal for the chosen contract and
   reject it if the implied payout ratio is below threshold.
   Threshold resolution order:
       config.payout.per_symbol[symbol]  →  config.payout.min_threshold
   Set config.payout.enabled = false to bypass entirely.
   ───────────────────────────────────────────────────────────────── */
function resolvePayoutThreshold(sym, config) {
    const p = (config && config.payout) || {};
    if (p.per_symbol && Number.isFinite(Number(p.per_symbol[sym]))) {
        return Number(p.per_symbol[sym]);
    }
    return Number.isFinite(Number(p.min_threshold)) ? Number(p.min_threshold) : 0.80;
}
async function checkPayoutThreshold(ws, norm, config) {
    const p = (config && config.payout) || {};
    if (p.enabled === false) return { ok: true, ratio: null, threshold: null };
    const threshold = resolvePayoutThreshold(norm.symbol, config);
    try {
        const minutes = Risk.expirySecondsToMinutes(norm.expirySec);
        const reply = await Deriv.request(ws, {
            proposal: 1,
            amount: norm.stake,
            basis: 'stake',
            contract_type: norm.direction === 'call' ? 'CALL' : 'PUT',
            currency: 'USD',
            duration: minutes,
            duration_unit: 'm',
            symbol: norm.symbol,
        }, 10000);
        const prop = reply && reply.proposal;
        if (!prop) return { ok: true, ratio: null, threshold, soft: 'no_proposal' };
        const ask    = Number(prop.ask_price)   || Number(norm.stake);
        const payout = Number(prop.payout)      || 0;
        const ratio  = ask > 0 ? (payout / ask - 1) : 0;
        return {
            ok:        ratio >= threshold,
            ratio,
            threshold,
            payout,
            ask,
        };
    } catch (e) {
        Logger.warn('payout proposal failed; allowing trade', { error: e.message });
        return { ok: true, ratio: null, threshold, soft: 'proposal_error' };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Daily stats — cumulative counter for the rolling UTC day. Reset by
   the daily_summary task. Independent of cycle_session.
   ───────────────────────────────────────────────────────────────── */
function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}
function ensureDailyStats(state) {
    if (!state.daily_stats || state.daily_stats.date !== todayUTC()) {
        state.daily_stats = {
            date:    todayUTC(),
            trades:  0,
            wins:    0,
            losses:  0,
            pnl:     0,
            by_symbol: {},
        };
    }
    return state.daily_stats;
}
function applyDailyStat(state, record) {
    const ds = ensureDailyStats(state);
    ds.trades += 1;
    const pnl = Number(record.pnl || 0);
    ds.pnl = Number((ds.pnl + pnl).toFixed(2));
    if (record.outcome === 'win')  ds.wins   += 1;
    if (record.outcome === 'loss') ds.losses += 1;
    const bs = ds.by_symbol[record.symbol] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    bs.trades += 1;
    bs.pnl     = Number((bs.pnl + pnl).toFixed(2));
    if (record.outcome === 'win')  bs.wins   += 1;
    if (record.outcome === 'loss') bs.losses += 1;
    ds.by_symbol[record.symbol] = bs;
}

/* ─────────────────────────────────────────────────────────────────
   Validate AI decision (defence in depth, even though prompt says ≥900s)
   ───────────────────────────────────────────────────────────────── */
function validateDecision(d, config, state, opts) {
    const errs = [];
    if (!d || typeof d !== 'object') return { ok: false, errs: ['decision not object'] };
    if (d.action === 'skip') return { ok: true, skip: true };
    if (d.action !== 'trade') errs.push(`action must be "trade" or "skip" (got ${d.action})`);
    if (typeof d.symbol !== 'string' || !d.symbol) errs.push('symbol missing');
    const dir = String(d.direction || '').toLowerCase();
    if (!['call', 'put'].includes(dir)) errs.push(`direction invalid (${d.direction})`);
    if (errs.length) return { ok: false, errs };

    const expiry = Risk.clampExpirySeconds(d.expiry_seconds, config);
    const minConf = (config.ai && config.ai.min_confidence) || 0;
    if (Number(d.confidence) < minConf) {
        return { ok: true, skip: true, reason: `confidence ${d.confidence} < ${minConf}` };
    }

    if (!isSymbolEnabled(d.symbol, config)) {
        return { ok: true, skip: true, reason: `symbol ${d.symbol} disabled in config` };
    }

    let stakeOpts = {};
    if (opts && opts.cycle) {
        stakeOpts = { cycleSessionRemaining: (state.cycle_session && state.cycle_session.capital_remaining) };
    } else if (opts && opts.manual) {
        // Manual trades clamp against the MANUAL session capital_remaining
        stakeOpts = { cycleSessionRemaining: (state.manual_session && state.manual_session.capital_remaining) };
    }
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
            rationale:  String(d.rationale || ''),
        },
    };
}

/* ─────────────────────────────────────────────────────────────────
   Place a single trade (cycle OR manual). Returns the trade record.
   ───────────────────────────────────────────────────────────────── */
async function placeAndSettle(ws, norm, config, state, opts) {
    const contractType = norm.direction === 'call' ? 'CALL' : 'PUT';
    const minutes      = Risk.expirySecondsToMinutes(norm.expirySec);
    const mode         = (config.account && config.account.mode) || 'demo';
    const isCycle      = !!(opts && opts.cycle);

    // The Deriv socket may have gone stale while we waited on the AI
    // decision — ANY slow AI provider can trigger this (Gemini long
    // think-time, OpenRouter reasoning models like NVIDIA Nemotron that
    // "think" before answering, etc.). We pass an explicit `context`
    // so the recovery log line clearly identifies the stale-after-AI
    // path, and a short timeout so a genuinely dead connection fails
    // cleanly (logged exactly as it does today) instead of hanging.
    // This check happens IMMEDIATELY before every trade placement
    // call site, not just one — placeAndSettle is the single trade-
    // placement path in this repo (both the cycle and manual /scan
    // call sites funnel through here).
    if (opts && opts.connOpts) {
        ws = await Deriv.ensureOpen(ws, opts.connOpts, {
            context:   'trade placement',
            timeoutMs: 8000,
        });
    }

    let placedNotified = false;
    let contractIdShown = null;

    const contract = await Deriv.placeTrade(ws,
        {
            symbol:        norm.symbol,
            contractType,
            stake:         norm.stake,
            duration:      minutes,
            durationUnit:  'm',
        },
        {
            onPlaced: async ({ proposal, buy }) => {
                contractIdShown = buy.contract_id;
                // -----------------------------------------------------
                // Provisional capital HOLD — deduct stake from
                // capital_remaining the moment the buy is accepted, so
                // concurrent ticks can't overspend before settlement.
                // applyCycleSettlement / applyManualSettlement add back
                // `stake + pnl` on settle, leaving the math correct.
                // -----------------------------------------------------
                if (isCycle && state.cycle_session) {
                    state.cycle_session.capital_remaining = Number(
                        ((state.cycle_session.capital_remaining || 0) - norm.stake).toFixed(2)
                    );
                } else if (!isCycle && state.manual_session) {
                    state.manual_session.capital_remaining = Number(
                        ((state.manual_session.capital_remaining || 0) - norm.stake).toFixed(2)
                    );
                }
                try {
                    await Telegram.send(Telegram.templates.tradePlaced({
                        symbol:       norm.symbol,
                        mode,
                        direction:    contractType,
                        stake:        norm.stake,
                        duration:     minutes,
                        durationUnit: 'm',
                        strategy:     isCycle ? 'aurelia/cycle' : 'aurelia/manual',
                        contractId:   buy.contract_id,
                    }));
                    placedNotified = true;
                } catch (e) {
                    Logger.warn('Telegram tradePlaced failed', { error: e.message });
                }
                // Best-effort chart attached to placement notification.
                // chart.js already does one internal retry; we treat a
                // missing chart as a recoverable signal-side issue and
                // surface a small notice so the user knows the trade
                // itself was placed even when the visual didn't make it.
                try {
                    const buf = await Chart.generateChart(ws, norm.symbol, '5m');
                    if (buf && buf.length > 1024) {
                        await Telegram.sendPhoto(buf,
                            `${norm.symbol} • ${contractType} • ${norm.stake} USD • ${minutes}m\n` +
                            `Why: ${norm.rationale}`);
                    } else {
                        Logger.warn('Chart generation returned no usable buffer', {
                            symbol: norm.symbol,
                            bytes: buf ? buf.length : 0,
                        });
                        await Telegram.send(`📉 <i>Chart unavailable for <code>${norm.symbol}</code> — trade placed without chart attachment.</i>`).catch(() => {});
                    }
                } catch (e) {
                    Logger.warn('Chart generation failed (entry)', { error: e.message });
                    await Telegram.send(`📉 <i>Chart render failed for <code>${norm.symbol}</code> (<code>${String(e.message).slice(0,120)}</code>) — trade placed without chart.</i>`).catch(() => {});
                }
            },
            settleWaitMs: HARD_BUDGET_MS - 8000,
        }
    );

    // Build a stable trade record. CRITICAL: contract.settled is the
    // proposal_open_contract snapshot returned by Deriv — it may be a
    // terminal (is_sold/won/lost) snapshot OR a non-terminal "timeout"
    // snapshot. We must inspect is_sold/status to decide.
    const poc = (contract && contract.settled) || {};
    const isTerminal =
        !!poc.is_sold ||
        poc.status === 'sold' ||
        poc.status === 'won'  ||
        poc.status === 'lost';

    let outcome = 'pending';
    let pnl     = 0;
    let entry   = undefined;
    let exit    = undefined;

    if (isTerminal) {
        pnl = Number(poc.profit || 0);
        outcome = pnl > 0 ? 'win' : (pnl < 0 ? 'loss' : 'breakeven');
        entry = poc.entry_spot;
        exit  = poc.exit_tick || poc.sell_spot;
    }

    const record = {
        ts:         new Date().toISOString(),
        path:       isCycle ? 'cycle' : 'manual',
        symbol:     norm.symbol,
        direction:  norm.direction,
        stake:      norm.stake,
        expiry_sec: norm.expirySec,
        confidence: norm.confidence,
        rationale:  norm.rationale,
        contract_id: contract && contract.buy ? contract.buy.contract_id : contractIdShown,
        settled:    isTerminal,
        outcome,
        entry,
        exit,
        pnl,
        ai_outcome_note: null,
    };

    return { record, contract, ws, isTerminal };
}

/* ─────────────────────────────────────────────────────────────────
   Settle a pending contract record. Mutates `pending` entry, returns
   { settled: bool, outcome, pnl, exit, entry } when terminal.
   ───────────────────────────────────────────────────────────────── */
async function settlePending(ws, pending) {
    try {
        const reply = await Deriv.request(ws, {
            proposal_open_contract: 1,
            contract_id: pending.contract_id,
        }, 10000);
        const poc = reply.proposal_open_contract;
        if (!poc) return { settled: false };
        if (poc.is_sold) {
            const profit = Number(poc.profit || 0);
            return {
                settled: true,
                outcome: profit > 0 ? 'win' : profit < 0 ? 'loss' : 'breakeven',
                pnl:     profit,
                entry:   poc.entry_spot,
                exit:    poc.exit_tick || poc.sell_spot,
            };
        }
        return { settled: false };
    } catch (e) {
        Logger.warn(`settle ${pending.contract_id} failed`, { error: e.message });
        return { settled: false };
    }
}

/* ─────────────────────────────────────────────────────────────────
   Apply settlement to session counters (cycle only). Enforces TP/SL.
   ───────────────────────────────────────────────────────────────── */
function applyCycleSettlement(state, record) {
    const sess = state.cycle_session;
    if (!sess) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    // At placement we deducted the stake as a provisional hold. The
    // actual P&L delta (profit-or-loss above the stake) reconciles
    // capital_remaining to the correct post-trade value:
    //   loss:  hold = -stake; settle adds +(-stake)? NO — Deriv reports
    //          profit as a signed delta from the stake (e.g. -10 on a
    //          $10 loss, or +8.5 on a $10 win paying $18.5). So adding
    //          `stake + profit` here correctly returns the returned
    //          capital after a trade closes.
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
    // TP / SL enforcement
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

/* ─────────────────────────────────────────────────────────────────
   Apply settlement to manual session counters (separate envelope).
   Manual session resets daily via ensureManualSession() — no TP/SL
   halt loop needed (manual is fire-and-forget), but we still track
   capital_remaining and stop sizing when it drops to zero.
   ───────────────────────────────────────────────────────────────── */
function applyManualSettlement(state, record) {
    const sess = state.manual_session;
    if (!sess) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    sess.capital_remaining = Number(
        ((sess.capital_remaining || 0) + Number(record.stake || 0) + pnl).toFixed(2)
    );
    if (record.outcome === 'win')  sess.wins   = (sess.wins   || 0) + 1;
    if (record.outcome === 'loss') sess.losses = (sess.losses || 0) + 1;
}

/* ─────────────────────────────────────────────────────────────────
   Ensure a manual_session envelope exists, rolling daily. Capital,
   TP and SL come from config.manual; the session resets to a fresh
   envelope every UTC day.
   ───────────────────────────────────────────────────────────────── */
function ensureManualSession(state, config) {
    const today = todayUTC();
    const cfgManual = (config && config.manual) || {};
    const cap = Number(cfgManual.capital || 0);
    const tp  = Number(cfgManual.take_profit || 0);
    const sl  = Number(cfgManual.stop_loss   || 0);
    if (!state.manual_session || state.manual_session.date !== today) {
        state.manual_session = {
            date:              today,
            active:            true,
            capital_start:     cap,
            capital_remaining: cap,
            take_profit:       tp,
            stop_loss:         sl,
            trades: 0, wins: 0, losses: 0, pnl: 0,
        };
    } else {
        // Keep envelope params live with current config (so editing
        // config.manual takes effect immediately on the next trade).
        state.manual_session.take_profit = tp;
        state.manual_session.stop_loss   = sl;
    }
    return state.manual_session;
}

/* ─────────────────────────────────────────────────────────────────
   Settle ALL outstanding pending contracts (cycle + manual). For
   newly-terminal ones, optionally fire a post-mortem AI call to
   capture an `ai_outcome_note`.
   ───────────────────────────────────────────────────────────────── */
async function settleAllPending(ws, config, state) {
    if (!Array.isArray(state.pending_contracts)) state.pending_contracts = [];
    const still = [];
    const newlySettled = [];
    for (const p of state.pending_contracts) {
        const r = await settlePending(ws, p);
        if (!r.settled) { still.push(p); continue; }
        // Patch the trade history record by contract_id
        const histArr = p.path === 'manual'
            ? state.trade_history_manual
            : state.trade_history_cycle;
        const rec = (histArr || []).find(t => t.contract_id === p.contract_id);
        if (rec) {
            rec.settled = true;
            rec.outcome = r.outcome;
            rec.pnl     = r.pnl;
            rec.entry   = r.entry;
            rec.exit    = r.exit;
            newlySettled.push({ rec, path: p.path });
            if (p.path === 'cycle')  applyCycleSettlement(state, rec);
            if (p.path === 'manual') applyManualSettlement(state, rec);
            applyDailyStat(state, rec);
            // Clear cycle position lock if this was the open cycle position
            if (p.path === 'cycle' && state.cycle_open_position &&
                state.cycle_open_position.contract_id === p.contract_id) {
                state.cycle_open_position = null;
                state.next_cycle_eligible_at =
                    Date.now() + 1000 * ((config.cycle && config.cycle.interval_seconds) || 60);
            }
        }
    }
    state.pending_contracts = still;

    // Detect cycle-session halt transitions caused by the settlements
    // we just applied (TP / SL / capital exhaustion). We snapshot the
    // halted flag BEFORE applyCycleSettlement runs and compare against
    // the post-state here so we only notify on the actual transition.
    if (state.cycle_session
        && state.cycle_session.halted
        && !state._notified_halt_reason) {
        const reason = String(state.cycle_session.halt_reason || '');
        let kind = 'other';
        if (/take_profit/i.test(reason)) kind = 'take_profit';
        else if (/stop_loss/i.test(reason)) kind = 'stop_loss';
        else if (/capital/i.test(reason)) kind = 'capital';
        try {
            await Telegram.send(Telegram.templates.sessionHalted({
                kind,
                reason,
                mode:     state.account_mode || (config.account && config.account.mode),
                session:  {
                    wins:              state.cycle_session.wins,
                    losses:            state.cycle_session.losses,
                    pnl:               state.cycle_session.pnl,
                    trades:            state.cycle_session.trades,
                    capital_remaining: state.cycle_session.capital_remaining,
                },
                balance:  state.balance,
                currency: state.currency,
            }));
            // Latch so we don't re-notify on every subsequent tick while
            // the session stays halted. Cleared in startCycleSession().
            state._notified_halt_reason = reason;
        } catch (e) {
            Logger.warn('sessionHalted notification failed', { error: e.message });
        }
    }

    // Fire settled notifications + post-mortems
    for (const { rec } of newlySettled) {
        try {
            await Telegram.send(Telegram.templates.cycleResult({
                result:   rec.outcome,
                symbol:   rec.symbol,
                mode:     state.account_mode || config.account.mode,
                entry:    rec.entry,
                exit:     rec.exit,
                pnl:      rec.pnl,
                strategy: `aurelia/${rec.path}`,
                duration: Risk.expirySecondsToMinutes(rec.expiry_sec || 900),
                durationUnit: 'm',
                balance:  state.balance,
                currency: state.currency,
                session:  rec.path === 'cycle' ? {
                    wins: state.cycle_session.wins,
                    losses: state.cycle_session.losses,
                    pnl: state.cycle_session.pnl,
                    trades: state.cycle_session.trades,
                } : null,
            }));
        } catch (e) {
            Logger.warn('cycleResult notification failed', { error: e.message });
        }
        // Post-mortem (best-effort) — uses post-entry M5 candles
        try {
            const post = await Deriv.ticksHistory(ws, rec.symbol, 300, 20).catch(() => []);
            const note = await AIClient.askPostMortem({
                trade: rec,
                postEntryCandles: post.map(c => ({ o:c.open, h:c.high, l:c.low, c:c.close })),
                config, state,
            });
            if (note) rec.ai_outcome_note = note;
        } catch (e) {
            Logger.warn('post-mortem failed', { error: e.message });
        }
    }
}

/* ─────────────────────────────────────────────────────────────────
   CYCLE PATH
   ───────────────────────────────────────────────────────────────── */
async function runCycle(ws, config, state, connOpts) {
    // Session gates (REBUILD_PROMPT §2A — code-enforced, AI cannot override)
    if (!config.cycle || !config.cycle.running) {
        Logger.info('Cycle not running (config.cycle.running=false)');
        return;
    }
    const sess = state.cycle_session;
    if (!sess || !sess.active) {
        Logger.info('Cycle session not active');
        return;
    }
    if (sess.halted) {
        Logger.info('Cycle session halted', { reason: sess.halt_reason });
        return;
    }
    if (state.cycle_open_position) {
        Logger.info('Cycle position open — waiting for settlement', state.cycle_open_position);
        return;
    }
    if (Date.now() < (state.next_cycle_eligible_at || 0)) {
        Logger.info('In post-settlement cooldown', {
            ms_remaining: state.next_cycle_eligible_at - Date.now(),
        });
        return;
    }

    // Build payload + ask AI
    let payload;
    try {
        payload = await Payload.buildDecisionPayload(ws, config, state);
    } catch (e) {
        Logger.error('Payload build failed', { error: e.message });
        return;
    }
    let decision, keyUsed;
    try {
        const r = await AIClient.askDecision({ payload, config, state });
        decision = r.decision; keyUsed = r.keyUsed;
    } catch (e) {
        Logger.error('AI decision failed', { error: e.message });
        await Telegram.send(`⚠️ <b>AURELIA</b> — AI decision failed: <code>${String(e.message).slice(0,180)}</code>`);
        return;
    }

    const v = validateDecision(decision, config, state, { cycle: true });
    if (!v.ok) {
        Logger.warn('Invalid AI decision', { errs: v.errs });
        return;
    }
    if (v.skip) {
        Logger.info('AI chose to skip this tick', { reason: v.reason || decision.rationale });
        return;
    }

    // Payout-threshold filter (defensive — applies AFTER AI decision)
    const pay = await checkPayoutThreshold(ws, v.normalised, config);
    if (!pay.ok) {
        const msg = `payout ${(pay.ratio * 100).toFixed(1)}% < threshold ${(pay.threshold * 100).toFixed(0)}%`;
        Logger.info('Cycle trade blocked by payout filter', { symbol: v.normalised.symbol, ratio: pay.ratio, threshold: pay.threshold });
        try {
            await Telegram.send(`🛑 <b>AURELIA</b> — trade skipped (<code>${v.normalised.symbol}</code>): ${msg}`);
        } catch (_) {}
        return;
    }

    // Place and (try to) settle in-cycle
    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: true, connOpts });
    ws = freshWs || ws;
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_cycle.push(record);

    if (record.settled) {
        // In-cycle terminal settlement: book it now and arm cooldown.
        applyCycleSettlement(state, record);
        applyDailyStat(state, record);
        state.next_cycle_eligible_at =
            Date.now() + 1000 * (config.cycle.interval_seconds || 60);
    } else if (record.contract_id) {
        // Non-terminal — push to pending, set the cycle open-position
        // lock so the next tick will not place a second trade until
        // settleAllPending() resolves this one. Result notification
        // fires from settleAllPending on the settling tick.
        state.cycle_open_position = {
            contract_id: record.contract_id,
            symbol:      record.symbol,
            placed_at:   record.ts,
        };
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path:        'cycle',
            symbol:      record.symbol,
            placed_at:   record.ts,
            expiry_sec:  record.expiry_sec,
        });
    }
    return ws;
}

/* ─────────────────────────────────────────────────────────────────
   MANUAL PATH (stateless w.r.t. cycle session)
   ───────────────────────────────────────────────────────────────── */
async function runManual(ws, config, state, connOpts) {
    let inputPayload = {};
    try { inputPayload = JSON.parse(process.env.INPUT_PAYLOAD || '{}'); }
    catch (e) { /* ignore */ }

    const action = inputPayload.action || 'scan';

    if (action === 'chart') {
        const symbol = inputPayload.symbol || 'frxEURUSD';
        const tf     = inputPayload.tf     || '5m';
        try {
            const buf = await Chart.generateChart(ws, symbol, tf);
            if (buf) await Telegram.sendPhoto(buf, `${symbol} — ${tf}`);
        } catch (e) {
            await Telegram.send(`Chart failed: <code>${e.message}</code>`);
        }
        return;
    }

    // Default manual action: ask AI to scan + place ONE trade now.
    let payload;
    try { payload = await Payload.buildDecisionPayload(ws, config, state); }
    catch (e) {
        Logger.error('Manual payload build failed', { error: e.message });
        await Telegram.send(`⚠️ Manual scan failed: <code>${e.message}</code>`);
        return;
    }

    let decision;
    try {
        const r = await AIClient.askDecision({ payload, config, state });
        decision = r.decision;
    } catch (e) {
        Logger.error('Manual AI decision failed', { error: e.message });
        await Telegram.send(`⚠️ Manual AI call failed: <code>${e.message}</code>`);
        return;
    }

    const v = validateDecision(decision, config, state, { manual: true });
    if (!v.ok) {
        Logger.warn('Invalid manual decision', { errs: v.errs });
        await Telegram.send(`⚠️ Manual decision rejected: ${v.errs.join('; ')}`);
        return;
    }
    if (v.skip) {
        Logger.info('AI declined manual trade', { rationale: decision.rationale });
        await Telegram.send(`🤖 AI declined: <i>${(decision.rationale || v.reason || 'no high-confidence setup').slice(0,200)}</i>`);
        return;
    }

    // Payout-threshold filter (manual trades are also subject to it)
    const pay = await checkPayoutThreshold(ws, v.normalised, config);
    if (!pay.ok) {
        const msg = `payout ${(pay.ratio * 100).toFixed(1)}% < threshold ${(pay.threshold * 100).toFixed(0)}%`;
        Logger.info('Manual trade blocked by payout filter', { symbol: v.normalised.symbol, ratio: pay.ratio, threshold: pay.threshold });
        await Telegram.send(`🛑 Manual trade skipped (<code>${v.normalised.symbol}</code>): ${msg}`);
        return;
    }

    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: false, connOpts });
    ws = freshWs || ws;
    state.trade_history_manual = state.trade_history_manual || [];
    state.trade_history_manual.push(record);

    if (record.settled) {
        applyManualSettlement(state, record);
        applyDailyStat(state, record);
    } else if (record.contract_id) {
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path:        'manual',
            symbol:      record.symbol,
            placed_at:   record.ts,
            expiry_sec:  record.expiry_sec,
        });
    }
    return ws;
}

/* ─────────────────────────────────────────────────────────────────
   DAILY SUMMARY PATH
   ─────────────────────────────────────────────────────────────────
   cron-job.org dispatches this with {"task":"daily_summary"} once per
   day. We:
     1. Settle any pending contracts first (so the day's books close
        properly even if a contract crossed midnight UTC).
     2. Emit the dailySummary Telegram message for state.daily_stats.
     3. Archive the snapshot into state.daily_history (last 60 days).
     4. Reset state.daily_stats to today's empty counter.
   ───────────────────────────────────────────────────────────────── */
async function runDailySummary(ws, config, state) {
    const ds = ensureDailyStats(state);
    const reportDate = ds.date;

    try {
        await Telegram.send(Telegram.templates.dailySummary({
            date:   reportDate,
            mode:   state.account_mode || (config.account && config.account.mode) || 'demo',
            trades: ds.trades,
            wins:   ds.wins,
            losses: ds.losses,
            pnl:    ds.pnl,
        }));
    } catch (e) {
        Logger.warn('dailySummary send failed', { error: e.message });
    }

    // Archive
    state.daily_history = Array.isArray(state.daily_history) ? state.daily_history : [];
    state.daily_history.push({
        date:   ds.date,
        trades: ds.trades,
        wins:   ds.wins,
        losses: ds.losses,
        pnl:    ds.pnl,
        by_symbol: ds.by_symbol || {},
    });
    if (state.daily_history.length > 60) {
        state.daily_history = state.daily_history.slice(-60);
    }

    // Reset (unless config disables it)
    const resetOn = !config.daily_summary || config.daily_summary.reset_on_send !== false;
    if (resetOn) {
        state.daily_stats = {
            date:    todayUTC(),
            trades:  0,
            wins:    0,
            losses:  0,
            pnl:     0,
            by_symbol: {},
        };
        Logger.info('daily_stats reset for new UTC day', { date: state.daily_stats.date });
    }
}

/* ─────────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────────── */
async function main() {
    const cycleStart = Date.now();
    Logger.info('Tick start', { ts: new Date().toISOString() });

    const config = readJSON(CFG_PATH);
    if (!config) { Logger.error('config.json missing'); return 0; }

    const state = readJSON(STATE_PATH, {});
    state.cycle_session       = state.cycle_session       || { active:false, halted:false };
    state.pending_contracts   = state.pending_contracts   || [];
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_manual= state.trade_history_manual|| [];
    state.ai_keys_bench       = state.ai_keys_bench       || {};
    ensureDailyStats(state);
    ensureManualSession(state, config);

    if (config.enabled === false) {
        Logger.info('Bot disabled');
        state.last_cycle = new Date().toISOString();
        state.logs = Logger.mergeRing(state.logs || []);
        writeJSON(STATE_PATH, state);
        return 0;
    }

    const task = detectTask();
    const connOpts = {
        bearer: process.env.DERIV_BEARER_TOKEN,
        appId:  process.env.DERIV_APP_ID,
        mode:   config.account.mode,
        realId: process.env.DERIV_REAL_ID || config.account.real_id,
        demoId: process.env.DERIV_DEMO_ID || config.account.demo_id,
    };
    let conn = null, ws = null;
    try {
        conn = await Deriv.connect(connOpts);
        ws = conn.ws;

        // Balance refresh
        try {
            const bal = await Deriv.getBalance(ws);
            state.balance = bal.balance;
            state.currency = bal.currency;
            state.account_mode = config.account.mode;
        } catch (e) { Logger.warn('balance fetch failed', { error: e.message }); }

        // Always settle pendings first
        await settleAllPending(ws, config, state);

        if (task === 'cycle') {
            ws = await runCycle(ws, config, state, connOpts) || ws;
        } else if (task === 'manual') {
            ws = await runManual(ws, config, state, connOpts) || ws;
        } else if (task === 'settle_only') {
            Logger.info('settle_only — done');
        } else if (task === 'daily_summary') {
            await runDailySummary(ws, config, state);
        }
    } catch (e) {
        Logger.error('Tick failed', { error: e.message, stack: e.stack });
        try {
            await Telegram.send(`⚠️ <b>AURELIA</b> tick failed: <code>${String(e.message).slice(0,200)}</code>`);
        } catch (_) {}
    } finally {
        try { if (ws) Deriv.close(ws); } catch (_) {}
    }

    // Trim history rings (keep last 200 each)
    if (state.trade_history_cycle.length  > 200) state.trade_history_cycle  = state.trade_history_cycle.slice(-200);
    if (state.trade_history_manual.length > 200) state.trade_history_manual = state.trade_history_manual.slice(-200);

    state.last_cycle = new Date().toISOString();
    state.logs = Logger.mergeRing(state.logs || []);
    writeJSON(STATE_PATH, state);
    Logger.info('Tick end', { ms: Date.now() - cycleStart });
    return 0;
}

main().then(code => process.exit(code || 0))
      .catch(e  => { console.error('fatal', e); process.exit(1); });
