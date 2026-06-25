/* =====================================================================
   AURELIA — risk.js
   ─────────────────────────────────────────────────────────────────────
   Deliberately NOT a stake-computing module. Per REBUILD_PROMPT §5,
   stake sizing is fully AI-determined. This file only provides a SANITY
   CLAMP that the runner applies AFTER the AI returns a stake.

   Clamping rules (hard, non-negotiable):
     • min  : config.stake.absolute_min   (default 0.35)
     • max  : config.stake.absolute_max   (default 10000)
     • 2 decimal places
     • never exceed remaining session capital (cycle path only)
   Manual trades skip the "remaining session capital" check (they're
   stateless w.r.t. the cycle session) but still get min/max + rounding.

   Expiry clamp:
     • Always >= config.expiry.min_seconds (default 900, i.e. 15 min)
   ===================================================================== */

'use strict';

function _round2(n) { return Math.round(Number(n) * 100) / 100; }

function clampStake(stakeRaw, config, opts) {
    const min = (config.stake && config.stake.absolute_min) || 0.35;
    const max = (config.stake && config.stake.absolute_max) || 10000;
    let s = Number(stakeRaw);
    if (!Number.isFinite(s) || s <= 0) s = min;

    if (opts && opts.cycleSessionRemaining != null) {
        const cap = Number(opts.cycleSessionRemaining);
        if (Number.isFinite(cap) && cap > 0) {
            s = Math.min(s, cap);
        }
    }
    s = Math.max(min, Math.min(max, s));
    return _round2(s);
}

function clampExpirySeconds(expiryRaw, config) {
    const floor = (config.expiry && config.expiry.min_seconds) || 900;
    let e = Math.floor(Number(expiryRaw) || 0);
    if (e < floor) e = floor;
    return e;
}

function expirySecondsToMinutes(seconds) {
    return Math.max(1, Math.round(seconds / 60));
}

module.exports = {
    clampStake,
    clampExpirySeconds,
    expirySecondsToMinutes,
};
