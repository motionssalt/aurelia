/* =====================================================================
   AURELIA — calendar.js
   ─────────────────────────────────────────────────────────────────────
   ForexFactory economic calendar fetcher.

   Public surface:
     fetchCalendar()                        → Promise<event[]>
     findQualifyingEvent(calendar, nowMs?)  → event | null
         (kept for backward compatibility — returns the single best event)
     findQualifyingEvents(calendar, nowMs?) → event[]
         (NEW — returns ALL events in the qualifying window, sorted by
          proximity. When multiple events share the same timestamp
          (e.g. NFP + Unemployment Rate + Avg Hourly Earnings all at
          12:30 UTC) all of them are returned so the AI can reason
          over the combined bundle.)
     eventToSymbols(event)                  → string[] (Deriv symbols)
     minutesUntil(event, nowMs?)            → number
     describeEvent(event)                   → string
     describeEvents(events)                 → string  (bundle description)
     groupEventsByTime(events, toleranceMs?)→ event[][] (same-time buckets)

   The source file (ff_calendar_thisweek.json) is regenerated hourly
   server-side, so we refresh no more than once per hour.
   ===================================================================== */

'use strict';

const Logger = require('./logger');

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/* Qualifying window (minutes from now).
   ─────────────────────────────────────────────────────────────────
   The GitHub Actions cron runs every ~5 min (with ±1-2 min jitter
   from cron-job.org). To guarantee EVERY event is caught by at
   least one tick, the window must be strictly wider than the
   cron cadence. We use [0.5, 15]:
     • Lower bound 0.5 min — still catches an event even if the
       cron tick lands 30 s before it (previous code used 2 min,
       which silently DROPPED any event that fell into the
       [0, 2) bucket for a given tick — the biggest cause of
       missed events).
     • Upper bound 15 min — with 5-min cron cadence, this means an
       event is seen on 3 consecutive ticks (~15/10/5 min out) so
       even if one tick is dropped by GitHub Actions or cron-job.org
       we still have redundant chances to fire.
   Ideal-lead-time target for "closest" ranking is 5 min out. */
const WINDOW_MIN_MINUTES     = 0.5;
const WINDOW_MAX_MINUTES     = 15;
const IDEAL_LEAD_MINUTES     = 5;

/* Tolerance for grouping events that fire at the "same time".
   ForexFactory publishes to the minute, so anything within 60 s of
   another event is treated as a simultaneous release. */
const SAME_TIME_TOLERANCE_MS = 60 * 1000;

/* Country-code → Deriv forex symbol(s).
   We map the event currency to ALL enabled forex pairs that contain
   that currency so the AI can pick the most technically attractive. */
const COUNTRY_SYMBOL_MAP = {
    USD: ['frxEURUSD','frxGBPUSD','frxUSDJPY','frxAUDUSD','frxUSDCAD','frxUSDCHF','frxNZDUSD'],
    EUR: ['frxEURUSD','frxEURJPY','frxEURGBP','frxEURAUD','frxEURCAD','frxEURCHF'],
    GBP: ['frxEURGBP','frxGBPUSD','frxGBPJPY'],
    JPY: ['frxUSDJPY','frxEURJPY','frxGBPJPY','frxAUDJPY'],
    AUD: ['frxAUDUSD','frxEURAUD','frxAUDJPY'],
    CAD: ['frxUSDCAD','frxEURCAD'],
    CHF: ['frxUSDCHF','frxEURCHF'],
    NZD: ['frxNZDUSD'],
};

/* Fetch the calendar JSON from the NFS endpoint.
   Returns an array of event objects. On failure, throws a descriptive
   error — the caller decides how to handle it (alert + keep stale). */
async function fetchCalendar() {
    Logger.info('Fetching ForexFactory calendar...');
    let res;
    try {
        res = await fetch(CALENDAR_URL, {
            headers: { Accept: 'application/json' },
        });
    } catch (e) {
        throw new Error(`Calendar network error: ${e.message}`);
    }
    if (!res.ok) {
        throw new Error(`Calendar HTTP ${res.status}`);
    }
    const text = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`Calendar non-JSON response`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`Calendar unexpected schema (expected array, got ${typeof parsed})`);
    }
    /* Basic shape validation — at least check the first few items. */
    const valid = parsed.filter(ev =>
        ev && typeof ev.title === 'string' && typeof ev.country === 'string' && typeof ev.date === 'string'
    );
    if (valid.length === 0 && parsed.length > 0) {
        throw new Error(`Calendar schema mismatch — no valid events found`);
    }
    Logger.info('Calendar fetched', { events: valid.length });
    return valid;
}

/* Return the number of minutes from now until the event fires.
   Negative = event is in the past. */
function minutesUntil(event, nowMs) {
    const eventMs = Date.parse(event.date);
    const now = nowMs || Date.now();
    return (eventMs - now) / 60000;
}

/* ─────────────────────────────────────────────────────────────────
   findQualifyingEvents(calendar, nowMs?) → event[]

   Return ALL events whose fire-time falls inside the qualifying
   window [WINDOW_MIN_MINUTES, WINDOW_MAX_MINUTES] minutes from now,
   sorted by proximity to the ideal lead time (5 min).

   The returned array preserves original event objects (no wrapping)
   so downstream code can pass them straight to eventToSymbols /
   describeEvent. Duplicates within 60 s of each other are all
   included — grouping is the caller's responsibility (see
   groupEventsByTime).

   This is the primary lookup used by news-mode. The old
   findQualifyingEvent (singular) is retained as a thin wrapper for
   backward compatibility.
   ───────────────────────────────────────────────────────────────── */
