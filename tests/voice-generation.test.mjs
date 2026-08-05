import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generationExtras, DEFAULT_TTS_SEED, DEFAULT_TTS_TEMPERATURE,
  DEFAULT_NUM_STEPS, MAX_REFERENCE_SECONDS,
  MAX_CHAR_IN_SENTENCE, MIN_CHAR_IN_SENTENCE, runawaySampleLimit, DEFAULT_MAX_FRAMES, FRAME_RATE_HZ,
  pendingTailStart, wholeUtteranceMin, MAX_UTTERANCE_CHARS,
} from '../voice-generation.js';

/**
 * These exist because the bug they prevent shipped twice.
 *
 * PocketTTS re-seeds its sampler per SENTENCE, inside one generate call. With
 * upstream's -1 default that is a fresh random seed each time, so a
 * three-sentence reply came out as three voices at three energies — muffled,
 * then clear, then something else. Restructuring above the engine could not
 * fix it; only the seed can.
 */

test('a seed is always present — its absence is the whole bug', () => {
  const extra = generationExtras();
  assert.equal(typeof extra.seed, 'number');
  assert.ok(extra.seed >= 0, 'a negative seed is upstream for "randomise"');
  assert.equal(extra.seed, DEFAULT_TTS_SEED);
});

test('-1 is refused rather than passed through', () => {
  // -1 is upstream's "surprise me". Forwarding it would reintroduce exactly
  // the behaviour this module exists to stop, and it would do so silently.
  assert.equal(generationExtras({ seed: -1 }).seed, DEFAULT_TTS_SEED);
  assert.equal(generationExtras({ seed: -999 }).seed, DEFAULT_TTS_SEED);
});

test('a chosen seed is honoured, including zero', () => {
  assert.equal(generationExtras({ seed: 7 }).seed, 7);
  assert.equal(generationExtras({ seed: 0 }).seed, 0, '0 is a real seed, not "unset"');
});

test('junk falls back to the default instead of reaching the engine', () => {
  for (const bad of [undefined, null, '', 'abc', NaN, {}, []]) {
    assert.equal(generationExtras({ seed: bad }).seed, DEFAULT_TTS_SEED, `seed ${String(bad)}`);
    assert.equal(generationExtras({ temperature: bad }).temperature, DEFAULT_TTS_TEMPERATURE, `temp ${String(bad)}`);
  }
});

test('the same inputs always build the same extras — determinism starts here', () => {
  assert.deepEqual(generationExtras(), generationExtras());
  assert.deepEqual(generationExtras({ seed: 5, temperature: 0.4 }), generationExtras({ seed: 5, temperature: 0.4 }));
});

test('temperature is carried, so it can be tuned by ear', () => {
  assert.equal(generationExtras().temperature, DEFAULT_TTS_TEMPERATURE);
  assert.equal(generationExtras({ temperature: 0.3 }).temperature, 0.3);
});

test('the reference length rides along on every generation', () => {
  // Every generation must see the same reference window; a clone built from a
  // different slice of the clip is a different voice.
  assert.equal(generationExtras().max_reference_audio_len, MAX_REFERENCE_SECONDS);
  assert.equal(generationExtras({ seed: 3 }).max_reference_audio_len, MAX_REFERENCE_SECONDS);
});

test('the defaults are the values measured on real hardware', () => {
  assert.equal(DEFAULT_NUM_STEPS, 4, 'RTF 0.616 on the reference laptop');
  assert.equal(DEFAULT_TTS_TEMPERATURE, 0.7, "upstream's own default");
  assert.equal(MAX_REFERENCE_SECONDS, 12, 'most of a 12.8 s clip');
});

// ── The runt fragment, and the noise it caused ──────────────────────────

test('the sentence threshold is well clear of 200, where the runt was born', () => {
  // A 205-character sentence split at 200 left 'real.' as its own utterance.
  // The LM hit EOS at step 0, upstream's `if (eos_step > 0 …)` never fired,
  // and the loop ran its whole 500-frame budget as noise.
  // Assert the INVARIANT, not the number — the threshold moved to 2000 when
  // merging came in, and a test pinned to 360 would just have to be edited
  // again rather than telling anyone anything.
  assert.ok(MAX_CHAR_IN_SENTENCE > 205, 'the reported sentence must pass through whole');
});

