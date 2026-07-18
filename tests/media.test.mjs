import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

// media.js resolves MEDIA_DIR relative to its own file, so we can't point it
// elsewhere per-test. Instead we run against the real media/ dir and clean up
// every asset we create (tracked by id). Assets are content-addressed, so the
// fixtures below are deterministic and never collide with real user media.
import {
  saveAsset, getAsset, getAssetMeta, setAssetDescription, listAssets,
  deleteAsset, resolveAssetId, buildStandin, contentWithStandins,
  readImageSize, MEDIA_MAX_BYTES, IMAGE_MIME_EXT,
} from '../media.js';
import { slugifyLabel, meaningSlugId } from '../slug-ids.js';

// ── Fixtures: minimal-but-valid encoded headers, so readImageSize is tested
// against real bytes rather than mocks. ──

// A 1x1 PNG (real, from the canonical transparent pixel).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

// A GIF89a with a 3x5 logical screen (w/h are LE u16 at offset 6/8).
function gif(w, h) {
  const b = Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00\x00', 'binary');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

// A JPEG SOI + a synthetic SOF0 declaring 7x11 (h then w, BE u16).
function jpeg(w, h) {
  const head = Buffer.from([0xff, 0xd8]);                 // SOI
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0;                            // SOF0
  sof.writeUInt16BE(9, 2);                                 // segment length
  sof[4] = 8;                                              // precision
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);        // height, width
  return Buffer.concat([head, sof, Buffer.from([0xff, 0xd9])]);
}

const created = [];
async function track(meta) { if (meta?.id) created.push(meta.id); return meta; }
after(async () => { for (const id of created) await deleteAsset(id); });

test('readImageSize parses PNG / GIF / JPEG headers', () => {
  assert.deepEqual(readImageSize(PNG_1x1), { width: 1, height: 1 });
  assert.deepEqual(readImageSize(gif(3, 5)), { width: 3, height: 5 });
  assert.deepEqual(readImageSize(jpeg(7, 11)), { width: 7, height: 11 });
  assert.equal(readImageSize(Buffer.from('not an image')), null);
});

test('saveAsset stores bytes + meta and round-trips', async () => {
  const meta = await track(await saveAsset({
    buffer: gif(3, 5), mime: 'image/gif',
    origin: { surface: 'web', sessionId: 's-1' }, label: 'garden sketch v2',
  }));
  assert.equal(meta.kind, 'image');
  assert.equal(meta.mime, 'image/gif');
  assert.equal(meta.width, 3);
  assert.equal(meta.height, 5);
  assert.match(meta.slugs[0], /^garden-sketch-v2-[a-z0-9]{2}$/);
  assert.equal(meta.description, null);

  const got = await getAsset(meta.slugs[0]);
  assert.ok(Buffer.isBuffer(got.buffer));
  assert.equal(got.meta.id, meta.id);
});

test('content-addressed dedup: identical bytes return the same asset', async () => {
  const a = await track(await saveAsset({ buffer: jpeg(7, 11), mime: 'image/jpeg', label: 'first' }));
  const b = await saveAsset({ buffer: jpeg(7, 11), mime: 'image/jpeg', label: 'second' });
  assert.equal(b.id, a.id);
  assert.deepEqual(b.slugs, a.slugs);   // existing meta returned unchanged
});

test('rejects oversized and non-image inputs without throwing', async () => {
  const tooBig = await saveAsset({ buffer: Buffer.alloc(MEDIA_MAX_BYTES + 1), mime: 'image/png' });
  assert.equal(tooBig.ok, false);
  const badMime = await saveAsset({ buffer: PNG_1x1, mime: 'application/pdf' });
  assert.equal(badMime.ok, false);
  const empty = await saveAsset({ buffer: Buffer.alloc(0), mime: 'image/png' });
  assert.equal(empty.ok, false);
});

