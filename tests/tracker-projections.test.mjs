import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEatFirstBlock, MAX_EAT_FIRST } from '../src/tracker/tracker-projections.js';

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
