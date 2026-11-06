/**
 * late-look.js — one more turn for a picture I answered before I'd seen it
 * (0.14.123, ward-approved).
 *
 * A turn waits a bounded time for a picture's description (ensureDescribed),
 * then answers with the note it has ("I'm still looking at this one"). The
 * describe keeps running. When it lands soon after, the room gets one more turn
 * with the note now saying what I saw, so I can come back to it the way a
 * person would ("oh, now I see it"). I can still stay quiet in that turn.
 *
 * This module only decides whether and when: it waits for the describes, and
 * calls the surface's `queue` once with the pictures that landed in time. Each
 * surface owns how its turn runs (Discord queues a revisit; see the surface
 * matrix in docs/vision-describe-build-spec.md).
 */

import { settledDescribe } from './vision.js';
import { appendVisionEventLog } from '../../cerebellum.js';

// A description later than this after the turn is old news for the room.
export const LATE_LOOK_WINDOW_MS = 10 * 60_000;

// Pictures that already had (or are waiting on) their late look. In memory: a
// restart drops the running describes this waits on anyway.
const _claimed = new Set();

/**
 * Wait for `pending` pictures' describes; if any landed within the window, call
 * `queue(ids)` once with those. Once per picture, ever (in this process). A
 * picture whose describe didn't come through is released, so a later turn that
 * waits on it again can watch it again. Never throws; returns the ids queued.
 *
 * @param {object} p
 * @param {string[]} p.pending      asset ids the turn answered while still looking
 * @param {number}   p.turnAt       when the turn started (ms)
 * @param {(ids: string[]) => any} p.queue   the surface's "run one more turn"
 * @param {string}   [p.where]      for the log line (a location key)
 */
export async function watchLateLook({ pending, turnAt = Date.now(), queue, where = null, waitFor = settledDescribe, now = Date.now, windowMs = LATE_LOOK_WINDOW_MS } = {}) {
  const ids = [...new Set(Array.isArray(pending) ? pending : [])].filter(id => id && !_claimed.has(id));
  if (!ids.length || typeof queue !== 'function') return [];
  for (const id of ids) _claimed.add(id);
  const results = await Promise.all(ids.map(async (id) => {
    try { return { id, r: await waitFor(id) }; } catch { return { id, r: null }; }
  }));
  const landed = results.filter(x => x.r && x.r.ok !== false && x.r.description).map(x => x.id);
  for (const x of results) if (!landed.includes(x.id)) _claimed.delete(x.id);
  if (!landed.length) return [];
  if (now() - turnAt > windowMs) {
    appendVisionEventLog({ event: 'late-look', assets: landed, where, queued: false, reason: 'landed too late' });
    return [];
  }
  try {
    await queue(landed);
  } catch (err) {
    console.error('[vision] late look could not be queued:', err?.message ?? err);
    return [];
  }
  appendVisionEventLog({ event: 'late-look', assets: landed, where, queued: true });
  return landed;
}

/** For tests: forget which pictures were claimed. */
export function __resetLateLookForTest() { _claimed.clear(); }
