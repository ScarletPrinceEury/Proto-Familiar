import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTrackerProjectionTick } from '../src/schedule/tracker-projection-loop.js';

// The reconcile itself (mint/dedup/resolve) is covered Python-side in
// unruh/tests/test_tracker_projection.py. Here we pin the loop's gates:
// disabled, threat stand-down, the ran path, and graceful degradation.

test('runTrackerProjectionTick: disabled is a no-op', async () => {
  let called = 0;
  const r = await runTrackerProjectionTick({
    enabled: false,
    project: async () => { called++; return { ok: true, minted: 1 }; },
  });
  assert.equal(r.reason, 'disabled');
  assert.equal(called, 0, 'no reconcile runs while disabled');
});

test('runTrackerProjectionTick: stands down at moderate+ threat (never fires a banner into a crisis)', async () => {
  let called = 0;
  const r = await runTrackerProjectionTick({
    enabled: true,
    threat: async () => ({ tier: 'moderate', weight: 3 }),
    project: async () => { called++; return { ok: true, minted: 1 }; },
  });
  assert.equal(r.reason, 'stood-down');
  assert.equal(r.tier, 'moderate');
  assert.equal(called, 0, 'no projection nodes are minted while standing down');
});

test('runTrackerProjectionTick: when calm + enabled, runs the reconcile and reports counts', async () => {
  const r = await runTrackerProjectionTick({
    enabled: true,
    threat: async () => ({ tier: 'calm', weight: 0 }),
    project: async () => ({ ok: true, minted: 2, updated: 1, resolved: 3 }),
  });
  assert.equal(r.reason, 'ran');
  assert.equal(r.minted, 2);
  assert.equal(r.updated, 1);
  assert.equal(r.resolved, 3);
});

test('runTrackerProjectionTick: a down Unruh degrades to a skipped tick, never throws', async () => {
  const thrown = await runTrackerProjectionTick({
    enabled: true,
    threat: async () => ({ tier: 'calm' }),
    project: async () => { throw new Error('unruh not connected'); },
  });
  assert.equal(thrown.reason, 'unruh-unavailable');

  const softFail = await runTrackerProjectionTick({
    enabled: true,
    threat: async () => ({ tier: 'calm' }),
    project: async () => ({ ok: false, error: 'unruh not connected' }),
  });
  assert.equal(softFail.reason, 'unruh-unavailable');
});