function findQualifyingEvents(calendar, nowMs) {
    if (!Array.isArray(calendar) || calendar.length === 0) return [];
    const now = nowMs || Date.now();

    const candidates = calendar
        .map(ev => ({ ev, mins: minutesUntil(ev, now) }))
        .filter(({ mins }) => mins >= WINDOW_MIN_MINUTES && mins <= WINDOW_MAX_MINUTES);

    if (candidates.length === 0) return [];

    /* Sort by distance to ideal lead time (5 min out). Events that
       are equally close keep their original calendar order. */
    candidates.sort((a, b) =>
        Math.abs(a.mins - IDEAL_LEAD_MINUTES) - Math.abs(b.mins - IDEAL_LEAD_MINUTES)
    );

    return candidates.map(c => c.ev);
}

/* Backward-compatible singular helper — returns just the top event
   from findQualifyingEvents, or null. Existing callers that only
   want a single event keep working; new callers should use
   findQualifyingEvents to get the full batch. */
function findQualifyingEvent(calendar, nowMs) {
    const list = findQualifyingEvents(calendar, nowMs);
    return list.length > 0 ? list[0] : null;
}

/* Group events into buckets of near-simultaneous releases.
   Two events belong to the same bucket when their fire-times are
   within `toleranceMs` of each other (default 60 s).

   Input events do NOT need to be pre-sorted. Output is an array of
   buckets, each bucket is an array of events sharing a fire-time.
   Buckets are ordered by their (earliest) fire-time ascending. */
function groupEventsByTime(events, toleranceMs) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const tol = typeof toleranceMs === 'number' ? toleranceMs : SAME_TIME_TOLERANCE_MS;

    const withTime = events
        .map(ev => ({ ev, t: Date.parse(ev.date) }))
        .filter(x => Number.isFinite(x.t))
        .sort((a, b) => a.t - b.t);

    const buckets = [];
    for (const x of withTime) {
        const last = buckets[buckets.length - 1];
        if (last && Math.abs(x.t - last.t) <= tol) {
            last.events.push(x.ev);
            /* Keep bucket timestamp anchored to the earliest event in it. */
        } else {
            buckets.push({ t: x.t, events: [x.ev] });
        }
    }
    return buckets.map(b => b.events);
}

/* Map an event's country code to the Deriv forex symbol(s) that
   contain that currency. Returns [] if no mapping exists. */
function eventToSymbols(event) {
    if (!event || !event.country) return [];
    return COUNTRY_SYMBOL_MAP[event.country.toUpperCase()] || [];
}

/* Build a human-readable description of a SINGLE event for AI context. */
function describeEvent(event) {
    if (!event) return '';
    const mins = Math.round(minutesUntil(event));
    const timeLabel = mins > 0 ? `${mins} min from now` : (mins < 0 ? `${Math.abs(mins)} min ago` : 'now');
    const parts = [
        `Event: ${event.title}`,
        `Country/Currency: ${event.country}`,
        `Time: ${event.date} (${timeLabel})`,
        `Impact: ${event.impact || 'unknown'}`,
    ];
    if (event.forecast) parts.push(`Forecast: ${event.forecast}`);
    if (event.previous) parts.push(`Previous: ${event.previous}`);
    return parts.join('\n');
}

/* Build a human-readable description of a BUNDLE of events (one or
   many) sharing approximately the same fire-time. Used by news-mode
   to give the AI the full multi-event picture instead of just one. */
function describeEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return '';
    if (events.length === 1) return describeEvent(events[0]);

    const first = events[0];
    const mins  = Math.round(minutesUntil(first));
    const timeLabel = mins > 0 ? `${mins} min from now` : (mins < 0 ? `${Math.abs(mins)} min ago` : 'now');

    const header = [
        `Simultaneous release: ${events.length} events at ${first.date} (${timeLabel})`,
        `Currencies affected: ${Array.from(new Set(events.map(e => e.country))).join(', ')}`,
        '',
    ];

    const body = events.map((ev, i) => {
        const lines = [
            `[Event ${i + 1}] ${ev.title}`,
            `  Country/Currency: ${ev.country}`,
            `  Impact: ${ev.impact || 'unknown'}`,
        ];
        if (ev.forecast) lines.push(`  Forecast: ${ev.forecast}`);
        if (ev.previous) lines.push(`  Previous: ${ev.previous}`);
        return lines.join('\n');
    });

    return header.concat(body).join('\n');
}

module.exports = {
    fetchCalendar,
    findQualifyingEvent,     // legacy singular (returns top event)
    findQualifyingEvents,    // NEW plural (returns full list)
    groupEventsByTime,       // NEW helper for same-time bundling
    eventToSymbols,
    minutesUntil,
    describeEvent,
    describeEvents,          // NEW bundle formatter
    CALENDAR_URL,
    /* Exposed for tests / diagnostics */
    WINDOW_MIN_MINUTES,
    WINDOW_MAX_MINUTES,
    IDEAL_LEAD_MINUTES,
    SAME_TIME_TOLERANCE_MS,
};
