import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneTick } from '../pondering-loop.js';

// Sequence-aware stubs: return queued results in order, fail loudly
// on unexpected extra calls.
function once(values) {
  const queue = [...values];
  return async () => {
    if (!queue.length) throw new Error('called more times than expected');
    return queue.shift();
  };
}

test('runOneTick: empty interests → no_interests, no ponder', async () => {
  let pondered = false;
  const r = await runOneTick({
    getInterests: async () => [],
    runPonder:    async () => { pondered = true; return null; },
    now:          () => 1000,
  });
  assert.deepEqual(r.acted,  false);
  assert.equal(r.reason,     'no_interests');
  assert.equal(pondered,     false);
});

test('runOneTick: undefined / non-array from getInterests → no_interests', async () => {
  const r = await runOneTick({
    getInterests: async () => undefined,
    runPonder:    async () => 'should not run',
    now:          () => 1000,
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'no_interests');
});

test('runOneTick: cooldown not elapsed → too_soon with timing details', async () => {
  let pondered = false;
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'x', weight: 5 }],
    runPonder:       async () => { pondered = true; return null; },
    computeInterval: () => 60_000,
    now:             () => 1000,
    lastPonderAt:    500,            // 500ms ago — much less than 60_000
  });
  assert.equal(r.acted,      false);
  assert.equal(r.reason,     'too_soon');
  assert.equal(r.sinceMs,    500);
  assert.equal(r.requiredMs, 60_000);
  assert.equal(r.topWeight,  5);
  assert.equal(pondered,     false);
});

test('runOneTick: cooldown elapsed → picks an interest and ponders', async () => {
  const calls = [];
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'thinking about it', weight: 6, id: 'abc' }],
    runPonder:       async (topic, picked) => { calls.push({ topic, picked }); return { uid: 'pondered-uid' }; },
    computeInterval: () => 60_000,
    now:             () => 70_000,
    lastPonderAt:    1000,           // 69_000ms ago > 60_000ms required
  });
  assert.equal(r.acted,            true);
  assert.equal(r.picked.label,     'thinking about it');
  assert.equal(r.result.uid,       'pondered-uid');
  assert.equal(r.topWeight,        6);
  assert.equal(calls.length,       1);
  assert.equal(calls[0].topic,     'thinking about it');
  assert.equal(calls[0].picked.id, 'abc');
});

test('runOneTick: first ever tick (lastPonderAt=0, realistic clock) — allowed', async () => {
  // In production now() = Date.now() (trillions of ms). With sentinel
  // lastPonderAt=0, since is enormous and any sane required interval
  // is satisfied → first tick always fires.
  let pondered = false;
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'first', weight: 3 }],
    runPonder:       async () => { pondered = true; return null; },
    computeInterval: () => 6 * 60 * 60_000,   // 6h required
    now:             () => Date.now(),
    lastPonderAt:    0,
  });
  assert.equal(r.acted,  true);
  assert.equal(pondered, true);
});

test('runOneTick: empty weights → no_eligible_pick (picker filters them out)', async () => {
  let pondered = false;
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'zero', weight: 0 }, { label: 'neg', weight: -1 }],
    runPonder:       async () => { pondered = true; return null; },
    computeInterval: () => 0,           // not gated by cooldown
    now:             () => 1000,
    lastPonderAt:    0,
  });
  // The cadence formula based on topWeight=0 says Infinity → too_soon.
  // We're overriding computeInterval to 0 here so we land in the
  // picker-rejection branch directly.
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'no_eligible_pick');
  assert.equal(pondered, false);
});

test('runOneTick: weight-zero topWeight with default cadence → too_soon (Infinity required)', async () => {
  const r = await runOneTick({
    getInterests: async () => [{ label: 'zero', weight: 0 }],
    runPonder:    async () => 'unreached',
    now:          () => 1000,
    lastPonderAt: 0,
    // computeInterval not overridden → uses default tiered (returns Infinity for weight 0)
  });
  assert.equal(r.acted,      false);
  assert.equal(r.reason,     'too_soon');
  assert.equal(r.requiredMs, Infinity);
  assert.equal(r.topWeight,  0);
});

