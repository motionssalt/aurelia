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

/* OpenRouter-specific hard caps.
   Reasoning models on OpenRouter (Nemotron 3 Ultra, DeepSeek R1, etc.)
   can spend 5–10+ minutes on hidden chain-of-thought before emitting
   their final JSON answer. By the time the response comes back, the
   market data the signal was based on is already stale. We mitigate
   with three knobs, all overridable via config:

     • reasoning effort  → smallest tier the model supports ('low')
     • max_tokens        → hard cap on TOTAL output (reasoning + content)
     • timeout_ms        → dedicated, longer-but-bounded OpenRouter timeout

   Overrides (provider-level wins over global ai.*):
     config.ai.providers[].reasoning_effort
     config.ai.providers[].timeout_ms
     config.ai.providers[].max_tokens
     config.ai.openrouter_reasoning_effort
     config.ai.openrouter_timeout_ms
     config.ai.openrouter_max_tokens                                    */
const DEFAULT_OPENROUTER_TIMEOUT_MS       = 300000; // 5 min — bounded but generous
const DEFAULT_OPENROUTER_MAX_TOKENS       = 4096;
const DEFAULT_OPENROUTER_REASONING_EFFORT = 'low';  // 'low' | 'medium' | 'high' | 'none'

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
   PROVIDER: OpenRouter (OpenAI-compatible aggregator)

   OpenRouter exposes a unified OpenAI-compatible chat-completions
   endpoint that fronts many upstream models (NVIDIA Nemotron, Llama,
   Mistral, etc.). Free-tier models have an ID suffix ":free" (e.g.
   "nvidia/nemotron-3-ultra-550b-a55b:free") and are rate-limited to
   20 requests/minute and 50 requests/day (1000/day if the account has
   $10+ in credits, lifetime). Both successful and FAILED requests
   count against the daily quota.

   We split this out from _callOpenAICompat for two reasons:
     1. Optional HTTP-Referer / X-Title attribution headers — OpenRouter
        uses these for usage tracking on its leaderboard.
     2. Reasoning models like Nemotron 3 Ultra return a separate
        `choices[0].message.reasoning` field alongside `.content`. The
        final answer lives in .content; .reasoning is the model's
        scratchpad and MUST NOT be parsed as the answer (it's not
        guaranteed to be JSON). We explicitly ignore .reasoning here.

   On HTTP errors (incl. 429 rate-limited / 402 insufficient credits)
   we throw with err.status set, exactly like the other providers, so
   the outer waterfall flags the key and falls through to the next
   provider — it does NOT halt the AI pipeline.
   ───────────────────────────────────────────────────────────────── */
