// The Village presence block — who from my human's Village is in play THIS turn.
//
// The problem it fixes: a villager's pronouns and distinguishing facts only ever
// reached me when I actively ran `village_lookup`, which I rarely thought to do
// mid-conversation. So I misgendered people I should know and couldn't tell them
// apart in casual talk — the facts simply weren't in front of me at the moment I
// spoke. This block puts them there, automatically, for exactly the people
// relevant to the current turn, riding the turn that is already happening (no new
// LLM call — pure code + a rendered block).
//
// It stays lean by construction: it renders nothing unless a known person is
// actually here or being talked about. Two detection signals:
//   • present   — a registered villager the Discord classifier already resolved
//                 as speaking / in the room (high confidence, zero false positives)
//   • mentioned — a villager's name appears in the current turn's text (a
//                 whole-word, case-insensitive scan; works on web and Discord)
//
// Gating lives in `village-card.js` (disclosableVillagerFields): private notes are
// ward-only; everything else is fair game. This block never surfaces MEMORIES —
// only registry fields — so recall's own content/audience gate stays the sole
// path for memories and this can't bypass it.

import { disclosableVillagerFields } from './village-card.js';

// A villager mid-conversation is usually named by a single part of their name
// ("how's Sam?"), so we scan for the full name AND each part this long or longer.
// Shorter parts ("Al", "Jo") are skipped from the free-text scan — they collide
// with ordinary words — but such a person still surfaces via the `present` signal.
export const MIN_NAME_TOKEN = 3;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-word test: the token bounded by non-(letter/number/underscore) on each
// side, Unicode-aware so accented names match. Case-insensitive.
function mentions(text, token) {
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(token)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  } catch { return false; }
}

export function nameTokens(name) {
  const full = String(name ?? '').trim();
  if (!full) return [];
  const parts = full.split(/\s+/).filter(p => p.length >= MIN_NAME_TOKEN);
  return [...new Set([full, ...parts])];
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The registered villagers relevant to this turn, each tagged with WHY
 * ('present' | 'mentioned'). Pure — the registry, turn text, and the room's
 * accumulated participants come in as arguments. The ward is never returned as
 * a villager (they are my human, not one of their people).
 */
export function detectRelevantVillagers({ registry, text = '', participants = [], wardName = '' } = {}) {
  const villagers = registry?.villagers ?? [];
  if (!villagers.length) return [];

  const partIds = new Set((participants ?? []).map(p => p?.id).filter(Boolean));
  const partNames = new Set((participants ?? []).map(p => norm(p?.name)).filter(Boolean));
  const body = String(text ?? '');
  const wardLc = norm(wardName);

  const out = [];
  for (const v of villagers) {
    if (!v || !v.id) continue;
    const vNameLc = norm(v.name);
    if (wardLc && vNameLc === wardLc) continue; // my human is not a villager

    let why = null;
    if (partIds.has(v.id) || (vNameLc && partNames.has(vNameLc))) why = 'present';
    else if (body && nameTokens(v.name).some(tok => mentions(body, tok))) why = 'mentioned';

    if (why) out.push({ villager: v, why });
  }
  return out;
}

/**
 * The injected [Village] context block, or '' when nobody registered is in play.
 * First person, literal "my human" (this is an injected block — it does NOT pass
 * through the macro boundaries, so it must never carry a {{user}}/{{char}} token).
 */
export function buildVillagePresenceBlock(opts = {}) {
  const { wardPrivate = true } = opts;
  let relevant;
  try { relevant = detectRelevantVillagers(opts); }
  catch { return ''; } // fail-closed: a malformed registry never blocks a turn
  if (!relevant.length) return '';

  const cards = relevant.map(({ villager: v, why }) => {
    const f = disclosableVillagerFields(v, { wardPrivate });
    const head = `- ${v.name}${f.pronouns ? ` (${f.pronouns})` : ''}${why === 'present' ? ' — here now' : ''}`;
    const lines = [head];
    if (f.relationToWard) lines.push(`  To my human: ${f.relationToWard}`);
    if (f.commStyleNotes) lines.push(`  Manner: ${f.commStyleNotes}`);
    if (f.notes) lines.push(`  Notes: ${f.notes}`);
    if (f.privateNotes) lines.push(`  Private (just us): ${f.privateNotes}`);
    return lines.join('\n');
  });

  const intro = 'People from my human\'s Village who are here or that we\'re talking about right now — '
    + 'so I get their name, pronouns and manner right without stopping to look them up. '
    + '`village_lookup` has the rest.';
  return `[Village]\n${intro}\n${cards.join('\n')}`;
}

// Off-switch, mirroring the loop/feature pattern: env kill-switch wins, then the
// synced setting; default ON.
export function villagePresenceOn(settings = {}) {
  if (process.env.PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED === '1') return false;
  return settings?.villagePresenceEnabled !== false;
}
