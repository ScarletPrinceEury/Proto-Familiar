import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneTriageTick, TRIAGE_SILENCE_THRESHOLD_MS } from '../silence-triage-loop.js';

function makeEnq() {
  const calls = [];
  return {
    fn: async (item) => { calls.push(item); return { id: 'fake', deduped: false }; },
    calls,
  };
}
function dedupingEnq() {
  const calls = [];
  return {
    fn: async (item) => { calls.push(item); return { id: 'fake', deduped: true }; },
    calls,
  };
}

test('runOneTriageTick: calm → no_threat / low_threat skip, no LLM call', async () => {
  let decideCalled = false;
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'calm', weight: 0, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 999_999_999 }),
    decideTriage:    async () => { decideCalled = true; return null; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'low_threat');
  assert.equal(decideCalled, false, 'LLM must not be called for calm threat');
});

test('runOneTriageTick: mild → also skipped (mild distress alone is not actively outreach-worthy)', async () => {
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'mild', weight: 1, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 999_999_999 }),
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'low_threat');
});

test('runOneTriageTick: severe + recent activity → too_recent skip', async () => {
  let decideCalled = false;
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8, disabled: false }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60_000 }),  // 1 min ago
    decideTriage:    async () => { decideCalled = true; return null; },
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'too_recent_activity');
  assert.equal(decideCalled, false);
  assert.equal(r.requiredMs, TRIAGE_SILENCE_THRESHOLD_MS.severe);
});

test('runOneTriageTick: detector disabled → skip with detector_disabled', async () => {
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8, disabled: true }),
    getLastActivity: async () => ({ ts: '...', ms: 0 }),
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'detector_disabled');
});

test('runOneTriageTick: no activity record → skip', async () => {
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 8 }),
    getLastActivity: async () => null,
    decideTriage:    async () => { throw new Error('should not be called'); },
    enqueueOutboxFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'no_activity_record');
});

test('runOneTriageTick: thresholds met, LLM says wait → no outbox enqueue', async () => {
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 2 * 60 * 60_000 }), // 2hr ago > 1hr required
    decideTriage:    async () => ({ action: 'wait' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,    false);
  assert.equal(r.reason,   'llm_said_wait');
  assert.equal(enq.calls.length, 0);
});

test('runOneTriageTick: thresholds met, LLM says reach_out → enqueues triage outbox', async () => {
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'high', weight: 5 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 2 * 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out', message: 'I was thinking about you. No pressure to reply.' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  true);
  assert.equal(r.reason, 'reached_out');
  assert.equal(enq.calls.length, 1);
  assert.equal(enq.calls[0].kind,  'triage');
  assert.equal(enq.calls[0].body,  'I was thinking about you. No pressure to reply.');
  assert.match(enq.calls[0].originId, /^triage-high-\d+$/);
});

test('runOneTriageTick: dedup → returns rate_limited not reached_out', async () => {
  const enq = dedupingEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 3 * 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out', message: 'gentle nudge' }),
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'rate_limited');
});

test('runOneTriageTick: LLM returns reach_out without message → not honored (no enqueue)', async () => {
  const enq = makeEnq();
  const r = await runOneTriageTick({
    getThreat:       async () => ({ tier: 'severe', weight: 9 }),
    getLastActivity: async () => ({ ts: '...', ms: Date.now() - 60 * 60_000 }),
    decideTriage:    async () => ({ action: 'reach_out' }),     // missing message
    enqueueOutboxFn: enq.fn,
  });
  assert.equal(r.acted,  false);
  assert.equal(r.reason, 'llm_said_wait');
  assert.equal(enq.calls.length, 0);
});

test('runOneTriageTick: missing required callbacks raise clear errors', async () => {
  await assert.rejects(runOneTriageTick({ getLastActivity: async () => null, decideTriage: async () => null, enqueueOutboxFn: async () => null }), /getThreat/);
  await assert.rejects(runOneTriageTick({ getThreat: async () => ({ tier: 'calm' }), decideTriage: async () => null, enqueueOutboxFn: async () => null }), /getLastActivity/);
});