test('runOneTick: tiered cadence — high-weight tick fires sooner than low-weight', async () => {
  // High-weight ponder allowed at 60_000ms wait; low-weight needs 4hrs
  // for the same wait. Use real computeRequiredInterval, fake clock.
  const tickHigh = await runOneTick({
    getInterests: async () => [{ label: 'hot', weight: 9 }],
    runPonder:    async () => ({ uid: 'h' }),
    now:          () => 30 * 60_000 + 1,  // 30min + 1ms since last ponder
    lastPonderAt: 0,
  });
  assert.equal(tickHigh.acted, true, 'weight 9 should ponder after 30min');

  const tickLow = await runOneTick({
    getInterests: async () => [{ label: 'cold', weight: 1 }],
    runPonder:    async () => 'unreached',
    now:          () => 30 * 60_000 + 1,  // same wait
    lastPonderAt: 0,
  });
  assert.equal(tickLow.acted,  false, 'weight 1 should NOT ponder yet');
  assert.equal(tickLow.reason, 'too_soon');
});

test('runOneTick: runPonder error propagates (loop wrapper handles it via onError)', async () => {
  await assert.rejects(
    runOneTick({
      getInterests:    async () => [{ label: 'x', weight: 5 }],
      runPonder:       async () => { throw new Error('LLM 503'); },
      computeInterval: () => 0,
      now:             () => 1000,
      lastPonderAt:    0,
    }),
    /LLM 503/,
  );
});

test('runOneTick: getInterests error propagates', async () => {
  await assert.rejects(
    runOneTick({
      getInterests: async () => { throw new Error('unruh down'); },
      runPonder:    async () => null,
      now:          () => 1000,
    }),
    /unruh down/,
  );
});

test('runOneTick: missing getInterests / runPonder raises a clear error', async () => {
  await assert.rejects(runOneTick({ runPonder: async () => null }),  /getInterests is required/);
  await assert.rejects(runOneTick({ getInterests: async () => [] }), /runPonder is required/);
});

// ── Threat-aware cadence (step 4b) ──────────────────────────────

test('runOneTick: getThreat is passed to computeInterval', async () => {
  let observedThreat = null;
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'x', weight: 5 }],
    runPonder:       async () => 'pondered',
    getThreat:       async () => 6,
    computeInterval: (w, threat) => { observedThreat = threat; return 0; },
    now:             () => 1000,
    lastPonderAt:    0,
  });
  assert.equal(observedThreat, 6);
  assert.equal(r.acted,        true);
});

test('runOneTick: result carries threatLevel for observability', async () => {
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'x', weight: 5 }],
    runPonder:       async () => 'pondered',
    getThreat:       async () => 4.5,
    computeInterval: () => 0,
    now:             () => 1000,
    lastPonderAt:    0,
  });
  assert.equal(r.threatLevel, 4.5);
});

test('runOneTick: getThreat default = 0 (backward compat — old callers still work)', async () => {
  const r = await runOneTick({
    getInterests:    async () => [{ label: 'x', weight: 5 }],
    runPonder:       async () => 'pondered',
    computeInterval: (w, t) => { assert.equal(t, 0); return 0; },
    now:             () => 1000,
    lastPonderAt:    0,
  });
  assert.equal(r.acted,       true);
  assert.equal(r.threatLevel, 0);
});

test('runOneTick: high threat shortens cadence — same wait, low threat skips, high threat fires', async () => {
  // Wait of 5 minutes with weight 5:
  //   no threat   → mid tier (60 min) → too_soon
  //   severe (8)  → 60 min × 0.15 = 9 min → too_soon (still)
  //   severe + larger wait → fires
  // Use the real computeRequiredInterval.
  const fiveMin = 5 * 60_000;
  const tenMin  = 10 * 60_000;

  const tickCalm = await runOneTick({
    getInterests: async () => [{ label: 'x', weight: 5 }],
    runPonder:    async () => 'unreached',
    getThreat:    async () => 0,
    now:          () => tenMin,
    lastPonderAt: 0,  // wait = 10min
  });
  assert.equal(tickCalm.acted,  false, 'mid-weight + calm threat: 60 min required, 10 min wait → too_soon');

  const tickSevere = await runOneTick({
    getInterests: async () => [{ label: 'x', weight: 5 }],
    runPonder:    async () => 'pondered',
    getThreat:    async () => 8,
    now:          () => tenMin,
    lastPonderAt: 0,  // wait = 10min
  });
  assert.equal(tickSevere.acted, true, 'mid-weight + severe threat: 9 min required, 10 min wait → fires');
});
