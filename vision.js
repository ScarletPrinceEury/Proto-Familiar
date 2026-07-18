/**
 * The provider boundary (vision build spec §3) — the ONE seam where media
 * references become provider content-parts. Nothing else in the repo knows
 * what a given model can look at, which is what makes the design future-proof:
 * a video-capable model is a change here, not a message-format migration.
 *
 * `materializeAttachments(apiMessages, opts)` transforms an assembled API
 * message array: a message carrying `attachments` either gains an `image_url`
 * part per live image (when the connection can see and the image is within the
 * live budget) or has a code-built stand-in appended to its content STRING
 * (otherwise). A message that never carried attachments is returned byte-for-
 * byte unchanged — a non-vision request is exactly the shape it is today.
 *
 * Capability (§3.1): per-connection `visionCapable` tri-state — 'yes'/'no' are
 * the ward's word; 'auto' (default) resolves via a cache keyed `provider:model`
 * (tomes/.vision-capability.json). An uncached 'auto' is treated as
 * OPTIMISTICALLY capable and the real turn serves as the probe: a modality
 * rejection flips the cache to 'no' (mid-turn fallback in server.js), a
 * successful live turn records 'yes'. This beats a synthetic probe image,
 * which would add an LLM call on the first image and break the "zero extra
 * calls" acceptance criterion.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { getAsset, getAssetMeta, buildStandin } from './media.js';
import { shortSlug } from './slug-ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAP_FILE = path.join(__dirname, 'tomes', '.vision-capability.json');

export const DEFAULT_MAX_LIVE_IMAGES = 4;

// ── Capability cache (provider:model → 'yes'|'no') ────────────────
function capKey(provider, model) {
  return `${String(provider ?? '').trim()}:${String(model ?? '').trim()}`;
}

async function readCapCache() {
  try {
    const raw = await fsp.readFile(CAP_FILE, 'utf8');
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

/** Record a resolved capability for a provider:model. Best-effort; a failed
 *  write just means the next turn re-derives it (optimistic path is safe). */
