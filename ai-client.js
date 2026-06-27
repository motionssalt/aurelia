/* =====================================================================
   AURELIA — ai-client.js
   ─────────────────────────────────────────────────────────────────────
   Multi-provider AI decision client with key/provider failover + benching.

   Provider waterfall (v2):
     1. Gemini (multi-key via config.ai.key_registry — original behaviour)
     2. config.ai.providers[] in declared order, where `enabled: true`
        and process.env[key_env] is present.

   Each provider call returns STRICT JSON matching the same decision
   schema. Benching keys is unchanged for Gemini; provider-level
   failures are also benched in state.ai_keys_bench keyed by the
   provider name (e.g. `provider:openai`).

   Public surface:
     askDecision({ payload, config, state })   → { decision, keyUsed }
     askPostMortem({ trade, config, state })   → string | null
   ===================================================================== */

'use strict';

const Logger = require('./logger');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BENCH_MINUTES = 120;
const DEFAULT_TIMEOUT_MS = 180000; // 3 min per key — Gemini load spikes

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

function _parseJsonStrict(text) {
    const cleaned = _stripFences(text);
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 160)}`); }
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: Gemini (Google)
   ───────────────────────────────────────────────────────────────── */
function _extractGeminiText(geminiReply) {
    try {
        const cand = (geminiReply.candidates || [])[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        return parts.map(p => p.text || '').join('').trim();
    } catch (e) { return ''; }
}

async function _callGemini({ keyValue, model, prompt, timeoutMs }) {
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
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`gemini ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const text = _extractGeminiText(json);
    if (!text) throw new Error('gemini returned empty text');
    return text;
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: OpenAI-compatible (OpenAI, Grok/xAI)
   Both use Chat Completions schema. Caller passes the endpoint URL.
   ───────────────────────────────────────────────────────────────── */
async function _callOpenAICompat({ keyValue, model, prompt, endpoint, timeoutMs, providerName }) {
    const f = await _fetch();
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${keyValue}`,
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`${providerName} ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const text = (((json.choices || [])[0] || {}).message || {}).content || '';
    if (!text) throw new Error(`${providerName} returned empty text`);
    return String(text).trim();
}

/* ─────────────────────────────────────────────────────────────────
   PROVIDER: Anthropic Claude (different request/response shape)
   ───────────────────────────────────────────────────────────────── */
