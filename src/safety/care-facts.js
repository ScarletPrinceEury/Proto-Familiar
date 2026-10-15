/**
 * care-facts.js — my human's care-critical standing facts, put in front of me
 * directly (0.14.70, ward-signed — docs/identity-lean-build-spec.md).
 *
 * What helps, what doesn't, meds, allergies, triggers, who to call. These used to
 * sit in my always-injected identity files, which also put them in front of
 * everyone in a group chat. They live as high-care `ward` standing facts now
 * (Phylactery memory.list_care_facts), and this block is how they still reach me
 * reliably — not left to semantic recall happening to match:
 *   • my human's own turns (web, ward DM, voice) — enrich(), ward-private only,
 *     capped at CARE_FACTS_CHAT_MAX_CHARS so it can't re-crowd the context;
 *   • silence triage and noticing — the whole set.
 * NEVER a gated room: every caller checks that before fetching.
 *
 * Server-injected context: authored in the literal "my human" voice, no macros.
 * Pure.
 */

import { excerpt } from '../util/excerpt.js';

export const CARE_FACTS_CHAT_MAX_CHARS = 6000;   // ~1.5k tokens on a chat turn

/**
 * My own high_care flag (save_memory / update_memory_by_id) → the stored
 * care_weight. true → 'high' (in the care list); false → 'low' (explicitly
 * not, which also overrides the wording match in care.py); anything else →
 * undefined (unset: the wording decides). 'high'/'low' is the same vocabulary
 * as the Knowledge editor's care-weight select, so the editor shows and keeps
 * my call. Models sometimes send the boolean as a string, so "true"/"false"
 * count too.
 */
export function careWeightFromFlag(flag) {
  if (flag === true || flag === 'true') return 'high';
  if (flag === false || flag === 'false') return 'low';
  return undefined;
}

/** How many care facts listCareFacts fetches for triage, noticing and the chat block. */
export const CARE_FACTS_FETCH_LIMIT = 60;

/**
 * My own review of the care list (list_care_facts): every fact in the order my
 * care block uses, with its id, how it got onto the list (flagged by me / the
 * cleanup, or only by its wording) and whether it's in my chat-turn block —
 * placed by the same rule as the block (placeCareFacts). So I can take off what
 * isn't really care and keep what is. Ward-private only; the tool checks that.
 */
export function formatCareFactsReview(items, { maxChars = CARE_FACTS_CHAT_MAX_CHARS, fetchLimit = CARE_FACTS_FETCH_LIMIT } = {}) {
  const placed = placeCareFacts(items, maxChars);
  if (!placed.length) return 'Nothing counts as a care fact about my human right now.';
  const tok = n => Math.round(n / 4).toLocaleString('en-US');
  const total = placed.reduce((n, p) => n + p.line.length + 1, 0);
  const inBlock = placed.filter(p => p.inBlock).length;
  const byWording = placed.filter(p => p.item?.how === 'wording').length;
  const head = [
    `My care list: ${placed.length} facts, about ${tok(total)} tokens. ${placed.length - byWording} are flagged high-care; ${byWording} count only because their wording sounds like care.`,
    `On a chat turn with my human my care block holds about ${tok(maxChars)} tokens: ${inBlock} of these. The rest come back only through recall.`,
    placed.length > fetchLimit
      ? `Triage and noticing see the first ${fetchLimit}; the last ${placed.length - fetchLimit} reach neither.`
      : 'Triage and noticing see all of them.',
  ];
  const lines = placed.map((p, i) => {
    const how = p.item?.how === 'wording' ? 'wording' : 'flagged';
    const where = p.inBlock ? 'in block' : 'recall only';
    return `${i + 1}. [${how}, ${where}] ${p.item?.id ?? '?'}: ${excerpt(String(p.item?.content ?? '').trim(), 220)}`;
  });
  return [...head, '', ...lines, '',
    'To take one off the list: update_memory_by_id with high_care: false. To keep a wording one for sure: high_care: true. read_memory_by_id shows a whole fact.',
  ].join('\n');
}

/**
 * The chat-turn care block, or '' — enrich()'s one entry point. A gated (group
 * or villager) turn, or a static-only assembly, returns '' WITHOUT fetching: the
 * facts never even leave Phylactery for a room that isn't my human's own.
 * Best-effort: a failed fetch is ''.
 */
export async function careFactsBlockForTurn({ gated, staticOnly, fetchFacts, maxChars = CARE_FACTS_CHAT_MAX_CHARS }) {
  if (gated || staticOnly) return '';
  try { return formatCareFactsBlock(await fetchFacts(), { maxChars }); }
  catch { return ''; }
}

/**
 * Which care facts make it into a block capped at maxChars, in list order. A
 * fact too long for the room left is skipped, and a shorter one after it can
 * still fit, so "in the block" isn't simply the first N. The one placement
 * rule, shared by the block itself and by list_care_facts' review, so what I'm
 * told is in my block is what's actually in it.
 * @returns {Array<{item, line, inBlock: boolean}>} (empty-content items dropped)
 */
export function placeCareFacts(items, maxChars = Infinity) {
  const placed = [];
  let used = 0;
  let any = false;
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item?.content ?? '').trim();
    if (!text) continue;
    const line = `- ${text}`;
    const inBlock = !any || used + line.length + 1 <= maxChars;
    if (inBlock) { used += line.length + 1; any = true; }
    placed.push({ item, line, inBlock });
  }
  return placed;
}

export function formatCareFactsBlock(items, { maxChars = Infinity } = {}) {
  const placed = placeCareFacts(items, maxChars);
  const lines = placed.filter(p => p.inBlock).map(p => p.line);
  if (!lines.length) return '';
  const left = placed.length - lines.length;
  const more = left ? `\n(${left} more I can recall when they come up.)` : '';
  return '[What I keep in mind about caring for my human]\n'
    + "Things my human has told me matter for their care: what helps, what doesn't, health details, who to call. These stay between my human and me.\n"
    + lines.join('\n') + more;
}
