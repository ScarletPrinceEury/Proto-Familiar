/**
 * Which circle a tome note belongs to (0.14.95, ward decision: tome lore gets
 * full parity with memories) — the coarse half of the room gate, the same one
 * memory recall uses (village/audience.js), so a note and a memory with the
 * same subject and the same room behave the same way.
 *
 * A memory's audience is derived in code at write time from who it's about and
 * the room it was made in (`deriveMemoryAudience`). A note gets the same
 * derivation, from:
 *   - who it names: villagers mentioned by name in its title or text;
 *   - the room it was made in: `roomTag` (stamped by save_to_tome on a shared
 *     turn) or `room` (the session audience a web topic-save records); neither
 *     means my human's own room, which is where nearly every note is made;
 *   - its sensitivity, from its topic tags (medical / mental-health count as
 *     the sensitive memory categories).
 * So a note about my human made in our own room is content-gated (its topic
 * decides, like a memory about them); a note about someone else stays within
 * what that person's own disclosure settings allow (private by default, like a
 * memory about them); a note made in someone's room stays in that circle.
 * An explicit `audience` on the entry (set by my human) wins over derivation.
 *
 * Pure. Never asks the model; nothing here is a value the model types.
 */
import { deriveMemoryAudience, audienceTagFor, AUDIENCE_TAG_WARD_PRIVATE } from '../village/audience.js';
import { tagTopics } from './tome-tags.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word name matchers for the village, built once per turn. My own name is
 * left out (I'm not a third party in my own notes); names under 3 characters are
 * skipped (too many false hits).
 */
export function villagerMatchers(registry, { charName = '' } = {}) {
  const own = String(charName ?? '').trim().toLowerCase();
  const out = [];
  for (const v of (registry?.villagers ?? [])) {
    const name = String(v?.name ?? '').trim();
    if (name.length < 3 || name.toLowerCase() === own) continue;
    out.push({ villager: v, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu') });
  }
  return out;
}

/** The villagers a note names, in its title or text. */
export function namedVillagers(entry, matchers = []) {
  const text = `${entry?.comment ?? ''}\n${entry?.content ?? ''}`;
  return matchers.filter(m => m.re.test(text)).map(m => m.villager);
}

/** The room a note was made in, as an audience tag (my human's own room by default). */
export function entryRoomTag(entry, registry) {
  if (typeof entry?.roomTag === 'string' && entry.roomTag.trim()) return entry.roomTag.trim();
  if (entry?.room && typeof entry.room === 'object') {
    try { return audienceTagFor(entry.room, registry) || AUDIENCE_TAG_WARD_PRIVATE; }
    catch { return AUDIENCE_TAG_WARD_PRIVATE; }
  }
  return AUDIENCE_TAG_WARD_PRIVATE;
}

/** The memory category a note's topics amount to, for the sensitivity floor. */
export function entryCategory(entry) {
  const topics = new Set(tagTopics(entry?.contentTag).map(t => t.topic));
  if (topics.has('medical')) return 'health_info';
  if (topics.has('mental-health')) return 'emotional_content';
  return 'basics';
}

/** The circle a note belongs to: its explicit `audience`, or the memory derivation. */
export function entryAudience(entry, { registry = null, matchers = null, charName = '' } = {}) {
  if (typeof entry?.audience === 'string' && entry.audience.trim()) return entry.audience.trim();
  return deriveMemoryAudience({
    category: entryCategory(entry),
    subjects: namedVillagers(entry, matchers ?? villagerMatchers(registry, { charName })),
    sessionTag: entryRoomTag(entry, registry),
    registry,
  });
}
