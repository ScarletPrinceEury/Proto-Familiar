/**
 * Which tome lore reaches a turn, by room (0.14.90; full Village parity with
 * memories 0.14.95, ward decisions).
 *
 * In my human's own room I have all of it. In a shared room (a villager's DM, a
 * Discord channel, a web chat with others present) a note goes through the same
 * two checks my memories do, so I stay myself — my interests, my essays, my
 * manual still come along — while what's about my human or anyone else only
 * reaches the people it's meant for:
 *
 *   1. the circle check (tome-audience.js): the circle the note belongs to —
 *      derived like a memory's, from who it names and the room it was made in —
 *      must be one everyone present shares (`visibleAudiences`);
 *   2. the topic check: an entry tagged `self` (my own or general knowledge)
 *      passes; an entry with topic tags (`medical:sensitive`, or several joined
 *      with '+') passes when the room's grants cover every one of them; an
 *      untagged entry is treated as `general:sensitive`, exactly as memories.
 *
 * Overrides: a `wardOnly` entry and a `roomShare: 'never'` tome never reach a
 * shared room. A `roomShare: 'always'` tome lets its untagged entries through
 * the topic check; an entry with its own topics still follows them (that's how
 * the condition tomes share their guidance while the diagnosis lines follow
 * the mental-health grant). Session Memories is an ordinary tome now: its
 * entries are gated like any other.
 *
 * Entries are filtered BEFORE keyword activation, so a hidden entry can't wake
 * a visible one through recursion. `topicGrants === null` means my human's own
 * room (the same convention recall uses). Pure except loreForTurn's file read.
 */
import { readAllTomes } from './tome-store.js';
import { activateLore, foldLoreForPrompt } from './tome-lore.js';
import { resolveTomeMacros } from './tome-macros.js';
import { memoryVisibleToVillager, topicVisibleToGrants } from '../memory/content-tags.js';
import { AUDIENCE_TAG_WARD_OPEN } from '../village/audience.js';
import { normalizeTomeTag, tagTopics, TOME_SELF_TAG, TOME_PRIVATE_TAG } from './tome-tags.js';
import { entryAudience, villagerMatchers } from './tome-audience.js';

export { TOME_SELF_TAG };

// A tome marked `wardOnly: true` never reaches a shared room, whatever its
// entries say. (Until 0.14.95 Session Memories was private by name; it's now
// gated entry by entry like any other tome.)
export function tomeIsWardOnly(tome) {
  return tome?.wardOnly === true;
}

export const ROOM_SHARE_MODES = ['content', 'always', 'never'];

/** A tome's shared-room setting: 'content' (default), 'always' or 'never'. */
export function tomeRoomShare(tome) {
  if (tomeIsWardOnly(tome)) return 'never';
  return ROOM_SHARE_MODES.includes(tome?.roomShare) ? tome.roomShare : 'content';
}

/**
 * Does one entry, in a tome with this setting, reach a room with these grants
 * and these circles? `audiences` is the room's `visibleAudiences` set; when a
 * caller has none for a shared room, only content-gated notes pass the circle
 * check (fail-closed: a note about someone else never slips through).
 */
export function entryReachesRoom(entry, { share = 'content', topicGrants = null, audiences = null, registry = null, matchers = null } = {}) {
  if (topicGrants == null) return true;
  if (entry?.wardOnly === true) return false;
  if (share === 'never') return false;
  const allowed = Array.isArray(audiences) ? audiences : [AUDIENCE_TAG_WARD_OPEN];
  if (!allowed.includes(entryAudience(entry, { registry, matchers }))) return false;
  const tag = normalizeTomeTag(entry?.contentTag);
  if (tag === TOME_SELF_TAG) return true;
  if (tag === TOME_PRIVATE_TAG) return false;
  if (tag) return tagTopics(tag).every(t => topicVisibleToGrants(topicGrants, t.topic, t.level));
  return share === 'always' || memoryVisibleToVillager(null, topicGrants);
}

/** The tomes as this room may see them (entry shape — array or map — kept). */
export function tomesForRoom(tomes, { topicGrants = null, audiences = null, registry = null, charName = '' } = {}) {
  const list = Array.isArray(tomes) ? tomes : [];
  if (topicGrants == null) return list;
  const matchers = villagerMatchers(registry, { charName });
  const out = [];
  for (const t of list) {
    if (!t) continue;
    const share = tomeRoomShare(t);
    if (share === 'never') continue;
    const keep = (e) => entryReachesRoom(e, { share, topicGrants, audiences, registry, matchers });
    const entries = Array.isArray(t.entries)
      ? t.entries.filter(keep)
      : Object.fromEntries(Object.entries(t.entries ?? {}).filter(([, e]) => keep(e)));
    out.push({ ...t, entries });
  }
  return out;
}

/**
 * The lore for one turn: read the tomes, gate them for the room, activate on
 * the turn's text, fold into { lead, tail, atDepth } with live macros resolved.
 * Never throws; a bad tome degrades to no lore.
 */
export async function loreForTurn({ content, messages = [], settings = {}, topicGrants = null, audiences = null, registry = null, tomesDir }) {
  const none = { lead: '', tail: '', atDepth: '', count: 0 };
  try {
    const tomes = tomesForRoom(await readAllTomes(tomesDir), { topicGrants, audiences, registry, charName: settings?.charName });
    if (!tomes.length) return none;
    const priorTurns = messages.filter(m => m?.role === 'user' || m?.role === 'assistant');
    const activated = activateLore(tomes, content, {
      messages,
      opts: {
        scanDepth:         settings.tomeScanDepth,
        recursive:         settings.tomeRecursive,
        maxRecursionSteps: settings.tomeMaxRecursionSteps,
        caseSensitive:     settings.tomeCaseSensitive,
        matchWholeWords:   settings.tomeMatchWholeWords,
      },
      env: { turnCount: priorTurns.length, charName: settings.charName, generationMode: 'normal' },
    });
    const count = ['sys_top', 'before_char', 'after_char', 'sys_bottom', 'at_depth']
      .reduce((s, k) => s + (activated[k]?.length || 0), 0);
    return { ...foldLoreForPrompt(activated, (t) => resolveTomeMacros(t, settings)), count };
  } catch (err) {
    console.error('[tomes] room lore failed (skipping):', err?.message ?? err);
    return none;
  }
}

/**
 * Put a turn's lore where the web chat's own lore sits: lead at the start of
 * the system message, tail at its end, at-depth just above the current
 * message (the Discord placement too). Used for a shared web session, where
 * the server does the lore because only it knows the room's grants. Pure.
 */
export function placeRoomLore(messages, { lead = '', tail = '', atDepth = '' } = {}) {
  let out = Array.isArray(messages) ? [...messages] : [];
  const join = (parts) => parts.filter(Boolean).join('\n\n---\n\n');
  if (lead || tail) {
    const i = out.findIndex(m => m?.role === 'system' && typeof m.content === 'string');
    if (i >= 0) out[i] = { ...out[i], content: join([lead, out[i].content, tail]) };
    else out = [{ role: 'system', content: join([lead, tail]) }, ...out];
  }
  if (atDepth) {
    let j = -1;
    for (let k = out.length - 1; k >= 0; k--) if (out[k]?.role === 'user') { j = k; break; }
    const lore = { role: 'system', content: atDepth };
    out = j >= 0 ? [...out.slice(0, j), lore, ...out.slice(j)] : [...out, lore];
  }
  return out;
}
