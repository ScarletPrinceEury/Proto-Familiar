/**
 * Villager consent self-service — the `!consent` command over Discord DM.
 *
 * The consent model's original intent: "ask" means ask the PERSON the fact
 * is about, not only my human — my human already has full access and
 * control through the UI. This module gives every registered villager a
 * small menu about THEMSELVES: what I remember about them, what I'm
 * holding pending review, and their own per-category consent settings —
 * which they can change directly.
 *
 * Privacy spine:
 *  - Only a REGISTERED villager, in their own DM, about THEMSELVES.
 *    (Strangers' DMs never reach this code — the router ignores them.)
 *  - Shown facts are ones where they are a recorded subject; briefs only.
 *  - Their changes touch only their own remember map, are audit-logged
 *    (discord-writes), and are visible to my human in the Village UI —
 *    no covert state changes in either direction.
 *
 * Pure functions here; the gateway wires I/O. No LLM call anywhere — a
 * consent menu must be exact, so it is code, not judgment.
 */
import { REMEMBER_CATEGORIES, setVillagerRemember, standingConsentActive } from './village.js';

// Plain-language names per category — shown in the menu and accepted as
// command aliases alongside the raw keys.
export const CATEGORY_LABELS = {
  basics:            'basics (name, everyday facts)',
  emotional_content: 'feelings (moods, emotional moments)',
  health_info:       'health',
  relationships:     'relationships',
  whereabouts:       'whereabouts (places, travel)',
};
const CATEGORY_ALIASES = {
  basics: 'basics', feelings: 'emotional_content', emotions: 'emotional_content',
  emotional_content: 'emotional_content', health: 'health_info', health_info: 'health_info',
  relationships: 'relationships', whereabouts: 'whereabouts', places: 'whereabouts',
};
const GATE_WORDS = { keep: true, ask: 'ask', never: false };

/** Is this message the consent command at all? (leading `!consent`) */
export function isConsentCommand(text) {
  return /^\s*!consent\b/i.test(String(text ?? ''));
}

/**
 * Parse a `!consent …` message.
 * Returns { action:'menu' } | { action:'set', gate, categories:[…] } |
 * { action:'help', error? }.
 */
export function parseConsentCommand(text) {
  const t = String(text ?? '').trim();
  if (!isConsentCommand(t)) return null;
  const rest = t.replace(/^\s*!consent\b/i, '').trim();
  if (!rest) return { action: 'menu' };
  const [word, ...catWords] = rest.split(/\s+/);
  const gate = GATE_WORDS[word.toLowerCase()];
  if (gate === undefined) {
    return { action: 'help', error: `I don't know "${word}".` };
  }
  if (!catWords.length) return { action: 'help', error: `"${word}" needs a category (or "all").` };
  if (catWords.length === 1 && catWords[0].toLowerCase() === 'all') {
    return { action: 'set', gate, categories: [...REMEMBER_CATEGORIES] };
  }
  const categories = [];
  for (const w of catWords) {
    const cat = CATEGORY_ALIASES[w.toLowerCase()];
    if (!cat) return { action: 'help', error: `I don't have a "${w}" category.` };
    if (!categories.includes(cat)) categories.push(cat);
  }
  return { action: 'set', gate, categories };
}

const gateWord = (v) => v === true ? 'keep' : v === false ? 'never' : 'ask';

/**
 * The menu text — first person, plain, and complete: what I hold, what's
 * pending, their settings, and how to change them. All inputs are
 * pre-fetched by the caller so this stays pure.
 */
export function buildConsentMenu({ villager, memories = [], pending = [] }) {
  const lines = [];
  lines.push(`Hi ${villager.name} — this is everything I hold about you, and your say over it.`);
  lines.push('');

  if (memories.length) {
    lines.push(`**What I remember about you** (${memories.length}${memories.length >= 50 ? '+' : ''}):`);
    for (const m of memories.slice(0, 8)) {
      lines.push(`• ${m.date ? `[${m.date}] ` : ''}${m.brief}${m.brief?.length >= 160 ? '…' : ''}`);
    }
    if (memories.length > 8) lines.push(`…and ${memories.length - 8} more.`);
  } else {
    lines.push(`**What I remember about you:** nothing right now.`);
  }
  lines.push('');

  if (pending.length) {
    lines.push(`**Waiting for a yes/no** (${pending.length}) — things I heard but haven't kept:`);
    for (const p of pending.slice(0, 5)) {
      lines.push(`• ${p.date ? `[${p.date}] ` : ''}${p.brief}`);
    }
    if (pending.length > 5) lines.push(`…and ${pending.length - 5} more.`);
  } else {
    lines.push(`**Waiting for a yes/no:** nothing pending about you.`);
  }
  lines.push('');

  lines.push('**Your settings** — per kind of thing, what I do when I hear it:');
  const rem = villager.remember ?? {};
  for (const cat of REMEMBER_CATEGORIES) {
    lines.push(`• ${CATEGORY_LABELS[cat]}: **${gateWord(rem[cat] ?? 'ask')}**`);
  }
  if (standingConsentActive(villager)) {
    lines.push('• standing consent: **active** — you\'ve told me to use my judgment for now.');
  }
  lines.push('');
  lines.push('**To change:** `!consent keep|ask|never <category|all>` — e.g. `!consent never health`, `!consent keep all`.');
  lines.push('_keep_ = I may remember it · _ask_ = I check with you first · _never_ = I drop it.');
  return lines.join('\n');
}

/**
 * Apply a parsed `set` command to the villager's own remember map.
 * Returns the confirmation text. Throws on unknown villager (caller
 * surfaces a plain error).
 */
export async function applyConsentSet({ villagerId, gate, categories }) {
  const patch = {};
  for (const cat of categories) patch[cat] = gate;
  await setVillagerRemember(villagerId, patch);
  const names = categories.map(c => CATEGORY_LABELS[c].split(' (')[0]).join(', ');
  const verb = gate === true
    ? 'I\'ll remember these without asking'
    : gate === false
      ? 'I\'ll drop these when I hear them — and I won\'t keep new ones'
      : 'I\'ll check with you before keeping any of these';
  return `Done — ${names}: **${gateWord(gate)}**. ${verb}. (\`!consent\` shows the full picture.)`;
}

export function consentHelpText(error) {
  return `${error ? error + ' ' : ''}I understand: \`!consent\` (the menu), or \`!consent keep|ask|never <category|all>\`. Categories: ${Object.values(CATEGORY_LABELS).map(l => l.split(' (')[0]).join(', ')}.`;
}
