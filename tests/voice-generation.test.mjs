import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generationExtras, DEFAULT_TTS_SEED, DEFAULT_TTS_TEMPERATURE,
  DEFAULT_NUM_STEPS, MAX_REFERENCE_SECONDS,
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
