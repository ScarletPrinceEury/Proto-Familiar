/**
 * Media store (vision build spec §2) — asset persistence, content-addressed.
 *
 * The one module that owns image (and, later, video/audio/frame) bytes. No
 * orchestration file grows a storage concern. Bytes live once on disk keyed by
 * their own sha256, so the same photo sent twice is one asset (dedup is free).
 *
 * Layout (git-ignored, auto-created, same posture as logs/ and tomes/):
 *   media/<sha256>.<ext>    the bytes
 *   media/<sha256>.json     the asset meta (the contract below)
 *   media/.slugs.json       slug → sha index (rebuildable from the metas;
 *                           an O(1) lookup for the model-facing slug ids)
 *
 * Every function returns a value or `{ok:false, error}` — nothing throws into
 * a caller. The chat path must never see a media failure as an exception.
 *
 * The meta is machine-authored end to end EXCEPT `description.text` (the §6
 * describe result), which is labeled as model-authored and sanitized before it
 * is ever cached.
 */

import path from 'path';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { meaningSlugId, slugifyLabel, shortSlug } from './slug-ids.js';
import { relativeTime } from './relative-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(__dirname, 'media');
const SLUG_INDEX = path.join(MEDIA_DIR, '.slugs.json');

// Caps enforced at save (constants here, never scattered across call sites).
export const MEDIA_MAX_BYTES = 6 * 1024 * 1024;   // 6 MB per asset
export const MAX_IMAGES_PER_MESSAGE = 4;
// mime → file extension allow-list. A mime not in this map is rejected; the
// model kind is derived from the map, never from sniffing (spec §2 `kind`).
export const IMAGE_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

// ── Pure-code image dimensions (no native image library) ──────────
// Reads width/height from the file header for the four allowed formats. A
// format we can't parse just yields null dimensions — never an error; the
// asset is still stored and usable, the meta simply omits width/height.
export function readImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  try {
    // PNG: 8-byte signature, then IHDR chunk with width/height as big-endian u32.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: "GIF87a"/"GIF89a", then logical screen w/h as little-endian u16.
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // WebP: "RIFF"...."WEBP", then a VP8 / VP8L / VP8X chunk.
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8 ') {
        // Lossy: 16.3.2 header — dimensions at offset 26/28, 14 bits each.
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        // Lossless: 14-bit dimensions minus one, packed from offset 21.
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === 'VP8X') {
        // Extended: 24-bit dimensions minus one, little-endian from offset 24.
        const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
        const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
        return { width: w, height: h };
      }
      return null;
    }
    // JPEG: scan the marker segments for a Start-Of-Frame (SOFn), read h/w.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        // SOF0..SOF15 except the DHT/DAC/RST markers (c4/c8/cc).
        if (marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        // Standalone markers (no length): RSTn, SOI, EOI, TEM.
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) break;
        off += 2 + len;
      }
      return null;
    }
  } catch { /* malformed header → no dimensions, not an error */ }
  return null;
}

// ── Filesystem helpers (atomic writes, best-effort, never throw) ──
async function ensureDir() {
  try { await fsp.mkdir(MEDIA_DIR, { recursive: true }); } catch { /* best effort */ }
}

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${shortSlug(4)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function metaPath(id) { return path.join(MEDIA_DIR, `${id}.json`); }
function bytesPath(id, ext) { return path.join(MEDIA_DIR, `${id}.${ext}`); }

// ── Slug index (slug → sha). Rebuildable from the metas, so drift is
// always recoverable; we treat the metas as truth and the index as a cache. ──
async function readSlugIndex() { return readJson(SLUG_INDEX, {}); }

async function indexSlugs(slugs, id) {
  await ensureDir();
  const idx = await readSlugIndex();
  let changed = false;
  for (const s of (slugs || [])) { if (idx[s] !== id) { idx[s] = id; changed = true; } }
  if (changed) { try { await atomicWrite(SLUG_INDEX, JSON.stringify(idx, null, 2)); } catch { /* cache only */ } }
}

/**
 * Resolve a model-facing slug (or a raw sha, or any legacy alias) to the sha
 * id that names the files. Returns null when nothing matches. The slug index
 * is the fast path; a miss falls back to a meta scan (and heals the index),
 * so a lost/rebuilt index never makes an asset unreachable.
 */
export async function resolveAssetId(slugOrId) {
  const key = String(slugOrId ?? '').trim();
  if (!key) return null;
  // A raw sha (the meta filename) resolves directly.
  try { await fsp.access(metaPath(key)); return key; } catch { /* not a sha */ }
  const idx = await readSlugIndex();
  if (idx[key]) {
    try { await fsp.access(metaPath(idx[key])); return idx[key]; } catch { /* stale entry */ }
  }
  // Fallback: scan metas for the slug, healing the index on a hit.
  try {
    const files = await fsp.readdir(MEDIA_DIR);
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const meta = await readJson(path.join(MEDIA_DIR, f), null);
      if (meta && Array.isArray(meta.slugs) && meta.slugs.includes(key)) {
        await indexSlugs(meta.slugs, meta.id);
        return meta.id;
      }
    }
  } catch { /* no dir yet */ }
  return null;
}