test('both sentence bounds ride on every generation', () => {
  const extra = generationExtras();
  assert.equal(extra.max_char_in_sentence, MAX_CHAR_IN_SENTENCE);
  assert.equal(extra.min_char_in_sentence, MIN_CHAR_IN_SENTENCE);
});

test('a runaway is capped in seconds, not tens of seconds', () => {
  const forTheRunt = runawaySampleLimit('real.', 24000) / 24000;
  assert.ok(forTheRunt <= 4, `the fragment that caused this must not run long: ${forTheRunt}s`);
  assert.ok(forTheRunt >= 2, 'but not so tight that a short real line is cut');
});

test('the cap scales with the text, so a long sentence is not truncated', () => {
  const short = runawaySampleLimit('Hey.', 24000);
  const long = runawaySampleLimit('x'.repeat(300), 24000);
  assert.ok(long > short * 3, 'more words must buy more room');
  assert.ok(long / 24000 > 300 / 14, 'and comfortably more than the text could take to say');
});

test('the cap never returns zero or NaN, whatever it is handed', () => {
  // It gates audio reaching a person. A NaN ceiling would compare false and
  // silently disable the guard.
  for (const bad of ['', null, undefined, 0, {}, []]) {
    const v = runawaySampleLimit(bad, 24000);
    assert.ok(Number.isFinite(v) && v > 0, `runawaySampleLimit(${String(bad)}) = ${v}`);
  }
});

// ── The un-streamed tail: the last sentence must not be dropped ─────────

test('a callback that under-delivers leaves a tail to send from where it stopped', () => {
  // The reported bug: the message stopped a sentence early because the engine
  // handed its final chunk back in the clip, not through onProgress. The clip
  // is longer than what streamed, and the remainder starts where streaming did.
  assert.equal(pendingTailStart(48000, 72000), 48000);
});

test('nothing is re-sent when the callback already delivered the whole clip', () => {
  // The ordinary case: streamed === total, so there is no tail and the listener
  // is never handed audio they already heard.
  assert.equal(pendingTailStart(72000, 72000), -1);
  assert.equal(pendingTailStart(72001, 72000), -1);
});

test('a runaway stop is never reconciled — the tail there is the noise we cut', () => {
  // Past the streamed count on a runaway is exactly the degenerating audio the
  // cap stopped on purpose. Re-appending it would defeat the guard.
  assert.equal(pendingTailStart(48000, 200000, { runaway: true }), -1);
});

test('junk counts never invent a tail', () => {
  for (const [s, t] of [[NaN, 100], [100, NaN], [undefined, 100], [100, undefined]]) {
    assert.equal(pendingTailStart(s, t), -1, `pendingTailStart(${s}, ${t})`);
  }
});

// ── One message, one trajectory, one voice ──────────────────────────────

test('the merge threshold covers the whole text, so a message is one utterance', () => {
  // The reported bug: "it swaps through different voices at different points of
  // the message" — sherpa resets the LM per utterance, so every extra utterance
  // is another voice. A fixed 400 left a long message as several.
  const long = 'x'.repeat(1200);
  assert.equal(wholeUtteranceMin(long), 1200, 'the threshold reaches the end of the text');
  assert.ok(wholeUtteranceMin(long) > MIN_CHAR_IN_SENTENCE, 'and past the old fixed floor');
});

test('a short line never drops below the old floor', () => {
  assert.equal(wholeUtteranceMin('Hey.'), MIN_CHAR_IN_SENTENCE);
  assert.equal(wholeUtteranceMin(''), MIN_CHAR_IN_SENTENCE);
});

test('the threshold is capped by what one trajectory can actually hold', () => {
  // Past the frame budget a single utterance stops fitting at all, so the cap
  // is the ceiling rather than the text length.
  assert.equal(wholeUtteranceMin('y'.repeat(99999)), MAX_UTTERANCE_CHARS);
});

