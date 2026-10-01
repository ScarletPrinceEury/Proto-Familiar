import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForMatch } from '../src/util/text-normalize.js';
import { scoreMessage } from '../src/safety/crisis-signals.js';
import { scoreThreatMessage } from '../src/safety/crisis-classifier.js';

// §1 — the regex floor must not miss common spellings. These synthetic phrases
// stand in for the real-world variants the ward actually types (curly apostrophe,
// "wanna"); no private content appears here.

// The same severe statement, four ways it gets typed.
const SEVERE_VARIANTS = [
  "I don't want to be here anymore",     // straight apostrophe
  "i dont want to be here anymore",      // no apostrophe
  "i don’t want to be here anymore", // curly apostrophe (was 0 before §1)
  "I don't wanna be here anymore",       // slang (was 0 before §1)
];

// ── the normaliser itself ───────────────────────────────────────────────────

test('normalizeForMatch: curly/prime apostrophes become straight', () => {
  assert.equal(normalizeForMatch('don’t'), "don't");
  assert.equal(normalizeForMatch('canʼt'), "can't");
});

test('normalizeForMatch: slang contractions expand to the literal form', () => {
  assert.equal(normalizeForMatch('wanna'), 'want to');
  assert.equal(normalizeForMatch('gonna'), 'going to');
  assert.equal(normalizeForMatch('gotta'), 'got to');
});

test('normalizeForMatch: un-apostrophed contractions regain the apostrophe', () => {
  assert.equal(normalizeForMatch('dont'), "don't");
  assert.equal(normalizeForMatch('im here'), "i'm here");
  assert.equal(normalizeForMatch('ive doesnt isnt'), "i've doesn't isn't");
});

test('normalizeForMatch: whole-word only — never touches substrings', () => {
  // "him"/"limb" contain "im" but are not the word "im"; "important" contains it too.
  assert.equal(normalizeForMatch('him limb important'), 'him limb important');
  assert.equal(normalizeForMatch('wannabe'), 'wannabe'); // not the word "wanna"
});

test('normalizeForMatch: collapses whitespace runs', () => {
  assert.equal(normalizeForMatch('  I   dont   know  '), "I don't know");
});

test('normalizeForMatch: does not mutate its input', () => {
  const original = 'I dont wanna';
  normalizeForMatch(original);
  assert.equal(original, 'I dont wanna');  // strings are immutable, but pin the contract
});

// ── the floor: all four variants reach the same tier ─────────────────────────

test('§1: all four spellings of the severe phrase score the SAME severe tier', () => {
  const results = SEVERE_VARIANTS.map(scoreMessage);
  for (const [i, r] of results.entries()) {
    assert.ok(r.signals.some(s => s.tier === 'severe'),
      `variant ${i} ("${SEVERE_VARIANTS[i]}") should fire a severe-tier signal`);
  }
  // They all normalise to the same statement, so the level is identical across all four.
  const levels = results.map(r => r.level);
  assert.ok(levels.every(l => l === levels[0]),
    `all four variants should score the same level, got ${JSON.stringify(levels)}`);
});

test('§1: benign control with "die" as a word stays 0', () => {
  const r = scoreMessage('Die Hard is my favourite film');
  assert.equal(r.level, 0);
  assert.equal(r.signals.length, 0);
});

// ── pipeline: through the real seam, with and without the ML artifact ─────────

test('§1 pipeline: scoreThreatMessage reaches severe for every variant (floor-only)', () => {
  // artifact:null forces the regex-floor path (the degraded case). Every variant
  // must still land severe purely on the normalised floor.
  const levels = SEVERE_VARIANTS.map(v => scoreThreatMessage(v, { artifact: null }));
  for (const [i, out] of levels.entries()) {
    assert.ok(out.signals.some(s => s.tier === 'severe'),
      `floor-only: variant ${i} should carry a severe signal`);
    assert.ok(out.level > 0, `floor-only: variant ${i} level should be > 0`);
  }
  // Same normalised statement → identical floor level across all four.
  assert.ok(levels.every(o => o.level === levels[0].level),
    `floor-only levels should match: ${JSON.stringify(levels.map(o => o.level))}`);
});

test('§1 pipeline: with the real artifact, the combined score never drops below the floor', () => {
  // The ML head is raise-only for severe, so combined >= floor for each variant.
  for (const v of SEVERE_VARIANTS) {
    const floor = scoreThreatMessage(v, { artifact: null }).level;
    const combined = scoreThreatMessage(v).level;  // undefined artifact → loadArtifact()
    assert.ok(combined >= floor,
      `combined (${combined}) should be >= floor (${floor}) for "${v}"`);
  }
});
