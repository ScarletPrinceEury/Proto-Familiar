/**
 * Tracker projections (trackers build spec §4) — pure, code-only derivations of
 * where a tracker is heading, surfaced as context blocks. No LLM, no stored
 * arithmetic: code owns every date and count; the model only reads.
 *
 * §4 inventory expiry — the "use first" line. (Menses windows + the reminder-node
 * projections are the heavier §4 pieces and land in a later pass.)
 */

// How an item's days-left reads. Code owns the number (from Unruh's
// expiring_items); the model never computes a date.
function whenText(daysLeft) {
  if (!Number.isFinite(daysLeft)) return '';
  if (daysLeft < 0) return 'expired';
  if (daysLeft === 0) return 'today';
  return `${daysLeft}d`;
}

/**
 * The "use first" block from Unruh's `tracker_expiring` items. Server-injected
 * context → literal "my human", plain and short. Soonest-first, capped at 4 so a
 * full pantry can't flood the block. Returns '' for an empty set.
 * @param {Array<{name, days_left}>} items
 */
export const MAX_EAT_FIRST = 4;

export function buildEatFirstBlock(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const line = items
    .slice(0, MAX_EAT_FIRST)
    .map(it => `${it.name} (${whenText(it.days_left)})`)
    .join(' · ');
  const more = items.length > MAX_EAT_FIRST ? ` (+${items.length - MAX_EAT_FIRST} more)` : '';
  return `[Pantry — use first]\n${line}${more}`;
}

// Locale-free "Mon D" — code owns the date (exact-values rule); the model only
// reads it. predict_windows emits local-naive ISO, so a plain YYYY-MM-DD prefix
// is all we parse.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? '').slice(0, 10);
  const mon = MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  return `${mon} ${parseInt(m[3], 10)}`;
}

/**
 * The likely-period-window block from Unruh's `tracker_predictions`. A sensitive
 * health projection, so it's plain and hedged ("around", "predicted") — never a
 * claim of certainty. Server-injected context → literal "my human". Only windows
 * that already cleared the honesty gate (≥2 cycles) reach here. Returns '' for none.
 * @param {Array<{tracker_label, window:{start,end}, cycles_seen}>} predictions
 */
export function buildMensesWindowBlock(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) return '';
  const lines = predictions.map(p => {
    const w = p?.window ?? {};
    if (!w.start || !w.end) return '';
    const cyc = Number.isFinite(p.cycles_seen)
      ? ` (predicted from ${p.cycles_seen} cycle${p.cycles_seen === 1 ? '' : 's'})`
      : '';
    return `  — ${p.tracker_label ?? p.tracker_id}: around ${fmtDay(w.start)} – ${fmtDay(w.end)}${cyc}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return ['[Likely period window]', ...lines].join('\n');
}