async function _callClaude({ keyValue, model, prompt, timeoutMs }) {
    const f = await _fetch();
    const body = {
        model,
        max_tokens: 1024,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await f('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         keyValue,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } finally { clearTimeout(t); }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`claude ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    // Claude returns content as an array of blocks; we want the first text block.
    const text = ((json.content || [])[0] || {}).text || '';
    if (!text) throw new Error('claude returned empty text');
    return String(text).trim();
}

/* ─────────────────────────────────────────────────────────────────
   Generic provider dispatcher \u2014 routes by provider.name.
   Returns the raw text reply (JSON-as-string).
   ───────────────────────────────────────────────────────────────── */
async function _callProvider(provider, { keyValue, prompt, timeoutMs }) {
    const model = provider.model;
    switch ((provider.name || '').toLowerCase()) {
        case 'gemini':
            return _callGemini({ keyValue, model, prompt, timeoutMs });
        case 'openai':
            return _callOpenAICompat({
                keyValue, model, prompt, timeoutMs,
                endpoint: 'https://api.openai.com/v1/chat/completions',
                providerName: 'openai',
            });
        case 'grok':
        case 'xai':
            return _callOpenAICompat({
                keyValue, model, prompt, timeoutMs,
                endpoint: 'https://api.x.ai/v1/chat/completions',
                providerName: 'grok',
            });
        case 'claude':
        case 'anthropic':
            return _callClaude({ keyValue, model, prompt, timeoutMs });
        default:
            throw new Error(`unknown AI provider "${provider.name}"`);
    }
}

/* ─────────────────────────────────────────────────────────────────
   Public: ask the AI for a structured trading decision.
   Returns { decision, keyUsed }. Mutates state.ai_keys_bench on failures.

   Strategy:
     1. Try every Gemini key in config.ai.key_registry (existing logic).
     2. If all benched/failed, walk config.ai.providers[] (in order),
        skipping disabled ones and ones with no env key.
   ───────────────────────────────────────────────────────────────── */
async function askDecision({ payload, config, state, prompt, schemaHint }) {
    const registry = (config.ai && config.ai.key_registry) || [];
    const benchMin = (config.ai && config.ai.bench_minutes) || DEFAULT_BENCH_MINUTES;
    const timeoutMs = (config.ai && config.ai.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const geminiModel = (config.ai && config.ai.model) || DEFAULT_MODEL;

    state.ai_keys_bench = state.ai_keys_bench || {};
    const now = Date.now();
    const fullPrompt = prompt || _buildDecisionPrompt(payload, schemaHint);

    let lastErr = null;

    // ---- Stage 1: Gemini multi-key (preserves existing behaviour) ----
    if (Array.isArray(registry) && registry.length > 0) {
        const ordered = _orderKeys(registry, state.ai_keys_bench, now);
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
                const text = await _callGemini({ keyValue, model: geminiModel, prompt: fullPrompt, timeoutMs });
                const parsed = _parseJsonStrict(text);
                if (state.ai_keys_bench[row.name]) delete state.ai_keys_bench[row.name];
                Logger.info(`AI decision via gemini key "${row.name}"`, {
                    action: parsed.action, symbol: parsed.symbol, conf: parsed.confidence,
                });
                return { decision: parsed, keyUsed: row.name };
            } catch (e) {
                lastErr = e;
                state.ai_keys_bench[row.name] = now + benchMin * 60 * 1000;
                Logger.warn(`Gemini key "${row.name}" failed — benching ${benchMin}m`, { error: e.message });
            }
        }
    }

    // ---- Stage 2: fallback providers from config.ai.providers ----
    const providers = (config.ai && Array.isArray(config.ai.providers)) ? config.ai.providers : [];
    for (const p of providers) {
        if (!p || p.enabled === false) continue;
        const name = String(p.name || '').toLowerCase();
        // Skip Gemini provider entries here — stage 1 already covered it
        // (the providers[] entry exists mostly so the Settings panel can
        // show/toggle Gemini as a provider).
        if (name === 'gemini') continue;
        const benchKey = `provider:${name}`;
        const benchUntil = Number(state.ai_keys_bench[benchKey] || 0);
        const isBenched = benchUntil > now;
        const keyValue = process.env[p.key_env];
        if (!keyValue) {
            Logger.warn(`Provider "${name}" enabled but env "${p.key_env}" not set — skipping`);
            continue;
        }
        if (isBenched) {
            Logger.warn(`Provider "${name}" benched; trying anyway as fallback`);
        }
        try {
            const text = await _callProvider(p, { keyValue, prompt: fullPrompt, timeoutMs });
            const parsed = _parseJsonStrict(text);
            if (state.ai_keys_bench[benchKey]) delete state.ai_keys_bench[benchKey];
            Logger.info(`AI decision via fallback provider "${name}"`, {
                action: parsed.action, symbol: parsed.symbol, conf: parsed.confidence,
            });
            return { decision: parsed, keyUsed: benchKey };
        } catch (e) {
            lastErr = e;
            state.ai_keys_bench[benchKey] = now + benchMin * 60 * 1000;
            Logger.warn(`Provider "${name}" failed — benching ${benchMin}m`, { error: e.message });
        }
    }

    throw new Error(`All AI providers/keys failed; last error: ${lastErr ? lastErr.message : 'unknown'}`);
}

/* ─────────────────────────────────────────────────────────────────
   Post-trade rationale: one-sentence "why did this win/lose".
   Best-effort; on total failure we return null and the caller logs.
   ───────────────────────────────────────────────────────────────── */
async function askPostMortem({ trade, postEntryCandles, config, state }) {
    const registry = (config.ai && config.ai.key_registry) || [];
    const providers = (config.ai && config.ai.providers) || [];
    if (!registry.length && !providers.some(p => p && p.enabled !== false)) return null;

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
        const { decision } = await askDecision({ payload: null, config, state, prompt });
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
        '  • stake MUST be between meta.stake_floor and meta.stake_ceiling, max 2 decimals.',
        '    stake_ceiling is the ABSOLUTE per-trade cap, NOT the session budget.',
        '    Use small position sizing — never bet a significant fraction of session.capital_remaining on one trade.',
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
