/**
 * tome-store.js — read the tome (lorebook) files from disk, server-side.
 *
 * Tomes live as JSON files under `tomes/` (the same files the `/api/tomes`
 * endpoints in server.js write; the browser loads them into `state.tomeCache`).
 * The web path matches keywords against that client cache; a server-side turn
 * (Discord, voice) has no cache, so it reads the files directly here.
 *
 * `isTomeFile` mirrors server.js exactly: a real tome is a non-dotfile `.json`
 * (dotfiles like `.consent-pending.json` / `.memorization-queue.json` are
 * bookkeeping, never lore).
 */
import { promises as fsp } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export function isTomeFile(f) {
  return f.endsWith('.json') && !f.startsWith('.');
}

// One SillyTavern-shaped tome entry, built in ONE place so the default-tome and
// named-tome save paths can't drift on the 16 fields. `keys` accepts string[]
// or a comma-separated string. Returns { uid, entry }.
export function buildTomeEntry({ comment, content, keys, learnedAt } = {}) {
  let normKeys = [];
  if (Array.isArray(keys)) normKeys = keys.map(k => String(k).trim()).filter(Boolean);
  else if (typeof keys === 'string') normKeys = keys.split(',').map(k => k.trim()).filter(Boolean);
  const uid = randomUUID();
  const now = new Date().toISOString();
  return { uid, entry: {
    uid,
    comment:             typeof comment === 'string' ? comment.trim() || 'Auto-saved entry' : 'Auto-saved entry',
    keys:                normKeys,
    keysecondary:        [],
    content:             String(content ?? '').trim(),
    constant:            false,
    selective:           false,
    selectiveLogic:      0,
    enabled:             true,
    // At-depth, not a system-message position — a keyword-triggered entry would
    // invalidate the prompt prefix cache if injected into it.
    position:            4,
    depth:               4,
    role:                0,
    scanDepth:           null,
    caseSensitive:       null,
    matchWholeWords:     null,
    probability:         100,
    sticky:              null,
    cooldown:            null,
    preventRecursion:    false,
    delayUntilRecursion: false,
    excludeRecursion:    false,
    group:               '',
    groupWeight:         null,
    insertion_order:     100,
    created_at:          now,
    learnedAt:           (typeof learnedAt === 'string' && learnedAt) ? learnedAt : now,
  } };
}

// A compact summary of every tome so the Familiar can see what it already has
// (reuse before creating) and name one as a save target. The manual is marked
// `protected` so it isn't treated as scratch space. Never throws.
export async function listTomesSummary(tomesDir) {
  const tomes = await readAllTomes(tomesDir);
  return tomes
    .map(t => ({
      name:        String(t?.name ?? '').trim() || '(unnamed)',
      description: String(t?.description ?? '').trim(),
      entries:     t?.entries && typeof t.entries === 'object' ? Object.keys(t.entries).length : 0,
      enabled:     t?.enabled !== false,
      protected:   t?.graduationExempt === true && /manual/i.test(String(t?.name ?? '')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every tome on disk, parsed. Never throws — a missing dir returns [], a
 * corrupt file is skipped (a bad lore file must never break a chat turn).
 * @param {string} tomesDir  absolute path to the tomes directory.
 * @returns {Promise<object[]>} tome objects ({ id, name, enabled?, entries }).
 */
export async function readAllTomes(tomesDir) {
  let files;
  try { files = await fsp.readdir(tomesDir); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    if (!isTomeFile(f)) continue;
    try {
      const raw = await fsp.readFile(path.join(tomesDir, f), 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') out.push(data);
    } catch { /* skip a corrupt or unreadable tome */ }
  }
  return out;
}
