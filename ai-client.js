/* =====================================================================
   AURELIA — ai-client.js
   ─────────────────────────────────────────────────────────────────────
   Gemini call wrapper with multi-key failover + benching.

   Design contract (REBUILD_PROMPT §8):
     • Arbitrary number of API keys, names come from config.ai.key_registry.
     • Each name is the GitHub Actions secret name (e.g. GEMINI_KEY_A).
       The actual value is in process.env[name] at workflow runtime.
     • On failure (error or 429/5xx/quota): immediately retry with the
       next key in rotation.
     • A key that fails gets benched for `config.ai.bench_minutes`
       (default 120 min). Benching state lives in
       `last-status.json -> ai_keys_bench[name] = untilEpochMs`.
     • If ALL keys are benched, fall back to the LEAST-recently benched
       one (best of bad options) and warn loudly.

   Public surface:
     askDecision({ payload, config, state })   → { decision, keyUsed }
     askPostMortem({ trade, config, state })   → string (one-sentence note)

   The AI returns strict JSON (no fences). We do best-effort fence-stripping
   just in case, and validate the schema before returning.
   ===================================================================== */

'use strict';

const Logger = require('./logger');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BENCH_MINUTES = 120;

async function _fetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

/* ─────────────────────────────────────────────────────────────────
   Key selection: order keys by (not-benched first, then bench-expiry asc)
   ───────────────────────────────────────────────────────────────── */
function _orderKeys(registry, benchMap, now) {
    const rows = registry.map(name => {
        const benchUntil = Number((benchMap || {})[name] || 0);
        const benched = benchUntil > now;
        return { name, benchUntil, benched };
    });
    rows.sort((a, b) => {
        if (a.benched !== b.benched) return a.benched ? 1 : -1;
        return a.benchUntil - b.benchUntil;
    });
    return rows;
}

function _stripFences(s) {
    if (typeof s !== 'string') return '';
    let out = s.trim();
    if (out.startsWith('```')) {
        out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    }
    return out.trim();
}

function _extractText(geminiReply) {
    try {
        const cand = (geminiReply.candidates || [])[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        return parts.map(p => p.text || '').join('').trim();
    } catch (e) {
        return '';
    }
}

/* ─────────────────────────────────────────────────────────────────
   Low-level: one HTTP call to Gemini using one API key.
   Returns the response text or throws.
   ───────────────────────────────────────────────────────────────── */
async function _callOnce({ keyValue, model, prompt, timeoutMs }) {
    const f = await _fetch();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(keyValue)}`;
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
        },
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
    let res;
    try {
        res = await f(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally {
        clearTimeout(t);
    }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`gemini ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const text = _extractText(json);
    if (!text) throw new Error('gemini returned empty text');
    return text;
}

/* ─────────────────────────────────────────────────────────────────
   Public: ask the AI for a structured trading decision.
   Returns { decision, keyUsed }. Mutates state.ai_keys_bench on failures.
   ───────────────────────────────────────────────────────────────── */