test('setAssetDescription caches + upgrades a generic slug to meaning-bearing', async () => {
  // A camera-noise filename yields the generic img- slug at arrival.
  const meta = await track(await saveAsset({ buffer: gif(4, 4), mime: 'image/gif', label: 'IMG_2043.jpg' }));
  assert.match(meta.slugs[0], /^img-[a-z0-9]{6}$/);

  const updated = await setAssetDescription(meta.id, { text: 'a mug of tea on a cluttered desk', by: { provider: 'x', model: 'y' }, at: 't' });
  assert.match(updated.slugs[0], /^a-mug-of-tea-[a-z0-9]{2}$/);   // preferred alias
  assert.ok(updated.slugs.includes(meta.slugs[0]));               // old slug still there
  // Both slugs resolve to the same asset.
  assert.equal(await resolveAssetId(updated.slugs[0]), meta.id);
  assert.equal(await resolveAssetId(updated.slugs[1]), meta.id);   // old slug still resolves
});

test('a caption-derived slug is NOT churned when a description lands', async () => {
  const meta = await track(await saveAsset({ buffer: jpeg(5, 5), mime: 'image/jpeg', label: 'my finished painting' }));
  const first = meta.slugs[0];
  assert.match(first, /^my-finished-painting-[a-z0-9]{2}$/);
  const updated = await setAssetDescription(meta.id, { text: 'an oil painting of a harbor at dusk' });
  assert.equal(updated.slugs[0], first);   // kept — arrival slug was already meaningful
});

test('buildStandin renders id, description state, and source', async () => {
  const undesc = await track(await saveAsset({ buffer: gif(2, 2), mime: 'image/gif', label: 'note' }));
  const s1 = buildStandin(undesc);
  assert.match(s1, /^\[image note-[a-z0-9]{2}: not yet described — shared by my human/);

  const described = await setAssetDescription(undesc.id, { text: 'a sticky note reading buy milk' });
  const s2 = buildStandin(described);
  assert.match(s2, /a sticky note reading buy milk/);

  const villager = await track(await saveAsset({
    buffer: jpeg(6, 6), mime: 'image/jpeg', label: 'pic',
    origin: { surface: 'discord', speaker: 'Sam' },
  }));
  assert.match(buildStandin(villager), /shared by Sam/);
});

test('contentWithStandins appends stand-ins; missing asset degrades to a note', async () => {
  const meta = await track(await saveAsset({ buffer: gif(9, 9), mime: 'image/gif', label: 'thing' }));
  const out = await contentWithStandins({ content: 'look at this', attachments: [{ id: meta.slugs[0] }] });
  assert.match(out, /^look at this\n\[image thing-/);

  // An image-only message becomes text-eligible via the stand-in.
  const imgOnly = await contentWithStandins({ content: '', attachments: [{ id: meta.id }] });
  assert.match(imgOnly, /^\[image thing-/);

  // A dangling reference never throws.
  const gone = await contentWithStandins({ content: 'x', attachments: [{ id: 'nope-zz' }] });
  assert.match(gone, /no longer available/);

  // No attachments → content unchanged.
  assert.equal(await contentWithStandins({ content: 'plain' }), 'plain');
});

test('listAssets returns newest-first and deleteAsset removes bytes+meta', async () => {
  const m = await track(await saveAsset({ buffer: jpeg(8, 8), mime: 'image/jpeg', label: 'listme' }));
  const list = await listAssets({ limit: 100 });
  assert.ok(list.find(x => x.id === m.id));
  const del = await deleteAsset(m.id);
  assert.equal(del.ok, true);
  assert.equal(await getAssetMeta(m.id), null);
});

// ── slug-ids additions ──

test('slugifyLabel: content words, camera-noise → empty', () => {
  assert.equal(slugifyLabel('Garden Sketch v2.png'), 'garden-sketch-v2');
  assert.equal(slugifyLabel('a mug of tea on a cluttered desk, sticky notes'), 'a-mug-of-tea');
  assert.equal(slugifyLabel('IMG_2043.jpg'), '');
  assert.equal(slugifyLabel('PXL_20260707_143107.jpg'), '');
  assert.equal(slugifyLabel('Screenshot_2026.png'), '');
  assert.equal(slugifyLabel('   '), '');
  assert.equal(slugifyLabel('!!!'), '');
});

test('meaningSlugId: meaning-bearing, else fallback by kind', () => {
  assert.match(meaningSlugId('tea ritual'), /^tea-ritual-[a-z0-9]{2}$/);
  assert.match(meaningSlugId('IMG_2043.jpg'), /^img-[a-z0-9]{6}$/);
  assert.match(meaningSlugId('', { fallbackKind: 'frame' }), /^frame-[a-z0-9]{6}$/);
});
