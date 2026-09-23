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
