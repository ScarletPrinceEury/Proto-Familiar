// Pins the memory_create reply parser (thalamus.parseMemoryCreateResult).
// Regression: memory ids became readable slugs (#195), but the Node parser
// still matched hex-only (`[a-f0-9]+`), truncating `carpal-tunnel-k3` to `ca`.
// The truncated id went into the consent-pending file, so the ward could never
// confirm/drop those memories by id — a silent consent-queue leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryCreateResult } from '../thalamus.js';

test('parses a full slug id (not just its leading hex chars)', () => {
  const r = parseMemoryCreateResult('Memory saved id=carpal-tunnel-k3.');
  assert.equal(r.id, 'carpal-tunnel-k3');
  assert.equal(r.merged, false);
});

test('a slug whose first word is all-hex is not truncated', () => {
  // "adhd-…" starts with a,d (hex chars) then hits a non-hex char — the old
  // regex returned "ad". This is the exact shape from the reported screenshot.
  const r = parseMemoryCreateResult('Memory saved id=adhd-winding-down-p7.');
  assert.equal(r.id, 'adhd-winding-down-p7');
});

test('significant form carries the composite key form of the id', () => {
  const r = parseMemoryCreateResult('Memory saved (significant/2026-07-13_first-date-x9) id=first-date-x9.');
  assert.equal(r.id, 'first-date-x9');
  assert.equal(r.merged, false);
});

test('merged reply is flagged and its id extracted', () => {
  const r = parseMemoryCreateResult('Memory merged into existing id=schlafstern-availability-z5.');
  assert.equal(r.id, 'schlafstern-availability-z5');
  assert.equal(r.merged, true);
});

test('legacy hex ids still parse (ids are opaque; old rows stay valid)', () => {
  const r = parseMemoryCreateResult('Memory saved id=31d5f9cc1a2b4c6d8e0f2a4b6c8d0e1f.');
  assert.equal(r.id, '31d5f9cc1a2b4c6d8e0f2a4b6c8d0e1f');
});

test('no id in the text → null, never a throw', () => {
  assert.deepEqual(parseMemoryCreateResult(''), { id: null, merged: false });
  assert.deepEqual(parseMemoryCreateResult(undefined), { id: null, merged: false });
});
