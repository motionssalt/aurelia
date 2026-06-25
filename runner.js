/* =====================================================================
   AURELIA — runner.js
   ─────────────────────────────────────────────────────────────────────
   One serverless invocation = one tick of work. Two independent paths,
   selected by INPUT_TASK (see .github/workflows/aurelia-cron.yml):

     • task=cycle  (default) → tick the AI cycle state machine
     • task=manual           → fire one immediate AI trade outside the cycle
     • task=settle_only      → just settle any pending contracts (cheap)

   Cycle state machine (REBUILD_PROMPT §2A):
     1. Load config + last-status
     2. Settle any pending contracts (cycle + manual)
     3. If a cycle position is OPEN and unsettled → do nothing else this tick
     4. If cycle paused (config.cycle.running=false) → skip
     5. If session.halted → skip
     6. If now < next_cycle_eligible_at (post-settlement cooldown) → skip
     7. Build AI payload, ask Gemini for decision
     8. Validate, clamp (stake + expiry), place trade
     9. Record as cycle trade; set next_cycle_eligible_at after settlement

   Session TP/SL is enforced HERE, in code, not by the AI.

   Manual path (REBUILD_PROMPT §2B):
     • Reads INPUT_PAYLOAD for {action:"scan"|"trade_now", ...}
     • Ignores cycle_open_position lock
     • Does NOT touch cycle_session counters
     • Logged into trade_history_manual
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

    const stakeOpts = opts && opts.cycle
        ? { cycleSessionRemaining: (state.cycle_session && state.cycle_session.capital_remaining) }
        : {};
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
    // decision (Gemini calls can now take up to a few minutes) — make
    // sure we have a live connection right before placing the trade.
    if (opts && opts.connOpts) {
        ws = await Deriv.ensureOpen(ws, opts.connOpts);
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
                try {
                    const buf = await Chart.generateChart(ws, norm.symbol, '5m');
                    if (buf) {
                        await Telegram.sendPhoto(buf,
                            `${norm.symbol} • ${contractType} • ${norm.stake} USD • ${minutes}m\n` +
                            `Why: ${norm.rationale}`);
                    }
                } catch (e) {
                    Logger.warn('Chart generation failed (entry)', { error: e.message });
                }
            },
            settleWaitMs: HARD_BUDGET_MS - 8000,
        }
    );

    // Build a stable trade record regardless of in-cycle settlement.
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
        settled:    !!(contract && contract.settled),
        outcome:    contract && contract.settled ? contract.outcome : 'pending',
        entry:      contract && contract.entry_spot,
        exit:       contract && contract.exit_spot,
        pnl:        contract && contract.profit != null ? Number(contract.profit) : 0,
        ai_outcome_note: null,
    };

    return { record, contract, ws };
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
    if (!sess || !sess.active) return;
    sess.trades = (sess.trades || 0) + 1;
    const pnl = Number(record.pnl || 0);
    sess.pnl = Number(((sess.pnl || 0) + pnl).toFixed(2));
    sess.capital_remaining = Number(((sess.capital_remaining || 0) + pnl).toFixed(2));
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
            if (p.path === 'cycle') applyCycleSettlement(state, rec);
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

    // Place and (try to) settle in-cycle
    const { record, contract, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: true, connOpts });
    ws = freshWs || ws;
    state.trade_history_cycle = state.trade_history_cycle || [];
    state.trade_history_cycle.push(record);

    if (record.settled) {
        applyCycleSettlement(state, record);
        state.next_cycle_eligible_at =
            Date.now() + 1000 * (config.cycle.interval_seconds || 60);
    } else if (record.contract_id) {
        // Position will be settled on a later tick by settleAllPending
        state.cycle_open_position = {
            contract_id: record.contract_id,
            symbol:      record.symbol,
            placed_at:   record.ts,
        };
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path: 'cycle',
            symbol: record.symbol,
            placed_at: record.ts,
            expiry_sec: record.expiry_sec,
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

    const v = validateDecision(decision, config, state, { cycle: false });
    if (!v.ok) {
        Logger.warn('Invalid manual decision', { errs: v.errs });
        await Telegram.send(`⚠️ Manual decision rejected: ${v.errs.join('; ')}`);
        return;
    }
    if (v.skip) {
        Logger.info('AI declined manual trade', { rationale: decision.rationale });
        await Telegram.send(`🤖 AI declined: <i>${(decision.rationale || 'no high-confidence setup').slice(0,200)}</i>`);
        return;
    }

    const { record, ws: freshWs } = await placeAndSettle(
        ws, v.normalised, config, state, { cycle: false, connOpts });
    ws = freshWs || ws;
    state.trade_history_manual = state.trade_history_manual || [];
    state.trade_history_manual.push(record);

    if (!record.settled && record.contract_id) {
        state.pending_contracts.push({
            contract_id: record.contract_id,
            path: 'manual',
            symbol: record.symbol,
            placed_at: record.ts,
            expiry_sec: record.expiry_sec,
        });
    }
    return ws;
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