export async function cacheVisionCapability(provider, model, verdict) {
  if (verdict !== 'yes' && verdict !== 'no') return;
  const cache = await readCapCache();
  const key = capKey(provider, model);
  if (cache[key] === verdict) return;
  cache[key] = verdict;
  try {
    await fsp.mkdir(path.dirname(CAP_FILE), { recursive: true });
    const tmp = `${CAP_FILE}.${process.pid}.${shortSlug(4)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fsp.rename(tmp, CAP_FILE);
  } catch { /* cache is advisory */ }
}

/**
 * Find the saved connection matching {provider, model} so its `visionCapable`
 * field can be read (the chat request only carries provider/apiKey/model at the
 * top level). Returns null when none matches.
 */
export function findConnection(settings, { provider, model } = {}) {
  const conns = Array.isArray(settings?.connections) ? settings.connections : [];
  return conns.find(c => c?.provider === provider && c?.model === model) || null;
}

/**
 * Resolve whether this connection can see images, as a boolean.
 *   'yes'/'no' → the ward's explicit word, never second-guessed.
 *   'auto'     → cached verdict if present; else OPTIMISTIC true (the turn probes).
 * `connection` may be a saved connection object OR a bare {provider, model}.
 */
export async function resolveVisionCapable(connection, settings) {
  const explicit = connection?.visionCapable;
  if (explicit === 'yes') return true;
  if (explicit === 'no')  return false;
  // 'auto' / unset → consult the cache, default optimistic.
  const conn = connection?.provider ? connection
    : findConnection(settings, connection || {});
  const provider = conn?.provider ?? connection?.provider;
  const model    = conn?.model ?? connection?.model;
  // A ward 'no' on the saved connection wins even when a bare {provider,model}
  // was passed (server.js passes the request's provider/model, not the object).
  if (conn?.visionCapable === 'no')  return false;
  if (conn?.visionCapable === 'yes') return true;
  const cache = await readCapCache();
  const cached = cache[capKey(provider, model)];
  if (cached === 'no')  return false;
  if (cached === 'yes') return true;
  return true;   // uncached auto → optimistic; the real turn is the probe
}

// ── The materializer ──────────────────────────────────────────────

function dataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * @param {Array} apiMessages   assembled API messages (content is a string on
 *                              every message; attachments ride beside it)
 * @param {object} opts
 * @param {object} opts.connection        saved connection or {provider,model,visionCapable}
 * @param {object} opts.settings
 * @param {Set|Array|null} opts.visibleAudiences  room's visible-audience set on a
 *        gated turn; null/undefined on a ward turn (no gating)
 * @param {number} [opts.maxLive]  overrides settings.visionMaxLiveImages
 * @param {number} [opts.now]
 * @returns {Promise<{messages, imagesLive:number, imagesStoodIn:number}>}
 */
export async function materializeAttachments(apiMessages, {
  connection, settings = {}, visibleAudiences = null, maxLive, now = Date.now(),
} = {}) {
  const messages = Array.isArray(apiMessages) ? apiMessages : [];
  // Fast path: nothing carries media → return the array untouched (identity),
  // so a non-image request is provably unchanged.
  const anyAttachments = messages.some(m => Array.isArray(m?.attachments) && m.attachments.length);
  if (!anyAttachments) return { messages, imagesLive: 0, imagesStoodIn: 0 };

  const capable = await resolveVisionCapable(connection, settings);
  const budget = Number.isFinite(maxLive) ? maxLive
    : Number.isFinite(settings?.visionMaxLiveImages) ? settings.visionMaxLiveImages
    : DEFAULT_MAX_LIVE_IMAGES;
  const gateSet = visibleAudiences == null ? null
    : (visibleAudiences instanceof Set ? visibleAudiences : new Set(visibleAudiences));

  // Collect every attachment in array order (later = newer) with its position,
  // resolving meta once. Audience-gated-out assets are dropped entirely here —
  // they never contribute even a stand-in (fail-closed).
  const refs = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const atts = Array.isArray(messages[mi]?.attachments) ? messages[mi].attachments : [];
    for (const a of atts) {
      const meta = await getAssetMeta(a?.id);
      if (gateSet && meta && !gateSet.has(meta.audienceTag)) continue; // fail-closed drop
      refs.push({ mi, id: a?.id, meta });
    }
  }

  // Live budget: only the newest `budget` images may ride live, and only when
  // the connection can see. Counted newest-first across the whole request.
  const liveIds = new Set();
  if (capable && budget > 0) {
    for (let i = refs.length - 1; i >= 0 && liveIds.size < budget; i--) {
      if (refs[i].meta) liveIds.add(`${refs[i].mi}:${refs[i].id}`);
    }
  }

  // The outgoing provider message never carries `attachments` — it's a
  // Proto-Familiar-internal sibling field, consumed into content parts (or a
  // stand-in) here. Some strict providers reject unknown message fields.
  const stripAtt = (m) => { if (!m || !('attachments' in m)) return m; const { attachments, ...rest } = m; return rest; };

  let imagesLive = 0, imagesStoodIn = 0;
  const out = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const myRefs = refs.filter(r => r.mi === mi);
    if (!myRefs.length) { out.push(stripAtt(msg)); continue; }

    const baseText = typeof msg.content === 'string' ? msg.content : '';
    const imageParts = [];
    const standinLines = [];
    for (const ref of myRefs) {
      const goLive = liveIds.has(`${mi}:${ref.id}`);
      if (goLive) {
        const got = await getAsset(ref.id);
        if (got?.buffer && got?.meta) {
          imageParts.push({ type: 'image_url', image_url: { url: dataUrl(got.meta.mime, got.buffer) } });
          imagesLive++;
          continue;
        }
        // Bytes vanished under us — degrade to a stand-in, never an error.
      }
      const standin = ref.meta ? buildStandin(ref.meta, { now })
        : `[image ${ref.id ?? '?'}: no longer available]`;
      standinLines.push(standin);
      imagesStoodIn++;
    }

    if (imageParts.length) {
      // Content becomes a parts array: the existing string (timestamps and
      // all) plus any non-live stand-ins as the text part, then the images.
      const text = standinLines.length ? `${baseText}\n${standinLines.join('\n')}` : baseText;
      out.push({ ...stripAtt(msg), content: [{ type: 'text', text }, ...imageParts] });
    } else {
      // No live parts → stays a string; the request shape is unchanged.
      const text = standinLines.length
        ? (baseText ? `${baseText}\n${standinLines.join('\n')}` : standinLines.join('\n'))
        : baseText;
      out.push({ ...stripAtt(msg), content: text });
    }
  }
  return { messages: out, imagesLive, imagesStoodIn };
}

/**
 * Heuristic: did a provider reject a request because it can't accept the image
 * modality (as opposed to auth, rate-limit, or a genuine server error)? Used
 * by the mid-turn hard fallback to decide whether to retry with stand-ins and
 * flip the capability cache to 'no'. Conservative: only classic modality
 * statuses (400/415/422) with modality-shaped body text count.
 */
export function isModalityError(status, bodyText = '') {
  if (![400, 415, 422].includes(Number(status))) return false;
  const t = String(bodyText).toLowerCase();
  return /image|vision|multimodal|modalit|content[_ ]?type|image_url|not support|unsupported/.test(t);
}
