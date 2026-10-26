/**
 * blocklist.js — the Village block list: accounts my human never wants
 * reaching me.
 *
 * Not a platform block (a Discord block hides the blocked person from the
 * blocker). This is a context filter: a blocked account's messages and voice
 * are dropped on arrival, before anything is stored, memorized, scored or
 * shown to a model, so as far as my prompts go their words don't exist. I
 * stay in the room with everyone else as normal.
 *
 * The list lives in the Village registry (`registry.blocked`) and syncs to
 * Phylactery with it. Only my human edits it (the Village editor); nothing
 * here is composed into my tools. The ward's own account can never be on it:
 * their messages carry the safety path (threat scoring, triage), so the
 * gateway checks the ward first and the endpoint refuses their id.
 *
 * Pure functions only; village.js owns storage and the sync cache.
 */

export const BLOCK_PLATFORMS = Object.freeze(['discord']);

// What I see in place of a blocked account's name, wherever someone else's
// message points at them (an @-mention, a reply, a voice roster). Their
// display name is text they wrote, so it never reaches me either.
export const BLOCKED_NAME = "someone I've blocked";

const DISCORD_ID = /^\d{5,25}$/;          // a Discord snowflake
const LABEL_MAX = 80;
const NAME_MAX = 40;
const NAMES_MAX = 6;

const key = (platform, id) => `${platform}:${id}`;

/** Is (platform, id) a well-formed account to block? */
export function validBlockTarget(platform, id) {
  const p = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  const i = typeof id === 'string' ? id.trim() : (typeof id === 'number' ? String(id) : '');
  if (!BLOCK_PLATFORMS.includes(p)) return null;
  if (p === 'discord' && !DISCORD_ID.test(i)) return null;
  return { platform: p, id: i };
}

/** Sanitize the names a blocked account has shown up as. Used only to hide
 *  lines stored before speaker ids were recorded (see withoutBlockedLines). */
export function sanitizeBlockedNames(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  const out = [];
  for (const n of list) {
    const s = typeof n === 'string' ? n.trim().slice(0, NAME_MAX) : '';
    if (s && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= NAMES_MAX) break;
  }
  return out;
}

/** Fail-closed normalization of `registry.blocked`: malformed entries are
 *  dropped, duplicates collapse (the first one wins). */
export function sanitizeBlocked(raw) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b || typeof b !== 'object') continue;
    const t = validBlockTarget(b.platform, b.id);
    if (!t || seen.has(key(t.platform, t.id))) continue;
    seen.add(key(t.platform, t.id));
    const label = typeof b.label === 'string' ? b.label.trim().slice(0, LABEL_MAX) : '';
    const names = sanitizeBlockedNames(b.names);
    out.push({
      ...t,
      ...(label ? { label } : {}),
      ...(names.length ? { names } : {}),
      addedAt: typeof b.addedAt === 'string' && b.addedAt ? b.addedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

/** The blocked ids on one platform, as a Set. */
export function blockedIds(reg, platform = 'discord') {
  return new Set((reg?.blocked ?? []).filter(b => b.platform === platform).map(b => b.id));
}

export function isBlockedAccount(reg, { platform = 'discord', id } = {}) {
  if (!id) return false;
  return (reg?.blocked ?? []).some(b => b.platform === platform && b.id === String(id));
}

/**
 * Stored conversation without a blocked account's lines. A line from after
 * this feature carries `authorId` and matches on that; an older line has
 * only its `speaker` name, so it matches the names my human listed for the
 * account. Hiding more is the safe direction here. Only user lines are ever
 * dropped: my own replies stay mine.
 */
export function withoutBlockedLines(messages, reg) {
  const list = Array.isArray(messages) ? messages : [];
  const blocked = reg?.blocked ?? [];
  if (!blocked.length) return list;
  const ids = new Set(blocked.map(b => b.id));
  const names = new Set(blocked.flatMap(b => b.names ?? []).map(n => n.toLowerCase()));
  return list.filter(m => {
    if (m?.role !== 'user') return true;
    if (m.authorId) return !ids.has(String(m.authorId));
    return !(typeof m.speaker === 'string' && names.has(m.speaker.trim().toLowerCase()));
  });
}