test('junk input never produces a threshold that would disable merging', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(wholeUtteranceMin(bad), MIN_CHAR_IN_SENTENCE, `wholeUtteranceMin(${String(bad)})`);
  }
});

test('raising the floor can never leave max below it (the runt-split guard)', () => {
  // generationExtras clamps max to min+200; without that, a min above
  // max_char_in_sentence would re-open the runt-fragment split.
  const min = wholeUtteranceMin('z'.repeat(3000));
  const extras = generationExtras({ minChars: min });
  assert.equal(extras.min_char_in_sentence, min);
  assert.ok(extras.max_char_in_sentence >= min + 200, 'max stays clear of min');
});

// ── Chunking: fewer LM resets, fewer places to drift ────────────────────

test('the frame budget leaves room for a merged utterance', () => {
  // Upstream's 500 is ~40 s at Mimi's 12.5 Hz — enough for one sentence, not
  // for a whole message once sentences merge into one trajectory.
  assert.ok(DEFAULT_MAX_FRAMES > 500);
  assert.equal(generationExtras().max_frames, DEFAULT_MAX_FRAMES);
  assert.equal(generationExtras({ maxFrames: 1800 }).max_frames, 1800);
});

test('the merge target is carried, and overridable', () => {
  assert.equal(generationExtras().min_char_in_sentence, MIN_CHAR_IN_SENTENCE);
  assert.equal(generationExtras({ minChars: 30 }).min_char_in_sentence, 30);
});

test('max is always forced clear of min, so a merged utterance is not re-split', () => {
  // Re-splitting a merged chunk gains nothing and risks the runt fragment.
  for (const [minChars, maxChars] of [[400, 100], [400, 400], [500, 550], [30, 360]]) {
    const e = generationExtras({ minChars, maxChars });
    assert.ok(
      e.max_char_in_sentence >= e.min_char_in_sentence + 200,
      `min=${e.min_char_in_sentence} max=${e.max_char_in_sentence} leaves no room to overshoot`,
    );
  }
});

test('the reference window is overridable, since upstream defaults to 10 not 12', () => {
  assert.equal(generationExtras({ referenceSeconds: 10 }).max_reference_audio_len, 10);
  assert.equal(generationExtras().max_reference_audio_len, MAX_REFERENCE_SECONDS);
});

// ── The guard must be able to fire at every length ─────────────────────

test('the runaway cap always lands below what the frame budget alone permits', () => {
  // Otherwise it is decorative for exactly the longest utterances — the ones
  // where a runaway costs the most listening. Raising max_frames to 4000 for
  // long messages put the cap at 429 s against a 320 s ceiling until this.
  const ceiling = DEFAULT_MAX_FRAMES / FRAME_RATE_HZ;
  for (const chars of [5, 400, 2000, 6000, 50000]) {
    for (const speed of [1, 0.5, 0.25, 2]) {
      const seconds = runawaySampleLimit('x'.repeat(chars), 24000, { speed }) / 24000;
      assert.ok(seconds < ceiling, `${chars} chars at speed ${speed}: cap ${seconds}s never fires under ${ceiling}s`);
      assert.ok(seconds >= 3, 'and never cuts below the floor');
    }
  }
});

test('slower speech buys proportionally more room', () => {
  // A ward who slows playback for comprehension must not have sentences cut in
  // half by a guard that exists to protect them.
  const normal = runawaySampleLimit('x'.repeat(400), 24000, { speed: 1 });
  const slow = runawaySampleLimit('x'.repeat(400), 24000, { speed: 0.5 });
  assert.ok(slow > normal * 1.5, 'half speed should roughly double the allowance');
});

test('merging is now ON by default — an ordinary message is one trajectory', () => {
  assert.ok(MIN_CHAR_IN_SENTENCE >= 400, 'upstream 30 merged nothing and produced the drift');
  assert.ok(MAX_CHAR_IN_SENTENCE >= MIN_CHAR_IN_SENTENCE + 200, 'a merged utterance must not be re-split');
  assert.ok(
    MAX_CHAR_IN_SENTENCE / 18.6 < DEFAULT_MAX_FRAMES / FRAME_RATE_HZ,
    'the longest permitted utterance must fit inside the frame budget',
  );
});
