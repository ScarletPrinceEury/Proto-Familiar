/**
 * tome-edits.js — I can change or delete a tome entry, and my human can undo
 * it (known-issues A4).
 *
 * Before this I could create tomes, add entries and read them (read_tome), but
 * not fix one: a wrong note stayed wrong, or I added a correction under it.
 *
 * Nothing changes covertly. Every edit and delete first appends the entry as it
 * was to tomes/.tome-edits.jsonl, and the Tomes window lists them under
 * "Recently changed by my Familiar" with Restore. Tomes have no snapshots the
 * way identity and memory do, so this log is what makes a delete undoable.
 *
 * Guards:
 *  - The app's own manual refuses (it rewrites itself from code).
 *  - Only in my human's own room (the executor checks; tomes hold their notes).
 *  - An edit re-checks the entry's share tag against the new text: a tag my
 *    human set stays theirs; one the sorting pass set is cleared so it gets
 *    sorted again; one I set is re-checked, so a note that now names someone
 *    is held at sensitive (checkTomeTag). Tome graduation's "already
 *    reviewed" mark is cleared too: the content is new.
 *
 * The file write goes through `modify` (thalamus modifyTomeFile in production:
 * per-file lock + atomic write), injected so tests don't need thalamus.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { REPO_ROOT } from '../../repo-root.js';
import { readTomeFiles, isProtectedTome } from './tome-store.js';
import { tomeEntries, entryAliases, findTome, findEntry } from './tome-reader.js';
import { checkTomeTag, applyTomeTag, TOME_PRIVATE_TAG } from './tome-tags.js';
import { meaningSlugId } from '../../slug-ids.js';

export const DEFAULT_EDITS_FILE = path.join(REPO_ROOT, 'tomes', '.tome-edits.jsonl');
export const MAX_ENTRY_CHARS = 16_000;

const nameOf = (t) => String(t?.name ?? '').trim() || '(unnamed)';
const titleOf = (e) => String(e?.comment ?? '').trim() || '(untitled)';

/**
 * The one entry `entry` names in tome `tome` (names and refs as read_tome shows
 * them). Returns {file, tome, key, uid, alias, entry} or {code, text}.
 */
export async function locateTomeEntry({ tomesDir, tome, entry }) {
  const files = await readTomeFiles(tomesDir);
  const tomes = files.map(f => f.tome);
  const { tome: t, matches } = findTome(tomes, tome);
  if (!t) {
    return matches.length
      ? { code: 'ambiguous-tome', text: `"${tome}" matches ${matches.length} tomes: ${matches.map(nameOf).join(', ')}. I name one exactly.` }
      : { code: 'no-tome', text: `There's no tome called "${tome}". list_tomes shows them.` };
  }
  const list = tomeEntries(t);
  const aliases = entryAliases(list);
  const { hit, matches: hits } = findEntry(list, aliases, entry);
  if (!hit) {
    return hits.length
      ? { code: 'ambiguous-entry', text: `"${entry}" matches ${hits.length} entries in ${nameOf(t)}: ${hits.slice(0, 8).map(x => aliases.get(x.uid)).join(', ')}. I use the one I mean, as read_tome shows it.` }
      : { code: 'no-entry', text: `There's no entry "${entry}" in ${nameOf(t)}. read_tome shows what's in it.` };
  }
  const key = Object.keys(t.entries).find(k => t.entries[k] === hit.e);
  return { file: files.find(f => f.tome === t).file, tome: t, key, uid: hit.uid, alias: aliases.get(hit.uid), entry: hit.e };
}

// The share tag after an edit (see the header): ward tags stay, sorting-pass
// tags are cleared for re-sorting, mine are re-checked against the new text.
function reshare(entry, text, people, now) {
  const tag = entry.wardOnly ? TOME_PRIVATE_TAG : (entry.contentTag ?? null);
  if (!tag) return { entry, heldBy: null };
  const src = entry.contentTagSource ?? null;
  if (src === 'ward') return { entry, heldBy: null };
  if (src === 'review') return { entry: applyTomeTag(entry, null, { now }), heldBy: null };
  const { tag: held, heldBy } = checkTomeTag(tag, text, people);
  // A tag the checker can't read is left as it was: clearing it would open
  // nothing, but rewriting someone's setting on a guess isn't mine to do.
  if (!held || held === tag) return { entry, heldBy: null };
  return { entry: applyTomeTag(entry, held, { source: 'familiar', now }), heldBy };
}

async function appendEdit(editsFile, rec) {
  await fsp.mkdir(path.dirname(editsFile), { recursive: true });
  await fsp.appendFile(editsFile, JSON.stringify(rec) + '\n', 'utf8');
}

/**
 * Change an entry's text, title and/or keywords. Returns {ok, record, changed,
 * heldBy} or {ok:false, code, text}.
 */
