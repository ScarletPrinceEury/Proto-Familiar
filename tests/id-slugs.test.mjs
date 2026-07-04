import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortPonderUid } from '../pondering.js';

test('shortPonderUid: compact slug shape, no lookalike chars', () => {
  for (let i = 0; i < 200; i++) {
    const uid = shortPonderUid();
    assert.match(uid, /^ponder-[a-hj-km-np-z2-9]{6}$/);
    assert.ok(uid.length <= 14);
  }
});

test('shortPonderUid: effectively unique across a large draw', () => {
  const seen = new Set(Array.from({ length: 5000 }, () => shortPonderUid()));
  assert.ok(seen.size > 4995);  // collisions this rare; the writer re-rolls anyway
});
