/**
 * Held relays — messages I wanted to pass on that the tripwire stopped
 * (outgoing-tripwire.js), waiting for my human.
 *
 * Only my human releases one: the "Send it" button in the web chat
 * (POST /api/held-relays/:id/send) or `!send <id>` in their Discord DM. There
 * is no tool for me to release a hold, on purpose: a page or a message I was
 * handed could otherwise talk me into sending the thing the hold exists to
 * stop. What I can do is send a new version without the flagged bit.
 *
 * Something from the keep-between-us list never gets sent as-is, not even on
 * my human's okay from here (their list is their hard line; they can send it
 * themselves). The list is checked again at release, so an entry added after
 * the hold still counts.
 *
 * Stored in tomes/.held-relays.json (git-ignored runtime state). A hold that
 * nobody settled in HOLD_DAYS stops being sendable.
 */

import path from 'path';
import { REPO_ROOT } from '../../repo-root.js';
import { readJsonState, writeJsonState } from '../util/json-state.js';
import { meaningSlugId } from '../../slug-ids.js';
import { protectedHits } from './outgoing-tripwire.js';

export const HOLD_DAYS = 7;
const MAX_KEPT = 200;
const DEFAULT_FILE = path.join(REPO_ROOT, 'tomes', '.held-relays.json');

let _chain = Promise.resolve();
function locked(fn) {
  const run = _chain.then(fn);
  _chain = run.catch(() => {});
  return run;
}

async function readAll(file) {
  const s = await readJsonState(file, { items: [] });
  return Array.isArray(s.items) ? s.items : [];
}

function settleExpired(items, now) {
  const cutoff = now - HOLD_DAYS * 86_400_000;
  for (const it of items) {
    if (it.status === 'held' && Date.parse(it.heldAt) < cutoff) { it.status = 'expired'; it.settledAt = new Date(now).toISOString(); }
  }
  return items;
}

/**
 * Keep a relay for my human to decide on. `reason` is 'shape' (sendable once
 * they okay it) or 'protected' (never sendable as-is). Returns the record.
 */
export function holdRelay({ targetName, delivery, message, reason, hits = [], now = Date.now(), file = DEFAULT_FILE }) {
  return locked(async () => {
    const items = settleExpired(await readAll(file), now);
    let id;
    do { id = meaningSlugId(`held ${targetName}`, { fallbackKind: 'held' }); } while (items.some(i => i.id === id));
    const rec = {
      id, targetName, delivery, message,
      reason, sendable: reason === 'shape',
      hits: reason === 'shape' ? hits : [],      // protected matches are never written back out
      status: 'held', heldAt: new Date(now).toISOString(),
    };
    items.push(rec);
    await writeJsonState(file, { items: items.slice(-MAX_KEPT) });
    return rec;
  });
}

export function listHeldRelays({ status = 'held', now = Date.now(), file = DEFAULT_FILE } = {}) {
  return locked(async () => {
    const items = settleExpired(await readAll(file), now);
    return status ? items.filter(i => i.status === status) : items;
  });
}

async function settle(id, { status, now, file, check }) {
  return locked(async () => {
    const items = settleExpired(await readAll(file), now);
    const rec = items.find(i => i.id === id);
    if (!rec) return { ok: false, code: 'not-found' };
    if (rec.status !== 'held') return { ok: false, code: 'not-held', record: rec };
    const refusal = check ? await check(rec) : null;
    if (refusal) return { ok: false, ...refusal, record: rec };
    rec.status = status;
    rec.settledAt = new Date(now).toISOString();
    await writeJsonState(file, { items });
    return { ok: true, record: rec };
  });
}

/**
 * My human okayed it: send it as written. Refuses a protected hold, and one
 * whose text now hits the list. `send` is relayToDiscord; `mirror` tells my
 * human (and, through the chat, me) what happened.
 */
export async function releaseHeldRelay(id, { send, mirror, privateList = [], now = Date.now(), file = DEFAULT_FILE } = {}) {
  let delivered = null;
  const res = await settle(id, {
    status: 'sent', now, file,
    check: async (rec) => {
      if (!rec.sendable || protectedHits(rec.message, privateList).length) return { code: 'protected' };
      delivered = await send({ ...rec.delivery, message: rec.message });
      return delivered?.ok ? null : { code: 'send-failed', error: delivered?.error ?? 'Discord didn\'t take it' };
    },
  });
  if (res.ok) {
    await mirror?.({
      kind: 'relay', originId: `held-sent:${id}`,
      title: `Sent the held message to ${res.record.targetName}`,
      body: `Sent it to ${res.record.targetName} as written: "${res.record.message}"`,
    })?.catch?.(() => {});
  }
  return res;
}

/** My human said no: it stays unsent. */
export async function dropHeldRelay(id, { mirror, now = Date.now(), file = DEFAULT_FILE } = {}) {
  const res = await settle(id, { status: 'dropped', now, file });
  if (res.ok) {
    await mirror?.({
      kind: 'relay', originId: `held-dropped:${id}`,
      title: `Dropped the held message to ${res.record.targetName}`,
      body: `Didn't send the held message to ${res.record.targetName}.`,
    })?.catch?.(() => {});
  }
  return res;
}

/** A plain line for each refusal, for the web button and `!send`. */
export function releaseRefusalText(res) {
  switch (res?.code) {
    case 'not-found':   return 'There\'s no held message with that id.';
    case 'not-held':    return `That one's already ${res.record?.status ?? 'settled'}.`;
    case 'protected':   return 'That one has something from your keep-between-us list in it, so I won\'t send it from here. You can send it yourself.';
    case 'send-failed': return `Couldn't send it: ${res.error}. It's still held.`;
    default:            return 'Couldn\'t do that.';
  }
}
