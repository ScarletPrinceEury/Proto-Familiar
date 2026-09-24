import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEatFirstBlock, buildMensesWindowBlock, MAX_EAT_FIRST, discussingFood } from '../src/tracker/tracker-projections.js';

const item = (name, days_left) => ({ name, days_left });

test('empty / non-array → no block', () => {
  assert.equal(buildEatFirstBlock([]), '');
  assert.equal(buildEatFirstBlock(null), '');
});

test('renders the marker + a soonest-first line with expired/today/Nd wording', () => {
  const block = buildEatFirstBlock([item('spinach', -1), item('yoghurt', 0), item('eggs', 2)]);
  assert.match(block, /^\[Pantry — use first\]/);
  assert.match(block, /spinach \(expired\) · yoghurt \(today\) · eggs \(2d\)/);
});

test(`caps at ${MAX_EAT_FIRST} items and notes the remainder`, () => {
  const many = Array.from({ length: 7 }, (_, i) => item(`item-${i}`, i));
  const block = buildEatFirstBlock(many);
  const shown = block.split('\n')[1];
  assert.equal(shown.split(' · ').length, MAX_EAT_FIRST + 0, 'only MAX_EAT_FIRST names before the +more');
  assert.match(block, new RegExp(`\\(\\+${7 - MAX_EAT_FIRST} more\\)`));
});

test('a single item renders without a remainder note', () => {
  assert.equal(buildEatFirstBlock([item('milk', 1)]), '[Pantry — use first]\nmilk (1d)');
});

// ── food-topic cue ("bring it up when food is discussed") ──────────────────────

test('discussingFood: fires on general food / kitchen vocabulary', () => {
  for (const t of ['what should I eat', 'thinking about dinner', "I'm hungry",
                   'need to do groceries', 'anything in the fridge?', 'a recipe idea',
                   'making lunch', 'leftovers again']) {
    assert.equal(discussingFood(t), true, `should fire on: ${t}`);
  }
});

test('discussingFood: does NOT fire on unrelated talk', () => {
  for (const t of ['how was your day', 'I fixed the bug', 'the weather is grim',
                   'reading a good book', '']) {
    assert.equal(discussingFood(t), false, `should not fire on: ${t}`);
  }
});

test('discussingFood: fires when my human names an expiring item (≥3 chars, word-bounded)', () => {
  assert.equal(discussingFood('should I use the spinach?', ['spinach', 'yoghurt']), true);
  assert.equal(discussingFood('nothing relevant here', ['spinach']), false);
  // a short name never matches inside another word
  assert.equal(discussingFood('the beggar left', ['egg']), false);
});

test('buildEatFirstBlock: foodTopic adds the active bring-it-up cue; default stays passive', () => {
  const items = [item('spinach', 1)];
  const passive = buildEatFirstBlock(items);
  assert.equal(passive, '[Pantry — use first]\nspinach (1d)');
  assert.doesNotMatch(passive, /on the topic of food/);

  const active = buildEatFirstBlock(items, { foodTopic: true });
  assert.match(active, /^\[Pantry — use first\]\nspinach \(1d\)/);
  assert.match(active, /on the topic of food, I should suggest to use up some food/);
  // no suppression hedge (CLAUDE.md ward-directed-intent rule)
  assert.doesNotMatch(active, /if it fits|when it feels|if the moment/i);
});

// ── buildMensesWindowBlock ───────────────────────────────────────────────────

const pred = (over = {}) => ({
  tracker_label: 'cycle', window: { start: '2026-10-03T00:00:00', end: '2026-10-09T00:00:00' }, cycles_seen: 4, ...over,
});

test('menses: empty / no-window → no block', () => {
  assert.equal(buildMensesWindowBlock([]), '');
  assert.equal(buildMensesWindowBlock(null), '');
  assert.equal(buildMensesWindowBlock([{ tracker_label: 'x', window: null }]), '');
});

test('menses: renders a hedged, locale-free date range with the cycle count', () => {
  const block = buildMensesWindowBlock([pred()]);
  assert.match(block, /^\[Likely period window\]/);
  assert.match(block, /cycle: around Oct 3 – Oct 9 \(predicted from 4 cycles\)/);
  // Hedged — never a claim of certainty.
  assert.match(block, /around/);
  assert.doesNotMatch(block, /will start|definitely|certain/i);
});

test('menses: singular cycle wording; cross-month range', () => {
  const block = buildMensesWindowBlock([pred({ cycles_seen: 1, window: { start: '2026-10-30T00:00:00', end: '2026-11-05T00:00:00' } })]);
  assert.match(block, /from 1 cycle\)/);
  assert.match(block, /Oct 30 – Nov 5/);
});

