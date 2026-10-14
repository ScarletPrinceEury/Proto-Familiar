// The shared tick guard (0.14.67): every background loop skips a tick while the
// previous one is still running — and used to wait forever for it. A tick stuck
// on an await that never settles (an MCP call, a tool, a file lock) stopped the
// loop for good, silently. The guard's watchdog releases it instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createTickGuard, tickGuardStatus } = await import('../src/util/tick-guard.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quiet = { warn() {}, error() {}, log() {} };

test('a tick that never settles is released, and the next tick runs', { timeout: 5000 }, async () => {
  const g = createTickGuard({ name: 'test-stuck', watchdogMs: 150, log: quiet });
  let stuck;
  g.run((tick) => { stuck = tick; return new Promise(() => {}); });
  assert.equal(g.run(() => 'skipped while busy').constructor, Promise, 'a busy guard hands back the in-flight tick');
  await sleep(250);
  assert.equal(stuck.abandoned, true);
  assert.equal(stuck.signal.aborted, true, 'bounded calls that took the signal stop too');
  let ran = false;
  await g.run(async () => { ran = true; });
  assert.equal(ran, true, 'the loop is alive again');
  assert.equal(tickGuardStatus()['test-stuck'].released, 1);
});

test('while a tick is genuinely running, the next one is skipped (no overlap)', { timeout: 5000 }, async () => {
  const g = createTickGuard({ name: 'test-overlap', watchdogMs: 5000, log: quiet });
  let runs = 0;
  const first = g.run(async () => { runs++; await sleep(100); });
  g.run(async () => { runs++; });
  await first;
  assert.equal(runs, 1);
  await g.run(async () => { runs++; });
  assert.equal(runs, 2);
});

test('a normal tick leaves no watchdog behind and is never marked abandoned', { timeout: 5000 }, async () => {
  const g = createTickGuard({ name: 'test-normal', watchdogMs: 60_000, log: quiet });
  let seen;
  assert.equal(await g.run(async (tick) => { seen = tick; return 7; }), 7);
  assert.equal(seen.abandoned, false);
  assert.equal(seen.signal.aborted, false);
  assert.equal(g.busy(), false);
  // (A leaked 60s watchdog timer would hold this file's process open.)
});

test('settle() waits for the in-flight tick, but no longer than its watchdog', { timeout: 5000 }, async () => {
  const g = createTickGuard({ name: 'test-settle', watchdogMs: 200, log: quiet });
  g.run(() => new Promise(() => {}));
  const t0 = Date.now();
  await g.settle();
  assert.ok(Date.now() - t0 < 1000, 'shutdown is not held hostage by a stuck tick');
});

