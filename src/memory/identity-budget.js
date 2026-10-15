/**
 * identity-budget.js — how much identity rides in front of me every turn
 * (0.14.70, ward-signed — docs/identity-lean-build-spec.md).
 *
 * My human's setting `identityBudgetTokens` (default 6k, adjustable in Settings).
 * Two consumers:
 *   • update_identity's result tells me when a category is over its share, and
 *     what to do about it — a nudge, never a refusal (a refusal could block a
 *     fact that matters);
 *   • Phylactery's graduation pass proposes trims for over-budget files (pushed
 *     there via identity_budget_set). The split and clamps below MIRROR
 *     phylactery/src/phylactery/graduation.py — a test pins the two together.
 */

export const IDENTITY_BUDGET_DEFAULT_TOKENS = 6000;
export const IDENTITY_BUDGET_MIN_TOKENS = 2000;
export const IDENTITY_BUDGET_MAX_TOKENS = 30000;
export const CHARS_PER_TOKEN = 4;
// Self keeps the largest share: it's who I am.
export const CATEGORY_SHARES = Object.freeze({ self: 14 / 24, ward: 6 / 24, relationship: 3 / 24, custom: 1 / 24 });

export function identityBudgetTokens(settings = {}) {
  const n = Math.round(Number(settings?.identityBudgetTokens));
  if (!Number.isFinite(n)) return IDENTITY_BUDGET_DEFAULT_TOKENS;
  return Math.max(IDENTITY_BUDGET_MIN_TOKENS, Math.min(IDENTITY_BUDGET_MAX_TOKENS, n));
}

export function categoryBudgetChars(category, tokens) {
  return Math.floor(tokens * CHARS_PER_TOKEN * (CATEGORY_SHARES[category] ?? 0));
}

// What I do when a category is over — said plainly, once, in my own voice.
const OVER_NOTE = {
  self: 'My core (identity, persona, personhood, wants, boundaries) is mine to shape; notes about myself that only matter sometimes I move to standing facts (save_memory, register me, then remove_from_identity cuts the line), and I tighten sections that sprawl (rewrite_identity_section).',
  ward: "What only matters sometimes — preferences, patterns, care details like what helps, meds or triggers — I move to standing facts about my human (save_memory, register ward, high_care for care details, then remove_from_identity cuts the line), and I tighten what's left (rewrite_identity_section).",
  relationship: 'Specific episodes and details I move to standing facts (save_memory, register ward, then remove_from_identity cuts the line), and I keep the shape of us tight (rewrite_identity_section).',
  custom: "What doesn't need to be in front of me every turn I move to standing facts (save_memory, then remove_from_identity cuts the line), and I tighten what's left (rewrite_identity_section).",
};
const CATEGORY_NAME = { self: 'My self files', ward: 'My files about my human', relationship: 'My files about us', custom: 'My custom files' };

/**
 * '' when the category fits its share, else a first-person note for
 * update_identity's result. `identityAll` is identity_get_all's shape:
 * { self: [{content}], ward: [...], relationship: [...], custom: [...] }.
 */
export function identityBudgetNote(identityAll, category, tokens) {
  const files = Array.isArray(identityAll?.[category]) ? identityAll[category] : [];
  const chars = files.reduce((n, f) => n + String(f?.content ?? '').length, 0);
  const budget = categoryBudgetChars(category, tokens);
  if (!budget || chars <= budget) return '';
  const toTok = (c) => Math.round(c / CHARS_PER_TOKEN / 100) * 100;
  return `${CATEGORY_NAME[category] ?? 'These files'} are at about ${toTok(chars)} tokens, over the ~${toTok(budget)} I keep for them in front of me every turn. ${OVER_NOTE[category] ?? OVER_NOTE.custom}`;
}
