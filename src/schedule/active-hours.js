/**
 * Active-hours accounting — ward-signed (2026-09, gauge safety ladder G-C.2).
 *
 * The gauge check-in deadline is measured in the ward's ACTIVE hours: their
 * configured quiet hours (their night) do NOT count toward it. So a check that
 * opens at bedtime doesn't quietly "expire" while they sleep and pull the
 * trigger at 3am — the deadline only advances while they could plausibly be
 * awake to answer it.
 *
 * Code owns this arithmetic (the exact-values rule). The interval is walked in
 * fixed steps and each step is classified by the ward-local hour at its
 * midpoint via the DST-correct `wardLocalNowISO` — so a midnight-wrapping quiet
 * window and DST folds are handled by Intl, not by hand-rolled window
 * subtraction, which is the class of silent exact-value bug that rule exists to
 * prevent. The walk short-circuits once `capMs` of active time is counted, so a
 * long-open check costs a bounded number of steps.
 */

import { wardLocalNowISO } from '../../relative-time.js';

// 5-minute resolution: worst-case ±5min on a multi-hour deadline, in exchange
// for not hand-rolling midnight/DST interval algebra. Fine for a care deadline.
export const ACTIVE_STEP_MS = 5 * 60_000;

/**
 * Is `hour` (0–23) inside the quiet window [start, end)? Wraps midnight when
 * start > end (e.g. 23 → 08). start === end disables the window (never quiet),
 * matching `isWarmthQuietHours` in server.js.
 */
export function isQuietHour(hour, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false;
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * Active (non-quiet) elapsed ms in [startMs, endMs] on the ward's clock.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @param {object} [o]
 * @param {number} [o.quietStart=23]  ward-local hour quiet begins
 * @param {number} [o.quietEnd=8]     ward-local hour quiet ends (start===end disables)
 * @param {string|null} [o.tz]        ward IANA zone (null → server-local)
 * @param {number} [o.capMs=Infinity] stop once this much active time is counted
 * @param {(ts:number)=>number} [o.hourAt] test seam: ward-local hour at a ts
 * @returns {number} active ms (0 for a non-positive or invalid interval)
 */
export function activeMsInInterval(startMs, endMs, {
  quietStart = 23, quietEnd = 8, tz = null, capMs = Infinity, hourAt,
} = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const localHour = typeof hourAt === 'function'
    ? hourAt
    : (ts) => Number(wardLocalNowISO(tz, ts).slice(11, 13));
  let active = 0;
  for (let t = startMs; t < endMs && active < capMs; t += ACTIVE_STEP_MS) {
    const chunk = Math.min(ACTIVE_STEP_MS, endMs - t);
    const h = localHour(t + Math.floor(chunk / 2));   // classify by the step's midpoint
    if (!isQuietHour(h, quietStart, quietEnd)) active += chunk;
  }
  return active;
}
