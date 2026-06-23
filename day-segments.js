/**
 * Day-segmentation — group a session's messages by LOCAL calendar date.
 *
 * The Hybrid model (see docs/day-anchoring-build-spec.md): the live session log
 * stays one intact file; a "day-segment" is DERIVED here at memorization time.
 * Dates are computed in the server's local timezone (the ward's machine time),
 * which the coverage ledger stamps for the record.
 *
 * Pure + synchronous → trivially testable; no I/O, no Phylactery.
 */

// Local calendar date 'YYYY-MM-DD' of an ISO/epoch timestamp, or null if the
// timestamp is missing/unparseable. Uses local-time accessors on purpose.
export function localDateOf(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The readable-message test the memorizer uses (skip tool turns, skip the
// assistant turn that only carries tool_calls, require non-empty string body).
// Shared so day-segment "is there enough here" counts match what extraction sees.
export function isReadableMessage(m) {
  if (!m || m.role === 'tool') return false;
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
  return typeof m.content === 'string' && m.content.trim().length > 0;
}

/**
 * Group `messages` by local calendar date. Returns one segment per date, in
 * date order:
 *   { date, startIdx, endIdx, count, readableCount, messages }
 *
 * - Grouping is by DATE, not by contiguous run, so an out-of-order timestamp
 *   can't split one date into two ledger entries (start/end span the date's
 *   indices; dupKey uniqueness comes from the date anyway).
 * - A message with no usable timestamp inherits the previous message's resolved
 *   date; a leading run with none inherits the first dated message's date.
 *   If NOTHING is dated, everything falls under today's local date.
 */
export function segmentByDay(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const rawDates = messages.map(m => localDateOf(m?.timestamp));
  const firstKnown = rawDates.find(Boolean) ?? localDateOf(new Date().toISOString());
  let prev = firstKnown;
  const resolved = rawDates.map(d => {
    if (d) { prev = d; return d; }
    return prev;
  });

  const byDate = new Map(); // date -> { idxs:[], messages:[] }
  messages.forEach((m, i) => {
    const date = resolved[i];
    if (!byDate.has(date)) byDate.set(date, { idxs: [], messages: [] });
    const e = byDate.get(date);
    e.idxs.push(i);
    e.messages.push(m);
  });

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, e]) => ({
      date,
      startIdx: e.idxs[0],
      endIdx: e.idxs[e.idxs.length - 1],
      count: e.messages.length,
      readableCount: e.messages.filter(isReadableMessage).length,
      messages: e.messages,
    }));
}