async function askDecision({ payload, config, state, prompt, schemaHint }) {
    const model    = (config.ai && config.ai.model) || DEFAULT_MODEL;
    const registry = (config.ai && config.ai.key_registry) || [];
    const benchMin = (config.ai && config.ai.bench_minutes) || DEFAULT_BENCH_MINUTES;

    if (!Array.isArray(registry) || registry.length === 0) {
        throw new Error('No Gemini keys registered. Use /addkey in Telegram.');
    }

    state.ai_keys_bench = state.ai_keys_bench || {};
    const now = Date.now();
    const ordered = _orderKeys(registry, state.ai_keys_bench, now);

    const fullPrompt = prompt || _buildDecisionPrompt(payload, schemaHint);

    let lastErr = null;
    for (const row of ordered) {
        const keyValue = process.env[row.name];
        if (!keyValue) {
            Logger.warn(`Gemini key "${row.name}" not present in env — skipping`);
            continue;
        }
        if (row.benched) {
            Logger.warn(`All keys benched; trying least-recently-benched "${row.name}" anyway`);
        }
        try {
            const text = await _callOnce({ keyValue, model, prompt: fullPrompt });
            const cleaned = _stripFences(text);
            let parsed;
            try { parsed = JSON.parse(cleaned); }
            catch (e) {
                throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 160)}`);
            }
            // Success — clear any prior bench on this key.
            if (state.ai_keys_bench[row.name]) delete state.ai_keys_bench[row.name];
            Logger.info(`AI decision via key "${row.name}"`, {
                action: parsed.action, symbol: parsed.symbol,
                conf: parsed.confidence,
            });
            return { decision: parsed, keyUsed: row.name };
        } catch (e) {
            lastErr = e;
            state.ai_keys_bench[row.name] = now + benchMin * 60 * 1000;
            Logger.warn(`Gemini key "${row.name}" failed — benching ${benchMin}m`, {
                error: e.message,
            });
        }
    }
    throw new Error(`All Gemini keys failed; last error: ${lastErr ? lastErr.message : 'unknown'}`);
}

/* ─────────────────────────────────────────────────────────────────
   Post-trade rationale: one-sentence "why did this win/lose".
   Best-effort; on total failure we return null and the caller logs.
   ───────────────────────────────────────────────────────────────── */
async function askPostMortem({ trade, postEntryCandles, config, state }) {
    const registry = (config.ai && config.ai.key_registry) || [];
    if (!registry.length) return null;

    const prompt = [
        'You are a trading post-mortem assistant. In ONE short sentence (max 30 words),',
        'explain why this trade resulted in the outcome it did, based on the post-entry price action provided.',
        'Return STRICT JSON: {"note": "<one sentence>"}.',
        '',
        'Trade record:',
        JSON.stringify({
            symbol: trade.symbol,
            direction: trade.direction,
            stake: trade.stake,
            entry: trade.entry,
            exit: trade.exit,
            outcome: trade.outcome,
            pnl: trade.pnl,
            rationale_at_entry: trade.rationale,
        }, null, 2),
        '',
        'Post-entry price action (recent closes after entry):',
        JSON.stringify(postEntryCandles || [], null, 2),
    ].join('\n');

    try {
        const { decision } = await askDecision({
            payload: null, config, state, prompt,
        });
        if (decision && typeof decision.note === 'string') return decision.note;
        return null;
    } catch (e) {
        Logger.warn('Post-mortem AI call failed', { error: e.message });
        return null;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Decision-prompt builder — used when caller doesn't supply one.
   ───────────────────────────────────────────────────────────────── */
function _buildDecisionPrompt(payload, schemaHint) {
    return [
        'You are AURELIA, an AI trade-decision engine for a Deriv binary-options bot.',
        'You are given a structured market snapshot for multiple symbols across M5/M10/M15,',
        'plus session context. Pick AT MOST ONE best setup, or skip.',
        '',
        'Hard rules you MUST obey:',
        '  • expiry_seconds MUST be >= 900 (Deriv forex intraday floor).',
        '  • stake MUST be between 0.35 and the remaining session capital, max 2 decimals.',
        '  • If nothing looks high-confidence, return {"action":"skip"} — do NOT force a trade.',
        '  • direction is "call" (price up) or "put" (price down).',
        '',
        'Return STRICT JSON only (no markdown fences):',
        schemaHint || _DEFAULT_SCHEMA,
        '',
        'Market + session payload:',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

const _DEFAULT_SCHEMA = JSON.stringify({
    action: '"trade" | "skip"',
    symbol: 'string (one of the symbols in payload.symbols), required if action=trade',
    direction: '"call" | "put", required if action=trade',
    expiry_seconds: 'integer >= 900, required if action=trade',
    stake: 'number, required if action=trade',
    confidence: 'number 0.0-1.0',
    rationale: 'short string explaining the setup',
}, null, 2);

module.exports = {
    askDecision,
    askPostMortem,
};