/**
 * Persist bytes and mint the asset meta. Content-addressed: a second save of
 * the same bytes returns the existing meta (dedup), never a duplicate.
 *
 * @param {object} p
 * @param {Buffer} p.buffer     the image bytes
 * @param {string} p.mime       must be in IMAGE_MIME_EXT
 * @param {object} [p.origin]   { surface, sessionId, speaker }
 * @param {string} [p.audienceTag] stamped from the arriving session/room
 * @param {string} [p.label]    caption or filename → the meaning-bearing slug
 * @returns {Promise<object>}   the meta, or {ok:false, error}
 */
export async function saveAsset({ buffer, mime, origin = {}, audienceTag = 'ward-private', label = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: 'no image bytes' };
  const ext = IMAGE_MIME_EXT[mime];
  if (!ext) return { ok: false, error: `unsupported media type ${mime || '(none)'}` };
  if (buffer.length > MEDIA_MAX_BYTES) {
    return { ok: false, error: `image too large (${buffer.length} > ${MEDIA_MAX_BYTES} bytes)` };
  }
  const id = crypto.createHash('sha256').update(buffer).digest('hex');
  await ensureDir();

  // Dedup: identical bytes already stored → return the existing meta as-is.
  const existing = await readJson(metaPath(id), null);
  if (existing) return existing;

  const size = readImageSize(buffer) || {};
  // Mint the arrival slug from the best label present (caption / meaningful
  // filename); camera-noise names fall back to `img-xxxxxx` inside meaningSlugId.
  const slug = meaningSlugId(label, { fallbackKind: 'img' });
  const meta = {
    id,
    slugs: [slug],
    kind: 'image',
    mime,
    ext,
    bytes: buffer.length,
    width: size.width ?? null,
    height: size.height ?? null,
    receivedAt: new Date().toISOString(),
    origin: {
      surface:   origin.surface ?? null,
      sessionId: origin.sessionId ?? null,
      speaker:   origin.speaker ?? null,
    },
    audienceTag: audienceTag || 'ward-private',
    label: label ? String(label).slice(0, 200) : null,
    description: null,
  };
  try {
    await fsp.writeFile(bytesPath(id, ext), buffer);
    await atomicWrite(metaPath(id), JSON.stringify(meta, null, 2));
    await indexSlugs(meta.slugs, id);
  } catch (err) {
    return { ok: false, error: `media store write failed: ${err?.message ?? err}` };
  }
  return meta;
}

/** Meta only (no bytes) — the common read for stand-in rendering + gating. */
export async function getAssetMeta(idOrSlug) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return null;
  return readJson(metaPath(id), null);
}

/** Meta + bytes — for the materializer (data-URL build) and the byte stream. */
export async function getAsset(idOrSlug) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return { ok: false, error: 'asset not found' };
  const meta = await readJson(metaPath(id), null);
  if (!meta) return { ok: false, error: 'asset meta not found' };
  try {
    const buffer = await fsp.readFile(bytesPath(id, meta.ext));
    return { meta, buffer };
  } catch (err) {
    return { ok: false, error: `asset bytes not readable: ${err?.message ?? err}` };
  }
}

/**
 * Cache the describe result (§6) and, when the description gives us better
 * words than the arrival slug, mint a meaning-bearing alias and make it the
 * PREFERRED (first) slug — so freshly-rendered stand-ins upgrade their
 * readability while every old slug still resolves forever. Written once;
 * callers must not regenerate a description that already exists.
 */
