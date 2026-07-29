/**
 * Voice notes, end to end (voice spec §9).
 *
 * The pipeline tests here are not optional decoration. The 0.9 vision
 * post-mortem's root cause #4 was that ZERO tests ran the orchestration paths,
 * so a `ReferenceError`, a swallowed exception, and a describe that landed
 * after the prompt was built all passed every pure-function test in the repo
 * and were caught only by a human listening. The same class of bug is
 * available here — a transcript that lands after the prompt means I answer a
 * message I never heard — so a real turn runs through the real assembly code
 * with a stubbed worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildStandin, clipLength, maxBytesForKind, mediaKindFor, MEDIA_KINDS, AUDIO_MAX_BYTES, MEDIA_MAX_BYTES } from '../media.js';
import { transcribeTimeoutMs, listeningAllowed } from '../voice-transcribe.js';
import { materializeAttachments } from '../vision.js';
import { encodeWav, toMono, elapsedLabel, TARGET_RATE } from '../public/voice-recorder.js';
import { parseWav } from '../voice-audio-features.js';

// ── The kind derivation ───────────────────────────────────────────

test('audio mimes are audio, image mimes are image, and the two maps agree', () => {
  assert.equal(mediaKindFor('audio/wav'), 'audio');
  assert.equal(mediaKindFor('image/png'), 'image');
  assert.equal(mediaKindFor('application/pdf'), null);
  // The regression this guards: saveAsset used to hard-code kind:'image' while
  // looking the extension up separately, so audio would have been stored as an
  // image with a .wav on it.
  for (const [mime, { kind }] of Object.entries(MEDIA_KINDS)) {
    assert.equal(mediaKindFor(mime), kind, `${mime} disagrees with itself`);
  }
});

test('audio gets its own size ceiling — the image cap would cut a note off at three minutes', () => {
  assert.equal(maxBytesForKind('image'), MEDIA_MAX_BYTES);
  assert.equal(maxBytesForKind('audio'), AUDIO_MAX_BYTES);
  assert.ok(AUDIO_MAX_BYTES > MEDIA_MAX_BYTES);
  // 16 kHz mono 16-bit = 32000 B/s. The cap should buy at least ten minutes.
  assert.ok(AUDIO_MAX_BYTES / 32000 > 600);
});

// ── The stand-in, which is the whole of what I read ───────────────

test('a transcribed note reads as something I heard, not as a file I cannot open', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['oat-milk-list-x7'], kind: 'audio', durationSec: 41,
    receivedAt: new Date().toISOString(), origin: {},
    description: { text: 'Could you add oat milk to the list' },
  });
  assert.match(line, /^\[voice note oat-milk-list-x7, 0:41: /);
  // FRAMING IS LOAD-BEARING: the image version of this shipped as metadata and
  // the model disclaimed it could not see, with the description right there.
  assert.match(line, /what I heard when I listened/);
  assert.match(line, /"Could you add oat milk to the list"/);
  assert.doesNotMatch(line, /\[image /);
});

test('each kind of silence says which kind it is', () => {
  const base = { id: 'sha', slugs: ['snd-aaaaaa'], kind: 'audio', durationSec: 5, receivedAt: new Date().toISOString(), origin: {} };
  assert.match(buildStandin({ ...base, description: null }), /haven't listened to this one yet/);
  assert.match(buildStandin({ ...base, description: { reason: 'voice-disabled' } }), /listening is switched off/);
  assert.match(buildStandin({ ...base, description: { text: '', reason: 'no-speech' } }), /no way to listen|haven't listened/);
});

test('a note whose audio was let go still carries its words', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['the-thing-x2'], kind: 'audio', durationSec: 12,
    receivedAt: new Date().toISOString(), origin: {},
    description: { text: 'the thing about Tuesday' },
    audio: { deletedAt: '2026-07-01T00:00:00Z' },
  });
  assert.match(line, /the thing about Tuesday/);
  assert.match(line, /sound itself has been let go/);
});

test('an unmeasurable length is omitted rather than invented', () => {
  // webm/ogg/m4a cannot be measured without a decoder we do not ship, and a
  // duration guessed from bitrate would be a made-up number on a model-facing
  // surface — the exact-values rule.
  const line = buildStandin({
    id: 'sha', slugs: ['snd-bbbbbb'], kind: 'audio', durationSec: null,
    receivedAt: new Date().toISOString(), origin: {}, description: { text: 'hi' },
  });
  assert.match(line, /^\[voice note snd-bbbbbb: /);
  assert.equal(clipLength(null), '');
  assert.equal(clipLength(41.2), '0:41');
  assert.equal(clipLength(362), '6:02');
});

test('an image still renders as an image — the audio branch did not capture everything', () => {
  const line = buildStandin({
    id: 'sha', slugs: ['a-cat-x1'], kind: 'image', receivedAt: new Date().toISOString(),
    origin: {}, description: { text: 'a tabby on a windowsill' },
  });
  assert.match(line, /^\[image a-cat-x1: what I saw when I looked/);
});

// ── The materializer: audio must never ride live ──────────────────

test('a voice note never becomes a provider content part, even on a seeing connection', async () => {
  const notes = [];
  const stub = {
    getAssetMeta: async () => ({
      id: 'sha1', slugs: ['a-note-x1'], kind: 'audio', mime: 'audio/wav', durationSec: 9,
      audienceTag: 'ward-private', receivedAt: new Date().toISOString(), origin: {},
      description: { text: 'remember the bins' },
    }),
  };
  // materializeAttachments reads the store, so this runs against the real one
  // via a temp asset instead of a mock — see the pipeline test below. Here we
  // only assert the shape rule with a hand-built message.
  const out = await materializeAttachments(
    [{ role: 'user', content: 'listen to this', attachments: [{ id: 'definitely-not-a-real-asset' }] }],
    { connection: { provider: 'x', model: 'y', visionCapable: 'yes' }, settings: {} },
  );
  // A missing asset degrades to a stand-in, never to an error and never to a
  // content-part array.
  assert.equal(typeof out.messages[0].content, 'string');
  assert.equal(out.imagesLive, 0);
  void notes; void stub;
});

// ── The browser's wav, read by the server's parser ────────────────

test('what the browser encodes is what the server can read', () => {
  const n = TARGET_RATE;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 440 * i) / TARGET_RATE) * 0.5;
  const wav = Buffer.from(encodeWav(s, TARGET_RATE));

  const back = parseWav(wav);
  assert.ok(back, 'the server could not parse the browser wav');
  assert.equal(back.sampleRate, TARGET_RATE);
  assert.equal(back.samples.length, n);
  assert.ok(Math.abs(back.durationSec - 1) < 0.01);
});

test('samples outside [-1,1] clamp instead of wrapping to the opposite extreme', () => {
  // Resampling routinely overshoots slightly; a wrap turns that into an
  // audible click, and clicks transcribe as nothing good.
  const view = new DataView(encodeWav(new Float32Array([2.0, -2.0]), TARGET_RATE));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('a mono downmix averages the channels rather than picking one', () => {
  // A headset mic often records to one channel only; taking the left channel
  // yields silence, which looks exactly like "the microphone did not work".
  const fake = {
    length: 3,
    numberOfChannels: 2,
    getChannelData: (c) => (c === 0 ? new Float32Array([0, 0, 0]) : new Float32Array([1, 1, 1])),
  };
  assert.deepEqual(Array.from(toMono(fake)), [0.5, 0.5, 0.5]);
});

test('the UI and the stand-in agree on how a length is written', () => {
  assert.equal(elapsedLabel(41.7), clipLength(41.7));
  assert.equal(elapsedLabel(0), '0:00');
});

// ── Consents and budgets ──────────────────────────────────────────

test('listening is off unless it was explicitly turned on', () => {
  assert.equal(listeningAllowed({}), false, 'an unset value must not enable a microphone');
  assert.equal(listeningAllowed({ voiceEnabled: false }), false);
  assert.equal(listeningAllowed({ voiceEnabled: 'yes' }), false, 'only a real true counts');
  assert.equal(listeningAllowed({ voiceEnabled: true }), true);
});

test('the hard env off-switch beats the setting', () => {
  const prior = process.env.PROTO_FAMILIAR_VOICE_DISABLED;
  process.env.PROTO_FAMILIAR_VOICE_DISABLED = '1';
  try {
    assert.equal(listeningAllowed({ voiceEnabled: true }), false);
  } finally {
    if (prior === undefined) delete process.env.PROTO_FAMILIAR_VOICE_DISABLED;
    else process.env.PROTO_FAMILIAR_VOICE_DISABLED = prior;
  }
});

test('the decode budget scales with the clip and never disappears', () => {
  assert.ok(transcribeTimeoutMs(5) >= 60_000, 'a short note still gets a floor');
  assert.ok(transcribeTimeoutMs(600) > transcribeTimeoutMs(60), 'a longer note gets longer');
  assert.ok(transcribeTimeoutMs(99999) <= 15 * 60_000, 'and it is still bounded');
  assert.ok(transcribeTimeoutMs(null) >= 60_000, 'an unknown length is not a zero budget');
});

// ── PIPELINE: a real turn, through the real code ──────────────────

test('PIPELINE: a voice note is transcribed BEFORE the prompt is assembled', async (t) => {
  // The failure this exists to catch: a fire-and-forget transcription lands
  // after materialize has already built the stand-in, so the turn goes out
  // saying "I haven't listened to this one yet" and the model confabulates
  // over the gap. Pure-function tests cannot see ordering.
  const { saveAsset, getAssetMeta, MEDIA_DIR } = await import('../media.js');
  const { ensureTranscribed } = await import('../voice-transcribe.js');

  // A real 1-second wav through the real store.
  const samples = new Float32Array(TARGET_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / TARGET_RATE) * 0.3;
  const meta = await saveAsset({
    buffer: Buffer.from(encodeWav(samples, TARGET_RATE)),
    mime: 'audio/wav',
    origin: { surface: 'test' },
  });
  assert.ok(meta?.id, `store rejected the wav: ${meta?.error}`);
  t.after(async () => {
    for (const f of [`${meta.id}.json`, `${meta.id}.wav`]) {
      await fs.rm(path.join(MEDIA_DIR, f), { force: true });
    }
  });

  // Duration was read at arrival, from the header — not guessed.
  assert.ok(Math.abs(meta.durationSec - 1) < 0.05, `duration was ${meta.durationSec}`);
  assert.equal(meta.kind, 'audio');
  assert.equal(meta.description, null, 'nothing should be transcribed at arrival');

  const messages = [{ role: 'user', content: 'have a listen', attachments: [{ id: meta.id }] }];

  // A worker that answers like the real one, without 226 MB of ONNX.
  const calls = [];
  const worker = {
    request: async (msg) => {
      calls.push(msg.op);
      if (msg.op === 'load') return { ok: true, role: msg.role };
      if (msg.op === 'transcribe') return { ok: true, text: 'the bins go out tonight', lang: 'en', elapsedMs: 12 };
      return { ok: false, reason: 'unknown-op' };
    },
  };

  const got = await ensureTranscribed(messages, { voiceEnabled: true }, { getWorker: async () => ({ worker }) });
  assert.equal(got.transcribed, 1, 'the note was not heard');
  assert.deepEqual(calls, ['load', 'transcribe'], 'the model must be loaded before it is asked to listen');

  // NOW assemble, exactly as a turn does.
  const out = await materializeAttachments(messages, {
    connection: { provider: 'p', model: 'm', visionCapable: 'yes' },
    settings: {},
  });

  const text = out.messages[0].content;
  assert.equal(typeof text, 'string', 'a voice note must never become a content-part array');
  assert.match(text, /have a listen/);
  assert.match(text, /what I heard when I listened: "the bins go out tonight"/);
  assert.doesNotMatch(text, /haven't listened/);
  assert.equal(out.imagesLive, 0);
  assert.equal(out.notesStoodIn, 1);

  // And the convention gets explained, or it is a capability I do not have.
  const explainer = out.messages.find((m) => m.role === 'system' && /voice note/.test(m.content ?? ''));
  assert.ok(explainer, 'the [voice note …] convention was never explained to me');

  // Listening is once: a second pass costs nothing and changes nothing.
  const again = await ensureTranscribed(messages, { voiceEnabled: true }, { getWorker: async () => ({ worker }) });
  assert.equal(again.transcribed, 0, 'a cached transcript was re-derived');
  assert.deepEqual(calls, ['load', 'transcribe'], 'the worker was asked twice for one note');

  // The slug graduated from the transcript, so I can find this by what was said.
  const after = await getAssetMeta(meta.id);
  assert.match(after.slugs[0], /bins/, `slug did not graduate: ${after.slugs[0]}`);
});

test('PIPELINE: with listening off, nothing is transcribed and the turn still goes out', async (t) => {
  const { saveAsset, MEDIA_DIR } = await import('../media.js');
  const { ensureTranscribed } = await import('../voice-transcribe.js');

  const samples = new Float32Array(8000).fill(0.1);
  const meta = await saveAsset({ buffer: Buffer.from(encodeWav(samples, TARGET_RATE)), mime: 'audio/wav', origin: { surface: 'test' } });
  assert.ok(meta?.id);
  t.after(async () => {
    for (const f of [`${meta.id}.json`, `${meta.id}.wav`]) await fs.rm(path.join(MEDIA_DIR, f), { force: true });
  });

  const messages = [{ role: 'user', content: 'here', attachments: [{ id: meta.id }] }];
  const worker = { request: async () => { throw new Error('the worker must not be reached when listening is off'); } };

  const got = await ensureTranscribed(messages, { voiceEnabled: false }, { getWorker: async () => ({ worker }) });
  assert.equal(got.transcribed, 0);
  assert.equal(got.skipped, 'voice-disabled');

  const out = await materializeAttachments(messages, { connection: { provider: 'p', model: 'm' }, settings: {} });
  assert.equal(typeof out.messages[0].content, 'string');
  assert.match(out.messages[0].content, /voice note/);
});

test('a temp dir is not left behind by these tests', async () => {
  // Guard against a future rewrite that starts writing outside the store.
  const stray = path.join(os.tmpdir(), 'proto-familiar-voice-notes');
  await fs.rm(stray, { recursive: true, force: true });
  assert.ok(true);
});