async function _callOpenRouter({ keyValue, model, prompt, timeoutMs, reasoningEffort, maxTokens }) {
    // SAFETY GUARD — validate inputs before any network I/O.
    // Prevents fall-through with a malformed request that would otherwise
    // hit OpenRouter, fail slowly, and chew the per-key timeout budget.
    if (!keyValue || typeof keyValue !== 'string') {
        const err = new Error('openrouter: missing or invalid API key');
        err.status = 0;
        throw err;
    }
    if (!model || typeof model !== 'string') {
        const err = new Error('openrouter: missing or invalid model id');
        err.status = 0;
        throw err;
    }
    if (!prompt || typeof prompt !== 'string') {
        const err = new Error('openrouter: empty prompt');
        err.status = 0;
        throw err;
    }

    const f = await _fetch();
    const effort = String(reasoningEffort || DEFAULT_OPENROUTER_REASONING_EFFORT).toLowerCase();
    const cappedMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0
        ? maxTokens
        : DEFAULT_OPENROUTER_MAX_TOKENS;

    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        // Strict JSON output — same as we already do for openai/grok/cloudflare.
        response_format: { type: 'json_object' },
        // Hard cap on TOTAL output tokens (reasoning + visible content).
        // Without this, reasoning models like Nemotron 3 Ultra / DeepSeek R1
        // can run for 5–10 minutes generating internal chain-of-thought
        // before emitting the JSON answer — by which time the market data
        // the signal was based on is already stale.
        max_tokens: cappedMaxTokens,
    };

    // OpenRouter unified reasoning controls.
    // https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
    //
    //   • effort: 'low' | 'medium' | 'high' | 'minimal' | 'none'
    //       Maps to provider-specific reasoning budgets. 'low' is
    //       the smallest non-zero budget. 'none' is OpenAI-style
    //       "reasoning off" — supported by models that have a
    //       non-thinking mode (e.g. Nemotron 3 Ultra).
    //   • enabled: false → belt-and-braces full disable on top of
    //       effort:'none'. The OpenRouter docs accept both shapes;
    //       sending both is safe and gives us the strictest possible
    //       "do not think" signal for models that respect either flag
    //       (and for models that respect neither, the field is silently
    //       ignored upstream).
    //   • exclude: true → do NOT return reasoning tokens in the response
    //       (suppresses message.reasoning; saves bandwidth + parse time).
    if (effort === 'none' || effort === 'off' || effort === 'disabled') {
        body.reasoning = { enabled: false, exclude: true };
    } else {
        body.reasoning = { effort, exclude: true };
    }

    // Optional attribution headers — recommended by OpenRouter for
    // usage tracking. Safe defaults; ignored upstream if unrecognised.
    const headers = {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${keyValue}`,
        'HTTP-Referer':  'https://github.com/motionssalt/Aurelia',
        'X-Title':       'AURELIA',
    };
    // OpenRouter gets its own (longer) timeout because its reasoning
    // models are the slowest provider in the pool. Caller passes the
    // resolved value via timeoutMs; we floor it to a safe minimum.
    const effectiveTimeout = Math.max(
        5000,
        timeoutMs || DEFAULT_OPENROUTER_TIMEOUT_MS,
    );
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), effectiveTimeout);
    let res;
    try {
        res = await f('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
    } catch (e) {
        // Normalise AbortError → typed timeout so the waterfall in
        // askDecision() flags the key consistently with other providers.
        if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
            const err = new Error(`openrouter timeout after ${effectiveTimeout}ms (reasoning model too slow)`);
            err.status = 408;
            throw err;
        }
        throw e;
    } finally { clearTimeout(t); }
    if (!res.ok) {
        // 429 (rate limited) and 402 (insufficient credits) land here
        // with err.status set — the outer loop flags the key and the
        // next provider in config.ai.providers[] is tried.
        const txt = await res.text().catch(() => '');
        const err = new Error(`openrouter ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = await res.json();
    const choice0 = ((json.choices || [])[0]) || {};
    const msg     = choice0.message || {};
    // IMPORTANT: only read .content. Reasoning models (e.g. Nemotron 3
    // Ultra) also populate .reasoning with their hidden scratchpad —
    // that field is NOT the answer and is not guaranteed to be JSON.
    const text = msg.content || '';
    if (!text) {
        const finishReason = choice0.finish_reason || choice0.stop_reason || '';
        const why = finishReason === 'length'
            ? 'truncated (finish_reason=length)'
            : (msg.reasoning
                ? 'reasoning-only response with no content'
                : 'no content returned');
        throw new Error(`openrouter returned empty text: ${why}`);
    }
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
   Cloudflare account ID resolver — each key belongs to a different
   Cloudflare account, so the account ID is keyed by secret name in
   provider.key_accounts.
   ───────────────────────────────────────────────────────────────── */
function _resolveCloudflareAccountId(provider, keyName) {
    const accountId = provider.key_accounts && provider.key_accounts[keyName];
    if (!accountId) {
        throw new Error(
            `Cloudflare key "${keyName}" has no matching account ID in provider.key_accounts — ` +
            `add an entry for it in config.json before this key can be used.`
        );
    }
    return accountId;
}

/* ─────────────────────────────────────────────────────────────────
   Generic provider dispatcher \u2014 routes by provider.name.
   Returns the raw text reply (JSON-as-string).
   ───────────────────────────────────────────────────────────────── */
async function _callProvider(provider, { keyValue, keyName, prompt, timeoutMs, config }) {
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
        case 'openrouter': {
            // OpenRouter gets dedicated knobs because reasoning models on
            // OpenRouter are by far the slowest tail in the provider pool.
            // All three are config-driven so they can be tuned without
            // shipping new code:
            //
            //   config.ai.openrouter_timeout_ms
            //     Per-request abort timeout in ms.
            //     Default 300 000 (5 min).
            //
            //   config.ai.openrouter_max_tokens
            //     Hard cap on TOTAL output tokens (reasoning + content).
            //     Default 4096.
            //
            //   config.ai.openrouter_reasoning_effort
            //     'low' | 'medium' | 'high' | 'none'. Default 'low'.
            //     'none' disables reasoning entirely on models that
            //     support a non-thinking mode.
            //
            // Provider-level overrides on the openrouter provider block
            // (provider.timeout_ms, provider.max_tokens, provider.reasoning_effort)
            // win over the top-level ai.* defaults.
            const aiCfg = (config && config.ai) || {};
            const orTimeout =
                provider.timeout_ms ||
                aiCfg.openrouter_timeout_ms ||
                DEFAULT_OPENROUTER_TIMEOUT_MS;
            const orMaxTokens =
                provider.max_tokens ||
                aiCfg.openrouter_max_tokens ||
                DEFAULT_OPENROUTER_MAX_TOKENS;
            const orEffort =
                provider.reasoning_effort ||
                aiCfg.openrouter_reasoning_effort ||
                DEFAULT_OPENROUTER_REASONING_EFFORT;
            return _callOpenRouter({
                keyValue,
                model,
                prompt,
                timeoutMs: orTimeout,
                reasoningEffort: orEffort,
                maxTokens: orMaxTokens,
            });
        }
        case 'claude':
        case 'anthropic':
            return _callClaude({ keyValue, model, prompt, timeoutMs });
        case 'cloudflare':
        case 'workers-ai': {
            const accountId = _resolveCloudflareAccountId(provider, keyName);
            // Use OpenAI-compat endpoint — model goes in the request body,
            // NOT in the URL. The /ai/run/{model} native endpoint returns
            // result.response which is empty for chat models.
            //
            // IMPORTANT for @cf/openai/gpt-oss-* (reasoning models):
            //   • Without a generous max_tokens, the model spends ALL
            //     output tokens on its hidden reasoning_content and
            //     returns an EMPTY message.content — which then gets
            //     mis-recovered by our reasoning_content fallback as
            //     prose like "We need to analyze market indicators..."
            //     and dies in _parseJsonStrict as "AI returned non-JSON".
            //   • Setting reasoning.effort="low" keeps the chain-of-thought
            //     short so the final JSON answer actually fits.
            //   • response_format json_object forces strict JSON output.
            const isGptOss = /^@cf\/openai\/gpt-oss/i.test(String(model || ''));
            const cfBody = {
                model,
                messages: [{ role: 'user', content: prompt }],
                // Strict JSON — same as we already do for openai/grok.
                response_format: { type: 'json_object' },
                // Reasoning models eat tokens fast; give them headroom.
                max_tokens: isGptOss ? 8192 : 2048,
            };
            if (isGptOss) {
                // gpt-oss accepts OpenAI Responses-API style reasoning hint.
                // Keep effort low so reasoning_content stays small and the
                // final answer lands in message.content.
                cfBody.reasoning = { effort: 'low' };
                cfBody.temperature = 0.4;
            } else {
                cfBody.temperature = 0.4;
            }
            const f = await _fetch();
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
            let res;
            try {
                res = await f(
                    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':  'application/json',
                            'Authorization': `Bearer ${keyValue}`,
                        },
                        body: JSON.stringify(cfBody),
                        signal: ctl.signal,
                    }
                );
            } finally { clearTimeout(t); }
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                const err = new Error(`cloudflare ${res.status}: ${txt.slice(0, 200)}`);
                err.status = res.status;
                throw err;
            }
            const json = await res.json();
            // Cloudflare's /ai/v1/chat/completions wraps the OpenAI-compat
            // payload inside `result` (i.e. json.result.choices[...]), while
            // its native /ai/run/{model} endpoint returns json.result.response.
            const result  = json.result || json;
            const choice0 = ((result.choices || [])[0]) || {};
            const msg     = choice0.message || {};
            const finishReason = choice0.finish_reason || choice0.stop_reason || '';
            let   text    = msg.content || result.response || '';

            // Reasoning-model fallback: if content is empty but we got
            // reasoning_content, try to extract a JSON object from the
            // reasoning text. Crucially, we ONLY accept JSON — never
            // raw prose — because the upstream caller will parse this
            // with JSON.parse and would otherwise throw
            // "AI returned non-JSON: We need to analyze market...".
            if (!text && msg.reasoning_content) {
                const rc = String(msg.reasoning_content);
                // Greedy match: largest balanced-looking {...} block in the
                // reasoning trace. gpt-oss usually "thinks aloud" then
                // produces the final JSON near the end.
                const matches = rc.match(/\{[\s\S]*\}/g);
                if (matches && matches.length) {
                    // Prefer the last JSON-looking block — that's normally
                    // the model's final answer after its scratchpad.
                    for (let i = matches.length - 1; i >= 0; i--) {
                        try { JSON.parse(matches[i]); text = matches[i]; break; }
                        catch (_) { /* try previous */ }
                    }
                }
            }

            if (!text) {
                // Surface the real reason so the runner log is actionable
                // instead of just "cloudflare returned empty text".
                const why = finishReason === 'length'
                    ? 'truncated (finish_reason=length) — raise max_tokens or lower reasoning.effort'
                    : (msg.reasoning_content
                        ? 'reasoning-only response with no extractable JSON'
                        : 'no content returned');
                throw new Error(`cloudflare returned empty text: ${why}`);
            }
            return String(text).trim();
        }
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
    // Each provider supports key_registry[] (multi-key rotation, same as Gemini)
    // or a single key_env. key_registry takes precedence when present and non-empty.
    const providers = (config.ai && Array.isArray(config.ai.providers)) ? config.ai.providers : [];
    for (const p of providers) {
        if (!p || p.enabled === false) continue;
        const name = String(p.name || '').toLowerCase();
        // Skip Gemini — stage 1 already covered it.
        if (name === 'gemini') continue;

        const provRegistry = Array.isArray(p.key_registry) && p.key_registry.length > 0
            ? p.key_registry
            : (p.key_env ? [p.key_env] : []);

        if (!provRegistry.length) {
            Logger.warn(`Provider "${name}" has no key_registry or key_env — skipping`);
            continue;
        }

        const ordered = _orderKeys(provRegistry, state.ai_keys_bench, now);
        for (const row of ordered) {
            const keyValue = process.env[row.name];
            if (!keyValue) {
                Logger.warn(`Provider "${name}" key env "${row.name}" not set — skipping`);
                continue;
            }
            if (row.benched) {
                Logger.warn(`Provider "${name}" key "${row.name}" benched; trying anyway as fallback`);
            }
            try {
                const text = await _callProvider(p, { keyValue, keyName: row.name, prompt: fullPrompt, timeoutMs, config });
                const parsed = _parseJsonStrict(text);
                if (state.ai_keys_bench[row.name]) delete state.ai_keys_bench[row.name];
                Logger.info(`AI decision via provider "${name}" key "${row.name}"`, {
                    action: parsed.action, symbol: parsed.symbol, conf: parsed.confidence,
                });
                return { decision: parsed, keyUsed: row.name };
            } catch (e) {
                lastErr = e;
                state.ai_keys_bench[row.name] = now + benchMin * 60 * 1000;
                Logger.warn(`Provider "${name}" key "${row.name}" failed — benching ${benchMin}m`, { error: e.message });
            }
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
        '  • expiry_seconds MUST be >= 900 (15 minutes — Deriv forex intraday floor).',
        '    ANY duration at or above 900 seconds is allowed (e.g. 900, 1200, 1800,',
        '    3600, ... up to 24h). Pick whatever duration best fits the setup —',
        '    there is no implicit preference for the minimum.',
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
    expiry_seconds: 'integer >= 900 (any value at or above 15m is fine), required if action=trade',
    stake: 'number, required if action=trade',
    confidence: 'number 0.0-1.0',
    rationale: 'short string explaining the setup',
}, null, 2);

module.exports = {
    askDecision,
    askPostMortem,
};