export async function setAssetDescription(idOrSlug, description) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return { ok: false, error: 'asset not found' };
  const meta = await readJson(metaPath(id), null);
  if (!meta) return { ok: false, error: 'asset meta not found' };

  meta.description = description && typeof description === 'object' ? description : { text: String(description ?? '') };

  // Upgrade the model-facing slug from the description's key words, unless the
  // arrival slug was already meaning-bearing (a caption/filename gave it real
  // words — don't churn a good id).
  const arrival = meta.slugs?.[0] ?? '';
  const arrivalWasGeneric = /^img-[a-z0-9]{6}$/.test(arrival);
  const descWords = slugifyLabel(meta.description?.text ?? '');
  if (arrivalWasGeneric && descWords) {
    const alias = `${descWords}-${shortSlug(2)}`;
    if (!meta.slugs.includes(alias)) meta.slugs = [alias, ...meta.slugs];
  }
  try {
    await atomicWrite(metaPath(id), JSON.stringify(meta, null, 2));
    await indexSlugs(meta.slugs, id);
  } catch (err) {
    return { ok: false, error: `description write failed: ${err?.message ?? err}` };
  }
  return meta;
}

/**
 * Link an asset to a graph node it depicts (picture→node, §6.5) — a photo of
 * Milkyway ties to the `milkyway-x7` node, so the Familiar gains continuity
 * across everything it has seen of a person, pet, place, or thing. The bytes
 * stay local; this is an embodiment-local annotation on the asset meta, deduped
 * by nodeId. Atomic write; never throws.
 */
export async function addAssetLink(idOrSlug, { nodeId, label = '', kind = '', by = 'familiar' } = {}) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return { ok: false, error: 'asset not found' };
  const node = String(nodeId ?? '').trim();
  if (!node) return { ok: false, error: 'a node id is required' };
  const meta = await readJson(metaPath(id), null);
  if (!meta) return { ok: false, error: 'asset meta not found' };
  const links = Array.isArray(meta.links) ? meta.links.filter(l => l && l.nodeId !== node) : [];
  links.push({ nodeId: node, label: String(label || node).slice(0, 120), kind: String(kind || '').slice(0, 40), by: by === 'ward' ? 'ward' : 'familiar' });
  meta.links = links;
  try { await atomicWrite(metaPath(id), JSON.stringify(meta, null, 2)); }
  catch (err) { return { ok: false, error: `link write failed: ${err?.message ?? err}` }; }
  return meta;
}

/** Remove one asset→node link (leaves the asset and the node intact). */
export async function removeAssetLink(idOrSlug, nodeId) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return { ok: false, error: 'asset not found' };
  const meta = await readJson(metaPath(id), null);
  if (!meta) return { ok: false, error: 'asset meta not found' };
  const node = String(nodeId ?? '').trim();
  meta.links = (Array.isArray(meta.links) ? meta.links : []).filter(l => l && l.nodeId !== node);
  try { await atomicWrite(metaPath(id), JSON.stringify(meta, null, 2)); }
  catch (err) { return { ok: false, error: `link write failed: ${err?.message ?? err}` }; }
  return meta;
}

/** Every asset linked to a given graph node, newest first — powers "show me
 *  what Milkyway looks like" (the Familiar view_images them). */
export async function assetsForNode(nodeId, { limit = 20 } = {}) {
  const node = String(nodeId ?? '').trim();
  if (!node) return [];
  const all = await listAssets({ limit: 1000 });
  return all.filter(m => Array.isArray(m.links) && m.links.some(l => l.nodeId === node)).slice(0, limit);
}

