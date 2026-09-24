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
 * Is my human talking about food right now? Pure code (gate in code, ride the
 * turn — no LLM). Fires on general food / eating / kitchen vocabulary OR on any
 * near-expiry item's OWN name appearing in the message (the `trackerTermsRegex`
 * registry-trigger precedent — a name is the ward's own logged string, so it's
 * escaped, word-bounded, and ≥3 chars so a short name can't match inside another
 * word). This is the gate that turns the ambient "use first" block from passive
 * awareness into an active "bring it up now" cue.
 * @param {string} text  the current message
 * @param {string[]} itemNames  the near-expiry items' names
 */
const FOOD_TOPIC_RE = /\b(food|eat|eats|eating|eaten|ate|meal|meals|breakfast|brunch|lunch|dinner|supper|snack|snacks|snacking|cook|cooks|cooking|cooked|bake|baking|recipe|recipes|hungry|starving|peckish|groceries|grocery|fridge|freezer|pantry|cupboard|leftovers?|kitchen)\b/i;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function discussingFood(text, itemNames = []) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (FOOD_TOPIC_RE.test(t)) return true;
  for (const name of (Array.isArray(itemNames) ? itemNames : [])) {
    const n = String(name ?? '').trim();
    if (n.length >= 3 && new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(t)) return true;
  }
  return false;
}

/**
 * The "use first" block from Unruh's `tracker_expiring` items. Server-injected
 * context → literal "my human", plain and short. Soonest-first, capped at 4 so a
 * full pantry can't flood the block. Returns '' for an empty set.
 *
 * When `foodTopic` is set (my human is on the subject of food, per
 * `discussingFood`), the block carries an explicit cue to bring it up now —
 * named plainly, no "if it fits" hedge (CLAUDE.md ward-directed-intent rule).
 * Without it the block stays the ambient passive line it always was.
 * @param {Array<{name, days_left}>} items
 * @param {{foodTopic?: boolean}} [opts]
 */
export const MAX_EAT_FIRST = 4;

export function buildEatFirstBlock(items, { foodTopic = false } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const line = items
    .slice(0, MAX_EAT_FIRST)
    .map(it => `${it.name} (${whenText(it.days_left)})`)
    .join(' · ');
  const more = items.length > MAX_EAT_FIRST ? ` (+${items.length - MAX_EAT_FIRST} more)` : '';
  const block = `[Pantry — use first]\n${line}${more}`;
  if (!foodTopic) return block;
  return `${block}\nOh, right, on the topic of food, I should suggest to use up some food about to go off.`;
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
