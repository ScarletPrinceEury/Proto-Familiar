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

export const CARE_FACTS_CHAT_MAX_CHARS = 6000;   // ~1.5k tokens on a chat turn

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

export function formatCareFactsBlock(items, { maxChars = Infinity } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = [];
  let used = 0;
  let left = 0;
  for (const it of items) {
    const text = String(it?.content ?? '').trim();
    if (!text) continue;
    const line = `- ${text}`;
    if (lines.length && used + line.length + 1 > maxChars) { left += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const more = left ? `\n(${left} more I can recall when they come up.)` : '';
  return '[What I keep in mind about caring for my human]\n'
    + "Things my human has told me matter for their care: what helps, what doesn't, health details, who to call. These stay between my human and me.\n"
    + lines.join('\n') + more;
}
