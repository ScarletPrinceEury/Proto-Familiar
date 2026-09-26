// voice-call-sfx.js — the whimsy "rummaging" filler (voice Pass 2). Pure-module
// coverage; the engine orchestration is covered in call-engine.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRustlePcm, parseWavToMonoPcm, resolveThinkingSound, loadThinkingPcm,
  makeThinkingSoundStream, createThinkingSoundMaker, DEFAULT_SFX_SAMPLE_RATE,
} from '../src/voice/voice-call-sfx.js';

// Build a minimal 16-bit PCM WAV for the parser tests.
function makeWav({ sampleRate = 16000, channels = 1, samples }) {
  const frames = samples.length / channels;
  const dataLen = samples.length * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

// ── generateRustlePcm ─────────────────────────────────────────────────────────
test('generateRustlePcm: right length, non-silent, quiet & bounded', () => {
  const pcm = generateRustlePcm({ sampleRate: 24000, ms: 500, seed: 7 });
  assert.equal(pcm.length, 24000 * 0.5 * 2, 'sampleRate*ms/1000 samples, 2 bytes each');
  let peak = 0, nonzero = 0;
  for (let i = 0; i < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v) nonzero++; peak = Math.max(peak, v); }
  assert.ok(nonzero > 0, 'not silent');
  assert.ok(peak <= 32767, 'within int16 range');
  assert.ok(peak < 0.35 * 32767, 'quiet by design (well under full scale)');
});

test('generateRustlePcm: deterministic for a seed', () => {
  assert.deepEqual(generateRustlePcm({ ms: 100, seed: 3 }), generateRustlePcm({ ms: 100, seed: 3 }));
});

// ── parseWavToMonoPcm ─────────────────────────────────────────────────────────
test('parseWavToMonoPcm: mono 16-bit → pcm + rate', () => {
  const wav = makeWav({ sampleRate: 16000, channels: 1, samples: [0, 100, -100, 32767] });
  const r = parseWavToMonoPcm(wav);
  assert.equal(r.sampleRate, 16000);
  assert.equal(r.pcm.length, 8);
  assert.equal(r.pcm.readInt16LE(6), 32767);
});

test('parseWavToMonoPcm: stereo → downmixed to mono (frames halve, channels averaged)', () => {
  const wav = makeWav({ sampleRate: 8000, channels: 2, samples: [100, 200, -50, -150] }); // 2 frames
  const r = parseWavToMonoPcm(wav);
  assert.equal(r.sampleRate, 8000);
  assert.equal(r.pcm.length, 4, 'two mono frames');
  assert.equal(r.pcm.readInt16LE(0), 150);   // (100+200)/2
  assert.equal(r.pcm.readInt16LE(2), -100);  // (-50+-150)/2
});

test('parseWavToMonoPcm: garbage / truncated → null (soft miss)', () => {
  assert.equal(parseWavToMonoPcm(Buffer.from('not a wav at all')), null);
  assert.equal(parseWavToMonoPcm(Buffer.alloc(10)), null);
});

// ── resolveThinkingSound ──────────────────────────────────────────────────────
test('resolveThinkingSound: default OFF; on → generated; +path → file; env forces off', () => {
  assert.equal(resolveThinkingSound({}).enabled, false, 'opt-in whimsy, default off');
  assert.deepEqual(resolveThinkingSound({ voiceCallSoundEffects: true }), { enabled: true, source: 'generated', filePath: null });
  assert.deepEqual(resolveThinkingSound({ voiceCallSoundEffects: true, voiceCallSoundEffectPath: '/x.wav' }),
    { enabled: true, source: 'file', filePath: '/x.wav' });
  process.env.PROTO_FAMILIAR_VOICE_CALL_SFX_DISABLED = '1';
  try { assert.equal(resolveThinkingSound({ voiceCallSoundEffects: true }).enabled, false); }
  finally { delete process.env.PROTO_FAMILIAR_VOICE_CALL_SFX_DISABLED; }
});

// ── loadThinkingPcm ───────────────────────────────────────────────────────────
test('loadThinkingPcm: file parses → used; unreadable/bad file → generated fallback', () => {
  const wav = makeWav({ sampleRate: 22050, channels: 1, samples: [1, 2, 3, 4] });
  const good = loadThinkingPcm({ source: 'file', filePath: '/ok.wav' }, { readFileSync: () => wav });
  assert.equal(good.sampleRate, 22050);
  assert.equal(good.pcm.length, 8);

  const thrown = loadThinkingPcm({ source: 'file', filePath: '/missing.wav' }, { readFileSync: () => { throw new Error('ENOENT'); } });
  assert.equal(thrown.sampleRate, DEFAULT_SFX_SAMPLE_RATE, 'unreadable → generated fallback, never throws');
  assert.ok(thrown.pcm.length > 0);

  const garbage = loadThinkingPcm({ source: 'file', filePath: '/junk' }, { readFileSync: () => Buffer.from('nope') });
  assert.equal(garbage.sampleRate, DEFAULT_SFX_SAMPLE_RATE, 'unparseable → generated fallback');
});

// ── makeThinkingSoundStream ───────────────────────────────────────────────────
test('makeThinkingSoundStream: carries sampleRate; stops promptly when shouldStop flips', async () => {
  const pcm = generateRustlePcm({ ms: 100 });
  let ticks = 0;
  const stream = makeThinkingSoundStream({ pcm, sampleRate: 24000, chunkMs: 10, sleep: () => Promise.resolve(), shouldStop: () => (++ticks > 3) });
  assert.equal(stream.sampleRate, 24000);
  let chunks = 0;
  for await (const c of stream) { assert.ok(c.length > 0); if (++chunks > 50) break; }
  assert.ok(chunks <= 4, `stopped promptly after shouldStop, got ${chunks} chunks`);
});

test('makeThinkingSoundStream: hard ceiling ends the loop even if shouldStop never fires', async () => {
  const pcm = generateRustlePcm({ ms: 40 });
  let t = 0;
  // now() jumps past MAX_STREAM_MS after the first check → loop must exit.
  const stream = makeThinkingSoundStream({ pcm, sampleRate: 24000, chunkMs: 10, sleep: () => Promise.resolve(), now: () => (t += 30000), shouldStop: () => false });
  let chunks = 0;
  for await (const _c of stream) { if (++chunks > 1000) break; }
  assert.ok(chunks < 1000, 'ceiling terminated the loop');
});

// ── createThinkingSoundMaker ──────────────────────────────────────────────────
test('createThinkingSoundMaker: off → null; on → a playable stream', () => {
  assert.equal(createThinkingSoundMaker({ readSettings: () => ({}) })({ shouldStop: () => false }), null);
  const s = createThinkingSoundMaker({ readSettings: () => ({ voiceCallSoundEffects: true }) })({ shouldStop: () => true });
  assert.ok(s && typeof s[Symbol.asyncIterator] === 'function' && s.sampleRate === DEFAULT_SFX_SAMPLE_RATE);
});
