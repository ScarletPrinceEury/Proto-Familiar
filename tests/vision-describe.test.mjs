// Pictures that never got looked at (0.14.123, docs/vision-describe-build-spec.md).
//
// z.ai's Vision MCP takes only JPG/PNG up to 5 MB, and big PNGs outlasted the
// turn's 25 s wait. So: every describer gets a small JPG/PNG copy, a failed
// describer hands over to the next, a picture's note says where it stands, a
// Discord room gets one more turn when a slow look lands, and a stranger's
// picture leaves a note that it was there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

// No live helper children, and no z.ai MCP spawn: with the MCP off, a z.ai
// describer fails like a down service would, which is what the chain is for.
process.env.PROTO_FAMILIAR_PHYLACTERY_DISABLED = '1';
process.env.PROTO_FAMILIAR_UNRUH_DISABLED = '1';
process.env.PROTO_FAMILIAR_ZAI_VISION_DISABLED = '1';

const { prepareDescribeInput, zaiRefusal, ZAI_MAX_BYTES } = await import('../src/vision/describe-input.js');
const { describeAsset, describeChain, ensureDescribed, materializeAttachments, describeInFlight, settledDescribe } = await import('../src/vision/vision.js');
const { saveAsset, deleteAsset, getAssetMeta, buildStandin } = await import('../src/vision/media.js');
const { watchLateLook, __resetLateLookForTest } = await import('../src/vision/late-look.js');
const { mediaArrivalNote, ingestDiscordMedia } = await import('../src/discord/discord-gateway.js');

const created = [];
after(async () => { for (const id of created) await deleteAsset(id); });

let _seq = 0;
async function picture(format = 'webp', { w = 40 + (_seq++), h = 30 } = {}) {
  const img = sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0.6 } } });
  return format === 'png' ? img.png().toBuffer() : img.webp().toBuffer();
}
async function stored(buffer, mime, label = 'a test picture') {
  const m = await saveAsset({ buffer, mime, label });
  created.push(m.id);
  return m;
}
// A GIF header with nothing after it: the converter can't read it, so it goes
// to the describer as a GIF, the way a file sharp can't decode would.
function brokenGif(w, h) {
  const b = Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00\x00', 'binary');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}
const completion = (text) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
});
// The image part a describe call sent, from the request body.
const sentImageUrl = (init) => JSON.parse(init.body).messages[0].content.find(p => p.type === 'image_url').image_url.url;

const ZAI = { id: 'z', provider: 'zai-coding', model: 'glm-4.6', apiKey: 'zk' };
const SEES = { id: 'o', provider: 'zai', model: 'glm-4.6v', apiKey: 'k', visionCapable: 'yes' };

// ── The describe copy ─────────────────────────────────────────────────────

test('a WebP becomes a JPEG copy for the describer; the stored bytes are untouched', async () => {
  const webp = await picture('webp');
  const out = await prepareDescribeInput({ buffer: webp, mime: 'image/webp' });
  assert.equal(out.converted, true);
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.from, 'image/webp');
  assert.deepEqual([...out.buffer.subarray(0, 2)], [0xff, 0xd8]);   // a JPEG
  assert.equal(zaiRefusal(out), null);                              // z.ai takes it
});

test('a small PNG goes as it is (crisp text stays crisp); a big one becomes a smaller JPEG', async () => {
  const small = await picture('png');
  const kept = await prepareDescribeInput({ buffer: small, mime: 'image/png' });
  assert.equal(kept.converted, false);
  assert.equal(kept.buffer, small);

  const side = 900;
  const noise = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(noise.length > 1_000_000);
  const big = await prepareDescribeInput({ buffer: noise, mime: 'image/png' });
  assert.equal(big.converted, true);
  assert.equal(big.mime, 'image/jpeg');
  assert.ok(big.buffer.length < noise.length);
});

test('without the converter the stored bytes go as they are, and z.ai\'s refusal is known up front', async () => {
  const webp = await picture('webp');
  const out = await prepareDescribeInput({ buffer: webp, mime: 'image/webp' }, { loadConverter: async () => null });
  assert.equal(out.converted, false);
  assert.equal(out.note, 'no-converter');
  assert.equal(zaiRefusal(out), 'format');
  assert.equal(zaiRefusal({ buffer: Buffer.alloc(ZAI_MAX_BYTES + 1), mime: 'image/jpeg' }), 'too-big');
});

