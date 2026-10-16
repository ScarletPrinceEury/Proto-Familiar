/**
 * Which tome lore reaches a turn, by room (0.14.90, ward decision) — step 2 of
 * the tome audience gate.
 *
 * In my human's own room I have all of it. In a shared room (a villager's DM, a
 * Discord channel, a web chat with others present) lore goes through the same
 * per-topic content gate my memories use, so I stay myself — my interests, my
 * essays, my manual still come along — while what's about my human only reaches
 * the people they've opened that topic to:
 *
 *   - an entry tagged `self` is my own or general knowledge: it reaches any room;
 *   - an entry with a content tag (`medical:sensitive`, `general:open`, …)
 *     reaches the room when its grants cover that tag (memoryVisibleToVillager);
 *   - an untagged entry is unsure, so it's treated as `general:sensitive` —
 *     only a circle granted that much sees it, exactly as with memories;
 *   - a `wardOnly` entry never reaches a shared room;
 *   - a tome's own setting can override all of that: `roomShare: 'always'` or
 *     `'never'` (my human's call, in the Tomes modal); a private tome
 *     (`tomeIsWardOnly`: Session Memories, or marked wardOnly) is `'never'`.
 *
 * Entries are filtered BEFORE keyword activation, so a hidden entry can't wake
 * a visible one through recursion. `topicGrants === null` means my human's own
 * room (the same convention recall uses). Pure except loreForTurn's file read.
 */
import { readAllTomes } from './tome-store.js';
import { activateLore, foldLoreForPrompt } from './tome-lore.js';
import { resolveTomeMacros } from './tome-macros.js';
import { memoryVisibleToVillager } from '../memory/content-tags.js';

export const TOME_SELF_TAG = 'self';

// Tomes that are always private to my human, whatever room I'm in: summaries
// of our own conversations. A tome can also say so itself with `wardOnly: true`
// (new Session Memories tomes are created that way); the name covers the one
// that already exists.
export const PRIVATE_TOME_NAMES = new Set(['Session Memories']);

export function tomeIsWardOnly(tome) {
  return tome?.wardOnly === true || PRIVATE_TOME_NAMES.has(String(tome?.name ?? ''));
}
export const ROOM_SHARE_MODES = ['content', 'always', 'never'];

/** A tome's shared-room setting: 'content' (default), 'always' or 'never'. */
export function tomeRoomShare(tome) {
  if (tomeIsWardOnly(tome)) return 'never';
  return ROOM_SHARE_MODES.includes(tome?.roomShare) ? tome.roomShare : 'content';
}

/** Does one entry, in a tome with this setting, reach a room with these grants? */
export function entryReachesRoom(entry, { share = 'content', topicGrants = null } = {}) {
  if (topicGrants == null) return true;
  if (entry?.wardOnly === true) return false;
  if (share === 'never') return false;
  if (share === 'always') return true;
  const tag = String(entry?.contentTag ?? '').trim().toLowerCase();
  if (tag === TOME_SELF_TAG) return true;
  return memoryVisibleToVillager(tag || null, topicGrants);
}

/** The tomes as this room may see them (entry shape — array or map — kept). */
export function tomesForRoom(tomes, { topicGrants = null } = {}) {
  const list = Array.isArray(tomes) ? tomes : [];
  if (topicGrants == null) return list;
  const out = [];
  for (const t of list) {
    if (!t) continue;
    const share = tomeRoomShare(t);
    if (share === 'never') continue;
    const keep = (e) => entryReachesRoom(e, { share, topicGrants });
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
export async function loreForTurn({ content, messages = [], settings = {}, topicGrants = null, tomesDir }) {
  const none = { lead: '', tail: '', atDepth: '', count: 0 };
  try {
    const tomes = tomesForRoom(await readAllTomes(tomesDir), { topicGrants });
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
