/**
 * Share tags on tome entries (0.14.91) — what decides whether a note comes
 * along when I'm in a room with other people (room-lore.js reads them).
 *
 * One entry carries at most one of:
 *   - `contentTag: 'self'`        my own thinking, interests or general
 *                                 knowledge that isn't about anyone: any room;
 *   - `contentTag: 'topic:level'` the memory vocabulary (content-tags.js):
 *                                 reaches a room whose grants cover it. A note
 *                                 can cover several topics, joined with '+'
 *                                 ('work:open+mental-health:sensitive', 0.14.95);
 *                                 a room then needs every one of them;
 *   - `wardOnly: true`            just between my human and me;
 *   - nothing                     not sorted yet, treated as general:sensitive.
 *
 * Who sets them: me when I save a note (save_to_tome's content_tag), the
 * tagging review for older notes (tome-tagging.js), and my human in the entry
 * editor. `contentTagSource` + `contentTagAt` record which, so a later look can
 * tell my own call from theirs. The review stamps `contentTagReviewedAt` when it
 * looked and couldn't tell, so it doesn't ask again.
 *
 * Code checks every tag I pick: a note that names my human or someone from the
 * village can't be `self` or `:open` — it's held at `sensitive` (checkTomeTag).
 * My human's own choice in the editor is never second-guessed. Pure.
 */
import { normalizeTag } from '../memory/content-tags.js';

export const TOME_SELF_TAG = 'self';
export const TOME_PRIVATE_TAG = 'private';

/**
 * A share tag as written by me or the editor → 'self' | 'private' | one or
 * more 'topic:level' joined with '+' (sorted, one per topic, the stricter
 * level kept) | null (unsure, empty, or not a real tag). A topic without a
 * level reads as sensitive (normalizeTag's safe default). Several topics may
 * come as an array or separated by '+' or ','; if ANY part isn't a real topic
 * the whole tag is unreadable (null), so a typo can't quietly drop a topic.
 */
export function normalizeTomeTag(raw) {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[+,]/))
    .map(p => String(p ?? '').trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) {
    const s = parts[0];
    if (s === 'unsure') return null;
    if (s === TOME_SELF_TAG || s === 'mine') return TOME_SELF_TAG;
    if (s === TOME_PRIVATE_TAG || s === 'ward-only' || s === 'wardonly') return TOME_PRIVATE_TAG;
  }
  const byTopic = new Map();
  for (const p of parts) {
    const t = normalizeTag(p);
    if (!t) return null;
    if (byTopic.get(t.topic) !== 'sensitive') byTopic.set(t.topic, t.level);
  }
  return [...byTopic].sort(([a], [b]) => a.localeCompare(b)).map(([t, l]) => `${t}:${l}`).join('+');
}

/** The topics a tag covers: [{ topic, level }] ([] for self / private / none). */
export function tagTopics(tag) {
  const t = normalizeTomeTag(tag);
  if (!t || t === TOME_SELF_TAG || t === TOME_PRIVATE_TAG) return [];
  return t.split('+').map(p => { const [topic, level] = p.split(':'); return { topic, level }; });
}

/**
 * The names that mean "this is about a person": my human (by name, as "my
 * human", or as the {{user}} token), and everyone in the village. My own name
 * is left out. Names under 3 characters are skipped (too many false hits).
 */
export function peopleNames({ settings = {}, registry = null } = {}) {
  const own = String(settings?.charName ?? '').trim().toLowerCase();
  const out = new Set(['my human', '{{user}}']);
  const add = (n) => {
    const s = String(n ?? '').trim();
    if (s.length >= 3 && s.toLowerCase() !== own) out.add(s.toLowerCase());
  };
  add(settings?.userName);
  for (const v of (registry?.villagers ?? [])) add(v?.name);
  return [...out];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first of `names` that appears in `text` as a whole word, or null. */
export function mentionedPerson(text, names = []) {
  const hay = String(text ?? '');
  if (!hay) return null;
  for (const n of names) {
    if (!n) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(hay)) return n;
  }
  return null;
}

/**
 * Hold a tag I picked to what the note's content allows. A note that mentions
 * a person can't be `self` (→ general:sensitive) or `:open` (→ :sensitive).
 * Returns { tag, heldBy } — heldBy is the name that held it, or null.
 */
export function checkTomeTag(tag, text, names = []) {
  const t = normalizeTomeTag(tag);
  if (!t || t === TOME_PRIVATE_TAG) return { tag: t, heldBy: null };
  const isSelf = t === TOME_SELF_TAG;
  if (!isSelf && !t.includes(':open')) return { tag: t, heldBy: null };
  const who = mentionedPerson(text, names);
  if (!who) return { tag: t, heldBy: null };
  return { tag: isSelf ? 'general:sensitive' : t.replace(/:open\b/g, ':sensitive'), heldBy: who };
}

/**
 * An entry with a share tag applied (a new object; the input is untouched).
 * `tag` null means "not sorted": the review marks it looked-at
 * (`reviewed: true`), anyone else clears it back to unsorted.
 */
export function applyTomeTag(entry, tag, { source, now = new Date().toISOString(), reviewed = false } = {}) {
  const t = normalizeTomeTag(tag);
  const out = { ...(entry ?? {}) };
  delete out.contentTag;
  delete out.wardOnly;
  delete out.contentTagReviewedAt;
  if (t === TOME_PRIVATE_TAG) out.wardOnly = true;
  else if (t) out.contentTag = t;
  if (t || reviewed) {
    out.contentTagSource = source ?? null;
    out.contentTagAt = now;
    if (!t) out.contentTagReviewedAt = now;
  } else {
    delete out.contentTagSource;
    delete out.contentTagAt;
  }
  return out;
}

/** The share fields a new entry starts with, for a tag I picked. */
export function newEntryTagFields(tag, { source = 'familiar', now } = {}) {
  const t = normalizeTomeTag(tag);
  if (!t) return {};
  return applyTomeTag({}, t, { source, now });
}

/**
 * Canonicalise an entry's share fields as they arrive from outside (the tome
 * PUT): a `contentTag` of 'private' becomes `wardOnly`, an unreadable tag is
 * dropped (→ unsorted). Returns a new entry.
 */
export function canonicalEntryTag(entry) {
  if (!entry || typeof entry !== 'object' || entry.contentTag == null) return entry;
  const t = normalizeTomeTag(entry.contentTag);
  const out = { ...entry };
  if (t === TOME_PRIVATE_TAG) { delete out.contentTag; out.wardOnly = true; }
  else if (t) out.contentTag = t;
  else delete out.contentTag;
  return out;
}

/** 'private' | 'self' | 'topic' | 'unsure' (looked at, couldn't tell) | 'unsorted'. */
export function entryShareKind(entry) {
  if (entry?.wardOnly === true) return 'private';
  const t = normalizeTomeTag(entry?.contentTag);
  if (t === TOME_SELF_TAG) return 'self';
  if (t) return 'topic';
  return entry?.contentTagReviewedAt ? 'unsure' : 'unsorted';
}
