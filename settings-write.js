/**
 * settings-write — the one writer for settings.json.
 *
 * ⚠️ Saved connections vanished (2026-10-28). Every page pushed its WHOLE copy
 * of the synced settings on any change, so a page holding an old copy (a tab
 * opened before connections were added, a phone whose cache was weeks old, or
 * a page whose startup push beat its first read of the server) wrote that old
 * list over the real one, and my human was back on a connection they'd moved
 * off. Two fixes meet here:
 *
 *  - Per-key revisions. settings.json carries `_revisions: {key: n}`, bumped
 *    whenever a key's value changes, by ANY writer. A page says which revision
 *    each key it sends was based on (`base`), and a key that changed since
 *    comes back as a conflict instead of being overwritten. The page then
 *    merges and tries again (public/app.js `flushSettings`).
 *  - One lock, one write path. Every writer (the PUT, my own settings tools,
 *    the Discord console, the voice picker) goes through `writeSettings`, so a
 *    read-modify-write can't interleave with another and lose its update. A
 *    patch can be a function of the current settings for exactly that reason.
 *
 * A settings.json that exists but won't parse is never overwritten: writing
 * the patch alone over it would blank every other setting.
 */

import { promises as fsp } from 'fs';
import { SETTINGS_FILE } from './settings-store.js';
import { mergeSettings } from './settings-merge.js';

export const REVISIONS_KEY = '_revisions';

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const _locks = new Map();
function withFileLock(file, fn) {
  const prev = _locks.get(file) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  _locks.set(file, tail);
  tail.then(() => { if (_locks.get(file) === tail) _locks.delete(file); });
  return run;
}

/** The revision map stored in a settings object ({} when there is none). */
export function revisionsOf(settings) {
  return isPlainObject(settings?.[REVISIONS_KEY]) ? settings[REVISIONS_KEY] : {};
}

/**
 * What `PUT /api/settings` does with a body, as {status, body, result}: the
 * route in server.js is a thin adapter around this, so a test can drive the
 * real decision. A body without `base` is a page still running the old code
 * (it sent its whole copy, which is how the connections got wiped) and is
 * refused; reloading the page fixes it.
 */
export async function putSettings(reqBody, { maxBytes = Infinity, file = SETTINGS_FILE } = {}) {
  const { settings, base } = reqBody ?? {};
  if (!isPlainObject(settings)) return { status: 400, body: { error: 'settings (object) is required' } };
  if (!isPlainObject(base)) {
    return { status: 409, body: { ok: false, code: 'stale-page', error: 'This page is running an older version. Reload it, then save again.' } };
  }
  let result;
  try { result = await writeSettings(settings, { base, maxBytes, file }); }
  catch (err) { return { status: 500, body: { error: `failed to write settings: ${err?.message ?? err}` } }; }
  if (result.code === 'conflict') {
    return { status: 409, result, body: { ok: false, code: 'conflict', conflicts: result.conflicts, settings: result.settings, revisions: result.revisions } };
  }
  if (!result.ok) return { status: result.code === 'unreadable' ? 500 : 400, result, body: { ok: false, code: result.code, error: result.error } };
  return { status: 200, result, body: { ok: true, revisions: result.revisions } };
}

/**
 * Apply a patch to settings.json.
 *
 * @param {object|function} patch  keys to set (null deletes), or a function
 *        `(current) => patch` evaluated under the lock
 * @param {object} [opts]
 * @param {object|null} [opts.base]  {key: revision} the caller's values were
 *        based on. Given → a key whose revision moved since, and whose value
 *        differs from what's being written, is a conflict and nothing is
 *        written. Omitted → unconditional (server-side writers).
 * @param {number} [opts.maxBytes]  refuse a result larger than this
 * @param {string} [opts.file]      for tests; production uses the default
 * @returns {Promise<{ok:true, settings, prior, revisions, changed:string[]}
 *   | {ok:false, code:'conflict', conflicts:string[], settings, revisions}
 *   | {ok:false, code:string, error:string}>}
 */
export async function writeSettings(patch, { base = null, maxBytes = Infinity, file = SETTINGS_FILE } = {}) {
  return withFileLock(file, async () => {
    let current = {};
    try {
      current = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!isPlainObject(current)) current = {};
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return { ok: false, code: 'unreadable', error: `settings.json couldn't be read (${err?.message ?? err}); not overwriting it` };
      }
    }
    const raw = typeof patch === 'function' ? patch(current) : patch;
    if (!isPlainObject(raw)) return { ok: false, code: 'bad-patch', error: 'patch must be an object' };
    const { [REVISIONS_KEY]: _clientRevs, ...incoming } = raw;
    const revs = revisionsOf(current);

    if (isPlainObject(base)) {
      const conflicts = Object.keys(incoming).filter(k =>
        (revs[k] ?? 0) !== (Number(base[k]) || 0) && !same(current[k], incoming[k]));
      if (conflicts.length) return { ok: false, code: 'conflict', conflicts, settings: current, revisions: revs };
    }

    const merged = mergeSettings(current, incoming);
    const nextRevs = { ...revs };
    const changed = [];
    for (const k of Object.keys(incoming)) {
      if (!same(current[k], merged[k])) { nextRevs[k] = (revs[k] ?? 0) + 1; changed.push(k); }
    }
    if (!changed.length) return { ok: true, settings: current, prior: current, revisions: revs, changed };
    merged[REVISIONS_KEY] = nextRevs;

    const serialised = JSON.stringify(merged, null, 2);
    if (serialised.length > maxBytes) return { ok: false, code: 'too-large', error: `settings exceed ${maxBytes}-byte limit` };
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, serialised, 'utf8');
    await fsp.rename(tmp, file);
    return { ok: true, settings: merged, prior: current, revisions: nextRevs, changed };
  });
}
