/**
 * What I hear back from my identity tools (known-issues A1).
 *
 * Every edit used to answer a bare "ok", and I had no way to look at a file
 * after changing it: the copy in front of me was the one loaded when the turn
 * started. So I re-cut the same passage with different quotes, or rewrote a
 * section and left the next one in twice without knowing. Now an edit says
 * what it did and where, and points at read_identity_file, which shows the
 * file as it is. Plain facts, no verdicts (CLAUDE.md prompt error #6).
 */

import { categoryBudgetChars, CHARS_PER_TOKEN } from './identity-budget.js';

export const CHECK_TAIL = 'read_identity_file shows it now.';

const n = (x) => Number(x || 0).toLocaleString('en-US');
const CATEGORY_NAME = { self: 'self files', ward: 'files about my human', relationship: 'files about us', custom: 'custom files' };

/** The file as it is: size, how the category sits against its share, headings, text. */
export function formatIdentityRead(read, identityAll, budgetTokens) {
  const { category, filename, content = '', chars = content.length, outline = [] } = read ?? {};
  const files = Array.isArray(identityAll?.[category]) ? identityAll[category] : [];
  const total = files.reduce((t, f) => t + String(f?.content ?? '').length, 0);
  const budget = categoryBudgetChars(category, budgetTokens);
  const tok = (c) => Math.round(c / CHARS_PER_TOKEN / 100) * 100;
  const share = budget
    ? ` My ${CATEGORY_NAME[category] ?? 'files here'} together are about ${n(tok(total))} of the ~${n(tok(budget))} tokens I keep for them.`
    : '';
  const heads = outline.length
    ? outline.map(o => `${'#'.repeat(o.level || 2)} ${o.heading}${o.of ? ` (${o.occurrence} of ${o.of})` : ''} · ${n(o.chars)} chars`).join('\n')
    : '(no headings)';
  return `${category}/${filename}: ${n(chars)} chars.${share}\n\nHeadings:\n${heads}\n\n--- the file ---\n${content}`;
}

/** A missing file, with the ones that category has. */
export function identityFileMissing(category, filename, files = []) {
  return `There's no ${category}/${filename}.${files.length ? ` The ${category} files are: ${files.join(', ')}.` : ''}`;
}

const which = (count) => Array.from({ length: Math.max(0, Number(count) || 0) }, (_, i) => i + 1).join(' or ');

/** Why a rewrite or delete changed nothing. `verb` is "rewritten" / "deleted". */
export function identityRefusal(verb, res, { category, filename, section }) {
  const where = `${category}/${filename}`;
  switch (res?.code) {
    case 'duplicate':
      return `Nothing ${verb}: there are ${res.count} sections headed "${section}" in ${where}. I pass occurrence (${which(res.count)}) to say which one; read_identity_file numbers them.`;
    case 'bad_occurrence':
      return `Nothing ${verb}: there's no section "${section}" number that high in ${where} (there are ${res.count}).`;
    case 'includes_heading': {
      const h = res.headings?.[0] ?? '';
      return `Nothing ${verb}: the new text has "${h}" in it, which ${where} already has as its own section. I can rewrite "${h}" on its own, or leave it out of this one.`;
    }
    default: {
      const heads = Array.isArray(res?.sections) ? res.sections : null;
      const hint = heads?.length
        ? ` Its headings are: ${heads.map(h => `"${h}"`).join(', ')}.`
        : (heads ? ' It has no ## headings, so I cut lines with remove_from_identity instead.' : '');
      return `Nothing ${verb}: ${res?.error ?? 'phylactery unavailable'}.${hint}`;
    }
  }
}

/** Where an append landed. */
export function appendedText({ category, filename, added, chars, under, created }) {
  const unit = Number(added) === 1 ? 'char' : 'chars';
  if (created) return `Started ${category}/${filename} with ${n(added)} ${unit}.`;
  return `Added ${n(added)} ${unit} at the end of ${category}/${filename}${under ? `, under "${under}"` : ''} (now ${n(chars)}).`;
}

/** A passage that couldn't be cut. */
export function removeRefusal(res, { category, filename }) {
  if (res?.code === 'not_found') {
    return `Nothing removed: that passage isn't in ${category}/${filename} as quoted. It may already be gone (read_identity_file shows the file now), or the quote differs from the file.`;
  }
  return `Nothing removed: ${res?.error ?? 'phylactery unavailable'}.`;
}