/** Ward-facing inventory, newest first. */
export async function listAssets({ limit = 100 } = {}) {
  try {
    const files = await fsp.readdir(MEDIA_DIR);
    const metas = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const meta = await readJson(path.join(MEDIA_DIR, f), null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    return metas.slice(0, Math.max(0, limit));
  } catch { return []; }
}

/** Remove an asset (bytes + meta + index entries). References are never
 *  rewritten — a deleted asset renders as `[image no longer available]`. */
export async function deleteAsset(idOrSlug) {
  const id = await resolveAssetId(idOrSlug);
  if (!id) return { ok: false, error: 'asset not found' };
  const meta = await readJson(metaPath(id), null);
  try {
    if (meta?.ext) await fsp.rm(bytesPath(id, meta.ext), { force: true });
    await fsp.rm(metaPath(id), { force: true });
    if (meta?.slugs?.length) {
      const idx = await readSlugIndex();
      for (const s of meta.slugs) delete idx[s];
      try { await atomicWrite(SLUG_INDEX, JSON.stringify(idx, null, 2)); } catch { /* cache only */ }
    }
  } catch (err) {
    return { ok: false, error: `delete failed: ${err?.message ?? err}` };
  }
  return { ok: true, id };
}

// ── Stand-ins (§6) — the textual trace the model reads when it can't see the
// bytes natively. Code-built; the model never composes this line. ──

// Who shared it, in the Familiar's voice. Ward → "my human"; a villager →
// their name (provenance, same spirit as villager memory writes).
function sharedByPhrase(meta) {
  const sp = meta?.origin?.speaker;
  if (sp && String(sp).trim()) return `shared by ${String(sp).trim()}`;
  return 'shared by my human';
}

/**
 * The single code-built stand-in line for one asset. Uses the PREFERRED
 * (first) slug — the meaning-bearing one once a description has landed. The
 * description text (or an honest "not yet described" / "no vision connection
 * available to look"), the source, and a machine relative-time render.
 */
export function buildStandin(meta, { now = Date.now() } = {}) {
  if (!meta || !meta.id) return '';
  const slug = meta.slugs?.[0] ?? meta.id;
  let body;
  if (meta.description && typeof meta.description.text === 'string' && meta.description.text.trim()) {
    body = meta.description.text.trim();
  } else if (meta.description === null) {
    body = 'not yet described';
  } else {
    body = 'no vision connection available to look';
  }
  // Named node links (picture→node, §6.5) ride in the stand-in so the Familiar
  // reads WHO/WHAT an image depicts — continuity across everything it's seen of
  // Milkyway, not just "a cat". Code-built from the link labels.
  const links = Array.isArray(meta.links) ? meta.links.filter(l => l && l.label) : [];
  const linkPart = links.length ? ` — of ${links.map(l => l.label).join(', ')}` : '';
  const when = meta.receivedAt ? (relativeTime(meta.receivedAt, now) || '') : '';
  const whenPart = when ? `, ${when}` : '';
  return `[image ${slug}: ${body}${linkPart} — ${sharedByPhrase(meta)}${whenPart}]`;
}

/**
 * §10 helper: drain images the Familiar asked to look at again (view_image
 * stashed them on `toolCtx._pendingImages` after validating id + audience gate)
 * into a user-role message carrying the image parts, for the tool loop's next
 * round. Clears the stash. Returns [] when there's nothing pending. Lives here
 * (not vision.js) so BOTH the streaming loop (server.js) and runToolCallLoop
 * (cerebellum.js) can call it without the cerebellum↔vision import cycle.
 */
export async function drainPendingImages(toolCtx = {}) {
  const pending = Array.isArray(toolCtx?._pendingImages) ? toolCtx._pendingImages : [];
  if (!pending.length) return [];
  toolCtx._pendingImages = [];
  const parts = [];
  for (const p of pending) {
    const got = await getAsset(p?.id);
    if (got?.buffer && got?.meta) {
      parts.push({ type: 'image_url', image_url: { url: `data:${got.meta.mime};base64,${got.buffer.toString('base64')}` } });
    }
  }
  if (!parts.length) return [];
  const label = pending.length === 1
    ? 'Here is the image I asked to look at again.'
    : `Here are the ${parts.length} images I asked to look at again.`;
  return [{ role: 'user', content: [{ type: 'text', text: label }, ...parts] }];
}

/**
 * §7 helper: a message's content string with a stand-in appended for every
 * attachment it carries. The memorization prompt builders and the loop
 * prompts call this instead of reading `m.content` raw, so an image-only
 * message (empty text, one attachment) still becomes text-eligible. Async
 * because it reads each asset's meta. A string message with no attachments
 * comes back unchanged (minus a trailing space) — cheap and safe.
 */
export async function contentWithStandins(message, { now = Date.now() } = {}) {
  const base = typeof message?.content === 'string' ? message.content : '';
  const atts = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!atts.length) return base;
  const lines = [];
  for (const a of atts) {
    const meta = await getAssetMeta(a?.id);
    if (meta) lines.push(buildStandin(meta, { now }));
    else      lines.push(`[image ${a?.id ?? '?'}: no longer available]`);
  }
  return base ? `${base}\n${lines.join('\n')}` : lines.join('\n');
}