// ── The describe chain ────────────────────────────────────────────────────

test('the chain is the vision connection, then my human\'s backups, then other connections that can see; one z.ai key counts once', async () => {
  const s = {
    connections: [ZAI, { ...ZAI, id: 'z2' }, { id: 'blind', provider: 'nanogpt', model: 't', apiKey: 'k', visionCapable: 'no' }, SEES, { id: 'g', provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k', visionCapable: 'yes' }],
    featureConnections: { vision: 'z' },
    fallbackConnectionIds: ['g'],
  };
  assert.deepEqual((await describeChain(s)).map(c => c.id), ['z', 'g', 'o']);
  assert.deepEqual((await describeChain({ ...s, visionDescribeFallbacks: false })).map(c => c.id), ['z']);
});

test('pipeline: a WebP on a z.ai-first chain gets looked at by the next connection, and the turn reads what I saw', async () => {
  const m = await stored(await picture('webp'), 'image/webp', 'a webp screenshot');
  const settings = { connections: [ZAI, SEES], featureConnections: { vision: 'z' }, fallbackConnectionIds: ['o'] };
  const sent = [];
  const fetchFn = async (_url, init) => { sent.push(sentImageUrl(init)); return completion('A pink square, a little see-through.'); };
  const messages = [{ role: 'user', content: 'look at this', attachments: [{ id: m.id }] }];

  const d = await ensureDescribed(messages, settings, { fetchFn });
  assert.equal(d.described, 1);
  assert.deepEqual(d.pending, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^data:image\/jpeg;base64,/);   // the converted copy, not the WebP

  const blindChat = { id: 'chat', provider: 'nanogpt', model: 'text-only', apiKey: 'k', visionCapable: 'no' };
  const mat = await materializeAttachments(messages, { connection: blindChat, settings });
  assert.match(mat.messages[0].content, /what I saw when I looked: A pink square/);
  assert.equal(mat.blindImageStandins, 0);
});

test('every describer refusing the file is recorded, not retried with the same setup, and retried once the setup changes', async () => {
  const m = await stored(brokenGif(301, 302), 'image/gif', 'a gif nothing could read');
  const onlyZai = { connections: [ZAI], primaryConnectionId: 'z' };
  const r = await describeAsset(m.id, onlyZai, { fetchFn: async () => { throw new Error('no call expected'); } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'format');
  const meta = await getAssetMeta(m.id);
  assert.equal(meta.describeFailure.permanent, true);
  assert.equal(buildStandin(meta), buildStandin(meta));   // pure
  assert.match(buildStandin(meta), /I couldn't get a look at this one — my image reader doesn't take GIF files/);

  const again = await describeAsset(m.id, onlyZai);
  assert.equal(again.cached, true);

  let calls = 0;
  const withBackup = { connections: [ZAI, SEES], primaryConnectionId: 'z', fallbackConnectionIds: ['o'] };
  const done = await describeAsset(m.id, withBackup, { fetchFn: async () => { calls++; return completion('A tiny broken gif.'); } });
  assert.equal(calls, 1);
  assert.equal(done.description.text, 'A tiny broken gif.');
  assert.equal('describeFailure' in (await getAssetMeta(m.id)), false);   // settled by the look
});

test('a describer that just failed leaves "tried, didn\'t come through", and the next turn tries again', async () => {
  const m = await stored(await picture('png'), 'image/png', 'a flaky describe');
  const settings = { connections: [SEES], primaryConnectionId: 'o' };
  const down = async () => ({ ok: false, status: 503, text: async () => 'busy' });
  const r = await describeAsset(m.id, settings, { fetchFn: down });
  assert.equal(r.ok, false);
  const meta = await getAssetMeta(m.id);
  assert.equal(meta.describeFailure.permanent, false);
  assert.match(buildStandin(meta), /I tried to look at this one and it didn't come through/);
  const ok = await describeAsset(m.id, settings, { fetchFn: async () => completion('Now it worked.') });
  assert.equal(ok.description.text, 'Now it worked.');
});

test('two turns asking about the same picture share one look, and meanwhile its note says I\'m still looking', async () => {
  const m = await stored(await picture('png'), 'image/png', 'a slow describe');
  const settings = { connections: [SEES], primaryConnectionId: 'o' };
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const fetchFn = async () => { calls++; await gate; return completion('Slowly seen.'); };

  const a = describeAsset(m.id, settings, { fetchFn });
  const b = describeAsset(m.id, settings, { fetchFn });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(describeInFlight(m.id), true);
  const blindChat = { id: 'chat', provider: 'nanogpt', model: 'text-only', apiKey: 'k', visionCapable: 'no' };
  const mat = await materializeAttachments([{ role: 'user', content: 'hm', attachments: [{ id: m.id }] }], { connection: blindChat, settings });
  assert.match(mat.messages[0].content, /I'm still looking at this one/);

  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra.description.text, 'Slowly seen.');
  assert.equal(rb.description.text, 'Slowly seen.');
  assert.equal(describeInFlight(m.id), false);
});

test('a look that outlasts the wait comes back as pending, and finishes in the background', async () => {
  const m = await stored(await picture('png'), 'image/png', 'outlasts the wait');
  const settings = { connections: [SEES], primaryConnectionId: 'o' };
  const fetchFn = async () => { await new Promise(r => setTimeout(r, 80)); return completion('Seen after the wait.'); };
  const d = await ensureDescribed([{ attachments: [{ id: m.id }] }], settings, { fetchFn, perImageTimeoutMs: 10 });
  assert.equal(d.described, 0);
  assert.deepEqual(d.pending, [m.id]);
  const settled = await settledDescribe(m.id);
  assert.equal(settled.description.text, 'Seen after the wait.');
});

// ── The late look ─────────────────────────────────────────────────────────

test('a late look is queued once for the pictures that landed in time, never twice for one picture', async () => {
  __resetLateLookForTest();
  const queued = [];
  const waitFor = async (id) => (id === 'seen' ? { description: { text: 'x' } } : { ok: false, reason: 'down' });
  const ids = await watchLateLook({ pending: ['seen', 'failed'], queue: (x) => { queued.push(x); }, waitFor });
  assert.deepEqual(ids, ['seen']);
  assert.deepEqual(queued, [['seen']]);
  assert.deepEqual(await watchLateLook({ pending: ['seen'], queue: (x) => { queued.push(x); }, waitFor }), []);
  assert.equal(queued.length, 1);
  // A picture whose look failed is released: a later turn waiting on it again can watch it.
  const retried = await watchLateLook({ pending: ['failed'], queue: (x) => { queued.push(x); }, waitFor: async () => ({ description: { text: 'y' } }) });
  assert.deepEqual(retried, ['failed']);
});

test('a look that lands after the window gets no late look', async () => {
  __resetLateLookForTest();
  let queued = 0;
  const ids = await watchLateLook({
    pending: ['slow'], turnAt: 0, now: () => 11 * 60_000,
    waitFor: async () => ({ description: { text: 'x' } }), queue: () => { queued++; },
  });
  assert.deepEqual(ids, []);
  assert.equal(queued, 0);
});

// ── A stranger's picture ──────────────────────────────────────────────────

test('a stranger\'s picture is never fetched, but the message says one was there', async () => {
  const msg = { attachments: [
    { content_type: 'image/png', filename: 'a.png', url: 'https://example.invalid/a.png', width: 10, height: 10 },
    { content_type: 'image/webp', filename: 'b.webp', url: 'https://example.invalid/b.webp', width: 10, height: 10 },
  ] };
  const r = await ingestDiscordMedia(msg, { isWard: false, villager: null, locationKey: 'discord:guild:1:channel:2' }, { audienceTag: 'strangers' });
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.notKept, { images: 2, videos: 0 });
  assert.equal(mediaArrivalNote(r), "\n[2 pictures from someone I don't know — the app doesn't keep those, so I can't see them]");
  assert.equal(mediaArrivalNote({ notKept: { images: 0, videos: 1 } }), "\n[a video from someone I don't know — the app doesn't keep those, so I can't see it]");
  assert.equal(mediaArrivalNote({ failed: 1 }), '\n[image failed to load]');
  assert.equal(mediaArrivalNote({ failed: 0 }), '');
});
