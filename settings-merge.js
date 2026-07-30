/**
 * Merging a settings PUT into what is already on disk.
 *
 * ⚠️ This once destroyed my human's data. `PUT /api/settings` wrote the request
 * body wholesale, so any key the browser did not know about was gone on the
 * next sync. `voiceTts` was set, the UI synced once, and the setting vanished —
 * which sent a whole voice test through the wrong engine and produced a page of
 * analysis of a backend nobody had chosen.
 *
 * It reached every server-owned setting: anything a script or background loop
 * writes, and any setting added before its UI control exists — which is the
 * normal build order.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 * The client owns the keys it SENDS (`SERVER_SYNCED_KEYS` in public/app.js).
 * Anything it does not mention is preserved; silence means "no opinion", never
 * "destroy it". Deleting therefore needs an explicit `null`.
 *
 * ── Top level only, deliberately ────────────────────────────────────────
 * A key's VALUE is replaced wholesale, not deep-merged. A client that owns
 * `voiceTts` sends the whole object; deep-merging would make it impossible to
 * remove a sub-key, and would quietly resurrect settings someone cleared.
 *
 * The cost is a sharp edge worth knowing: sending `{voiceTts:{backend}}` drops
 * the chosen voice. Callers read the current object and send it back whole —
 * see `onVoiceBackendChange` in public/app.js, which had exactly that bug
 * before it shipped.
 */

/** Is this a plain settings object (not an array, not null)? */
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} prior     what is currently on disk
 * @param {unknown} incoming  the PUT body's `settings`
 * @returns {object} what should be written
 */
export function mergeSettings(prior, incoming) {
  if (!isPlainObject(incoming)) {
    // Nothing usable arrived. Keep what exists rather than blanking it — an
    // unparseable request is not an instruction to erase.
    return isPlainObject(prior) ? { ...prior } : {};
  }
  if (!isPlainObject(prior)) return stripNulls({ ...incoming });

  const kept = {};
  for (const [k, v] of Object.entries(prior)) {
    if (!(k in incoming)) kept[k] = v;
  }
  return stripNulls({ ...kept, ...incoming });
}

/** An explicit null is a deletion, and must not survive into the file. */
function stripNulls(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) delete obj[k];
  }
  return obj;
}
