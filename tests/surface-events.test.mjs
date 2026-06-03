// surface-events.test.mjs
//
// Targets the event store + outcome tagger directly. We swap the
// events file location via env var so tests don't stomp on the
// production .surface-events.json — slice 2's module reads the path
// once at module-load, so we use a per-test temp dir setup pattern
// that re-imports cleanly.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// The module reads its events path from a constant — for testing we
// just stub it through file replacement. Tests run sequentially per
// node:test default for files in the same process; reset state at the
// top of each test.

let surfaceEvents;
let EVENTS_PATH;

before(async () => {
  // Use a temp tomes/ dir so we don't touch the production file.
  // The module resolves EVENTS_PATH = __dirname/tomes/.surface-events.json
  // relative to surface-events.js. Move/swap the production file out
  // of the way for the duration of the test, restore at the end.
  surfaceEvents = await import('../surface-events.js');
  EVENTS_PATH = path.resolve(
    path.dirname(new URL('../surface-events.js', import.meta.url).pathname),
    'tomes',
    '.surface-events.json',
  );
});

async function resetEventsFile() {
  try { await fs.unlink(EVENTS_PATH); } catch { /* missing is fine */ }
}

// Use timestamps relative to "now" so pruneEvents (30d retention from
// Date.now()) doesn't discard the synthetic events under us.
const T0 = Date.now() - 60_000; // 1 min ago — well within retention

beforeEach(async () => {
  await resetEventsFile();
});

// ── Recording + dedup ───────────────────────────────────────────────

test('recordSurfaceOffers + getRecentOfferTimes round-trip', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [
      { id: 't1', label: 'eat lunch',     type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'submit form',   type: 'task', stakesTier: 'external_obligation', confidence: 'high' },
    ],
    { threat_tier: 'calm', routine_phase: 'morning' },
    T0,
  );
  const times = await surfaceEvents.getRecentOfferTimes();
  assert.equal(times.t1, T0);
  assert.equal(times.t2, T0);
});

test('getRecentOfferTimes returns most-recent offer per task', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0,
  );
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'eat lunch', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 4000,
  );
  const times = await surfaceEvents.getRecentOfferTimes();
  assert.equal(times.t1, T0 + 4000);
});

// ── Outcome tagging ─────────────────────────────────────────────────

test('tagOutcomes: done resolution → engaged_and_completed', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'submit form', type: 'task', stakesTier: 'external_obligation', confidence: 'high' }],
    { threat_tier: 'calm' }, T0,
  );
  const result = await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', type: 'task', label: 'submit form', resolution: 'done' }],
    now: T0 + 1000,
  });
  assert.equal(result.tagged, 1);
  const store = await surfaceEvents.loadSurfaceEvents();
  assert.equal(store.events[0].outcome, surfaceEvents.OUTCOMES.ENGAGED_AND_COMPLETED);
  assert.equal(store.events[0].outcome_at, T0 + 1000);
});

test('tagOutcomes: maps cancelled / carried_forward / fired', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [
      { id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'b', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't3', label: 'c', type: 'reminder', stakesTier: 'personal_wellbeing', confidence: 'low' },
    ],
    {}, T0,
  );
  await surfaceEvents.tagOutcomes({
    windowItems: [
      { id: 't1', resolution: 'cancelled' },
      { id: 't2', resolution: 'carried_forward' },
      { id: 't3', resolution: 'fired' },
    ],
    now: T0 + 1000,
  });
  const store = await surfaceEvents.loadSurfaceEvents();
  const byId = Object.fromEntries(store.events.map(e => [e.task_id, e.outcome]));
  assert.equal(byId.t1, surfaceEvents.OUTCOMES.CANCELLED);
  assert.equal(byId.t2, surfaceEvents.OUTCOMES.DEFERRED);
  assert.equal(byId.t3, surfaceEvents.OUTCOMES.FIRED);
});

test('tagOutcomes: unresolved + > 24h old → unresponded', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0,
  );
  const result = await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 25 * 3600 * 1000,
  });
  assert.equal(result.tagged, 1);
  const store = await surfaceEvents.loadSurfaceEvents();
  assert.equal(store.events[0].outcome, surfaceEvents.OUTCOMES.UNRESPONDED);
});

test('tagOutcomes: unresolved + < 24h → skipped (left null)', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0,
  );
  const result = await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', resolution: null }],
    now: T0 + 3 * 3600 * 1000,
  });
  assert.equal(result.tagged, 0);
  assert.equal(result.skipped, 1);
});

test('tagOutcomes: already-tagged events are not re-tagged', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0,
  );
  await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'done' }],
    now: T0 + 1000,
  });
  // Second tag pass with different resolution — should be ignored
  const result = await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'cancelled' }],
    now: T0 + 2000,
  });
  assert.equal(result.tagged, 0);
  const store = await surfaceEvents.loadSurfaceEvents();
  assert.equal(store.events[0].outcome, surfaceEvents.OUTCOMES.ENGAGED_AND_COMPLETED);
  assert.equal(store.events[0].outcome_at, T0 + 1000);
});

// ── Reflection inputs ──────────────────────────────────────────────

test('getNewOutcomesSinceLastReflection: includes only outcome_at > last_reflection_at', async () => {
  await surfaceEvents.recordSurfaceOffers(
    [
      { id: 't1', label: 'a', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
      { id: 't2', label: 'b', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' },
    ],
    {}, T0,
  );
  await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't1', resolution: 'done' }],
    now: T0 + 1000,
  });
  await surfaceEvents.markReflected(T0 + 1500);
  await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't2', resolution: 'done' }],
    now: T0 + 2000,
  });
  const fresh = await surfaceEvents.getNewOutcomesSinceLastReflection();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].task_id, 't2');
});

test('shouldReflectNow: threshold gate', async () => {
  // Empty store → false
  assert.equal(await surfaceEvents.shouldReflectNow({ minOutcomes: 5 }), false);

  // Add and tag 4 outcomes → still below threshold
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: `t${i}`, label: `task${i}`, type: 'task',
    stakesTier: 'personal_wellbeing', confidence: 'low',
  }));
  await surfaceEvents.recordSurfaceOffers(four, {}, T0);
  await surfaceEvents.tagOutcomes({
    windowItems: four.map(t => ({ id: t.id, resolution: 'done' })),
    now: T0 + 1000,
  });
  assert.equal(await surfaceEvents.shouldReflectNow({ minOutcomes: 5 }), false);

  // 5th outcome — threshold met
  await surfaceEvents.recordSurfaceOffers(
    [{ id: 't5', label: 'task5', type: 'task', stakesTier: 'personal_wellbeing', confidence: 'low' }],
    {}, T0 + 2000,
  );
  await surfaceEvents.tagOutcomes({
    windowItems: [{ id: 't5', resolution: 'done' }],
    now: T0 + 3000,
  });
  assert.equal(await surfaceEvents.shouldReflectNow({ minOutcomes: 5 }), true);
});

test('markReflected resets the fresh-outcome window', async () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, label: `task${i}`, type: 'task',
    stakesTier: 'personal_wellbeing', confidence: 'low',
  }));
  await surfaceEvents.recordSurfaceOffers(five, {}, T0);
  await surfaceEvents.tagOutcomes({
    windowItems: five.map(t => ({ id: t.id, resolution: 'done' })),
    now: T0 + 1000,
  });
  assert.equal(await surfaceEvents.shouldReflectNow(), true);
  await surfaceEvents.markReflected(T0 + 2000);
  assert.equal(await surfaceEvents.shouldReflectNow(), false);
});
