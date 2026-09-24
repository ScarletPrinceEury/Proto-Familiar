// Gauge safety ladder — G-C.1 (the CHECK). SAFETY-CRITICAL, ward-signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  selectGaugeCheckActions, buildGaugeCheckMessage, runGaugeCheckTick,
} from '../src/schedule/gauge-escalation.js';

const gauge = (id, band, extra = {}) => ({ id, label: id, band, escalation: { enabled: true, checkin_deadline_hours: 6 }, ...extra });

// ── G1 (structural): G-C.1 contains NO crisis code ────────────────────────────
test('G1: the check module calls no threat/contact machinery (G-C.1 is check-only)', () => {
  const src = readFileSync(new URL('../src/schedule/gauge-escalation.js', import.meta.url), 'utf8');
  // No crisis call sites anywhere — the escalation branch is G-C.2.
  for (const call of ['flagDistress(', 'recordThreat(', 'contactDeadlineFor(', 'relayToDiscord(']) {
    assert.ok(!src.includes(call), `G-C.1 must not call ${call}`);
  }
  // No imports from the threat/crisis modules.
  assert.ok(!/from '.*threat-tracker/.test(src) && !/from '.*cerebellum/.test(src), 'no threat/crisis imports');
  // The only side-effect is the outbox (the warm check reach-out).
  assert.match(src, /enqueueOutbox/);
});

// ── selectGaugeCheckActions (pure) ────────────────────────────────────────────
test('opens a check when a gauge is extreme with none open', () => {
  const { actions, nextState } = selectGaugeCheckActions({ candidates: [gauge('water', 'extreme')], checkState: {}, now: 100 });
  assert.deepEqual(actions.map(a => a.kind), ['open']);
  assert.equal(nextState.water.checkOpenedAt, 100);
});

test('an already-open check does not re-open while still extreme', () => {
  const { actions } = selectGaugeCheckActions({ candidates: [gauge('water', 'extreme')], checkState: { water: { checkOpenedAt: 1 } }, now: 100 });
  assert.equal(actions.length, 0);
});

test('a recovered band closes an open check (G2)', () => {
  const { actions, nextState } = selectGaugeCheckActions({ candidates: [gauge('water', 'fine')], checkState: { water: { checkOpenedAt: 1 } }, now: 100 });
  assert.deepEqual(actions.map(a => a.kind), ['close']);
  assert.ok(!('water' in nextState), 'the closed check is dropped from state');
});

test('state for a gauge that dropped out (escalation off / archived) is pruned', () => {
  const { nextState } = selectGaugeCheckActions({ candidates: [], checkState: { water: { checkOpenedAt: 1 } }, now: 100 });
  assert.deepEqual(nextState, {});
});

// ── buildGaugeCheckMessage ────────────────────────────────────────────────────
test('the check message fills the exact duration + label, no hedge', () => {
  const m = buildGaugeCheckMessage({ label: 'Water', hours_since: 50 });
  assert.match(m.body, /Water/);
  assert.match(m.body, /about 2 days/);
  assert.match(m.body, /Are you okay\?/);
  assert.doesNotMatch(m.body, /if it fits|when it feels|maybe/i);
  // an hourly duration under 2 days reads in hours
  assert.match(buildGaugeCheckMessage({ label: 'x', hours_since: 20 }).body, /about 20 hours/);
  // a per-gauge phrase makes the ask natural
  assert.match(buildGaugeCheckMessage({ label: 'Meals', hours_since: 72, escalation: { check_phrase: 'eat' } }).body, /Have you been able to eat\?/);
});

// ── runGaugeCheckTick (I/O) ───────────────────────────────────────────────────
test('runGaugeCheckTick: disabled is a no-op', async () => {
  let enq = 0;
  const r = await runGaugeCheckTick({ enabled: false, candidates: [gauge('water', 'extreme')], enqueue: async () => { enq++; } });
  assert.equal(r.reason, 'disabled');
  assert.equal(enq, 0);
});

test('runGaugeCheckTick: opens a check as ONE outbox reach-out, and never double-posts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauge-'));
  try {
    const calls = [];
    const enqueue = async (item) => { calls.push(item); return { id: 'x' }; };
    const cands = [gauge('water', 'extreme', { hours_since: 50 })];
    const first = await runGaugeCheckTick({ candidates: cands, enqueue, tomesDir: dir, enabled: true, now: 1000 });
    assert.equal(first.opened, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'gauge-check');
    assert.equal(calls[0].originId, 'gauge-check:water');
    // Still extreme next tick, check already open → no new reach-out.
    const second = await runGaugeCheckTick({ candidates: cands, enqueue, tomesDir: dir, enabled: true, now: 2000 });
    assert.equal(second.opened, 0);
    assert.equal(calls.length, 1, 'no second banner while the check is open');

    // The persisted state records the open check (safety state survives a restart).
    const state = JSON.parse(await readFile(path.join(dir, '.gauge-checks.json'), 'utf8'));
    assert.equal(state.water.checkOpenedAt, 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runGaugeCheckTick: a down Unruh degrades to a skipped tick, never throws', async () => {
  const r = await runGaugeCheckTick({ enabled: true, fetchCandidates: async () => { throw new Error('unruh down'); } });
  assert.equal(r.reason, 'unruh-unavailable');
});
