import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  materializeAttachments, resolveVisionCapable, findConnection,
  isModalityError, DEFAULT_MAX_LIVE_IMAGES,
} from '../vision.js';
import { saveAsset, deleteAsset } from '../media.js';

function gif(w, h) {
  const b = Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00\x00', 'binary');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

const created = [];
let _seq = 100;   // unique dimensions per call → unique bytes → unique sha (no dedup collisions)
async function mk(label, over = {}) {
  const w = over.w ?? _seq++;
  const h = over.h ?? _seq++;
  const { w: _w, h: _h, ...rest } = over;
  const m = await saveAsset({ buffer: gif(w, h), mime: 'image/gif', label, ...rest });
  created.push(m.id);
  return m;
}
after(async () => { for (const id of created) await deleteAsset(id); });

// ── Capability resolution ─────────────────────────────────────────

test("resolveVisionCapable: 'yes'/'no' are the ward's word; auto is optimistic", async () => {
  assert.equal(await resolveVisionCapable({ visionCapable: 'yes' }, {}), true);
  assert.equal(await resolveVisionCapable({ visionCapable: 'no' }, {}), false);
  assert.equal(await resolveVisionCapable({ visionCapable: 'auto', provider: 'p', model: 'never-seen' }, {}), true);
  assert.equal(await resolveVisionCapable({ provider: 'p', model: 'also-never' }, {}), true);
});

test('findConnection matches by provider+model', () => {
  const settings = { connections: [
    { provider: 'nanogpt', model: 'a', visionCapable: 'no' },
    { provider: 'zai', model: 'b', visionCapable: 'yes' },
  ]};
  assert.equal(findConnection(settings, { provider: 'zai', model: 'b' }).visionCapable, 'yes');
  assert.equal(findConnection(settings, { provider: 'x', model: 'y' }), null);
});

test("a ward 'no' on the saved connection is honored even via bare {provider,model}", async () => {
  const settings = { connections: [{ provider: 'nanogpt', model: 'text-only', visionCapable: 'no' }] };
  const conn = findConnection(settings, { provider: 'nanogpt', model: 'text-only' });
  assert.equal(await resolveVisionCapable(conn, settings), false);
});

// ── Materializer ──────────────────────────────────────────────────

test('no attachments anywhere → identity (same array, strings untouched)', async () => {
  const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(messages, msgs);   // same reference — provably unchanged
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 0);
});

test('capable connection: image becomes a data-URL part beside the text', async () => {
  const m = await mk('a mug of tea');
  const msgs = [{ role: 'user', content: 'look', attachments: [{ id: m.id }] }];
  const { messages, imagesLive } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(imagesLive, 1);
  const content = messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'look');
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/gif;base64,/);
});

test('non-capable connection: content stays a string with a stand-in appended', async () => {
  const m = await mk('the sketch');
  const msgs = [{ role: 'user', content: 'look', attachments: [{ id: m.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 1);
  assert.equal(typeof messages[0].content, 'string');
  assert.match(messages[0].content, /^look\n\[image the-sketch-/);
});

test('live budget: only the newest N ride live, older ones stand in', async () => {
  const a = await mk('one');
  const b = await mk('two');
  const c = await mk('three');
  const msgs = [
    { role: 'user', content: 'first', attachments: [{ id: a.id }] },
    { role: 'user', content: 'second', attachments: [{ id: b.id }, { id: c.id }] },
  ];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, maxLive: 2,
  });
  assert.equal(imagesLive, 2);        // b + c (newest)
  assert.equal(imagesStoodIn, 1);     // a (oldest) degraded
  assert.equal(typeof messages[0].content, 'string');   // 'first' message → stand-in only
  assert.match(messages[0].content, /\[image one-/);
  assert.ok(Array.isArray(messages[1].content));        // 'second' → two image parts
  assert.equal(messages[1].content.filter(p => p.type === 'image_url').length, 2);
});

test('audience gate (fail-closed): an out-of-scope asset contributes nothing', async () => {
  const priv = await mk('secret', { audienceTag: 'ward-private' });
  const roomOk = await mk('room pic', { audienceTag: 'room-42' });
  const msgs = [{ role: 'user', content: 'see', attachments: [{ id: priv.id }, { id: roomOk.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, visibleAudiences: new Set(['room-42']),
  });
  // ward-private dropped entirely (no stand-in, no part); room-42 rides live.
  assert.equal(imagesLive, 1);
  assert.equal(imagesStoodIn, 0);
  const parts = messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.ok(!JSON.stringify(parts).includes('secret'));   // nothing about the private asset leaked
});

test('a dangling reference degrades to a note, never throws', async () => {
  const msgs = [{ role: 'user', content: 'x', attachments: [{ id: 'gone-zz' }] }];
  const { messages, imagesStoodIn } = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.equal(imagesStoodIn, 1);
  assert.match(messages[0].content, /no longer available/);
});

test('outgoing provider messages never carry the internal attachments field', async () => {
  const m = await mk('leak check');
  const msgs = [{ role: 'user', content: 'hi', attachments: [{ id: m.id }] }];
  // Live path (array content) and stand-in path (string content) both strip it.
  const live = await materializeAttachments(msgs, { connection: { visionCapable: 'yes' } });
  assert.ok(!('attachments' in live.messages[0]));
  const stood = await materializeAttachments(msgs, { connection: { visionCapable: 'no' } });
  assert.ok(!('attachments' in stood.messages[0]));
});

test('a fully gated-out message drops its attachments field too', async () => {
  const priv = await mk('private', { audienceTag: 'ward-private' });
  const msgs = [{ role: 'user', content: 'x', attachments: [{ id: priv.id }] }];
  const { messages, imagesLive, imagesStoodIn } = await materializeAttachments(msgs, {
    connection: { visionCapable: 'yes' }, visibleAudiences: new Set(['room-1']),
  });
  assert.equal(imagesLive, 0);
  assert.equal(imagesStoodIn, 0);
  assert.ok(!('attachments' in messages[0]));
  assert.equal(messages[0].content, 'x');   // untouched string, nothing leaked
});

test('isModalityError classifies only modality-shaped 4xx', () => {
  assert.equal(isModalityError(400, 'this model does not support image_url content'), true);
  assert.equal(isModalityError(415, 'unsupported content type'), true);
  assert.equal(isModalityError(429, 'rate limit'), false);
  assert.equal(isModalityError(401, 'invalid api key'), false);
  assert.equal(isModalityError(400, 'temperature must be a number'), false);
});
