/**
 * noticing-held.js — what came due while the model wasn't answering
 * (known-issues D1, ward-signed 0.14.121).
 *
 * When something I meant to do comes due, the noticing loop wakes me to look
 * at it. If that look keeps failing (the model is down, or every connection is
 * out of allowance), the loop stops retrying it and holds it here. My next live
 * turn with my human carries one plain note about it, once:
 *
 *   [Came due while the model wasn't answering, so I haven't acted on it yet:
 *    Call the pharmacy (due 15:00, id call-the-pharmacy-x7).]
 *
 * so a commitment doesn't vanish into a provider outage. A later look that does
 * run takes its items back out first (the note wouldn't be true any more).
 *
 * Code owns the times (the exact-values rule): a timed intention's own time,
 * or for a phase round the ward-local time of the first failed look. The note
 * shows HH:MM when it came due today, the day too otherwise.
 */

import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState, runtimeStatePath } from '../util/json-state.js';
import { wardLocalNowISO } from '../../relative-time.js';
import { naiveLabel } from '../schedule/promise-time.js';
import { excerpt } from '../util/excerpt.js';

const DEFAULT_FILE = runtimeStatePath(path.join(REPO_ROOT, 'tomes', '.noticing-held.json'), 'noticing-held');
// Days of an outage with daily rounds shouldn't grow a wall: the newest ones.
export const HELD_CAP = 20;

let _file = DEFAULT_FILE;
/** Tests point the store somewhere else. */
export function __setNoticingHeldFileForTest(f) { _file = f || DEFAULT_FILE; }

// One change at a time: the loop holds and releases, a live turn takes.
let _queue = Promise.resolve();
function locked(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

async function readItems(file) {
  const s = await readJsonState(file, null);
  return Array.isArray(s?.items) ? s.items.filter(i => i && typeof i.id === 'string') : [];
}

/** When it came due, local-naive. */
export function heldDueAt(intention, sinceMs, timeZone = null) {
  const at = intention?.trigger?.kind === 'at' ? intention.trigger.at : null;
  return (typeof at === 'string' && at.length >= 16) ? at.slice(0, 19) : wardLocalNowISO(timeZone, sinceMs);
}

/** Hold these for my next chat. `entries` are the loop's [{ intention, since }]. */
export function holdForChat(entries, { timeZone = null, file = _file, now = Date.now() } = {}) {
  return locked(async () => {
    const items = await readItems(file);
    let added = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      const id = e?.intention?.id;
      if (!id) continue;
      const dueAt = heldDueAt(e.intention, e.since, timeZone);
      if (items.some(i => i.id === id && i.dueAt === dueAt)) continue;
      items.push({ id, what: String(e.intention.what ?? '').trim(), dueAt, heldAt: new Date(now).toISOString() });
      added += 1;
    }
    if (added) await writeJsonState(file, { items: items.slice(-HELD_CAP) });
    return added;
  });
}

/** A look that ran had these in front of it: their notes go. */
export function releaseHeld(ids, { file = _file } = {}) {
  const drop = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  if (!drop.size) return Promise.resolve(0);
  return locked(async () => {
    const items = await readItems(file);
    const kept = items.filter(i => !drop.has(i.id));
    if (kept.length !== items.length) await writeJsonState(file, { items: kept });
    return items.length - kept.length;
  });
}

/** The note for these items, '' for none. `today` is the ward's local YYYY-MM-DD. */
export function heldNote(items, { today = '' } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  const line = (i) => {
    const what = excerpt(String(i.what ?? '').replace(/\s+/g, ' ').trim() || 'something I meant to do', 200);
    const dueAt = String(i.dueAt ?? '');
    const when = dueAt.slice(0, 10) === today ? dueAt.slice(11, 16) : (naiveLabel(dueAt) || dueAt);
    return `${what} (due ${when}, id ${i.id})`;
  };
  if (items.length === 1) return `[Came due while the model wasn't answering, so I haven't acted on it yet: ${line(items[0])}.]`;
  return `[Came due while the model wasn't answering, so I haven't acted on these yet:\n${items.map(i => `· ${line(i)}`).join('\n')}]`;
}

/** The note for whatever is held, clearing it. '' when nothing. Never throws. */
export async function takeHeldNote({ timeZone = null, file = _file, now = Date.now() } = {}) {
  try {
    return await locked(async () => {
      const items = await readItems(file);
      if (!items.length) return '';
      await writeJsonState(file, { items: [] });
      return heldNote(items, { today: wardLocalNowISO(timeZone, now).slice(0, 10) });
    });
  } catch (err) {
    console.warn('[noticing] no held note this turn:', err?.message ?? err);
    return '';
  }
}
