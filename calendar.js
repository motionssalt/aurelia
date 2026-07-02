/* =====================================================================
   AURELIA — calendar.js
   ─────────────────────────────────────────────────────────────────────
   ForexFactory economic calendar fetcher.

   Public surface:
     fetchCalendar()                → Promise<event[]>
     findQualifyingEvent(calendar, nowMs?) → event | null
     eventToSymbols(event)          → string[] (Deriv symbols)
     minutesUntil(event, nowMs?)    → number

   The source file (ff_calendar_thisweek.json) is regenerated hourly
   server-side, so we refresh no more than once per hour.
   ===================================================================== */

'use strict';

const Logger = require('./logger');

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

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

/* Find a qualifying upcoming news event:
   • Event is in the future (between 2 and 10 minutes from now).
   • We look for the closest event that falls within the "5 minutes
     before" window, with relaxed tolerance (±3 min) since cron ticks
     land on 5-minute boundaries and won't always hit exactly -5 min.
   • Returns the single best-matching event, or null if none qualify.

   We deliberately do NOT filter by impact level — the AI decides
   whether an event is worth trading. */
function findQualifyingEvent(calendar, nowMs) {
    if (!Array.isArray(calendar) || calendar.length === 0) return null;
    const now = nowMs || Date.now();

    /* Window: events between 2 and 10 minutes from now.
       The sweet spot is ~5 min before the event — enough time for the
       AI to analyse and place a trade, but close enough that the pre-
       news price action is meaningful. */
    const candidates = calendar
        .map(ev => ({ ev, mins: minutesUntil(ev, now) }))
        .filter(({ mins }) => mins >= 2 && mins <= 10);

    if (candidates.length === 0) return null;

    /* Pick the event closest to 5 minutes away (the ideal lead time). */
    candidates.sort((a, b) => Math.abs(a.mins - 5) - Math.abs(b.mins - 5));
    return candidates[0].ev;
}

/* Map an event's country code to the Deriv forex symbol(s) that
   contain that currency. Returns [] if no mapping exists. */
function eventToSymbols(event) {
    if (!event || !event.country) return [];
    return COUNTRY_SYMBOL_MAP[event.country.toUpperCase()] || [];
}

/* Build a human-readable description of the event for AI context. */
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

module.exports = {
    fetchCalendar,
    findQualifyingEvent,
    eventToSymbols,
    minutesUntil,
    describeEvent,
    CALENDAR_URL,
};