test('a tick that throws rejects its own run, and the guard clears', { timeout: 5000 }, async () => {
  const g = createTickGuard({ name: 'test-throw', watchdogMs: 5000, log: quiet });
  await assert.rejects(g.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(g.busy(), false);
});

test('an abandoned tick that finally finishes is logged, not silently dropped', { timeout: 5000 }, async () => {
  const lines = [];
  const g = createTickGuard({ name: 'test-late', watchdogMs: 100, log: { warn: (m) => lines.push(m), error: (m) => lines.push(m), log() {} } });
  g.run(() => sleep(300));
  await sleep(450);
  assert.ok(lines.some(l => /test-late/.test(l) && /released/i.test(l)));
  assert.ok(lines.some(l => /test-late/.test(l) && /finally finished/i.test(l)));
});

// ── Pipeline: real loops recover from a tick that never settles ─────────────
test('the reminders loop fires again after a tick that hung', { timeout: 5000 }, async () => {
  const { startRemindersLoop, stopRemindersLoop } = await import('../src/schedule/reminders-loop.js');
  let calls = 0;
  let resolveSecond;
  const second = new Promise(r => { resolveSecond = r; });
  startRemindersLoop({
    tickMs: 50, watchdogMs: 200,
    // First tick: the schedule read never answers. Later ticks: nothing due.
    getDueReminders: () => { calls++; if (calls === 1) return new Promise(() => {}); resolveSecond(); return Promise.resolve([]); },
    fireReminder: async () => {},
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
  });
  try {
    await second;
    assert.ok(calls >= 2, 'reminders are checked again — before the watchdog, never');
  } finally { await stopRemindersLoop(); }
});

test('the warm reach-out loop deliberates again after a tick that hung', { timeout: 5000 }, async () => {
  const { startReachoutLoop, stopReachoutLoop } = await import('../src/warmth/reachout-loop.js');
  let calls = 0;
  let resolveSecond;
  const second = new Promise(r => { resolveSecond = r; });
  startReachoutLoop({
    tickMs: 50, watchdogMs: 200,
    getThreat: async () => ({ tier: 'calm', weight: 0 }),
    getLastActivity: async () => null,
    isQuietHours: async () => false,
    decideReachout: () => { calls++; if (calls === 1) return new Promise(() => {}); resolveSecond(); return Promise.resolve({ action: 'wait' }); },
    deliverWardKnock: async () => ({ ok: true }),
    deliverVillagerReach: async () => ({ ok: true }),
    getWaitStreakFn: () => null,
    recordWaitFn: async () => {},
  });
  try {
    await second;
    assert.ok(calls >= 2);
  } finally { await stopReachoutLoop(); }
});

// ── The safety loops (ward-signed 0.14.67) ──────────────────────────────────
process.env.PROTO_FAMILIAR_WAIT_STREAK_DISABLED = '1';   // no streak writes from these loops

test('the ward-signed watchdogs: triage 10 min, noticing 20 min, needs/gauge 10 min', async () => {
  const { TRIAGE_WATCHDOG_MS } = await import('../src/safety/silence-triage-loop.js');
  const { NOTICING_WATCHDOG_MS } = await import('../src/safety/noticing-loop.js');
  const { NEEDS_WATCHDOG_MS } = await import('../src/schedule/needs-tracking-loop.js');
  assert.equal(TRIAGE_WATCHDOG_MS, 10 * 60_000);
  assert.equal(NOTICING_WATCHDOG_MS, 20 * 60_000);
  assert.equal(NEEDS_WATCHDOG_MS, 10 * 60_000);
});

test('silence triage: a stuck tick is reported as tick_released (→ event log + escalation check), then triage runs again', { timeout: 5000 }, async () => {
  const { startSilenceTriageLoop, stopSilenceTriageLoop } = await import('../src/safety/silence-triage-loop.js');
  let reads = 0;
  const reasons = [];
  let resolveAfter;
  const after = new Promise(r => { resolveAfter = r; });
  startSilenceTriageLoop({
    tickMs: 50, watchdogMs: 200,
    // The first threat read never answers; later ones do.
    getThreat: () => { reads++; return reads === 1 ? new Promise(() => {}) : Promise.resolve({ tier: 'calm', weight: 0 }); },
    getLastActivity: async () => ({ ts: '', ms: Date.now() }),
    decideTriage: async () => ({ action: 'wait' }),
    enqueueOutboxFn: async () => ({ id: 'x', deduped: false }),
    onTick: (r) => { reasons.push(r.reason); if (reasons.includes('tick_released') && reasons.includes('low_threat')) resolveAfter(); },
  });
  try {
    await after;
    assert.ok(reasons.indexOf('tick_released') < reasons.indexOf('low_threat'));
  } finally { await stopSilenceTriageLoop(); }
});

test('noticing: a stuck tick is reported as tick_released, then noticing looks again', { timeout: 5000 }, async () => {
  const { startNoticingLoop, stopNoticingLoop } = await import('../src/safety/noticing-loop.js');
  let reads = 0;
  const reasons = [];
  let resolveAfter;
  const after = new Promise(r => { resolveAfter = r; });
  startNoticingLoop({
    tickMs: 50, watchdogMs: 200,
    getThreat: async () => ({ tier: 'calm' }),
    // The first wake-input read never answers; later ones find nothing to notice.
    getWakeInputs: () => { reads++; return reads === 1 ? new Promise(() => {}) : Promise.resolve({}); },
    deliberate: async () => ({ toolNamesCalled: [] }),
    onTick: (r) => { reasons.push(r.reason); if (reasons.includes('tick_released') && reasons.includes('quiet_window')) resolveAfter(); },
  });
  try {
    await after;
    assert.ok(reasons.indexOf('tick_released') < reasons.indexOf('quiet_window'));
  } finally { await stopNoticingLoop(); }
});
