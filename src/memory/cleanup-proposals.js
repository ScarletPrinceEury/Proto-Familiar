/**
 * Identity cleanup proposals (0.14.78) — how they read to me.
 *
 * My memory upkeep no longer cuts my identity files on its own. It proposes:
 * an exact passage, the standing fact it would become, and why. These format
 * the open proposals for my turn (a bounded block) and for my own full review
 * (list_cleanup_proposals). Pure: the caller fetches, these only render.
 */

/** How much room the per-turn block may take. At least one proposal always shows. */
export const CLEANUP_BLOCK_MAX_CHARS = 3000;
/** A passage longer than this is cut short in the block; my review shows it whole. */
export const CLEANUP_PASSAGE_MAX_CHARS = 600;

export const CLEANUP_BLOCK_TITLE = '[Cleanup proposals for my identity';

function destination(p) {
  const who = p.register === 'me' ? 'a standing fact about me' : 'a standing fact about my human';
  return p.care_weight === 'high' ? `${who} (high-care)` : who;
}

function clip(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return { text: s, cut: false };
  const at = s.lastIndexOf(' ', max);
  return { text: `${s.slice(0, at > max * 0.6 ? at : max)}…`, cut: true };
}

function formatOne(p, n, { passageMax = Infinity } = {}) {
  const passage = clip(p.passage, passageMax);
  const lines = [
    `${n}. [id: ${p.id}] ${p.category}/${p.filename} → ${destination(p)}`,
    `   Passage: "${passage.text}"${passage.cut ? ' (cut short here)' : ''}`,
  ];
  if (p.fact && p.fact.trim() !== String(p.passage ?? '').trim()) lines.push(`   Would become: "${p.fact.trim()}"`);
  if (p.why) lines.push(`   Why: ${p.why}`);
  return { text: lines.join('\n'), cut: passage.cut };
}

/**
 * The per-turn block: as many open proposals as fit the budget (always one),
 * then a count of the rest. '' when there are none.
 */
export function formatCleanupProposalsBlock(items, { maxChars = CLEANUP_BLOCK_MAX_CHARS } = {}) {
  const open = Array.isArray(items) ? items.filter(p => p && p.id && p.passage) : [];
  if (!open.length) return '';
  const head = `${CLEANUP_BLOCK_TITLE} — my memory upkeep thinks these passages only matter sometimes, so they could become standing facts I recall when they're relevant. Nothing has moved yet; each one is my call.]`;
  const shown = [];
  let used = head.length;
  let anyCut = false;
  for (const p of open) {
    const one = formatOne(p, shown.length + 1, { passageMax: CLEANUP_PASSAGE_MAX_CHARS });
    if (shown.length && used + one.text.length > maxChars) break;
    shown.push(one.text);
    used += one.text.length + 1;
    anyCut = anyCut || one.cut;
  }
  const rest = open.length - shown.length;
  const tail = [];
  if (rest > 0 || anyCut) {
    tail.push(rest > 0
      ? `${rest} more after these. list_cleanup_proposals shows them all, passages in full.`
      : 'list_cleanup_proposals shows the passages in full.');
  }
  tail.push('apply_cleanup_proposal saves the fact, then cuts exactly that passage (I can give my own wording, or set high_care). dismiss_cleanup_proposal leaves the passage where it is, and it isn\'t proposed again.');
  return [head, ...shown, ...tail].join('\n');
}

const STATUS_WORDS = {
  open: 'open', applied: 'applied', dismissed: 'dismissed', stale: 'stale (the passage changed, so it no longer applies)',
};

/** My full review: every open proposal in full, plus decided ones when asked. */
export function formatCleanupProposalsReview(items, { includeDecided = false } = {}) {
  const all = Array.isArray(items) ? items.filter(p => p && p.id) : [];
  const open = all.filter(p => p.status === 'open');
  const decided = includeDecided ? all.filter(p => p.status !== 'open') : [];
  if (!open.length && !decided.length) {
    return includeDecided
      ? 'There are no cleanup proposals for my identity, open or decided.'
      : 'There are no open cleanup proposals for my identity.';
  }
  const out = [];
  out.push(open.length
    ? `${open.length} open cleanup proposal${open.length === 1 ? '' : 's'} for my identity (nothing has moved yet):`
    : 'No open cleanup proposals for my identity.');
  open.forEach((p, i) => out.push(formatOne(p, i + 1).text));
  if (decided.length) {
    out.push('', 'Already decided:');
    for (const p of decided) {
      const when = p.resolved_at ? ` ${String(p.resolved_at).slice(0, 10)}` : '';
      const where = p.status === 'applied' && p.memory_id ? ` → ${p.memory_id}` : '';
      out.push(`- [${p.id}] ${STATUS_WORDS[p.status] ?? p.status}${when}${where}: ${p.summary ?? clip(p.passage, 80).text}`);
    }
  }
  return out.join('\n');
}
