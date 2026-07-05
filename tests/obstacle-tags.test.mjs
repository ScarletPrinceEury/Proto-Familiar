import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeObstacleTags } from '../cerebellum.js';

// ── normalizeObstacleTags ──────────────────────────────────────────

test('normalizeObstacleTags: array input [\'Outside\', \' outside \', \'phone\'] → lowercased, trimmed, deduplicated', () => {
  const result = normalizeObstacleTags(['Outside', ' outside ', 'phone']);
  assert.deepEqual(result, ['outside', 'phone']);
});

test('normalizeObstacleTags: string input "outside, phone-call" → comma-split, trimmed', () => {
  const result = normalizeObstacleTags('outside, phone-call');
  assert.deepEqual(result, ['outside', 'phone-call']);
});

test('normalizeObstacleTags: empty array → empty result', () => {
  const result = normalizeObstacleTags([]);
  assert.deepEqual(result, []);
});

test('normalizeObstacleTags: undefined → empty result', () => {
  const result = normalizeObstacleTags(undefined);
  assert.deepEqual(result, []);
});

test('normalizeObstacleTags: null → empty result', () => {
  const result = normalizeObstacleTags(null);
  assert.deepEqual(result, []);
});

test('normalizeObstacleTags: tag longer than 30 chars → truncated to 30', () => {
  const longTag = 'a'.repeat(35);
  const result = normalizeObstacleTags([longTag]);
  assert.equal(result[0].length, 30);
  assert.equal(result[0], 'a'.repeat(30));
});

test('normalizeObstacleTags: more than 8 tags → capped at 8', () => {
  const input = ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7', 'tag8', 'tag9', 'tag10'];
  const result = normalizeObstacleTags(input);
  assert.equal(result.length, 8);
  assert.deepEqual(result, ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7', 'tag8']);
});

test('normalizeObstacleTags: deduplicates case-insensitively', () => {
  const result = normalizeObstacleTags(['Phone', 'phone', 'PHONE']);
  assert.deepEqual(result, ['phone']);
});

test('normalizeObstacleTags: string with newlines → split and processed', () => {
  const result = normalizeObstacleTags('outside\nphone');
  assert.deepEqual(result, ['outside', 'phone']);
});

test('normalizeObstacleTags: array with whitespace-only entries → filtered out', () => {
  const result = normalizeObstacleTags(['outside', '   ', 'phone']);
  assert.deepEqual(result, ['outside', 'phone']);
});

test('normalizeObstacleTags: mix of long tags and short tags, capped at 8', () => {
  const longTag = 'very-long-obstacle-tag-that-exceeds-30-chars-boundary-line';
  const input = ['outside', longTag, 'phone', 'call', 'meeting', 'travel', 'water', 'food', 'extra1'];
  const result = normalizeObstacleTags(input);
  assert.equal(result.length, 8);
  assert(result[1].length <= 30, 'long tag should be truncated to 30 or less');
});