export async function editTomeEntry({ tomesDir, editsFile = DEFAULT_EDITS_FILE, modify, tome, entry, content, title, keywords, people = [], now = new Date().toISOString() }) {
  const at = await locateTomeEntry({ tomesDir, tome, entry });
  if (at.code) return { ok: false, ...at };
  if (isProtectedTome(at.tome)) return { ok: false, code: 'protected', text: 'That\'s the app\'s own manual. It rewrites itself, so I can\'t edit it.' };
  const changes = {};
  if (typeof content === 'string') changes.content = content.trim();
  if (typeof title === 'string' && title.trim()) changes.comment = title.trim();
  if (Array.isArray(keywords) || typeof keywords === 'string') {
    changes.keys = (Array.isArray(keywords) ? keywords : keywords.split(',')).map(k => String(k).trim()).filter(Boolean);
  }
  if (!Object.keys(changes).length) return { ok: false, code: 'nothing', text: 'Nothing to change: I give the new content, title or keywords.' };
  if (changes.content !== undefined && !changes.content) return { ok: false, code: 'empty', text: 'The new content is empty. To take the entry out, I delete it instead.' };
  if ((changes.content ?? '').length > MAX_ENTRY_CHARS) return { ok: false, code: 'too-long', text: `That's over ${MAX_ENTRY_CHARS.toLocaleString('en-US')} characters, too long for one entry.` };

  const before = at.entry;
  let next = { ...before, ...changes };
  delete next.graduationReviewedAt;
  let heldBy = null;
  if (changes.content !== undefined || changes.comment !== undefined) {
    const r = reshare(next, `${next.comment ?? ''}\n${next.content ?? ''}`, people, now);
    next = r.entry;
    heldBy = r.heldBy;
  }
  const record = {
    id: meaningSlugId(`edit ${titleOf(before)}`, { fallbackKind: 'edit' }),
    at: now, action: 'edit', tomeId: at.tome.id ?? null, tomeName: nameOf(at.tome), key: at.key, uid: at.uid,
    before, after: next,
  };
  await appendEdit(editsFile, record);
  await modify(at.file, (fresh) => { fresh.entries = fresh.entries || {}; fresh.entries[at.key] = next; return fresh; });
  return { ok: true, record, changed: Object.keys(changes), heldBy, alias: at.alias };
}

/** Take an entry out (a copy stays in the edit log for Restore). */
export async function deleteTomeEntry({ tomesDir, editsFile = DEFAULT_EDITS_FILE, modify, tome, entry, now = new Date().toISOString() }) {
  const at = await locateTomeEntry({ tomesDir, tome, entry });
  if (at.code) return { ok: false, ...at };
  if (isProtectedTome(at.tome)) return { ok: false, code: 'protected', text: 'That\'s the app\'s own manual. It rewrites itself, so I can\'t edit it.' };
  const record = {
    id: meaningSlugId(`delete ${titleOf(at.entry)}`, { fallbackKind: 'edit' }),
    at: now, action: 'delete', tomeId: at.tome.id ?? null, tomeName: nameOf(at.tome), key: at.key, uid: at.uid,
    before: at.entry,
  };
  await appendEdit(editsFile, record);
  await modify(at.file, (fresh) => { if (fresh.entries) delete fresh.entries[at.key]; return fresh; });
  return { ok: true, record };
}

/** My recent tome edits, newest first, each marked when it was restored. */
export async function listTomeEdits({ editsFile = DEFAULT_EDITS_FILE, limit = 30 } = {}) {
  let raw = '';
  try { raw = await fsp.readFile(editsFile, 'utf8'); } catch { return []; }
  const recs = [], restored = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.action === 'restore') restored.set(r.of, r.at);
    else if (r.id) recs.push(r);
  }
  return recs.reverse().slice(0, limit).map(r => ({ ...r, restoredAt: restored.get(r.id) ?? null }));
}

/**
 * Put an entry back as it was before one of my edits or deletes. Returns
 * {ok, record, changedSince} — changedSince when the entry was edited again
 * after this one (the restore still puts this version back).
 */
export async function restoreTomeEdit({ tomesDir, editsFile = DEFAULT_EDITS_FILE, modify, id, now = new Date().toISOString() }) {
  const rec = (await listTomeEdits({ editsFile, limit: Infinity })).find(r => r.id === id);
  if (!rec) return { ok: false, code: 'not-found', text: 'There\'s no change with that id.' };
  if (rec.restoredAt) return { ok: false, code: 'already', text: 'That one was already put back.' };
  const files = await readTomeFiles(tomesDir);
  const hit = files.find(f => (rec.tomeId && f.tome.id === rec.tomeId) || nameOf(f.tome) === rec.tomeName);
  if (!hit) return { ok: false, code: 'no-tome', text: `The tome "${rec.tomeName}" isn't there any more.` };
  const current = hit.tome.entries?.[rec.key];
  const changedSince = rec.action === 'edit' && JSON.stringify(current) !== JSON.stringify(rec.after);
  await modify(hit.file, (fresh) => { fresh.entries = fresh.entries || {}; fresh.entries[rec.key] = rec.before; return fresh; });
  await appendEdit(editsFile, { action: 'restore', of: id, at: now });
  return { ok: true, record: rec, changedSince };
}
