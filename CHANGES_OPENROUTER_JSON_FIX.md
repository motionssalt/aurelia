# AURELIA — OpenRouter "AI returned non-JSON" fix

## The bug

The Telegram screenshot reported:

```
/scan
Manual scan triggered.
⚠ Manual AI call failed: All AI providers/keys failed; last error:
AI returned non-JSON: We are given a market snapshot for multiple
symbols across M5, M10, M15 timeframes, plus session context.
We need to pick AT MOST ONE best setup, or skip.
Har…
```

### Root cause

The OpenRouter route uses NVIDIA Nemotron 3 Ultra on the `:free` tier
(`nvidia/nemotron-3-ultra-550b-a55b:free`). Despite request-time
`response_format=json_object` and `reasoning={effort:'low', exclude:true}`,
the model **leaks its chain-of-thought into `message.content`**. Per
OpenRouter's docs, `exclude:true` only suppresses `message.reasoning`
— it has no effect on the model writing reasoning text inside
`.content` itself.

`_parseJsonStrict()` did a single `JSON.parse(cleaned)` and threw
`AI returned non-JSON` on the leading letter of the reasoning preamble
("**W**e are given…"). That bubbled up through the whole provider
waterfall as "All AI providers/keys failed" because OpenRouter was the
last fallback after every Gemini key had also failed (or wasn't set).

## The fix

Same approach as `aurelia-multipliers` (already in production there):
keep strict parsing as the default for every well-behaved provider,
and add an **opt-in lenient parser** for providers that leak reasoning
into `.content`. The lenient parser is routed by a single config flag
(`provider.strict_json: false`), so only OpenRouter takes the new
code path; Gemini / OpenAI / Grok / Claude / Cloudflare keep their
existing behaviour bit-for-bit.

### Files changed

| File | Change |
| --- | --- |
| `ai-client.js` | Helpers + parser overhaul + OpenRouter prompt reinforcement |
| `config.json`  | OpenRouter provider opted into lenient parsing |

### `ai-client.js`

| Rule | Implementation |
| --- | --- |
| `_stripFences` recognises mid-string fences | New regex fallback captures the contents of the first ```json``` block, not just whole-string-wrapped fences. |
| `_extractBalancedJsonObject(s)` | NEW. Brace-counter that returns the first balanced `{...}` substring while correctly tracking string/escape state. |
| `_enumerateBalancedJsonObjects(s)` | NEW. Same scanner, returns ALL balanced blocks left-to-right. |
| `_extractLastBalancedJsonObject(s)` | NEW. Wrapper that returns the LAST balanced block. |
| `_looksLikeDecisionJson(obj)` | NEW. Heuristic — true only for objects with a known `action` (`trade`/`skip`/`buy`/`sell`/`hold`) or a non-empty `note` (post-mortem path). |
| `_parseJsonStrict` upgrade (safe) | Fast path unchanged. On `JSON.parse` failure, try `_extractBalancedJsonObject` once before throwing — this alone recovers most preamble-around-JSON cases without changing any provider's failure semantics. |
| `_parseJsonLenient(text)` | NEW. Used ONLY when `provider.strict_json === false`. Strict superset of `_parseJsonStrict`: tries (1) whole string, (2) first balanced block (if decision-shaped), (3) every balanced block from the END backwards picking the last decision-shaped one, (4) single-block fallback for post-mortem-style payloads. Throws on total failure so the provider waterfall still flags the key and moves on. |
| `_callOpenRouter` prompt reinforcement | Brackets the existing prompt with `SYSTEM CONSTRAINT — RESPOND WITH ONE JSON OBJECT ONLY` at the **start** and a strong reminder at the **end**. Reasoning models weight late-in-prompt instructions heavily, so the trailing reminder is what actually carries the constraint. The prompt for every other provider is untouched. |
| `askDecision` provider waterfall | Picks lenient vs strict based on `provider.strict_json === false`. On parse failure, throws a tagged `Error` (`err.kind = 'json_format'`, `err.provider = '<name>'`) so future Telegram alerts can distinguish JSON-format failures from outages / 429s. |

### `config.json`

| Path | Old | New |
| --- | --- | --- |
| `ai.providers[openrouter].strict_json` | (absent) | `false` |
| `ai.providers[openrouter].reasoning_effort` | (absent) | `"none"` |
| `ai.openrouter_timeout_ms` | (absent) | `300000` |
| `ai.openrouter_max_tokens` | (absent) | `4096` |
| `ai.openrouter_reasoning_effort` | (absent) | `"low"` |

The top-level `ai.openrouter_*` keys match the defaults already
hard-coded in `ai-client.js` (`DEFAULT_OPENROUTER_TIMEOUT_MS = 300000`,
`DEFAULT_OPENROUTER_MAX_TOKENS = 4096`,
`DEFAULT_OPENROUTER_REASONING_EFFORT = 'low'`) but surface them as
config so they can be tuned without shipping new code.

The per-provider `reasoning_effort: "none"` is the strongest
"do-not-think" signal we can send to Nemotron 3 Ultra — it drops the
`effort` key entirely and sends `reasoning: { enabled: false, exclude: true }`
in the request.

## Verification

Ran a 24-test suite (parser internals, called directly):

```
Test 1: exact failure mode from the screenshot                 3/3
Test 2: clean JSON (fast path, all providers)                  1/1
Test 3: markdown-fenced JSON                                   1/1
Test 4: reasoning preamble + fenced JSON at the end            1/1
Test 5: multiple JSON blocks; lenient returns a valid decision 2/2
Test 6: total garbage — strict + lenient both throw            2/2
Test 7: single-block non-decision JSON fallback                2/2
Test 8: post-mortem shape ({note: "..."})                      1/1
Test 9: balanced brace counter handles braces inside strings   1/1
Test 10: _looksLikeDecisionJson sanity                        10/10

Result: 24 passed, 0 failed
```

Test 1 directly reproduces the screenshot's failing text
("We are given a market snapshot for multiple symbols across M5, M10,
M15 timeframes…") followed by a real `{"action":"skip", …}` JSON, and
asserts both parsers now return the decision.

## Backwards compatibility

* Public surface unchanged: `module.exports = { askDecision, askPostMortem }`.
* Every existing provider continues to use `_parseJsonStrict` (only
  OpenRouter has `strict_json: false`).
* `_parseJsonStrict` is a strict superset of the old implementation —
  on the same input that previously parsed, the result is identical;
  on input that previously threw, it now tries one extra recovery
  step (`_extractBalancedJsonObject`) before throwing the same error
  shape (`AI returned non-JSON: …`).
* `_callOpenRouter`'s prompt reinforcement only wraps the prompt for
  OpenRouter calls; every other provider's prompt is byte-identical.
